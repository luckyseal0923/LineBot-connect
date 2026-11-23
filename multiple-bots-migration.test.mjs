import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { createCredentialVault } from './line-webhook.mjs';
import { createBotStore } from './bot-store.mjs';

test('migration keeps existing bot webhook and encrypted credentials',async()=>{
 const db=new PGlite();
 try {
  await db.exec("create role anon; create role authenticated; set linebot.isolated_test='yes';");
  await db.exec(await readFile(new URL('./db/005_independent_accounts.sql',import.meta.url),'utf8'));
  await db.exec(`insert into linebot_private.accounts(username,display_name,password_salt,password_hash,status) values ('legacy','Legacy','salt','hash','active');
   insert into linebot_private.bot_credentials(account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled)
   select id,'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Old Bot','{"value":"old"}'::jsonb,'{"value":"token"}'::jsonb,true from linebot_private.accounts where username='legacy';`);
  const old=(await db.query("select webhook_key from linebot_private.accounts where username='legacy'")).rows[0].webhook_key;
  await db.exec(await readFile(new URL('./db/011_multiple_bots.sql',import.meta.url),'utf8'));
  const row=(await db.query('select webhook_key,encrypted_secret,enabled from linebot_private.bot_credentials')).rows[0];
  assert.equal(row.webhook_key,old);assert.deepEqual(row.encrypted_secret,{value:'old'});assert.equal(row.enabled,true);
 } finally {await db.close();}
});

test('restricted runtime can add and isolate multiple bots after migration',async()=>{
 const db=new PGlite();
 try {
  await db.exec("create role anon; create role authenticated; create role linebot_runtime; set linebot.isolated_test='yes';");
  for(const name of ['005_independent_accounts.sql','006_runtime_grants.sql','011_multiple_bots.sql'])await db.exec(await readFile(new URL('./db/'+name,import.meta.url),'utf8'));
  const owner=(await db.query("insert into linebot_private.accounts(username,display_name,password_salt,password_hash,status) values('owner','Owner','salt','hash','active') returning id")).rows[0].id;
  const other=(await db.query("insert into linebot_private.accounts(username,display_name,password_salt,password_hash,status) values('other','Other','salt','hash','active') returning id")).rows[0].id;
  await db.exec('set role linebot_runtime');
  const key=randomBytes(32),bots=createBotStore({db,vault:createCredentialVault(key),tokenVault:createCredentialVault(key,{context:'channel-access-token'})});
  assert.equal(await bots.save(owner,'secret-one','token-one',{userId:'U'+'1'.repeat(32),displayName:'one'}),true);
  assert.equal(await bots.save(owner,'secret-two','token-two',{userId:'U'+'2'.repeat(32),displayName:'two'}),true);
  const items=await bots.list(owner);assert.equal(items.length,2);assert.notEqual(items[0].webhookKey,items[1].webhookKey);
  assert.equal(await bots.disable(other,items[0].id),false);
  assert.equal(await bots.save(other,'secret-one','token-one',{userId:'U'+'1'.repeat(32),displayName:'one'}),false);
  assert.equal((await bots.list(other)).length,0);
 } finally {await db.close();}
});
