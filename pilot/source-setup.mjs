import { randomUUID } from 'node:crypto';
import { externalIdPattern } from '../external-integrations.mjs';
import { json, privateHeaders, readJson } from './http.mjs';

const route = '/independent-api/source-setup';

export function createSourceSetup({ accounts, platforms, notifications, integrations, db, allow, origin, source, demoSession }) {
  const connections = new Map();
  const inProgress = new Set();
  const host = new URL(origin).host;
  const sourceDetails = { name: source.name, event: source.event, href: source.origin + '/' };

  async function sourceRequest(path, data) {
    const response = await fetch(new URL(path, source.origin), {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + source.secret, ...(data && { 'Content-Type': 'application/json' }) },
      body: data && JSON.stringify(data),
      redirect: 'error',
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) throw new Error('Source request failed');
    return response.json();
  }

  async function latestNotification(accountId, platform, connection) {
    if (connection.state !== 'connected') return null;
    let latest;
    try {
      latest = await sourceRequest('/service/latest/' + connection.id);
    } catch {
      return null;
    }
    if (!externalIdPattern.test(latest.messageId || '')) return null;
    const { rows } = await db.query(`select n.status,n.id from linebot_private.notifications n
      join linebot_private.integration_jobs j on j.notification_id=n.id
      where n.id=$1 and n.account_id=$2 and n.bot_id=$3 and j.integration_id=$4`,
      [latest.messageId, accountId, platform.botId, connection.integrationId]);
    return rows[0] || null;
  }

  async function describe(user, platform) {
    const record = connections.get(platform.id);
    const recipients = await notifications.list(user.id, platform.botId);
    let connection = null;
    if (record && record.state !== 'disconnected') {
      const routes = await integrations.list(user.id, platform.botId);
      const integration = routes.find(item => item.id === record.integrationId);
      const ready = integration?.targetReady && integration.enabled && integration.keyTail === record.keyTail;
      connection = {
        state: ready ? record.state : 'interrupted',
        recipientId: integration?.recipientId || record.recipientId,
        recipient: integration?.recipientLabel || record.recipientLabel
      };
    }
    return {
      source: sourceDetails,
      recipients: recipients.map(item => ({ id: item.id, label: item.label })),
      connection,
      latest: connection?.state === 'connected' ? await latestNotification(user.id, platform, record) : null
    };
  }

  async function connect(user, platform, recipient) {
    let record = connections.get(platform.id);
    if (record && record.state !== 'disconnected' && record.recipientId !== recipient.id) {
      return { status: 409, error: '請先斷開原本的連接，再選擇新的收件者。' };
    }
    if (record?.state === 'connected') {
      return { status: 200 };
    }
    if (!record || record.state === 'disconnected') {
      let issued;
      if (record) {
        const update = await integrations.edit(user.id, record.integrationId, {
          recipientId: recipient.id, name: source.event
        });
        if (update.error) return { status: 422, error: '收件者目前無法使用，請重新選擇。' };
        issued = await integrations.manage(user.id, record.integrationId, 'rotate');
        if (!issued.error && (await integrations.manage(user.id, record.integrationId, 'enable')).error) {
          await integrations.manage(user.id, record.integrationId, 'revoke');
          return { status: 422, error: '事件目前無法啟用，請確認 Bot 與收件者的狀態。' };
        }
      } else {
        issued = await integrations.create(user.id, { recipientId: recipient.id, name: source.event });
      }
      if (issued.error) return { status: 422, error: '目前無法連接，請確認 Bot 已啟用且收件者仍已配對。' };
      record = {
        id: randomUUID(),
        integrationId: issued.id,
        state: 'pending',
        recipientId: recipient.id,
        recipientLabel: recipient.label,
        keyTail: issued.apiKey.slice(-6),
        apiKey: issued.apiKey
      };
      connections.set(platform.id, record);
    }
    try {
      await sourceRequest('/service/connect', { id: record.id, key: record.apiKey });
    } catch {
      return { status: 502, error: '教具借用平台暫時無法確認連接。按「重試連接」即可繼續。' };
    }
    record.state = 'connected';
    delete record.apiKey;
    return { status: 200 };
  }

  async function handle(req, res) {
    if (req.headers.host !== host) return json(res, 403, { error: '來源不正確。' });
    const url = new URL(req.url, origin);
    if (url.pathname === route + '/preview' && req.method === 'GET') {
      const session = await demoSession(url.searchParams.get('account'));
      res.writeHead(303, {
        ...privateHeaders,
        'Set-Cookie': `linebot_sid=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`,
        Location: `/#connect?platform=${session.platformId}`
      });
      return res.end();
    }
    if (req.method === 'POST' && req.headers.origin !== origin) return json(res, 403, { error: '來源不正確。' });

    const token = /(?:^|;\s*)linebot_sid=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const user = await accounts.me(token);
    if (!user) return json(res, 401, { error: '請先登入。' });
    if (user.status !== 'active') return json(res, 403, { error: '帳號尚未核准。' });
    const platform = (await platforms.list(user.id)).find(item => item.id === url.searchParams.get('platform'));
    if (!platform) return json(res, 404, { error: '找不到可操作的平台。' });
    const supported = platform.id === source.platformId && platform.botId;
    if (req.method === 'GET' && url.pathname === route) {
      return json(res, 200, supported ? await describe(user, platform) : { source: null });
    }
    if (req.method !== 'POST' || ![route, route + '/disconnect'].includes(url.pathname)) {
      return json(res, 404, { error: '找不到操作。' });
    }
    if (!supported) return json(res, 404, { error: '這個平台目前沒有可用的試辦來源。' });
    if (inProgress.has(platform.id)) return json(res, 409, { error: '正在處理連接，請稍候重新查詢。' });
    inProgress.add(platform.id);
    try {
      if (!await allow('integration-manage') || !await allow('integration-manage:' + user.id)) {
        return json(res, 429, { error: '操作過於頻繁，請稍後再試。' });
      }
      if (url.pathname.endsWith('/disconnect')) {
        const record = connections.get(platform.id);
        if (record && record.state !== 'disconnected') {
          const revoked = await integrations.manage(user.id, record.integrationId, 'revoke');
          if (revoked.error) return json(res, 409, { error: '暫時無法斷開，請稍候重試。' });
          record.state = 'disconnected';
          delete record.apiKey;
          try { await sourceRequest('/service/disconnect', { id: record.id }); }
          catch { /* The integration key is already invalid at the station. */ }
        }
        return json(res, 200, await describe(user, platform));
      }
      const data = await readJson(req);
      const recipients = await notifications.list(user.id, platform.botId);
      const recipient = recipients.find(item => item.id === data?.recipientId);
      if (!recipient) return json(res, 422, { error: '請選擇這個平台的收件者。' });
      const result = await connect(user, platform, recipient);
      const status = await describe(user, platform);
      return json(res, result.status, { ...status, ...(result.error && { error: result.error }) });
    } finally {
      inProgress.delete(platform.id);
    }
  }

  return { handle, platformId: source.platformId };
}
