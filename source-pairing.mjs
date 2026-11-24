import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { externalIdPattern } from './external-integrations.mjs';
import { json, readJson } from './pilot/http.mjs';

const portalPath = '/independent-api/source-setup';
const sourcePath = '/api/v1/source-pairings';
const proof = /^[A-Za-z0-9_-]{43}$/;
const codePattern = /^[0-9A-F]{16}$/;
const lifetime = 10 * 60 * 1000;
const pollInterval = 5;
const normalizeCode = value => typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';
const label = value => typeof value === 'string' ? value.trim() : '';

export function createSourcePairing({ origin: publicOrigin, key, accounts, platforms, notifications, integrations, db, allow, clock = Date.now }) {
  const origin = new URL(publicOrigin).origin;
  const records = new Map();
  const sign = (context, text) => createHmac('sha256', key).update(context + ':' + text).digest('base64url');

  function expire() {
    const now = clock();
    for (const [code, record] of records) if (record.expires <= now) records.delete(code);
  }

  function decode(deviceToken, verifier) {
    if (typeof deviceToken !== 'string' || deviceToken.length > 180 || typeof verifier !== 'string' || !proof.test(verifier)) return null;
    const [id, code, expires, challenge, signature, extra] = deviceToken.split('.');
    if (extra !== undefined || !externalIdPattern.test(id) || !codePattern.test(code || '') ||
        !/^\d{13}$/.test(expires || '') || !proof.test(challenge || '') || !proof.test(signature || '')) return null;
    const expected = sign('source-pairing-grant-v1', [id, code, expires, challenge].join('.'));
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    if (createHash('sha256').update(verifier).digest('base64url') !== challenge) return null;
    return { id, code, expires: Number(expires), apiKey: 'lbc_' + sign('source-pairing-key-v1', id + ':' + verifier) };
  }

  async function begin(req, res) {
    if (!await allow('source-pairing-start')) return json(res, 429, { code: 'rate_limited', error: '目前連接請求較多，請稍後再試。' });
    const data = await readJson(req);
    const name = label(data?.sourceName);
    const event = label(data?.eventName);
    if (!name || name.length > 80 || !event || event.length > 80 || typeof data?.challenge !== 'string' || !proof.test(data.challenge)) {
      return json(res, 422, { code: 'invalid_request', error: '請提供來源名稱、事件名稱與有效的配對驗證碼。' });
    }
    expire();
    if (records.size >= 500) return json(res, 429, { code: 'rate_limited', error: '目前連接請求較多，請稍後再試。' });
    let code;
    do { code = randomBytes(8).toString('hex').toUpperCase(); } while (records.has(code));
    const id = randomUUID();
    const expires = clock() + lifetime;
    const signed = [id, code, expires, data.challenge].join('.');
    const deviceToken = signed + '.' + sign('source-pairing-grant-v1', signed);
    records.set(code, { id, name, event, expires });
    return json(res, 201, { pairingCode: code, deviceToken, expiresIn: lifetime / 1000, pollInterval });
  }

  async function claim(req, res) {
    if (!await allow('source-pairing-claim')) return json(res, 429, { code: 'rate_limited', error: '請稍後再查詢。' });
    const data = await readJson(req);
    const grant = decode(data?.deviceToken, data?.verifier);
    if (!grant) return json(res, 401, { code: 'invalid_device', error: '配對憑證無效。' });
    if (grant.expires <= clock()) return json(res, 410, { code: 'expired', error: '配對碼已過期，請重新開始。' });
    const record = records.get(grant.code);
    if (record && record.id !== grant.id) return json(res, 401, { code: 'invalid_device', error: '配對憑證無效。' });
    if (record && record.nextPoll > clock()) return json(res, 429, { code: 'slow_down', pollInterval });
    if (record) record.nextPoll = clock() + pollInterval * 1000;

    // A retry after a lost response can recover the same credential from the persisted integration.
    let access = await integrations.authenticate(grant.apiKey);
    if (access && access.id !== grant.id) return json(res, 409, { code: 'unavailable', error: '無法完成連接。' });
    if (!access) {
      if (!record) return json(res, 410, { code: 'expired', error: '此次配對已結束，請重新開始。' });
      if (!record.scope) return json(res, 202, { status: 'pending' });
      if (record.claimed) return json(res, 409, { code: 'disabled', error: '這次授權已失效，請重新配對。' });
      const { accountId, recipientId, botId } = record.scope;
      const result = await integrations.create(accountId, { name: record.event, recipientId }, {
        id: grant.id, apiKey: grant.apiKey, botId
      });
      if (!result.error) {
        access = { id: result.id, status: 'active', enabled: true };
      } else {
        access = await integrations.authenticate(grant.apiKey);
        if (!access) return json(res, 422, { code: 'target_unavailable', error: '請確認現有 LINE Bot 和收件者仍可用。' });
      }
    }
    if (access.id !== grant.id || access.status !== 'active' || !access.enabled) {
      return json(res, 409, { code: 'disabled', error: '這次授權目前無法使用。' });
    }
    if (record) {
      record.claimed = true;
      record.keyTail = grant.apiKey.slice(-6);
    }
    return json(res, 200, { status: 'connected', integrationId: grant.id, apiKey: grant.apiKey, endpoint: origin + '/api/v1/send' });
  }

  async function handleConnector(req, res, pathname) {
    if (req.method === 'POST' && pathname === sourcePath) return begin(req, res);
    if (req.method === 'POST' && pathname === sourcePath + '/claim') return claim(req, res);
    return json(res, 404, { code: 'not_found', error: '找不到配對操作。' });
  }

  async function describe(record, user, platform) {
    let connection = null;
    let latest = null;
    if (record.scope) {
      connection = {
        state: record.claimed ? 'connected' : 'approved',
        recipient: record.scope.recipient
      };
      if (record.claimed) {
        const routes = await integrations.list(user.id, platform.botId);
        const route = routes.find(entry => entry.id === record.id);
        if (!route?.enabled || !route.targetReady || route.keyTail !== record.keyTail) {
          connection.state = 'interrupted';
        } else {
          connection.recipient = route.recipientLabel;
          const { rows } = await db.query(`select n.status,n.id from linebot_private.notifications n
            join linebot_private.integration_jobs j on j.notification_id=n.id
            where j.integration_id=$1 and n.account_id=$2 and n.bot_id=$3
            order by n.created_at desc limit 1`, [record.id, user.id, platform.botId]);
          latest = rows[0] || null;
        }
      }
    }
    return { name: record.name, event: record.event, connection, latest };
  }

  async function handle(req, res) {
    const url = new URL(req.url, origin);
    if (!['GET', 'POST'].includes(req.method) || ![portalPath, portalPath + '/approve'].includes(url.pathname)) {
      return json(res, 404, { error: '找不到配對操作。' });
    }
    if (req.method === 'POST' && req.headers.origin !== origin) return json(res, 403, { error: '來源不正確。' });
    const session = /(?:^|;\s*)linebot_sid=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const user = await accounts.me(session);
    if (!user) return json(res, 401, { error: '請先登入。' });
    if (user.status !== 'active') return json(res, 403, { error: '帳號尚未核准。' });
    const platformId = url.searchParams.get('platform');
    const platform = platformId && (await platforms.list(user.id)).find(entry => entry.id === platformId);
    if (!platform) return json(res, 404, { error: '找不到可操作的平台。' });
    const recipients = (platform.botId ? await notifications.list(user.id, platform.botId) : [])
      .map(item => ({ id: item.id, label: item.label }));
    const info = { mode: 'source-pairing', recipients };

    if (req.method === 'GET' && url.pathname === portalPath && !url.searchParams.has('code')) return json(res, 200, info);
    if (url.pathname !== (req.method === 'POST' ? portalPath + '/approve' : portalPath)) {
      return json(res, 404, { error: '找不到配對操作。' });
    }
    const data = req.method === 'POST' ? await readJson(req) : null;
    const code = normalizeCode(data?.code || url.searchParams.get('code'));
    if (!codePattern.test(code)) return json(res, 422, { error: '請輸入來源平台顯示的配對碼。' });
    const record = records.get(code);
    if (!record || record.expires <= clock() || record.scope &&
        (record.scope.accountId !== user.id || record.scope.platformId !== platform.id)) {
      return json(res, 404, { error: '找不到可用的配對碼，請回來源平台重新確認。' });
    }
    if (req.method === 'POST') {
      if (!await allow('integration-manage') || !await allow('integration-manage:' + user.id)) {
        return json(res, 429, { error: '操作過於頻繁，請稍後再試。' });
      }
      const recipient = recipients.find(item => item.id === data?.recipientId);
      if (!recipient) return json(res, 422, { error: '請選擇這個平台的收件者。' });
      // Rate-limit queries yield; check again before recording the first decision.
      if (record.expires <= clock() || record.scope && (record.scope.accountId !== user.id ||
          record.scope.platformId !== platform.id || record.scope.recipientId !== recipient.id)) {
        return json(res, 409, { error: '這個配對碼已有授權，請回來源平台確認。' });
      }
      record.scope ??= {
        accountId: user.id, platformId: platform.id, botId: platform.botId, recipientId: recipient.id, recipient: recipient.label
      };
    }
    return json(res, 200, { ...info, pairing: { ...(await describe(record, user, platform)), code } });
  }
  return { handle, handleConnector, forAllPlatforms: true };
}
