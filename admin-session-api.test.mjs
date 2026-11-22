import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes,scryptSync } from 'node:crypto';
import { generate,generateSecret } from 'otplib';
import { PGlite } from '@electric-sql/pglite';
import { createAdminMfa } from './admin-mfa.mjs';
import { createAdminSessionApi } from './admin-session-api.mjs';
import { createAdminRateLimiter } from './admin-rate-limit.mjs';
import { createAdminApi } from './admin-api.mjs';
import { createAdminServer } from './admin-server.mjs';
import { createCredentialVault } from './line-webhook.mjs';

test('admin HTTP session requires both factors and protects review',async()=>{
 const db=new PGlite();let server;
 try{
  await db.exec("create role anon;create role authenticated;create role linebot_runtime;create role linebot_reviewer;create role linebot_admin_auth;set linebot.isolated_test='yes';");
  for(const name of ['005_independent_accounts.sql','006_runtime_grants.sql','007_review_retention.sql','008_admin_mfa.sql'])await db.exec(await readFile(new URL('./db/'+name,import.meta.url),'utf8'));
  const id='00000000-0000-0000-0000-000000000001',salt=randomBytes(16).toString('hex'),pass='test-password-long',secret=generateSecret();
  const hash=scryptSync(pass,Buffer.from(salt,'hex'),64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex');
  const vault=createCredentialVault(randomBytes(32),{context:'admin-totp'}),now=new Date('2026-01-01T00:00:00Z');
  await db.query('insert into linebot_private.admin_auth(id,username,password_salt,password_hash,encrypted_totp,enabled) values($1,$2,$3,$4,$5::jsonb,true)',[id,'admin_test',salt,hash,JSON.stringify(vault.seal(id,secret))]);
  await db.exec("insert into linebot_private.accounts(username,display_name,password_salt,password_hash) values('person_a','Person','salt','hash')");
  const origin='http://127.0.0.1:39184';const sessions=createAdminSessionApi({mfa:createAdminMfa({db,vault,clock:()=>now}),allow:createAdminRateLimiter({db}),publicOrigin:origin});
  const admin=createAdminApi({reviewDb:db,authorize:sessions.authorize,publicOrigin:origin});
  server=createAdminServer({reviewDb:db,mfa:createAdminMfa({db,vault,clock:()=>now}),allow:createAdminRateLimiter({db}),publicOrigin:origin});
  await new Promise(resolve=>server.listen(39184,'127.0.0.1',resolve));
  assert.match(await (await fetch(origin+'/')).text(),/帳號申請審核/);
  assert.equal((await fetch(origin+'/admin-api/pending')).status,401);
  const otp=await generate({secret,epoch:Math.floor(now.getTime()/1000)});
  const login=await fetch(origin+'/admin-session/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin_test',password:pass,otp})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await fetch(origin+'/admin-api/pending',{headers:{Cookie:cookie}})).json()).accounts.length,1);
  const result=await fetch(origin+'/admin-api/review',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({username:'person_a',status:'active',reason:'reviewed'})});
  assert.equal(result.status,200);
  await fetch(origin+'/admin-session/logout',{method:'POST',headers:{Origin:origin,Cookie:cookie}});
  assert.equal((await fetch(origin+'/admin-api/pending',{headers:{Cookie:cookie}})).status,401);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
