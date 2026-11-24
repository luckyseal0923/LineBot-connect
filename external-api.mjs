import { randomUUID } from 'node:crypto';
import { externalIdPattern, integrationKeyPattern, webhookTokenPattern } from './external-integrations.mjs';

const sendPath = '/api/v1/send';
const webhookPrefix = '/api/v1/webhooks/';
export const eventWebhookPath = (id, token) => webhookPrefix + id + (token ? '/' + token : '');
const statusPrefix = '/api/v1/messages/';
const maxBodyBytes = 16384;

const errors = {
  invalid: [400, '請提供有效的 Idempotency-Key，以及 1 至 2,000 字的 message。'],
  disabled: [403, '此串接或帳號已停用。'],
  event_conflict: [409, '同一個 Idempotency-Key 已用於不同的訊息內容。'],
  target_unavailable: [422, '請確認指定的 LINE Bot 已啟用，且收件人仍已配對。'],
  rate_limited: [429, '請稍候再試，重試時沿用同一個 Idempotency-Key。'],
  unsupported_media_type: [415, '請使用 application/json。'],
  payload_too_large: [413, '請求資料過大。']
};

function json(res, status, payload, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req, isPrivateWebhook) {
  const isJson = /^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '');
  if (!isPrivateWebhook && !isJson) {
    return { error: 'unsupported_media_type' };
  }
  if (Number(req.headers['content-length']) > maxBodyBytes) return { error: 'payload_too_large' };
  let size = 0;
  const parts = [];
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    size += part.length;
    if (size > maxBodyBytes) return { error: 'payload_too_large' };
    parts.push(part);
  }
  if (isPrivateWebhook && (!size || !isJson)) return {};
  try {
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid' };
    if (isPrivateWebhook) return { message: body.message, eventId: body.eventId };
    if (Object.keys(body).length !== 1 || typeof body.message !== 'string') return { error: 'invalid' };
    return body;
  } catch {
    return { error: 'invalid' };
  }
}

export function createExternalApi({ integrations, allow }) {
  return async function externalApi(req, res, path) {
    const messageId = path.startsWith(statusPrefix) ? path.slice(statusPrefix.length) : '';
    const parts = path.startsWith(webhookPrefix) ? path.slice(webhookPrefix.length).split('/') : [];
    const [eventId, webhookToken] = parts;
    const webhookId = eventId?.toLowerCase();
    const isEventWebhook = parts.length <= 2 && externalIdPattern.test(webhookId);
    const isPrivateWebhook = isEventWebhook && parts.length === 2;
    const method = path === sendPath || isEventWebhook ? 'POST' : externalIdPattern.test(messageId) ? 'GET' : null;
    if (!method) return json(res, 404, { code: 'not_found', error: '找不到功能。' });
    if (req.method !== method) {
      return json(res, 405, { code: 'method_not_allowed', error: '請使用指定的 HTTP 方法。' }, { Allow: method });
    }
    const unavailable = () => json(res, 503, { code: 'unavailable', error: '外部串接暫時無法使用。' });
    if (!integrations) return unavailable();

    const reject = code => {
      const [status, error] = isPrivateWebhook && code === 'invalid'
        ? [400, '請確認 JSON 格式、事件編號與 1 至 2,000 字的訊息。'] : errors[code];
      const headers = status === 429 ? { 'Retry-After': '60' } : status === 413 ? { Connection: 'close' } : {};
      return json(res, status, { code, error }, headers);
    };
    const unauthorized = () => isPrivateWebhook
      ? json(res, 401, { code: 'invalid_webhook', error: 'Webhook 網址無效，請在接線站重新複製網址。' })
      : json(res, 401, { code: 'invalid_key', error: '串接金鑰無效。' }, { 'WWW-Authenticate': 'Bearer' });
    try {
      const key = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1];
      const validCredential = isPrivateWebhook ? webhookTokenPattern.test(webhookToken) : integrationKeyPattern.test(key || '');
      if (!validCredential) return unauthorized();
      if (!await allow('external-api')) return reject('rate_limited');
      const access = isPrivateWebhook
        ? await integrations.authenticateWebhook(webhookId, webhookToken)
        : await integrations.authenticate(key);
      if (!access || (isEventWebhook && access.id !== webhookId)) return unauthorized();
      if (access.status !== 'active') return reject('disabled');

      if (method === 'GET') {
        const result = await integrations.status(access, messageId);
        return result ? json(res, 200, result) : json(res, 404, { code: 'not_found', error: '找不到此串接的傳訊紀錄。' });
      }
      if (!access.enabled) return reject('disabled');
      const body = await readBody(req, isPrivateWebhook);
      if (body.error) return reject(body.error);
      const eventKey = req.headers['idempotency-key'] ?? body.eventId ?? (isPrivateWebhook ? randomUUID() : undefined);
      const message = body.message ?? (isPrivateWebhook ? `「${access.eventName}」已觸發，請至數位平台查看。` : undefined);
      const result = await integrations.enqueue(access, eventKey, message);
      if (result.error) return reject(result.error);
      const location = statusPrefix + result.messageId;
      return json(res, ['queued', 'sending'].includes(result.status) ? 202 : 200, result, { Location: location });
    } catch {
      return unavailable();
    }
  };
}
