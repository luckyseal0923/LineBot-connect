import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createLinebotServer } from './app-server.mjs';
import { createExternalIntegrations, hasExternalIntegrationSchema } from './external-integrations.mjs';
import { createCredentialVault } from './line-webhook.mjs';
import { createNotifications } from './notifications.mjs';
import { createRequestLimiter } from './request-limiter.mjs';

test('isolated HTTP integration flow enforces ownership, persists and deduplicates delivery, and revokes keys', async () => {
  const db = new PGlite();
  let server;
  try {
    await db.exec(`create role anon; create role authenticated; create role linebot_runtime;
      create role linebot_reviewer; create role linebot_admin_auth; create role linebot_enroller;
      create schema other_platform; create table other_platform.records (value text);
      insert into other_platform.records values ('unchanged'); set linebot.isolated_test='yes';`);
    for (const file of ['005_independent_accounts.sql', '006_runtime_grants.sql', '007_review_retention.sql',
      '011_multiple_bots.sql', '012_notifications.sql', '013_admin_monitoring.sql', '014_line_quota.sql']) {
      await db.exec(await readFile(new URL('./db/' + file, import.meta.url), 'utf8'));
    }
    assert.equal(await hasExternalIntegrationSchema(db), false);
    await db.exec(await readFile(new URL('./db/015_external_integrations.sql', import.meta.url), 'utf8'));
    assert.equal(await hasExternalIntegrationSchema(db), true);
    assert.equal((await db.query('select value from other_platform.records')).rows[0].value, 'unchanged');

    for (const role of ['anon', 'authenticated', 'linebot_admin_auth', 'linebot_reviewer', 'linebot_enroller']) {
      const { rows } = await db.query(`select
        has_table_privilege($1,'linebot_private.integrations','SELECT,INSERT,UPDATE,DELETE') as integrations,
        has_table_privilege($1,'linebot_private.integration_jobs','SELECT,INSERT,UPDATE,DELETE') as jobs`, [role]);
      assert.deepEqual(rows, [{ integrations: false, jobs: false }]);
    }

    const key = randomBytes(32);
    const vault = createCredentialVault(key);
    const messageVault = createCredentialVault(key, { context: 'integration-message', maxBytes: 8000 });
    const recipientVault = createCredentialVault(key, { context: 'line-recipient' });
    const tokenVault = createCredentialVault(key, { context: 'channel-access-token' });
    const allow = createRequestLimiter({ db });
    const users = new Map();
    for (const [name, letter] of [['alice', 'a'], ['bob', 'b']]) {
      const accountId = randomUUID();
      const botId = randomUUID();
      const recipientId = randomUUID();
      const lineId = 'U' + letter.repeat(32);
      users.set(letter.repeat(43), { id: accountId, status: 'active', botId, recipientId, lineId });
      await db.query(`insert into linebot_private.accounts(id,username,display_name,password_salt,password_hash,status)
        values($1,$2,$2,'test salt','test hash','active')`, [accountId, name]);
      await db.query(`insert into linebot_private.bot_credentials
        (id,account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled)
        values($1,$2,$3,$4,'{}',$5,true)`, [botId, accountId, lineId, name, JSON.stringify(tokenVault.seal(accountId, name + '-demo-token'))]);
      await db.query(`insert into linebot_private.recipients(id,account_id,bot_id,line_hash,encrypted_line_id,label)
        values($1,$2,$3,$4,$5,$4)`, [recipientId, accountId, botId, name, JSON.stringify(recipientVault.seal(accountId, lineId))]);
    }
    const alice = users.get('a'.repeat(43));
    const bob = users.get('b'.repeat(43));
    users.set('p'.repeat(43), { id: randomUUID(), status: 'pending' });

    const sent = [];
    const lineReplies = [
      () => { throw new Error('simulated timeout'); },
      () => new Response(JSON.stringify({ sentMessages: [{ id: '654321' }] }), {
        status: 409, headers: { 'x-line-accepted-request-id': 'test-accepted' }
      })
    ];
    const fetchImpl = async (url, options) => {
      sent.push({ url, options });
      return lineReplies.shift()?.() ?? new Response('{}', { status: 200 });
    };
    await db.exec('set role linebot_runtime');
    await assert.rejects(db.query('select value from other_platform.records'), { code: '42501' });
    const integrations = createExternalIntegrations({ db, key, messageVault, recipientVault, tokenVault, allow, fetchImpl });
    const notifications = createNotifications({ db, key, recipientVault, tokenVault, fetchImpl, includeIntegrations: true });
    const origin = 'http://127.0.0.1:39186';
    server = createLinebotServer({
      accounts: { me: token => users.get(token) }, bots: { findByWebhook: async () => null },
      vault, eventStore: async () => {}, allow, lookupBot: async () => null, publicOrigin: origin, notifications, integrations
    });
    await new Promise((resolve, reject) => server.listen(39186, '127.0.0.1', resolve).once('error', reject));
    const adminPath = '/independent-api/integrations';
    const portal = (account, path = adminPath, data, source = origin) => fetch(origin + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Cookie: 'linebot_sid=' + account.repeat(43), Origin: source, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    const create = (account, recipientId, name) => portal(account, adminPath, { recipientId, name });
    const post = (apiKey, eventKey, body) => fetch(origin + '/api/v1/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': eventKey },
      body: JSON.stringify(body)
    });
    const lookup = (apiKey, messageId) => fetch(origin + '/api/v1/messages/' + messageId, {
      headers: { Authorization: 'Bearer ' + apiKey }
    });

    assert.equal((await portal('x')).status, 401);
    assert.equal((await portal('p')).status, 403);
    assert.equal((await portal('a', adminPath, {}, 'https://other.invalid')).status, 403);
    assert.equal((await create('a', bob.recipientId, '錯誤收件人')).status, 422);
    const created = await create('a', alice.recipientId, '課程報名');
    assert.equal(created.status, 201);
    const { id, apiKey } = await created.json();
    const other = await (await create('b', bob.recipientId, '測試系統')).json();
    const listed = await (await portal('a')).json();
    assert.equal(listed.endpoint, origin + '/api/v1/send');
    assert.equal(listed.integrations.length, 1);
    assert.equal(listed.integrations[0].keyTail, apiKey.slice(-6));
    assert.equal(JSON.stringify(listed).includes(apiKey), false);
    assert.equal((await portal('b', `${adminPath}/${id}/rotate`, {})).status, 404);
    assert.equal((await post('wrong', 'order-1042', { message: 'test' })).status, 401);
    assert.equal((await post(apiKey, '', { message: 'test' })).status, 400);
    assert.equal((await post(apiKey, 'order-1042', { recipientId: bob.recipientId, message: 'test' })).status, 400);
    assert.equal((await post(apiKey, 'too-large', { message: 'x'.repeat(17000) })).status, 413);

    const payload = { message: '測試訊息內容' };
    const pair = await Promise.all([post(apiKey, 'order-1042', payload), post(apiKey, 'order-1042', payload)]);
    assert.ok(pair.every(response => response.status === 202));
    const [first, duplicate] = await Promise.all(pair.map(response => response.json()));
    assert.equal(first.messageId, duplicate.messageId);
    assert.equal((await post(apiKey, 'order-1042', { message: 'changed' })).status, 409);
    assert.equal((await lookup(other.apiKey, first.messageId)).status, 404);
    const jobBefore = (await db.query('select * from linebot_private.integration_jobs')).rows;
    assert.equal(jobBefore.length, 1);
    for (const sensitive of [payload.message, apiKey, 'order-1042']) assert.equal(JSON.stringify(jobBefore).includes(sensitive), false);

    assert.equal(await integrations.runNext(), true);
    assert.equal(await integrations.runNext(), false);
    await db.query("update linebot_private.integration_jobs set next_attempt_at=now() where notification_id=$1", [first.messageId]);
    const claims = await Promise.all([integrations.runNext(), integrations.runNext()]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].url, 'https://api.line.me/v2/bot/message/push');
    assert.equal(sent[0].options.headers['X-Line-Retry-Key'], first.messageId);
    assert.equal(sent[1].options.headers['X-Line-Retry-Key'], first.messageId);
    assert.equal(sent[0].options.body, sent[1].options.body);
    assert.equal(JSON.parse(sent[0].options.body).to, alice.lineId);
    const receipt = await (await lookup(apiKey, first.messageId)).json();
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.lineMessageId, '654321');
    assert.equal(receipt.errorCode, null);
    assert.equal((await db.query('select encrypted_message from linebot_private.integration_jobs')).rows[0].encrypted_message, null);
    const history = await notifications.history(alice.id);
    assert.equal(history[0].integrationName, '課程報名');
    assert.deepEqual(await notifications.history(bob.id), []);
    assert.equal(JSON.stringify(history).includes(payload.message), false);

    const queued = await (await post(apiKey, 'order-1043', payload)).json();
    assert.equal((await portal('a', `${adminPath}/${id}/disable`, {})).status, 200);
    assert.equal((await post(apiKey, 'order-1044', payload)).status, 403);
    assert.equal((await portal('a', `${adminPath}/${id}/enable`, {})).status, 200);
    assert.equal(await integrations.runNext(), true);
    assert.equal((await (await lookup(apiKey, queued.messageId)).json()).status, 'cancelled');
    assert.equal(sent.length, 2);
    const queuedForBob = await (await post(other.apiKey, 'bob-event', payload)).json();
    assert.equal(await notifications.disable(bob.id, bob.recipientId), true);
    assert.equal(await integrations.runNext(), true);
    assert.equal((await (await lookup(other.apiKey, queuedForBob.messageId)).json()).status, 'cancelled');
    assert.equal((await post(other.apiKey, 'bob-next', payload)).status, 422);
    assert.equal(sent.length, 2);
    const rotated = await (await portal('a', `${adminPath}/${id}/rotate`, {})).json();
    assert.notEqual(rotated.apiKey, apiKey);
    assert.equal((await lookup(apiKey, first.messageId)).status, 401);
    assert.equal((await lookup(rotated.apiKey, first.messageId)).status, 200);
    assert.equal((await portal('a', `${adminPath}/${id}/revoke`, {})).status, 200);
    assert.equal((await lookup(rotated.apiKey, first.messageId)).status, 401);

    await db.exec('reset role; set role linebot_reviewer');
    assert.equal((await db.query("select integration_name from linebot_private.admin_notifications where username='alice' limit 1")).rows[0].integration_name, '課程報名');
    await assert.rejects(db.query('select key_hash from linebot_private.integrations'), { code: '42501' });
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await db.close();
  }
});
