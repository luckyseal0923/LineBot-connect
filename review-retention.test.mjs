import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('review authorization, audit, bounded retention and event quota',async()=>{
 const db=new PGlite();
 try {
  await db.exec("create role anon;create role authenticated;create role linebot_runtime;create role linebot_reviewer;set linebot.isolated_test='yes';");
  for(const name of ['005_independent_accounts.sql','006_runtime_grants.sql','007_review_retention.sql']) await db.exec(await readFile(new URL('./db/'+name,import.meta.url),'utf8'));
  await db.exec("insert into linebot_private.accounts(username,display_name,password_salt,password_hash) values('tester','Test','salt','hash')");
  const id=(await db.query("select id from linebot_private.accounts where username='tester'")).rows[0].id;
  await db.exec('set role linebot_runtime');
  await assert.rejects(db.query("select linebot_private.review_account('tester','active','approved')"));
  await assert.rejects(db.query("update linebot_private.accounts set status='active'"));
  await db.exec('reset role; set role linebot_reviewer');
  assert.equal((await db.query("select linebot_private.review_account('tester','active','reviewed') as ok")).rows[0].ok,true);
  assert.equal((await db.query('select username,status from linebot_private.accounts')).rows.length,1);
  await assert.rejects(db.query('select * from linebot_private.accounts'));
  await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int as n from linebot_private.review_audit')).rows[0].n,1);
  await db.exec('set role linebot_runtime');
  const payload=JSON.stringify([{event_id:'old',payload:{ciphertext:'abc'}},{event_id:'keep',payload:{ciphertext:'abc'}}]);
  await db.query('select linebot_private.store_events($1,$2::jsonb)',[id,payload]);
  await assert.rejects(db.query("delete from linebot_private.webhook_events"));
  await db.exec('reset role');
  await db.query("update linebot_private.webhook_events set received_at=now()-interval '8 days' where account_id=$1 and event_id='old'",[id]);
  await db.exec('set role linebot_runtime');
  assert.equal((await db.query('select linebot_private.purge_expired_events() as n')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int as n from linebot_private.webhook_events')).rows[0].n,1);
  await db.exec('reset role');
  await db.query("insert into linebot_private.webhook_events(account_id,event_id,payload) select $1, 'id-'||x, '{}'::jsonb from generate_series(1,999) x",[id]);
  await db.exec('set role linebot_runtime');
  await assert.rejects(db.query('select linebot_private.store_events($1,$2::jsonb)',[id,JSON.stringify([{event_id:'excess',payload:{ciphertext:'x'}}])]));
 }finally{await db.close();}
});
