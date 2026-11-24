import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createLineBotLookup, createLineWebhookCheck } from './line-client.mjs';
test('LINE bot info uses the official endpoint and rejects bad responses',async()=>{
 let called;
 const lookup=createLineBotLookup({fetchImpl:async (url,options)=>{called={url,options};return {ok:true,json:async()=>({userId:'U'+'a'.repeat(32),displayName:'Test Bot'})};}});
 assert.equal((await lookup('test-token')).displayName,'Test Bot');
 assert.equal(called.url,'https://api.line.me/v2/bot/info');assert.equal(called.options.redirect,'error');
 assert.equal(await lookup('invalid\ntoken'),null);
 const bad=createLineBotLookup({fetchImpl:async()=>({ok:true,json:async()=>({userId:'invalid',displayName:'Test'})})});
 assert.equal(await bad('test-token'),null);
});

test('LINE verification tests only the stored webhook URL and reports the actual LINE response', async () => {
  const expected = 'https://linebot.example/webhooks/line/opaque-id';
  let endpoint = 'https://another.example/callback';
  let active = false;
  let success = true;
  const calls = [];
  const check = createLineWebhookCheck({ fetchImpl: async (url, options) => {
    calls.push([url, options]);
    return Response.json(url.endsWith('/endpoint') ? { endpoint, active } : { success });
  } });
  assert.equal(await check('demo-only-token', expected), 'url_mismatch');
  assert.equal(calls.length, 1);
  endpoint = expected;
  assert.equal(await check('demo-only-token', expected), 'verified_inactive');
  assert.equal(calls[2][0], 'https://api.line.me/v2/bot/channel/webhook/test');
  assert.equal(calls[2][1].redirect, 'error');
  assert.deepEqual(JSON.parse(calls[2][1].body), { endpoint: expected });
  active = true;
  assert.equal(await check('demo-only-token', expected), 'verified');
  success = false;
  assert.equal(await check('demo-only-token', expected), 'failed');
});
