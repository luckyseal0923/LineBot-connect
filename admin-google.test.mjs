import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createAdminPassword } from './admin-password.mjs';
import { createGoogleOAuth } from './google-oauth.mjs';
import { adminSessionCookie } from './admin-session-api.mjs';

test('admin OAuth binds each authorized mailbox to its own Google identity and session',async()=>{
  const db=new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role linebot_admin_auth; create role linebot_runtime; create role linebot_reviewer; create schema linebot_private; set linebot.isolated_test='yes'");
    for(const name of ['008_admin_mfa','010_admin_login_audit','029_admin_google_signin'])
      await db.exec(await readFile(new URL('./db/'+name+'.sql',import.meta.url),'utf8'));
    const personal='person@gmail.com', staff='staff@example.org';
    for(const [username,email] of [['one',personal],['two',staff]]) {
      await db.query("insert into linebot_private.admin_auth(username,google_email,password_salt,password_hash,encrypted_totp,enabled) values($1,$2,'','','{}',true)",[username,email]);
    }
    await db.exec('set role linebot_admin_auth');
    const auth=createAdminPassword({db});
    const publicOrigin='https://admin.example.org', redirectOrigin='https://site.example.org';
    let claims;
    const oauth=createGoogleOAuth({admin:true,key:randomBytes(32),allow:async()=>true,
      clientId:'test.apps.googleusercontent.com',clientSecret:'fixture',publicOrigin,redirectOrigin,
      login:auth.loginWithGoogle,sessionCookie:adminSessionCookie,successPath:'/#overview',errorPath:'/#overview?google=',
      fetchImpl:async()=>Response.json({id_token:'fixture'}),verifyIdToken:async()=>claims});
    async function request(path,query,cookie=''){
      let headers;
      await oauth({method:'GET',url:path+'?'+query,headers:{cookie}},{
        writeHead(status,h){assert.equal(status,303);headers=h;},end(){}
      },path);
      return headers;
    }
    async function signIn(identity,{badState=false}={}) {
      const start=await request('/auth/google/start','');
      const params=new URL(start.Location).searchParams;
      assert.equal(params.get('redirect_uri'),redirectOrigin+'/auth/google/callback');
      assert.match(start['Set-Cookie'],/^__Host-linebot_admin_google_flow=.*; Path=\/; HttpOnly; SameSite=Lax; Secure/);
      claims={nonce:params.get('nonce'),email_verified:true,...identity};
      const query=new URLSearchParams({code:'fixture',state:badState?'bad-state':params.get('state')});
      return request('/auth/google/callback',query,start['Set-Cookie'].split(';')[0]);
    }
    const a={sub:'101',email:personal}, b={sub:'202',email:staff,hd:'example.org'};
    const session=async id=>{
      const result=await signIn(id);
      assert.equal(result.Location,'/#overview');
      const token=/^linebot_admin=([^;]+)/.exec(result['Set-Cookie'][1])[1];
      return {token,admin:await auth.session(token)};
    };
    const one=await session(a),two=await session(b);
    assert.equal(one.admin.googleVerified,true);assert.notEqual(one.admin.id,two.admin.id);
    for(const denied of [{...a,sub:'303'},{...b,email:'other@example.org'},{...b,hd:null}])
      assert.equal((await signIn(denied)).Location,'/#overview?google=disabled');
    assert.equal((await signIn({...a,email_verified:false})).Location,'/#overview?google=identity');
    assert.equal((await signIn(a,{badState:true})).Location,'/#overview?google=expired');
    await auth.logout(one.token);assert.equal(await auth.session(one.token),null);
    await db.exec("reset role; update linebot_private.admin_auth set enabled=false where username='two'; set role linebot_admin_auth");
    assert.equal(await auth.session(two.token),null);
  } finally {await db.close();}
});
