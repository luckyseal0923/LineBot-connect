import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createAccounts } from './accounts.mjs';
import { createCredentialVault } from './line-webhook.mjs';
import { createBotStore } from './bot-store.mjs';
import { createIndependentApi } from './independent-api.mjs';

test('independent HTTP signup, login, owner-only webhook and bot setup', async () => {
 const db=new PGlite(); let server;
 try {
  await db.exec("create role anon; create role authenticated; set linebot.isolated_test='yes';");
  await db.exec(await readFile(new URL('./db/005_independent_accounts.sql',import.meta.url),'utf8'));
  const accounts=createAccounts({db}),vault=createCredentialVault(randomBytes(32)),bots=createBotStore({db,vault,tokenVault:createCredentialVault(Buffer.alloc(32,1),{context:'channel-access-token'})});
  const api=createIndependentApi({accounts,bots,allow:async()=>true,lookupBot:async token=>({userId:'U'+(token==='token-b'?'b':'a').repeat(32),displayName:'test bot'}),publicOrigin:'http://127.0.0.1:39179'});
  server=createServer(async(req,res)=>{if(!await api(req,res)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(39179,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:39179';
  const post=(path,data,cookie,source=origin)=>fetch(origin+path,{method:'POST',headers:{Origin:source,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)});
  assert.equal((await post('/independent-api/register',{username:'user_a',displayName:'A',password:'a secure password'})).status,201);
  assert.equal((await post('/independent-api/register',{username:'user_b',displayName:'B',password:'a secure password'})).status,201);
  assert.equal((await post('/independent-api/login',{username:'user_a',password:'a secure password'},null,'https://other.example')).status,403);
  await db.exec("update linebot_private.accounts set status='active'");
  const login=await post('/independent-api/login',{username:'user_a',password:'a secure password'});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const me=await (await fetch(origin+'/independent-api/me',{headers:{Cookie:cookie}})).json();
  assert.equal(me.username,'user_a');assert.match(me.webhookUrl,/\/webhooks\/line\/[0-9a-f-]{36}$/);
  assert.equal((await post('/independent-api/bot',{channelSecret:'secret-a',accessToken:'token-a'},cookie)).status,200);
  assert.equal((await bots.findByWebhook(me.webhookUrl.split('/').pop())).userId,(await accounts.me(cookie.split('=')[1])).id);
  assert.equal((await post('/independent-api/bot',{channelSecret:'x'})).status,401);
  await post('/independent-api/logout',{},cookie);
  assert.equal((await fetch(origin+'/independent-api/me',{headers:{Cookie:cookie}})).status,401);
 } finally { if(server) await new Promise(resolve=>server.close(resolve));await db.close(); }
});
