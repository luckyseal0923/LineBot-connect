import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createLineQuotaPoller} from './line-quota.mjs';

test('quota poll stores only LINE usage, is scoped to active bots, and denies credential access to reviewer',async()=>{
 const db=new PGlite();try{
  await db.exec("create role anon;create role authenticated;create role linebot_runtime;create role linebot_reviewer;create role linebot_admin_auth;set linebot.isolated_test='yes';");
  for(const f of ['005_independent_accounts.sql','006_runtime_grants.sql','007_review_retention.sql','011_multiple_bots.sql','012_notifications.sql','013_admin_monitoring.sql','014_line_quota.sql'])await db.exec(await readFile(new URL('./db/'+f,import.meta.url),'utf8'));
  const account=(await db.query("insert into linebot_private.accounts(username,display_name,password_salt,password_hash,status) values('testuser','Test','s','h','active') returning id")).rows[0].id;
  await db.query("insert into linebot_private.bot_credentials(account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled) values($1,$2,'A','{}','{}',true),($1,$3,'B','{}','{}',false)",[account,'U'+'a'.repeat(32),'U'+'b'.repeat(32)]);
  await db.exec('set role linebot_runtime');let requests=0;
  const poll=createLineQuotaPoller({db,tokenVault:{open:()=> 'synthetic-token'},fetchImpl:async(url,options)=>{requests++;assert.equal(url,'https://api.line.me/v2/bot/message/quota/consumption');assert.equal(options.redirect,'error');return new Response(JSON.stringify({totalUsage:7}),{status:200});}});
  await poll();await poll();assert.equal(requests,1);
  let cached=await db.query('select total_usage,status from linebot_private.bot_monthly_usage');assert.equal(Number(cached.rows[0].total_usage),7);assert.equal(cached.rows[0].status,'ok');
  await db.query("update linebot_private.bot_monthly_usage set checked_at=now()-interval '31 minutes'");
  const failure=createLineQuotaPoller({db,tokenVault:{open:()=> 'synthetic-token'},fetchImpl:async()=>new Response('{}',{status:401})});await failure();
  cached=await db.query('select total_usage,status from linebot_private.bot_monthly_usage');assert.equal(cached.rows[0].total_usage,null);assert.equal(cached.rows[0].status,'unavailable');
  await db.exec('reset role; set role linebot_reviewer');
  const bots=await db.query('select * from linebot_private.admin_bots order by bot_name');assert.equal(bots.rows.length,2);assert.equal(bots.rows[0].usage_status,'unavailable');
  await assert.rejects(db.query('select encrypted_access_token from linebot_private.bot_credentials'));
  await assert.rejects(db.query('select * from linebot_private.bot_monthly_usage'));
 }finally{await db.close();}
});
