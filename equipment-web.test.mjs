import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createEquipmentServer } from './equipment-web.mjs';

test('the hosted equipment site serves the workspace and emits one approval event per loan', async () => {
  const events = [];
  const publicOrigin = 'https://equipment-loan-test.wfhai.org';
  const server = createEquipmentServer({
    publicOrigin, onApproved: async event => events.push(event)
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const root = await fetch(origin);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /虛擬教具借用平台/);
    const health = await fetch(origin + '/health');
    assert.equal(await health.text(), 'ok');

    const get = cookie => fetch(origin + '/api/borrow', { headers: cookie ? { Cookie: cookie } : {} });
    const post = (path, data, cookie, source = publicOrigin) => fetch(origin + path, {
      method: 'POST',
      headers: { Origin: source, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const newSession = async () => {
      const response = await get();
      const cookie = response.headers.get('set-cookie');
      assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=14400; Secure/);
      const state = await response.json();
      assert.equal(state.standalone, true);
      assert.equal(state.equipment.length, 3);
      assert.equal(state.loans.length, 0);
      return cookie.split(';')[0];
    };
    const user = await newSession();
    const other = await newSession();
    const draft = { itemId: 'resuscitation-model', unit: '示範教學組', purpose: '測試借用' };
    assert.equal((await post('/api/borrow', draft, user, 'https://another.invalid')).status, 403);
    const created = await post('/api/borrow', draft, user);
    assert.equal(created.status, 201);
    const { loans } = await created.json();
    const loan = loans[0];
    assert.equal(loan.approvedAt, null);
    assert.equal(events.length, 0);
    assert.equal((await (await get(other)).json()).loans.length, 0);
    assert.equal((await post('/api/borrow/approve', { id: loan.id }, other)).status, 404);

    const approvals = await Promise.all([
      post('/api/borrow/approve', { id: loan.id }, user),
      post('/api/borrow/approve', { id: loan.id }, user)
    ]);
    assert.ok(approvals.every(response => response.status === 200));
    assert.ok((await (await get(user)).json()).loans[0].approvedAt);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, loan.id);
    assert.equal(events[0].event, 'loan.approved');
    assert.equal((await fetch(origin + '/independent-api/me')).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
