import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { createIndependentApi } from './independent-api.mjs';
import { createPlatformServices } from './platform-services.mjs';

test('deleting a Bot is scoped, retires credentials and pairing, and preserves website and events', async () => {
 const db = new PGlite();
 try {
  await db.exec("create role anon;create role authenticated;create role linebot_runtime;create role linebot_reviewer;create role linebot_admin_auth;create role linebot_enroller;set linebot.isolated_test='yes'");
  for (const f of ['005_independent_accounts','006_runtime_grants','007_review_retention','011_multiple_bots','012_notifications','013_admin_monitoring','014_line_quota','015_external_integrations','017_platform_services','018_line_setup_details','020_delete_integration','021_event_recipients','024_delete_platform','027_delete_platform_bot'])
    await db.exec(await readFile(new URL('./db/'+f+'.sql', import.meta.url),'utf8'));
  const account=randomUUID(), other=randomUUID(), bot=randomUUID(), recipient=randomUUID(), platform=randomUUID(), event=randomUUID();
  for(const [id,name] of [[account,'owner'],[other,'other']]) await db.query("insert into linebot_private.accounts(id,username,display_name,password_salt,password_hash,status) values($1,$2,$2,'salt','hash','active')",[id,name]);
  await db.query("insert into linebot_private.bot_credentials(id,account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled) values($1,$2,$3,'測試 Bot','{}','{}',true)",[bot,account,'U'+'a'.repeat(32)]);
  await db.query("insert into linebot_private.platform_services(id,account_id,bot_id,name,line_setup) values($1,$2,$3,'測試網站', $4::jsonb)",[platform,account,bot,JSON.stringify({recipientLiffId:'old',loginProfile:{a:1},providerName:'kept'})]);
  await db.query("insert into linebot_private.recipients(id,account_id,bot_id,line_hash,encrypted_line_id,label) values($1,$2,$3,'hash',$4,'對象')",[recipient,account,bot,JSON.stringify({id:'encrypted'})]);
  await db.query("insert into linebot_private.integrations(id,account_id,platform_id,recipient_id,name,key_hash,key_tail) values($1,$2,$3,$4,'事件',$5,'123456')",[event,account,platform,recipient,'a'.repeat(64)]);
  await db.exec('set role linebot_runtime');
  const service=createPlatformServices({db});
  assert.deepEqual(await service.removeBot(other,platform,bot),{error:'unavailable'});
  assert.deepEqual(await service.removeBot(account,platform,randomUUID()),{error:'unavailable'});
  assert.deepEqual(await service.removeBot(account,platform,bot),{ok:true});
  assert.deepEqual(await service.removeBot(account,platform,bot),{error:'unavailable'});
  const [p]=(await db.query('select bot_id,line_setup from linebot_private.platform_services where id=$1',[platform])).rows;
  assert.equal(p.bot_id,null);assert.deepEqual(p.line_setup,{providerName:'kept'});
  const [b]=(await db.query('select bot_user_id,enabled,encrypted_secret,encrypted_access_token from linebot_private.bot_credentials where id=$1',[bot])).rows;
  assert.deepEqual(b,{bot_user_id:null,enabled:false,encrypted_secret:{},encrypted_access_token:{}});
  const [r]=(await db.query('select active,encrypted_line_id from linebot_private.recipients where id=$1',[recipient])).rows;
  assert.deepEqual(r,{active:false,encrypted_line_id:{}});
  const [e]=(await db.query('select name,enabled,recipient_id,extra_recipient_ids,revision,key_tail from linebot_private.integrations where id=$1',[event])).rows;
  assert.deepEqual(e,{name:'事件',enabled:false,recipient_id:null,extra_recipient_ids:[],revision:2,key_tail:'123456'});
  await db.exec('reset role');
  const newBot=randomUUID();
  await db.query("insert into linebot_private.bot_credentials(id,account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled) values($1,$2,$3,'重新設定','{}','{}',true)",[newBot,account,'U'+'a'.repeat(32)]);
  await db.exec('set role linebot_runtime');
  assert.deepEqual(await service.attach(account,platform,newBot),{id:platform});
  const [after]=(await db.query('select enabled,recipient_id from linebot_private.integrations where id=$1',[event])).rows;
  assert.deepEqual(after,{enabled:false,recipient_id:null});
 } finally { await db.close(); }
});


test('delete API requires confirmation, an active account, same origin and an owned platform', async () => {
 const origin='http://127.0.0.1:39377';
 const platform='11111111-1111-4111-8111-111111111111', bot='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 let calls=0, active=true;
 const api=createIndependentApi({publicOrigin:origin,accounts:{me:async()=>({id:'owner',status:active?'active':'pending',profile_complete:true})},bots:{},lookupBot:async()=>null,allow:async()=>true,platforms:{removeBot:async(account,p,b)=>{calls++;return account==='owner'&&p===platform&&b===bot?{ok:true}:{error:'unavailable'}}}});
 const server=createServer((req,res)=>api(req,res));await new Promise(resolve=>server.listen(39377,'127.0.0.1',resolve));
 try {
  const send=(confirmation,selected=platform,requestOrigin=origin)=>fetch(origin+'/independent-api/bot/delete?platform='+selected,{method:'POST',headers:{Origin:requestOrigin,'Content-Type':'application/json'},body:JSON.stringify({botId:bot,confirmation})});
  assert.equal((await send('不確認')).status,400);assert.equal(calls,0);
  assert.equal((await send('刪除 LINE Bot',platform,'http://other.test')).status,403);assert.equal(calls,0);
  active=false;assert.equal((await send('刪除 LINE Bot')).status,403);assert.equal(calls,0);active=true;
  assert.equal((await send('刪除 LINE Bot','22222222-2222-4222-8222-222222222222')).status,404);
  assert.equal((await send('刪除 LINE Bot')).status,200);assert.equal(calls,2);
 } finally { await new Promise(resolve=>server.close(resolve)); }
});
