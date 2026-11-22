import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { generate,generateSecret } from 'otplib';
import { PGlite } from '@electric-sql/pglite';
import { createAdminEnrollment } from './admin-enrollment.mjs';
import { createAdminMfa } from './admin-mfa.mjs';
import { createCredentialVault } from './line-webhook.mjs';

test('bootstrap requires QR proof, is single use and does not grant general admin access',async()=>{
 const db=new PGlite();
 try{
  await db.exec("create role anon;create role authenticated;create role linebot_runtime;create role linebot_reviewer;create role linebot_admin_auth;create role linebot_enroller;set linebot.isolated_test='yes';");
  for(const name of ['005_independent_accounts.sql','006_runtime_grants.sql','007_review_retention.sql','008_admin_mfa.sql','009_admin_enrollment.sql'])await db.exec(await readFile(new URL('./db/'+name,import.meta.url),'utf8'));
  const secret=generateSecret(),vault=createCredentialVault(randomBytes(32),{context:'admin-totp'}),now=new Date('2026-01-01T00:00:00Z');
  await db.exec('set role linebot_enroller');
  const enroll=await createAdminEnrollment({db,vault,username:'admin_test',password:'a long test password',clock:()=>now,makeSecret:()=>secret});
  assert.ok(enroll.qr.length>100);assert.equal(enroll.manualKey,secret);assert.equal(await enroll.confirm('000000'),false);
  const otp=await generate({secret,epoch:Math.floor(now.getTime()/1000)});
  assert.equal(await enroll.confirm(otp),true);assert.equal(await enroll.confirm(otp),false);
  await assert.rejects(db.query('select * from linebot_private.admin_auth'));
  await db.exec('reset role;set role linebot_admin_auth');
  const mfa=createAdminMfa({db,vault,clock:()=>now});
  assert.equal(await mfa.login({username:'admin_test',password:'a long test password',otp}),null);
  const next=new Date(now.getTime()+30000);const otp2=await generate({secret,epoch:Math.floor(next.getTime()/1000)});
  const mfa2=createAdminMfa({db,vault,clock:()=>next});assert.ok(await mfa2.login({username:'admin_test',password:'a long test password',otp:otp2}));
  await db.exec('reset role;set role linebot_enroller');
  const another=await createAdminEnrollment({db,vault,username:'another',password:'a long test password',clock:()=>now,makeSecret:()=>secret});
  await assert.rejects(another.confirm(otp));
 }finally{await db.close();}
});
