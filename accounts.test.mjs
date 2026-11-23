import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createAccounts } from './accounts.mjs';

test('independent accounts persist isolated sessions and random webhook keys', async () => {
 const db = new PGlite();
 try {
  await db.exec('create role anon; create role authenticated;');
  const sql = await readFile(new URL('./db/005_independent_accounts.sql', import.meta.url),'utf8');
  await assert.rejects(db.exec(sql));
  await db.exec("rollback; set linebot.isolated_test = 'yes';");
  await db.exec(sql);
  let now = new Date('2026-01-01T00:00:00Z');
  const accounts = createAccounts({db, clock: () => now});
  assert.equal((await accounts.register({username:'short_user',displayName:'Short',password:'1234567'})).status,'invalid');
  assert.equal((await accounts.register({username:'eight_user',displayName:'Eight',password:'12345678'})).status,'created');
  assert.equal((await accounts.register({username:'user_a',displayName:'User A',password:'a secure password'})).status,'created');
  assert.equal((await accounts.register({username:'user_b',displayName:'User B',password:'a different password'})).status,'created');
  assert.equal((await accounts.register({username:'user_a',displayName:'Duplicate',password:'a secure password'})).status,'unavailable');
  assert.equal((await accounts.login({username:'user_a',password:'wrong password'})).status,'invalid');
  const a=await accounts.login({username:'user_a',password:'a secure password'});
  const b=await accounts.login({username:'user_b',password:'a different password'});
  assert.equal(a.status,'ok'); assert.equal(b.status,'ok');
  const meA=await accounts.me(a.token), meB=await accounts.me(b.token);
  assert.equal(meA.username,'user_a'); assert.equal(meB.username,'user_b');
  assert.notEqual(meA.webhook_key,meB.webhook_key);
  assert.equal((await accounts.me(a.token)).webhook_key,meA.webhook_key);
  assert.equal((await db.query('select * from linebot_private.sessions where token_hash=$1',[a.token])).rows.length,0);
  await accounts.logout(a.token); assert.equal(await accounts.me(a.token),null);
  now = new Date('2026-01-01T09:00:00Z'); assert.equal(await accounts.me(b.token),null);
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select * from linebot_private.accounts'));
  await assert.rejects(db.query('select * from linebot_private.bot_credentials'));
  await db.exec('reset role; set role anon');
  await assert.rejects(db.query('select * from linebot_private.accounts'));
 } finally { await db.close(); }
});

test('repeated wrong password locks account temporarily', async () => {
 const db = new PGlite();
 try {
  await db.exec("create role anon; create role authenticated; set linebot.isolated_test='yes';");
  await db.exec(await readFile(new URL('./db/005_independent_accounts.sql',import.meta.url),'utf8'));
  let now=new Date('2026-01-01T00:00:00Z'); const service=createAccounts({db,clock:()=>now});
  await service.register({username:'user_a',displayName:'A',password:'a secure password'});
  for(let i=0;i<5;i++) assert.equal((await service.login({username:'user_a',password:'wrong'})).status,'invalid');
  assert.equal((await service.login({username:'user_a',password:'a secure password'})).status,'invalid');
  now=new Date('2026-01-01T00:16:00Z');
  assert.equal((await service.login({username:'user_a',password:'a secure password'})).status,'ok');
 } finally {await db.close();}
});

test('runtime role cannot approve accounts or access unrelated private data', async () => {
  const db=new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role linebot_runtime; set linebot.isolated_test='yes'; create schema other_platform; create table other_platform.records(secret text); revoke all on schema other_platform from public;");
    await db.exec(await readFile(new URL('./db/005_independent_accounts.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('./db/006_runtime_grants.sql',import.meta.url),'utf8'));
    await db.exec('set role linebot_runtime');
    const accounts=createAccounts({db});
    assert.equal((await accounts.register({username:'pending_user',displayName:'Pending',password:'a secure password'})).status,'created');
    assert.equal((await accounts.login({username:'pending_user',password:'a secure password'})).status,'ok');
    await assert.rejects(db.query("update linebot_private.accounts set status='active'"));
    await assert.rejects(db.query('select * from other_platform.records'));
  } finally {await db.close();}
});
