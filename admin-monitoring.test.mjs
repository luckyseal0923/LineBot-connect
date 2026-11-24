import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createAdminApi} from './admin-api.mjs';

test('management views expose limited metadata only to reviewer and require admin session',async()=>{
 const db=new PGlite();let server;
 try{
  await db.exec("create role anon;create role authenticated;create role linebot_runtime;create role linebot_reviewer;create role linebot_admin_auth;set linebot.isolated_test='yes';");
  for(const f of ['005_independent_accounts.sql','006_runtime_grants.sql','007_review_retention.sql','011_multiple_bots.sql','012_notifications.sql','013_admin_monitoring.sql'])await db.exec(await readFile(new URL('./db/'+f,import.meta.url),'utf8'));
  const a=(await db.query("insert into linebot_private.accounts(username,display_name,password_salt,password_hash,status) values('testuser','Test User','salt','private-hash','active') returning id")).rows[0].id;
  const b=(await db.query("insert into linebot_private.bot_credentials(account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled) values($1,$2,'Test Bot','{\"secret\":\"private-secret\"}','{\"token\":\"private-token\"}',true) returning id",[a,'U'+'a'.repeat(32)])).rows[0].id;
  const recipient=(await db.query("insert into linebot_private.recipients(account_id,bot_id,line_hash,encrypted_line_id,label) values($1,$2,'hash','{\"id\":\"private-id\"}','Test recipient') returning id",[a,b])).rows[0].id;
  await db.query("insert into linebot_private.notifications(id,account_id,bot_id,recipient_id,status,line_status) values($1,$2,$3,$4,'accepted',200)",[randomUUID(),a,b,recipient]);
  const other=(await db.query("insert into linebot_private.accounts(username,display_name,password_salt,password_hash,status) values('otheruser','Other User','salt','private-hash','active') returning id")).rows[0].id;
  const otherBot=(await db.query("insert into linebot_private.bot_credentials(account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled) values($1,$2,'Test Bot','{}','{}',true) returning id",[other,'U'+'b'.repeat(32)])).rows[0].id;
  const otherRecipient=(await db.query("insert into linebot_private.recipients(account_id,bot_id,line_hash,encrypted_line_id,label) values($1,$2,'hash','{}','Other recipient') returning id",[other,otherBot])).rows[0].id;
  await db.query("insert into linebot_private.notifications(id,account_id,bot_id,recipient_id,status,line_status,created_at) values($1,$2,$3,$4,'failed',401,'2026-05-12 16:15:00+00')",[randomUUID(),other,otherBot,otherRecipient]);
  await db.exec('set role linebot_runtime');await assert.rejects(db.query('select * from linebot_private.admin_notifications'));await db.exec('reset role');
  await db.exec('set role linebot_reviewer');await assert.rejects(db.query('select encrypted_secret from linebot_private.bot_credentials'));await assert.rejects(db.query('select password_hash from linebot_private.accounts'));
  let authorized=false;const origin='http://127.0.0.1:39186',api=createAdminApi({reviewDb:db,authorize:async()=>authorized?{id:'admin',passwordVerified:true}:null,publicOrigin:origin});
  server=createServer(async(req,res)=>{if(!await api(req,res)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(39186,'127.0.0.1',resolve));
  assert.equal((await fetch(origin+'/admin-api/monitor')).status,401);
  assert.equal((await fetch(origin+'/admin-api/notifications?username=testuser')).status,401);
  authorized=true;
  const response=await fetch(origin+'/admin-api/monitor');assert.equal(response.status,200);const body=await response.json();
  const testUser=body.accounts.find(item=>item.username==='testuser');
  assert.equal(testUser.active_bots,1);assert.equal(testUser.notifications_30d,1);
  assert.equal(body.notifications.find(item=>item.username==='testuser').recipient_label,'Test recipient');
  for(const secret of ['private-hash','private-secret','private-token','private-id'])assert.equal(JSON.stringify(body).includes(secret),false);
  const adminGet=async path=>(await fetch(origin+'/admin-api/'+path)).json();
  const users=await adminGet('accounts?q=TEST%20USER&status=active');
  assert.deepEqual(users.items.map(item=>item.username),['testuser']);
  const botList=await adminGet('bots?username=testuser');
  assert.deepEqual(botList.items.map(item=>[item.username,item.bot_name]),[['testuser','Test Bot']]);
  const matches=await adminGet('notifications?username=otheruser&bot=Test+Bot&status=attention&from=2026-05-13&to=2026-05-13');
  assert.deepEqual(matches.items.map(item=>[item.username,item.recipient_label,item.status]),[['otheruser','Other recipient','failed']]);
  const wrongDay=await adminGet('notifications?username=otheruser&from=2026-05-12&to=2026-05-12');
  assert.deepEqual(wrongDay.items,[]);
  assert.equal((await fetch(origin+'/admin-api/notifications?from=2026-02-30')).status,400);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
