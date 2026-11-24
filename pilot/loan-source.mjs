import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createEquipmentWorkspace, createStationClient } from '../equipment-workspace.mjs';
import { externalIdPattern, integrationKeyPattern } from '../external-integrations.mjs';
import { authorizeService, json, privateHeaders, readJson } from './http.mjs';

export function createLoanSource({ origin, hubOrigin, hubHref, serviceSecret, inbox }) {
  const host = new URL(origin).host;
  const assets = new Map([
    ['/', [new URL('./loan.html', import.meta.url), 'text/html; charset=utf-8']],
    ['/equipment', [new URL('./equipment.html', import.meta.url), 'text/html; charset=utf-8']],
    ['/equipment.js', [new URL('./equipment.js', import.meta.url), 'text/javascript; charset=utf-8']],
    ['/equipment.css', [new URL('./equipment.css', import.meta.url), 'text/css; charset=utf-8']],
    ['/loan.js', [new URL('./loan.js', import.meta.url), 'text/javascript; charset=utf-8']],
    ['/styles.css', [new URL('../public/styles.css', import.meta.url), 'text/css; charset=utf-8']]
  ]);
  let connection;
  let loan;
  let loanNumber = 0;
  let approval;
  const station = createStationClient(hubOrigin);
  const workspace = createEquipmentWorkspace({
    station, hubHref,
    receivedText: id => inbox.get(id)?.text,
    onQueued: (destination, id) => { destination.latest = id; }
  });

  function newLoan() {
    loan = { id: randomUUID(), number: 'DEMO-' + String(++loanNumber).padStart(3, '0'), approved: false, receipt: null };
  }
  newLoan();

  async function state() {
    const { id, number, approved, receipt } = loan;
    const status = await station.updateReceipt(receipt, connection);
    return {
      id, number, approved, connected: Boolean(connection), status, hubHref,
      message: receipt && inbox.get(receipt.messageId)?.text
    };
  }

  async function borrow(req, res, pathname) {
    if (pathname === '/api/borrow' && req.method === 'GET') return json(res, 200, await workspace.state(connection));
    if (req.method !== 'POST') return json(res, 404, { error: '找不到借用操作。' });
    if (req.headers.origin !== origin) return json(res, 403, { error: '來源不正確。' });
    const data = await readJson(req);
    let result;
    if (pathname === '/api/borrow') result = await workspace.add(data, connection);
    else if (['/api/borrow/approve', '/api/borrow/retry'].includes(pathname)) {
      result = await workspace.approve(data, connection, pathname.endsWith('/retry'));
    } else {
      return json(res, 404, { error: '找不到借用操作。' });
    }
    return json(res, ...result);
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
      if (!connection) return json(res, 409, { error: '請先回接線站允許連接。' });
      if (loan.receipt) return json(res, 200, await state());
      if (approval) return json(res, 409, { error: '正在處理這筆借用單，請稍候。' });
      const approvedLoan = loan;
      const destination = connection;
      approval = approvedLoan.id;
      approvedLoan.approved = true;
      try {
        const receipt = await station.enqueueApproval(approvedLoan, destination);
        if (receipt.error) return json(res, 502, { ...(await state()), error: receipt.error });
        approvedLoan.receipt = receipt;
        destination.latest = receipt.messageId;
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
