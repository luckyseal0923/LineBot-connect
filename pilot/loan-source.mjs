import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { externalIdPattern, integrationKeyPattern } from '../external-integrations.mjs';
import { authorizeService, json, privateHeaders, readJson } from './http.mjs';

export function createLoanSource({ origin, hubOrigin, hubHref, serviceSecret, inbox }) {
  const host = new URL(origin).host;
  const assets = new Map([
    ['/', [new URL('./loan.html', import.meta.url), 'text/html; charset=utf-8']],
    ['/loan.js', [new URL('./loan.js', import.meta.url), 'text/javascript; charset=utf-8']],
    ['/styles.css', [new URL('../public/styles.css', import.meta.url), 'text/css; charset=utf-8']]
  ]);
  let connection;
  let loan;
  let loanNumber = 0;
  let approval;

  function newLoan() {
    loan = { id: randomUUID(), number: 'DEMO-' + String(++loanNumber).padStart(3, '0'), approved: false, receipt: null };
  }
  newLoan();

  async function hub(path, key, data, eventKey) {
    return fetch(new URL(path, hubOrigin), {
      method: data ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + key,
        ...(data && { 'Content-Type': 'application/json', 'Idempotency-Key': eventKey })
      },
      body: data && JSON.stringify(data),
      redirect: 'error',
      signal: AbortSignal.timeout(4000)
    });
  }

  async function state() {
    const { id, number, approved, receipt } = loan;
    let status = receipt?.status;
    if (receipt && connection?.id === receipt.connectionId && ['queued', 'sending'].includes(status)) {
      try {
        const response = await hub('/api/v1/messages/' + receipt.messageId, connection.key);
        if (response.ok) {
          status = (await response.json()).status;
          receipt.status = status;
        }
      } catch { /* The source may check the receipt again. */ }
    }
    return {
      id, number, approved, connected: Boolean(connection), status, hubHref,
      message: receipt && inbox.get(receipt.messageId)?.text
    };
  }

  async function handler(req, res) {
    if (req.headers.host !== host) return json(res, 403, { error: '來源不正確。' });
    const { pathname } = new URL(req.url, origin);
    if (pathname.startsWith('/service/')) {
      if (!authorizeService(req, serviceSecret)) return json(res, 401, { error: '服務憑證無效。' });
      if (req.method === 'GET' && pathname.startsWith('/service/latest/')) {
        const id = pathname.slice('/service/latest/'.length);
        return json(res, 200, { messageId: connection?.id === id ? connection.latest : null });
      }
      if (req.method === 'POST' && ['/service/connect', '/service/disconnect'].includes(pathname)) {
        const data = await readJson(req);
        if (!externalIdPattern.test(data?.id || '')) return json(res, 422, { error: '連接資料不完整。' });
        if (pathname === '/service/disconnect') {
          if (connection?.id === data.id) connection = undefined;
          return json(res, 200, { connected: false });
        }
        if (!integrationKeyPattern.test(data.key || '')) return json(res, 422, { error: '連接資料不完整。' });
        if (connection?.id === data.id && connection.key !== data.key) {
          return json(res, 409, { error: '連接資料不一致。' });
        }
        if (connection?.id !== data.id) connection = { id: data.id, key: data.key, latest: null };
        return json(res, 200, { connected: true });
      }
      return json(res, 404, { error: '找不到服務操作。' });
    }

    if (pathname === '/api/loan' && req.method === 'GET') return json(res, 200, await state());
    if (req.method === 'POST' && ['/api/approve', '/api/new-loan'].includes(pathname)) {
      if (req.headers.origin !== origin) return json(res, 403, { error: '來源不正確。' });
      if (approval) return json(res, 409, { error: '正在處理這筆借用單，請稍候。' });
      if (pathname === '/api/new-loan') {
        newLoan();
        return json(res, 200, await state());
      }
      const data = await readJson(req);
      if (data?.id !== loan.id) return json(res, 409, { error: '借用單已更新，請重新載入。' });
      if (!connection) return json(res, 409, { error: '請先回接線站允許連接。' });
      if (loan.receipt) return json(res, 200, await state());
      if (approval) return json(res, 409, { error: '正在處理這筆借用單，請稍候。' });
      const approvedLoan = loan;
      const destination = connection;
      approval = approvedLoan.id;
      approvedLoan.approved = true;
      try {
        const response = await hub('/api/v1/send', destination.key, {
          message: `測試借用單 ${approvedLoan.number} 已核准，請至教具借用平台查看。`
        }, 'loan-approved-' + approvedLoan.id);
        if (!response.ok) {
          const error = response.status === 401 || response.status === 403
            ? '接線站的連接已失效。請回接線站重新連接。'
            : '借用單已核准，通知暫時未送入接線站。請按「重試送出通知」。';
          return json(res, 502, { ...(await state()), error });
        }
        const { messageId, status } = await response.json();
        approvedLoan.receipt = { messageId, status, connectionId: destination.id };
        destination.latest = messageId;
        return json(res, 200, await state());
      } catch {
        return json(res, 502, { ...(await state()), error: '借用單已核准。連線逾時，可重試送出同一筆通知。' });
      } finally {
        approval = undefined;
      }
    }

    const asset = req.method === 'GET' && assets.get(pathname);
    if (!asset) return json(res, 404, { error: '找不到頁面。' });
    const [file, type] = asset;
    const content = await readFile(file);
    res.writeHead(200, {
      ...privateHeaders,
      'Content-Type': type,
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(content);
  }

  return createServer((req, res) => {
    handler(req, res).catch(() => json(res, 503, { error: '教具借用平台暫時無法連線。' }));
  });
}
