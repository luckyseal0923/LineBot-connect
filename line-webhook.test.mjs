import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createCredentialVault, verifyLineSignature, createWebhookHandler } from './line-webhook.mjs';

const ownerA = '00000000-0000-0000-0000-000000000001';
const ownerB = '00000000-0000-0000-0000-000000000002';
const sign = (body, secret) => createHmac('sha256', secret).update(body).digest('base64');

test('credential encryption is random and bound to the owning account', () => {
  const vault = createCredentialVault(randomBytes(32));
  const first = vault.seal(ownerA, 'private secret');
  const second = vault.seal(ownerA, 'private secret');
  assert.notEqual(first.iv, second.iv);
  assert.equal(vault.open(ownerA, first), 'private secret');
  assert.throws(() => vault.open(ownerB, first));
  assert.throws(() => createCredentialVault(randomBytes(32)).open(ownerA, first));
  assert.throws(() => vault.open(ownerA, { ...first, tag: Buffer.alloc(16).toString('base64') }));
});

test('LINE signatures verify original request bytes and reject tampering', () => {
  const body = Buffer.from('{"events":[], "text":"測試"}');
  const signature = sign(body, 'channel-secret');
  assert.equal(verifyLineSignature(body, signature, 'channel-secret'), true);
  assert.equal(verifyLineSignature(Buffer.from('{"events":[],"text":"測試"}'), signature, 'channel-secret'), false);
  assert.equal(verifyLineSignature(body, signature, 'other-secret'), false);
  assert.equal(verifyLineSignature(body, 'broken', 'channel-secret'), false);
});

test('different bots use their own secrets and events are not silently discarded', async () => {
  const vault = createCredentialVault(randomBytes(32));
  const keyA = randomUUID(), keyB = randomUUID();
  const bots = new Map([[keyA, {userId: ownerA, enabled: true, encryptedSecret: vault.seal(ownerA, 'secret-a')}], [keyB, {userId: ownerB, enabled: true, encryptedSecret: vault.seal(ownerB, 'secret-b') }]]);
  const calls = [];
  const handle = createWebhookHandler({ vault, findBot: async key => bots.get(key), handleEvents: async (owner, events) => calls.push({ owner, events }) });
  const body = Buffer.from('{"events":[{"type":"follow"}]}');
  assert.equal((await handle({webhookKey:keyA, rawBody:body, signature:sign(body,'secret-b')})).status,401);
  assert.equal((await handle({webhookKey:keyB, rawBody:body, signature:sign(body,'secret-b')})).status,200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, ownerB);
  assert.equal((await handle({webhookKey:randomUUID(), rawBody:body, signature:sign(body,'secret-a')})).status,404);
  bots.get(keyB).enabled = false;
  assert.equal((await handle({webhookKey:keyB, rawBody:body, signature:sign(body,'secret-b')})).status,404);
  const notWired = createWebhookHandler({ vault, findBot: async () => bots.get(keyA) });
  assert.equal((await notWired({webhookKey:keyA, rawBody:body, signature:sign(body,'secret-a')})).status,503);
  const verify = Buffer.from('{"events":[]}');
  assert.equal((await notWired({webhookKey:keyA, rawBody:verify, signature:sign(verify,'secret-a')})).status,200);
  assert.equal((await notWired({webhookKey:keyA, rawBody:Buffer.alloc(1024*1024+1), signature:''})).status,413);
});
