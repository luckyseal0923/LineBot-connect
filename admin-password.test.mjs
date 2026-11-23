import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { randomBytes,scryptSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createAdminPassword } from './admin-password.mjs';
import { createAdminServer } from './admin-server.mjs';
import { createAdminRateLimiter } from './admin-rate-limit.mjs';

test('password login records outcomes and locks after five failures without access to other platform data', async () => {
 const db = new PGlite();
 try {
  await db.exec("create role anon;create role authenticated;create role linebot_runtime;create role linebot_reviewer;create role linebot_admin_auth;set linebot.isolated_test='yes';");
  for (const name of ['005_independent_accounts.sql','006_runtime_grants.sql','007_review_retention.sql','008_admin_mfa.sql','010_admin_login_audit.sql']) await db.exec(await readFile(new URL('./db/'+name,import.meta.url),'utf8'));
  const id='00000000-0000-0000-0000-000000000001', salt=randomBytes(16).toString('hex'), password='test-password-long';
  const hash=scryptSync(password,Buffer.from(salt,'hex'),64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex');
  await db.query("insert into linebot_private.admin_auth(id,username,password_salt,password_hash,encrypted_totp,enabled) values($1,$2,$3,$4,'{}'::jsonb,true)",[id,'admin_test',salt,hash]);
  await db.exec('set role linebot_admin_auth');
  const auth=createAdminPassword({db});
  assert.equal(await auth.login({username:'admin_test',password:'wrong'}),null);
  const token=await auth.login({username:'admin_test',password});
  assert.equal((await auth.session(token)).passwordVerified,true);
  await auth.logout(token); assert.equal(await auth.session(token),null);
  for(let i=0;i<5;i++) assert.equal(await auth.login({username:'admin_test',password:'wrong'}),null);
  assert.equal(await auth.login({username:'admin_test',password}),null);
  await assert.rejects(db.query('select * from linebot_private.accounts'));
  await db.exec('reset role');
  const rows=(await db.query('select outcome from linebot_private.admin_login_audit order by id')).rows;
  assert.deepEqual(rows.map(r=>r.outcome),['denied','success','denied','denied','denied','denied','denied','denied']);
  await db.exec("insert into linebot_private.admin_login_audit(outcome,created_at) values ('denied',now()-interval '91 days'); set role linebot_admin_auth; select linebot_private.purge_admin_login_audit(); reset role;");
  assert.equal(Number((await db.query('select count(*) as n from linebot_private.admin_login_audit')).rows[0].n),8);
 } finally { await db.close(); }
});

test('administrator can sign in without OTP and access the review page', async () => {
 const db=new PGlite(); let server;
 try {
  await db.exec("create role anon;create role authenticated;create role linebot_runtime;create role linebot_reviewer;create role linebot_admin_auth;set linebot.isolated_test='yes';");
  for(const name of ['005_independent_accounts.sql','006_runtime_grants.sql','007_review_retention.sql','008_admin_mfa.sql','010_admin_login_audit.sql']) await db.exec(await readFile(new URL('./db/'+name,import.meta.url),'utf8'));
  const salt=randomBytes(16).toString('hex'),password='test-password-long';
  const hash=scryptSync(password,Buffer.from(salt,'hex'),64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex');
  await db.query("insert into linebot_private.admin_auth(username,password_salt,password_hash,encrypted_totp,enabled) values($1,$2,$3,'{}'::jsonb,true)",['admin_test',salt,hash]);
  const origin='http://127.0.0.1:39185';
  server=createAdminServer({reviewDb:db,mfa:createAdminPassword({db}),allow:createAdminRateLimiter({db}),publicOrigin:origin});
  await new Promise(resolve=>server.listen(39185,'127.0.0.1',resolve));
  assert.doesNotMatch(await (await fetch(origin+'/')).text(),/name="otp"/);
  assert.equal((await fetch(origin+'/admin-api/pending')).status,401);
  const login=await fetch(origin+'/admin-session/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin_test',password})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(origin+'/admin-api/pending',{headers:{Cookie:cookie}})).status,200);
 } finally { if(server) await new Promise(resolve=>server.close(resolve)); await db.close(); }
});
