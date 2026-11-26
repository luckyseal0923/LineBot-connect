import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createPlatformServices} from './platform-services.mjs';
test('migrates existing bots, isolates services and keeps a one-to-one bot assignment',async()=>{
 const db=new PGlite();try{
  await db.exec("create role anon; create role authenticated; create role linebot_runtime; create role linebot_reviewer; create role linebot_admin_auth; create role linebot_enroller; set linebot.isolated_test='yes'");
  for(const f of ['005_independent_accounts.sql','006_runtime_grants.sql','007_review_retention.sql','011_multiple_bots.sql','012_notifications.sql','013_admin_monitoring.sql','014_line_quota.sql','015_external_integrations.sql'])await db.exec(await readFile(new URL('./db/'+f,import.meta.url),'utf8'));
  const a=randomUUID(),b=randomUUID(), bot=randomUUID(), otherBot=randomUUID(), recipient=randomUUID();
  for(const [id,name] of [[a,'alice'],[b,'bob']]) await db.query("insert into linebot_private.accounts(id,username,display_name,password_salt,password_hash,status) values($1,$2,$2,'salt','hash','active')",[id,name]);
  for(const [id,owner,lineId] of [[bot,a,'a'],[otherBot,b,'b']]) await db.query("insert into linebot_private.bot_credentials(id,account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled) values($1,$2,$3,'Bot','{}','{}',true)",[id,owner,'U'+lineId.repeat(32)]);
  await db.query("insert into linebot_private.recipients(id,account_id,bot_id,line_hash,encrypted_line_id,label) values($1,$2,$3,'hash','{}','A')",[recipient,a,bot]);
  await db.query("insert into linebot_private.integrations(account_id,recipient_id,name,key_hash,key_tail) values($1,$2,'原有名稱',$3,'123456')",[a,recipient,'a'.repeat(64)]);
  await db.exec(await readFile(new URL('./db/017_platform_services.sql',import.meta.url),'utf8'));
  for (const name of ['018_line_setup_details', '020_delete_integration', '021_event_recipients', '024_delete_platform']) {
    await db.exec(await readFile(new URL('./db/' + name + '.sql', import.meta.url), 'utf8'));
  }
  const existing=(await db.query('select name,event_name,key_hash from linebot_private.integrations')).rows[0];
  assert.deepEqual(existing,{name:'原有名稱',event_name:null,key_hash:'a'.repeat(64)});
  await db.query(`insert into linebot_private.recipients(account_id,bot_id,line_hash,encrypted_line_id,label)
    select $1,$2,'bulk-' || n,'{}','示例' from generate_series(1,201) n`, [a,bot]);
  await db.query("insert into linebot_private.recipients(account_id,bot_id,line_hash,encrypted_line_id,label,active) values($1,$2,'inactive','{}','停用',false)",[a,bot]);
  await db.query("insert into linebot_private.recipients(account_id,bot_id,line_hash,encrypted_line_id,label) values($1,$2,'other','{}','其他帳號')",[b,otherBot]);
  await db.exec('set role linebot_runtime');
  const services=createPlatformServices({db});const list=await services.list(a);
  assert.equal(list.length,1);assert.equal(list[0].botId,bot);assert.equal(list[0].name,null);
  assert.equal(list[0].recipientCount,202);assert.equal(list[0].eventCount,1);
  const otherCounts=(await services.list(b))[0];assert.equal(otherCounts.recipientCount,1);assert.equal(otherCounts.eventCount,0);
  assert.equal((await services.rename(b,list[0].id,'跨帳號')).error,'unavailable');
  assert.equal((await services.rename(a,list[0].id,'課程報名平台')).id,list[0].id);
  const created=await services.create(a,'教具借用平台');assert.ok(created.id);
  const empty=(await services.list(a)).find(p=>p.id===created.id);assert.equal(empty.recipientCount,0);assert.equal(empty.eventCount,0);
  assert.equal((await services.attach(a,created.id,otherBot)).error,'unavailable');
  assert.equal((await services.attach(a,created.id,bot)).error,'bot_in_use');
  await db.exec('reset role');
  const newBot=randomUUID(); await db.query("insert into linebot_private.bot_credentials(id,account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled) values($1,$2,$3,'Second Bot','{}','{}',true)",[newBot,a,'U'+'c'.repeat(32)]);
  await db.exec('set role linebot_runtime');
  assert.equal((await services.attach(a,created.id,newBot)).id,created.id);
  assert.equal((await services.list(a)).find(p=>p.id===created.id).botId,newBot);
  await assert.rejects(db.query('update linebot_private.platform_services set bot_id=$1 where id=$2',[otherBot,created.id]),{code:'23514'});
  assert.equal((await services.list(a)).length,2);assert.equal((await services.list(b)).length,1);
  const original = list[0].id;
  const vacant = await services.create(a,'未接線的平台');
  assert.deepEqual(await services.remove(b, original), {error:'unavailable'});
  assert.deepEqual(await services.remove(a, vacant.id), {id:vacant.id});
  assert.deepEqual(await services.remove(a, original), {id:original});
  assert.deepEqual(await services.remove(a, original), {id:original});
  assert.deepEqual((await services.list(a)).map(item => item.id), [created.id]);
  assert.equal((await services.list(b))[0].botId, otherBot);
  assert.equal((await services.rename(a, original, '已刪除')).error, 'unavailable');
  assert.equal((await services.getLineSetup(a, original)).error, 'unavailable');
  assert.equal((await services.attach(a, original, newBot)).error, 'unavailable');
  assert.deepEqual((await db.query('select bot_user_id,enabled,encrypted_access_token,encrypted_secret from linebot_private.bot_credentials where id=$1', [bot])).rows,
    [{bot_user_id:null,enabled:false,encrypted_access_token:{},encrypted_secret:{}}]);
  assert.equal((await db.query('select count(*)::int as count from linebot_private.integrations where platform_id=$1 and deleted_at is not null and key_hash is null', [original])).rows[0].count, 1);
  assert.equal((await db.query('select count(*)::int as count from linebot_private.recipients where id=$1', [recipient])).rows[0].count, 1);
 }finally{await db.close()}
});
