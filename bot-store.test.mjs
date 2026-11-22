import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { createHmac,randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createAccounts } from './accounts.mjs';
import { createCredentialVault,createWebhookHandler } from './line-webhook.mjs';
import { createBotStore } from './bot-store.mjs';

test('account-owned bot secret routes webhook to the correct account', async () => {
 const db=new PGlite();
 try {
  await db.exec("create role anon; create role authenticated; set linebot.isolated_test='yes';");
  await db.exec(await readFile(new URL('./db/005_independent_accounts.sql',import.meta.url),'utf8'));
  const accounts=createAccounts({db});
  for(const username of ['user_a','user_b']) await accounts.register({username,displayName:username,password:'a secure password'});
  await db.exec("update linebot_private.accounts set status='active'");
  const a=await accounts.me((await accounts.login({username:'user_a',password:'a secure password'})).token);
  const b=await accounts.me((await accounts.login({username:'user_b',password:'a secure password'})).token);
  const vault=createCredentialVault(randomBytes(32)), bots=createBotStore({db,vault,tokenVault:createCredentialVault(Buffer.alloc(32,1),{context:'channel-access-token'})});
  await bots.save(a.id,'secret-a','token-a',{userId:'U'+'a'.repeat(32),displayName:'Bot A'}); await bots.save(b.id,'secret-b','token-b',{userId:'U'+'b'.repeat(32),displayName:'Bot B'});
  const saved=(await db.query('select encrypted_secret from linebot_private.bot_credentials where account_id=$1',[a.id])).rows[0];
  assert.equal(JSON.stringify(saved).includes('secret-a'),false);
  const events=[]; const handle=createWebhookHandler({vault,findBot:bots.findByWebhook,handleEvents:async (owner,list)=>events.push({owner,list})});
  const body=Buffer.from(JSON.stringify({destination:'U'+'b'.repeat(32),events:[{type:'follow'}]}));
  const sig=(secret)=>createHmac('sha256',secret).update(body).digest('base64');
  assert.equal((await handle({webhookKey:a.webhook_key,rawBody:body,signature:sig('secret-b')})).status,401);
  assert.equal((await handle({webhookKey:b.webhook_key,rawBody:body,signature:sig('secret-b')})).status,200);
  assert.equal(events[0].owner,b.id);
  await bots.disable(b.id);
  assert.equal((await handle({webhookKey:b.webhook_key,rawBody:body,signature:sig('secret-b')})).status,404);
 } finally {await db.close();}
});
