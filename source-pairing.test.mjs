import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { startPilot } from './pilot/preview.mjs';

test('production guided pairing hands one scoped credential to the source and reports the send result', async () => {
  let now = Date.now();
  const pilot = await startPilot({ port: 39303, sourcePort: 39304, productionPairing: true, pairingClock: () => now });
  const { origin, supported, other, observerPlatform, inbox } = pilot;
  const portal = '/independent-api/source-setup';
  const source = '/api/v1/source-pairings';
  const setup = portal + '?platform=' + supported.id;
  const updates = portal + '/approve?platform=' + supported.id;
  try {
    async function login(account) {
      const response = await fetch(origin + portal + '/preview?account=' + account, { redirect: 'manual' });
      assert.equal(response.status, 303);
      return response.headers.get('set-cookie').split(';')[0];
    }
    const post = (path, data, headers) => fetch(origin + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(data)
    });
    const owner = await login('owner');
    const observer = await login('observer');
    const headers = { Origin: origin, Cookie: owner };
    const get = (path, cookie = owner) => fetch(origin + path, { headers: { Cookie: cookie } });
    const recipient = supported.targets[0];
    const integrationsPath = '/independent-api/integrations?platform=' + supported.id;
    const list = async () => (await (await get(integrationsPath)).json()).integrations;
    const assertNoSecret = value => assert.doesNotMatch(JSON.stringify(value), /lbc_[A-Za-z0-9_-]+|deviceToken/);

    const guide = await fetch(origin + '/connection-guide');
    assert.equal(guide.status, 200);
    assert.match(await guide.text(), /\/api\/v1\/source-pairings\/claim/);
    assert.equal((await fetch(origin + setup)).status, 401);
    assert.equal((await get(portal)).status, 404);
    const initial = await (await get(setup)).json();
    assert.equal(initial.mode, 'source-pairing');
    assert.ok(initial.recipients.some(item => item.id === recipient.id));
    assert.equal((await (await get(integrationsPath)).json()).guidedSetup, true);

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const begin = await post(source, { sourceName: '教具借用平台', eventName: '借用核准', challenge });
    assert.equal(begin.status, 201);
    const { deviceToken, pairingCode, pollInterval, expiresIn } = await begin.json();
    assert.equal(pollInterval, 5);
    assert.equal(expiresIn, 600);
    const pairQuery = setup + '&code=' + pairingCode;
    const input = { code: pairingCode, recipientId: recipient.id };
    const claim = value => post(source + '/claim', { deviceToken, verifier: value });
    assert.equal((await claim(randomBytes(32).toString('base64url'))).status, 401);
    assert.equal((await claim(verifier)).status, 202);
    assert.equal((await claim(verifier)).status, 429);
    const before = await (await get(pairQuery)).json();
    assert.equal(before.pairing.name, '教具借用平台');
    assert.equal(before.pairing.event, '借用核准');
    assert.equal(before.pairing.connection, null);
    assertNoSecret(before);

    assert.equal((await post(updates, input, { Origin: origin, Cookie: observer })).status, 404);
    assert.equal((await post(updates, input, { ...headers, Origin: 'https://example.invalid' })).status, 403);
    assert.equal((await post(updates, { ...input, recipientId: other.targets[0].id }, headers)).status, 422);
    const ok = await post(updates, input, headers);
    assert.equal(ok.status, 200);
    const approved = await ok.json();
    assert.equal(approved.pairing.connection.state, 'approved');
    assert.equal(approved.pairing.connection.recipient, recipient.label);
    assertNoSecret(approved);
    assert.equal((await get(portal + '?platform=' + other.id + '&code=' + pairingCode)).status, 404);
    assert.equal((await get(portal + '?platform=' + observerPlatform.id + '&code=' + pairingCode, observer)).status, 404);
    assert.equal((await list()).length, 0);

    now += 5001;
    const connected = await claim(verifier);
    assert.equal(connected.status, 200);
    const binding = await connected.json();
    assert.match(binding.apiKey, /^lbc_[A-Za-z0-9_-]{43}$/);
    assert.equal(binding.endpoint, origin + '/api/v1/send');
    assert.equal((await list())[0].id, binding.integrationId);
    assert.equal((await list()).length, 1);
    now += 5001;
    assert.deepEqual(await (await claim(verifier)).json(), binding);
    assert.equal((await list()).length, 1);
    const after = await (await get(pairQuery)).json();
    assertNoSecret(after);
    assert.equal(after.pairing.connection.state, 'connected');
    assert.equal(after.pairing.latest, null);

    const sent = await post('/api/v1/send', { message: '試辦借用已核准' },
      { Authorization: 'Bearer ' + binding.apiKey, 'Idempotency-Key': 'launch-test-loan-1' });
    assert.equal(sent.status, 202);
    const { messageId } = await sent.json();
    let latest;
    for (let attempt = 0; attempt < 36 && latest?.status !== 'accepted'; attempt++) {
      await wait(80);
      latest = (await (await get(pairQuery)).json()).pairing.latest;
    }
    assert.equal(latest?.status, 'accepted');
    assert.equal(latest.id, messageId);
    assert.equal(inbox.get(messageId).to, recipient.lineId);

    const revokePath = '/independent-api/integrations/' + binding.integrationId + '/revoke?platform=' + supported.id;
    assert.equal((await post(revokePath, {}, headers)).status, 200);
    assert.equal((await (await get(pairQuery)).json()).pairing.connection.state, 'interrupted');
    now += 5001;
    assert.equal((await claim(verifier)).status, 409);
    now += 600001;
    assert.equal((await claim(verifier)).status, 410);
    assert.equal((await get(pairQuery)).status, 404);
  } finally {
    await pilot.close();
  }
});
