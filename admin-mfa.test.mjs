import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { randomBytes,scryptSync } from 'node:crypto';
import { generate,generateSecret } from 'otplib';
import { PGlite } from '@electric-sql/pglite';
import { createCredentialVault } from './line-webhook.mjs';
import { createAdminMfa } from './admin-mfa.mjs';

test('admin requires password and TOTP, rejects replay, and limits role privileges',async()=>{
 const db=new PGlite();
 try{
  await db.exec("create role anon;create role authenticated;create role linebot_runtime;create role linebot_reviewer;create role linebot_admin_auth;set linebot.isolated_test='yes';");
  for(const name of ['005_independent_accounts.sql','006_runtime_grants.sql','007_review_retention.sql','008_admin_mfa.sql'])await db.exec(await readFile(new URL('./db/'+name,import.meta.url),'utf8'));
  const vault=createCredentialVault(randomBytes(32),{context:'admin-totp'}),id='00000000-0000-0000-0000-000000000001';
  const secret=generateSecret(), salt=randomBytes(16).toString('hex'), password='test-password-long';
  const hash=scryptSync(password,Buffer.from(salt,'hex'),64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex');
  await db.query('insert into linebot_private.admin_auth(id,username,password_salt,password_hash,encrypted_totp,enabled) values($1,$2,$3,$4,$5::jsonb,true)',[id,'admin_test',salt,hash,JSON.stringify(vault.seal(id,secret))]);
  await db.exec('set role linebot_admin_auth');
  const now=new Date('2026-01-01T00:00:00Z');const mfa=createAdminMfa({db,vault,clock:()=>now});
  const otp=await generate({secret,epoch:Math.floor(now.getTime()/1000)});
  assert.equal(await mfa.login({username:'admin_test',password:'wrong',otp}),null);
  const token=await mfa.login({username:'admin_test',password,otp});assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await mfa.session(token)).mfaVerified,true);
  assert.equal(await mfa.login({username:'admin_test',password,otp}),null);
  await assert.rejects(db.query("select linebot_private.review_account('admin_test','active','x')"));
  await assert.rejects(db.query('select * from linebot_private.accounts'));
  await mfa.logout(token);assert.equal(await mfa.session(token),null);
 }finally{await db.close();}
});
