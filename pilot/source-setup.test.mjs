import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { startPilot } from './preview.mjs';

test('the loan source creates and approves virtual requests, sends once on the selected connection, and can be disconnected', async () => {
  const pilot = await startPilot({ port: 39263, sourcePort: 39264 });
  const { origin, sourceOrigin, supported, other, inbox } = pilot;
  const path = '/independent-api/source-setup';
  const platform = encodeURIComponent(supported.id);
  const setup = path + '?platform=' + platform;
  try {
    async function login(account = 'owner') {
      const response = await fetch(origin + path + '/preview?account=' + account, { redirect: 'manual' });
      assert.equal(response.status, 303);
      return response.headers.get('set-cookie').split(';')[0];
    }
    const owner = await login();
    const observer = await login('observer');
    const post = (host, path, data, headers) => fetch(host + path, {
      method: 'POST',
      headers: { Origin: host, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(data)
    });
    const readSetup = (url = setup, cookie = owner) => fetch(origin + url, { headers: { Cookie: cookie } });
    const portal = (data, cookie = owner, url = setup, headers = {}) =>
      post(origin, url, data, { Cookie: cookie, ...headers });
    const source = url => fetch(sourceOrigin + url).then(response => response.json());
    const borrower = () => source('/api/loan');
    const sendApproval = id => post(sourceOrigin, '/api/approve', { id });
    const approveVirtual = id => post(sourceOrigin, '/api/borrow/approve', { id });
    const virtual = () => source('/api/borrow');
    const createVirtual = async itemId => {
      const response = await post(sourceOrigin, '/api/borrow', { itemId, unit: '示範教學組', purpose: '借用流程驗收' });
      assert.equal(response.status, 201);
      const { loans, created } = await response.json();
      return loans.find(loan => loan.number === created);
    };
    const eventPath = '/independent-api/integrations?platform=' + platform;
    const loadEvents = async () => (await readSetup(eventPath)).json();
    const recipient = supported.targets[0];

    assert.equal((await fetch(origin + setup)).status, 401);
    assert.equal((await readSetup(path)).status, 404);
    assert.equal((await readSetup(setup, observer)).status, 404);
    assert.equal((await portal({ recipientId: recipient.id }, observer)).status, 404);
    assert.equal((await readSetup(path + '?platform=' + other.id)).status, 200);
    assert.equal((await (await readSetup(path + '?platform=' + other.id)).json()).source, null);
    const otherEvents = await readSetup('/independent-api/integrations?platform=' + other.id);
    assert.equal((await otherEvents.json()).guidedSetup, undefined);
    assert.equal((await portal({ recipientId: other.targets[0].id })).status, 422);
    assert.equal((await portal({ recipientId: recipient.id }, owner, setup, { Origin: sourceOrigin })).status, 403);
    assert.equal((await post(sourceOrigin, '/service/connect', {})).status, 401);
    assert.equal((await sendApproval((await borrower()).id)).status, 409);
    assert.equal((await post(sourceOrigin, '/api/borrow', { itemId: 'invalid', unit: '示範教學組' })).status, 422);
    const beforeConnection = await createVirtual('resuscitation-model');
    assert.equal(beforeConnection.approvedAt, null);
    const offline = await (await approveVirtual(beforeConnection.id)).json();
    assert.equal(offline.hubHref, origin + path + '/preview');
    assert.equal(offline.loans[0].notice, 'unconnected');
    assert.ok(offline.loans[0].approvedAt);
    assert.equal(inbox.size, 0);

    const prepared = await (await readSetup()).json();
    assert.equal(prepared.source.event, '借用核准');
    assert.equal(prepared.source.href, sourceOrigin + '/equipment');
    assert.deepEqual(new Set(prepared.recipients.map(item => item.id)), new Set(supported.targets.map(item => item.id)));
    assert.equal(prepared.connection, null);
    assert.deepEqual((await loadEvents()).integrations, []);
    assert.equal((await loadEvents()).guidedSetup, true);

    const approvals = await Promise.all([
      portal({ recipientId: recipient.id }), portal({ recipientId: recipient.id })
    ]);
    assert.ok(approvals.every(response => [200, 409].includes(response.status)));
    const response = approvals.find(item => item.status === 200);
    const linked = await response.json();
    assert.equal(linked.connection.state, 'connected');
    assert.equal(linked.connection.recipient, recipient.label);
    assert.equal(JSON.stringify(linked).includes('lbc_'), false);
    assert.equal((await loadEvents()).integrations.length, 1);
    assert.equal((await borrower()).connected, true);
    assert.equal((await (await readSetup()).json()).latest, null);
    assert.equal((await virtual()).loans.find(loan => loan.id === beforeConnection.id).notice, 'unconnected');

    const pending = await createVirtual('injection-arm');
    assert.equal(pending.approvedAt, null);
    assert.equal(inbox.size, 0);
    const attempts = await Promise.all([approveVirtual(pending.id), approveVirtual(pending.id)]);
    assert.ok(attempts.every(result => result.status === 200));
    let full;
    for (let attempt = 0; attempt < 36 && full?.notice !== 'accepted'; attempt++) {
      await wait(80);
      full = (await virtual()).loans.find(loan => loan.id === pending.id);
    }
    assert.equal(full.notice, 'accepted');
    assert.match(full.message, new RegExp(pending.number));
    assert.match(full.message, /靜脈注射訓練手臂/);
    const hit = (await (await readSetup()).json()).latest;
    assert.equal(inbox.get(hit.id).to, recipient.lineId);
    assert.equal(inbox.size, 1);

    async function verifyDelivery() {
      const loan = await borrower();
      const initial = await sendApproval(loan.id);
      assert.equal(initial.status, 200);
      const duplicate = await sendApproval(loan.id);
      assert.equal(duplicate.status, 200);
      let status;
      for (let attempt = 0; attempt < 36 && status !== 'accepted'; attempt++) {
        await wait(80);
        status = (await borrower()).status;
      }
      assert.equal(status, 'accepted');
      assert.match((await borrower()).message, new RegExp(loan.number));
      const latest = (await (await readSetup()).json()).latest;
      assert.equal(latest.status, 'accepted');
      assert.equal(inbox.get(latest.id).to, recipient.lineId);
    }

    await verifyDelivery();
    assert.equal(inbox.size, 2);
    assert.equal((await post(sourceOrigin, '/api/new-loan', {})).status, 200);
    await verifyDelivery();
    assert.equal(inbox.size, 3);

    const disconnected = await portal({}, owner, path + '/disconnect?platform=' + platform);
    assert.equal(disconnected.status, 200);
    assert.equal((await disconnected.json()).connection, null);
    assert.equal((await borrower()).connected, false);
    assert.equal((await loadEvents()).integrations[0].enabled, false);
    const afterDisconnect = await createVirtual('blood-pressure');
    assert.equal((await (await approveVirtual(afterDisconnect.id)).json()).loans[0].notice, 'unconnected');
    assert.equal(inbox.size, 3);

    const changed = supported.targets[1];
    const reconnected = await portal({ recipientId: changed.id });
    assert.equal(reconnected.status, 200);
    assert.equal((await reconnected.json()).connection.recipient, changed.label);
    assert.equal((await loadEvents()).integrations.length, 1);
  } finally {
    await pilot.close();
  }
});
