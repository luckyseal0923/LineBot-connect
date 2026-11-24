import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, pair, message } from './source-notifications.mjs';
import { createEquipmentWorkspace } from './equipment-workspace.mjs';

test('only successful submissions create durable events; retry preserves payload and id', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'equip-test-'));
  try {
    writeFileSync(join(directory, 'connection.json'), JSON.stringify({ apiKey: 'secret', integrationId: 'route1' }));
    const calls = [];
    const fetcher = async (url, options) => { calls.push(options); if (calls.length === 1) throw Error('offline'); return new Response(JSON.stringify({messageId:'m1'}), { status: 202 }); };
    let source = createSource({ directory, fetcher });
    source.createSession('session', Date.now() + 100000);
    const workspace = createEquipmentWorkspace({ standalone:true, persist:(loans, submitted) => source.persist('session', loans, submitted) });
    assert.equal((await workspace.add({ itemId:'invalid', unit:'demo' }))[0], 422);
    assert.equal((await workspace.add({ itemId:'injection-arm', unit:'demo' }))[0], 201);
    await source.flush();
    source = createSource({ directory, fetcher });
    assert.equal(source.getSession('session').loans.length, 1);
    await source.flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
    assert.equal(calls[0].body, calls[1].body);
    assert.equal(JSON.parse(calls[0].body).message, message);
    assert.equal(JSON.parse(readFileSync(join(directory, 'source-state.json'))).jobs[0].status, 'submitted');
  } finally { rmSync(directory, { recursive:true, force:true }); }
});

test('pairing stores credential on backend and never outputs it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'equip-pair-'));
  let calls = 0; const logs = [];
  try {
    await pair({ directory, sleep: async () => {}, output: x => logs.push(x), fetcher: async (url, options) => {
      calls++;
      if (calls === 1) { assert.equal(JSON.parse(options.body).eventName, '送出借用申請'); return new Response(JSON.stringify({ pairingCode:'ABC', deviceToken:'device', expiresIn:600, pollInterval:5 }), { status:201 }); }
      return new Response(JSON.stringify({apiKey:'test-private-key', integrationId:'id', endpoint:'https://linebot-next.wfhai.org/api/v1/send'}));
    }});
    assert.equal(JSON.parse(readFileSync(join(directory, 'connection.json'))).apiKey, 'test-private-key');
    assert.ok(!logs.join(' ').includes('test-private-key'));
  } finally { rmSync(directory, { recursive:true, force:true }); }
});

test('the configured event webhook receives submissions with the event key and message', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'equip-webhook-'));
  const oldKey = process.env.EQUIPMENT_LINEBOT_API_KEY;
  const oldEndpoint = process.env.EQUIPMENT_LINEBOT_ENDPOINT;
  const endpoint = 'https://linebot-next.wfhai.org/api/v1/webhooks/6af8199e-0e63-4ff3-8248-2544af81150a';
  try {
    process.env.EQUIPMENT_LINEBOT_API_KEY = 'example-key';
    process.env.EQUIPMENT_LINEBOT_ENDPOINT = endpoint;
    const calls = [];
    const source = createSource({ directory, fetcher: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ messageId: 'message-1' }), { status: 202 });
    }});
    source.createSession('session', Date.now() + 100000);
    source.persist('session', [{ id: 'loan-1' }], { id: 'loan-1' });
    await source.flush();
    assert.equal(calls[0].url, endpoint);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer example-key');
    assert.equal(calls[0].options.headers['Idempotency-Key'], 'loan-submitted-loan-1');
    assert.equal(JSON.parse(calls[0].options.body).message, message);
  } finally {
    if (oldKey === undefined) delete process.env.EQUIPMENT_LINEBOT_API_KEY; else process.env.EQUIPMENT_LINEBOT_API_KEY = oldKey;
    if (oldEndpoint === undefined) delete process.env.EQUIPMENT_LINEBOT_ENDPOINT; else process.env.EQUIPMENT_LINEBOT_ENDPOINT = oldEndpoint;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a submitted loan and its notification survive server restart in the same session', async () => {
  const { createEquipmentServer } = await import('./equipment-web.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'equip-restart-'));
  let server;
  async function start() {
    const source = createSource({ directory });
    server = createEquipmentServer({ publicOrigin: 'http://127.0.0.1:39301', source });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + server.address().port;
  }
  try {
    writeFileSync(join(directory, 'connection.json'), JSON.stringify({ apiKey: 'secret', integrationId: 'route1' }));
    let base = await start();
    const first = await fetch(base + '/api/borrow');
    const cookie = first.headers.get('set-cookie').split(';')[0];
    const response = await fetch(base + '/api/borrow', {
      method: 'POST', headers: { Origin: 'http://127.0.0.1:39301', Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'injection-arm', unit: 'demo' })
    });
    assert.equal(response.status, 201);
    const loan = (await response.json()).loans[0];
    await new Promise(resolve => server.close(resolve));
    base = await start();
    const restored = await (await fetch(base + '/api/borrow', { headers: { Cookie: cookie } })).json();
    assert.equal(restored.loans[0].id, loan.id);
    const state = JSON.parse(readFileSync(join(directory, 'source-state.json')));
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].id, 'loan-submitted-' + loan.id);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
