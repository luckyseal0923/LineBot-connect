import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createCredentialVault} from './line-webhook.mjs';
import {createNotifications} from './notifications.mjs';

test('one-time pairing is scoped to the bot and account; sends are deduplicated and do not expose content',async()=>{
 const db=new PGlite();try{
  await db.exec("create role anon; create role authenticated; create role linebot_runtime; set linebot.isolated_test='yes';");
  for(const f of ['005_independent_accounts.sql','006_runtime_grants.sql','011_multiple_bots.sql','012_notifications.sql'])await db.exec(await readFile(new URL('./db/'+f,import.meta.url),'utf8'));
  const accounts=await db.query("insert into linebot_private.accounts(username,display_name,password_salt,password_hash,status) values ('alice','Alice','s','h','active'),('bob','Bob','s','h','active') returning id,username");
  const alice=accounts.rows.find(x=>x.username==='alice').id,bob=accounts.rows.find(x=>x.username==='bob').id,key=randomBytes(32);
  const tokenVault=createCredentialVault(key,{context:'channel-access-token'}),recipientVault=createCredentialVault(key,{context:'line-recipient'});
  const bots=await db.query("insert into linebot_private.bot_credentials(account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled) values($1,$2,'A','{}'::jsonb,$3::jsonb,true),($4,$5,'B','{}'::jsonb,$6::jsonb,true) returning id,account_id",[alice,'U'+'a'.repeat(32),JSON.stringify(tokenVault.seal(alice,'token-a')),bob,'U'+'b'.repeat(32),JSON.stringify(tokenVault.seal(bob,'token-b'))]);
  const botA=bots.rows.find(x=>x.account_id===alice).id,botB=bots.rows.find(x=>x.account_id===bob).id;let calls=[];
  await db.exec('set role linebot_runtime');
  const n=createNotifications({db,key,recipientVault,tokenVault,fetchImpl:async(url,opts)=>{calls.push({url,opts});return new Response('{}',{status:200});}});
  assert.equal(await n.createPairing(bob,botA,'wrong'),null);
  const pairing=await n.createPairing(alice,botA,'測試對象');const user='U'+'f'.repeat(32);
  const event={type:'message',message:{type:'text',text:pairing.message},source:{type:'user',userId:user},timestamp:Date.now()};
  const expired=await n.createPairing(alice,botA,'過期');await db.query("update linebot_private.pairing_codes set expires_at=now()-interval '1 second' where label=$1",['過期']);
  await n.pair(alice,botA,[{...event,message:{type:'text',text:expired.message}}]);assert.equal((await n.list(alice)).length,0);
  await n.pair(alice,botB,[event]);assert.equal((await n.list(alice)).length,0);
  await n.pair(alice,botA,[event]);await n.pair(alice,botA,[event]);let list=await n.list(alice);assert.equal(list.length,1);assert.equal((await n.list(bob)).length,0);
  assert.equal(JSON.stringify((await db.query('select encrypted_line_id,line_hash from linebot_private.recipients')).rows).includes(user),false);
  assert.equal((await n.send(bob,{recipientId:list[0].id,message:'hello',requestId:randomUUID()})).error,'recipient');
  assert.equal(await n.disable(bob,list[0].id),false);
  const id=randomUUID(),body={recipientId:list[0].id,message:'hello',requestId:id};assert.equal((await n.send(alice,body)).status,'accepted');assert.equal((await n.send(alice,body)).status,'accepted');assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.line.me/v2/bot/message/push');assert.equal(calls[0].opts.headers['X-Line-Retry-Key'],id);assert.equal(JSON.parse(calls[0].opts.body).to,user);
  assert.equal(JSON.stringify((await n.history(alice))).includes('hello'),false);
  await n.pair(alice,botA,[{type:'unfollow',source:{type:'user',userId:user},timestamp:Date.now()+1000}]);assert.equal((await n.list(alice)).length,0);
 }finally{await db.close();}
});

test('timeouts are recorded as uncertain and never resent under the same request id',async()=>{
 const calls=[];const db={query:async(sql)=>{calls.push(sql);if(sql.includes('select r.bot_id'))return {rowCount:1,rows:[{bot_id:randomUUID(),encrypted_line_id:{},encrypted_access_token:{}}]};if(sql.includes('insert into linebot_private.notifications'))return {rowCount:1,rows:[{}]};return {rowCount:1,rows:[]};}};
 const n=createNotifications({db,key:randomBytes(32),recipientVault:{open:()=> 'U'+'a'.repeat(32)},tokenVault:{open:()=> 'token'},fetchImpl:async()=>{throw Error('timeout');}});
 assert.equal((await n.send(randomUUID(),{recipientId:randomUUID(),requestId:randomUUID(),message:'test'})).status,'unknown');assert.ok(calls.some(x=>x.includes('completed_at')));
});
