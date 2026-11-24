import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { eventWebhookPath } from '../external-api.mjs';
import { json, privateHeaders, readJson } from './http.mjs';

export function createLoanSource({ origin, hubOrigin, hubHref, connection, inbox }) {
  const host = new URL(origin).host;
  const assets = new Map([
    ['/', [new URL('./loan.html', import.meta.url), 'text/html; charset=utf-8']],
    ['/equipment', [new URL('./equipment.html', import.meta.url), 'text/html; charset=utf-8']],
    ['/equipment.js', [new URL('./equipment.js', import.meta.url), 'text/javascript; charset=utf-8']],
    ['/equipment.css', [new URL('./equipment.css', import.meta.url), 'text/css; charset=utf-8']],
    ['/loan.js', [new URL('./loan.js', import.meta.url), 'text/javascript; charset=utf-8']],
    ['/styles.css', [new URL('../public/styles.css', import.meta.url), 'text/css; charset=utf-8']]
  ]);
  let loan;
  let loanNumber = 0;
  let approval;
  const equipment = [
    { id: 'resuscitation-model', name: '成人 CPR 訓練模型', label: '急救訓練', location: '教學器材室 A' },
    { id: 'injection-arm', name: '靜脈注射訓練手臂', label: '臨床技能', location: '技術練習室 B' },
    { id: 'blood-pressure', name: '電子血壓計', label: '生命徵象', location: '技術練習室 B' }
  ];
  const requests = new Map();

  function newLoan() {
    loan = { id: randomUUID(), number: 'DEMO-' + String(++loanNumber).padStart(3, '0'), approved: false, receipt: null };
  }
  newLoan();

  async function hub(path, key, data) {
    return fetch(new URL(path, hubOrigin), {
      method: data ? 'POST' : 'GET',
      headers: {
        ...(key && { Authorization: 'Bearer ' + key }),
        ...(data && { 'Content-Type': 'application/json' })
      },
      body: data && JSON.stringify(data),
      redirect: 'error',
      signal: AbortSignal.timeout(4000)
    });
  }

  async function updateReceipt(receipt) {
    if (receipt && connection?.id === receipt.connectionId && ['queued', 'sending'].includes(receipt.status)) {
      try {
        const response = await hub('/api/v1/messages/' + receipt.messageId, connection.key);
        if (response.ok) receipt.status = (await response.json()).status;
      } catch { /* The source may check the receipt again. */ }
    }
    return receipt?.status;
  }

  async function state() {
    const { id, number, approved, receipt } = loan;
    const status = await updateReceipt(receipt);
    return {
      id, number, approved, connected: Boolean(connection), status, hubHref,
      message: receipt && inbox.get(receipt.messageId)?.text
    };
  }

  async function enqueueApproval({ id, number, item }, destination) {
    const label = item ? '（' + item.name + '）' : '';
    const response = await hub(eventWebhookPath(destination.id, destination.webhookToken), null, {
      eventId: 'loan-approved-' + id,
      message: `測試借用單 ${number}${label}已核准，請至教具借用平台查看。`
    });
    if (!response.ok) {
      return { error: response.status === 401 || response.status === 403
        ? '接線站的連接已失效。請回接線站重新連接。'
        : '借用單已核准，通知暫時未送入接線站。請按「重試送出通知」。' };
    }
    const { messageId, status } = await response.json();
    return { messageId, status, connectionId: destination.id };
  }

  async function workspaceState() {
    const loans = await Promise.all([...requests.values()].reverse().map(async request => {
      const { id, number, item, unit, purpose, createdAt, approvedAt, receipt } = request;
      const status = await updateReceipt(receipt);
      const message = receipt && inbox.get(receipt.messageId)?.text;
      const current = Boolean(connection && connection.id === request.attemptedConnection);
      const notice = status || request.notice;
      return {
        id, number, item, unit, purpose, createdAt, approvedAt,
        notice: message ? 'accepted' : !current && ['retry', 'queued', 'sending'].includes(notice) ? 'disconnected' : notice,
        message,
        canRetry: request.notice === 'retry' && current
      };
    }));
    return { equipment, loans, hubHref, connected: Boolean(connection) };
  }

  async function borrow(req, res, pathname) {
    if (pathname === '/api/borrow' && req.method === 'GET') {
      return json(res, 200, await workspaceState());
    }
    if (req.method !== 'POST') return json(res, 404, { error: '找不到借用操作。' });
    if (req.headers.origin !== origin) return json(res, 403, { error: '來源不正確。' });
    const data = await readJson(req);

    if (pathname === '/api/borrow') {
      const item = equipment.find(entry => entry.id === data?.itemId);
      const unit = typeof data?.unit === 'string' ? data.unit.trim() : '';
      const purpose = typeof data?.purpose === 'string' ? data.purpose.trim() : '';
      if (!item || !unit || unit.length > 40 || purpose.length > 120) {
        return json(res, 422, { error: '請選擇教具並確認借用單位及用途。' });
      }
      const request = {
        id: randomUUID(),
        number: 'LAB-' + String(requests.size + 1).padStart(3, '0'),
        item, unit, purpose, createdAt: new Date().toISOString(), approvedAt: null
      };
      requests.set(request.id, request);
      return json(res, 201, { ...(await workspaceState()), created: request.number });
    }

    if (!['/api/borrow/approve', '/api/borrow/retry'].includes(pathname)) {
      return json(res, 404, { error: '找不到借用操作。' });
    }
    const request = requests.get(data?.id);
    if (!request) return json(res, 404, { error: '找不到這筆借用單。' });
    const retry = pathname.endsWith('/retry');
    const destination = connection;
    if (retry) {
      if (request.notice !== 'retry' || !destination || request.attemptedConnection !== destination.id) {
        return json(res, 409, { error: '這筆通知目前無法重試，請確認連接狀態。' });
      }
    } else {
      if (request.approvedAt) return json(res, 200, await workspaceState());
      request.approvedAt = new Date().toISOString();
      if (!destination) {
        request.notice = 'unconnected';
        return json(res, 200, await workspaceState());
      }
    }
    request.notice = 'enqueuing';
    request.attemptedConnection = destination.id;
    try {
      const receipt = await enqueueApproval(request, destination);
      if (receipt.error) request.notice = 'retry';
      else request.receipt = receipt;
    } catch {
      request.notice = 'retry';
    }
    return json(res, 200, await workspaceState());
  }

  async function handler(req, res) {
    if (req.headers.host !== host) return json(res, 403, { error: '來源不正確。' });
    const { pathname } = new URL(req.url, origin);
    if (pathname === '/api/borrow' || pathname.startsWith('/api/borrow/')) return borrow(req, res, pathname);
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
      if (!connection) return json(res, 409, { error: '請先設定借用核准的 Webhook。' });
      if (loan.receipt) return json(res, 200, await state());
      if (approval) return json(res, 409, { error: '正在處理這筆借用單，請稍候。' });
      const approvedLoan = loan;
      const destination = connection;
      approval = approvedLoan.id;
      approvedLoan.approved = true;
      try {
        const receipt = await enqueueApproval(approvedLoan, destination);
        if (receipt.error) return json(res, 502, { ...(await state()), error: receipt.error });
        approvedLoan.receipt = receipt;
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
