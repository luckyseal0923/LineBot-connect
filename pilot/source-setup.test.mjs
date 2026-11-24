import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { startPilot } from './preview.mjs';

test('an approved source sends two loan events to its selected recipient and can be disconnected', async () => {
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

    const prepared = await (await readSetup()).json();
    assert.equal(prepared.source.event, '借用核准');
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
    assert.equal(inbox.size, 1);
    assert.equal((await post(sourceOrigin, '/api/new-loan', {})).status, 200);
    await verifyDelivery();
    assert.equal(inbox.size, 2);

    const disconnected = await portal({}, owner, path + '/disconnect?platform=' + platform);
    assert.equal(disconnected.status, 200);
    assert.equal((await disconnected.json()).connection, null);
    assert.equal((await borrower()).connected, false);
    assert.equal((await loadEvents()).integrations[0].enabled, false);

    const changed = supported.targets[1];
    const reconnected = await portal({ recipientId: changed.id });
    assert.equal(reconnected.status, 200);
    assert.equal((await reconnected.json()).connection.recipient, changed.label);
    assert.equal((await loadEvents()).integrations.length, 1);
  } finally {
    await pilot.close();
  }
});
