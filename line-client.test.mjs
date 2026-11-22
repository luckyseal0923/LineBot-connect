import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createLineBotLookup } from './line-client.mjs';
test('LINE bot info uses the official endpoint and rejects bad responses',async()=>{
 let called;
 const lookup=createLineBotLookup({fetchImpl:async (url,options)=>{called={url,options};return {ok:true,json:async()=>({userId:'U'+'a'.repeat(32),displayName:'Test Bot'})};}});
 assert.equal((await lookup('test-token')).displayName,'Test Bot');
 assert.equal(called.url,'https://api.line.me/v2/bot/info');assert.equal(called.options.redirect,'error');
 assert.equal(await lookup('invalid\ntoken'),null);
 const bad=createLineBotLookup({fetchImpl:async()=>({ok:true,json:async()=>({userId:'invalid',displayName:'Test'})})});
 assert.equal(await bad('test-token'),null);
});
