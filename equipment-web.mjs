import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEquipmentWorkspace } from './equipment-workspace.mjs';
import { createSource } from './source-notifications.mjs';
import { json, privateHeaders, readJson } from './pilot/http.mjs';

const lifetime = 4 * 60 * 60 * 1000;
const assets = new Map([
  ['/', ['pilot/equipment.html', 'text/html; charset=utf-8']],
  ['/equipment.js', ['pilot/equipment.js', 'text/javascript; charset=utf-8']],
  ['/equipment.css', ['pilot/equipment.css', 'text/css; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']]
]);
const browserHeaders = {
  ...privateHeaders,
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};

export function createEquipmentServer({ publicOrigin, onApproved, source }) {
  const base = new URL(publicOrigin);
  const { origin } = base;
  if (base.href !== origin + '/' || !['https:', 'http:'].includes(base.protocol) ||
      (base.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(base.hostname))) {
    throw new Error('Invalid equipment site origin');
  }
  const entries = new Map();
  const cookieOptions = 'Path=/; HttpOnly; SameSite=Strict; Max-Age=' + lifetime / 1000 +
    (base.protocol === 'https:' ? '; Secure' : '');

  function workspaceFor(req, res, create) {
    const now = Date.now();
    for (const [id, item] of entries) {
      if (item.expires <= now) entries.delete(id);
    }
    const sessionId = /(?:^|;\s*)equipment_trial=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const entry = entries.get(sessionId);
    if (entry) return entry.workspace;
    const saved = sessionId && source?.getSession(sessionId);
    if (saved && saved.expires > now) {
      const workspace = createEquipmentWorkspace({ standalone: true, onApproved, initialLoans: saved.loans,
        persist: (loans, submitted) => source.persist(sessionId, loans, submitted), maxLoans: 30 });
      entries.set(sessionId, { workspace, expires: saved.expires });
      return workspace;
    }
    if (!create || entries.size >= 400) return null;

    const id = randomBytes(32).toString('base64url');
    const expires = now + lifetime;
    source?.createSession(id, expires);
    const workspace = createEquipmentWorkspace({ standalone: true, onApproved,
      persist: source ? (loans, submitted) => source.persist(id, loans, submitted) : undefined, maxLoans: 30 });
    entries.set(id, { workspace, expires });
    res.setHeader('Set-Cookie', 'equipment_trial=' + id + '; ' + cookieOptions);
    return workspace;
  }

  async function handle(req, res) {
    const path = new URL(req.url, origin).pathname;
    if (path === '/health' && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, { ...privateHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(req.method === 'GET' ? 'ok' : undefined);
    }
    if (path === '/api/borrow' && req.method === 'GET') {
      const workspace = workspaceFor(req, res, true);
      if (!workspace) return json(res, 503, { error: '試用區目前人數已滿，請稍後再試。' });
      return json(res, 200, await workspace.state());
    }
    if (req.method === 'POST' && ['/api/borrow', '/api/borrow/approve'].includes(path)) {
      if (req.headers.origin !== origin) return json(res, 403, { error: '來源不正確。' });
      const workspace = workspaceFor(req, res, false);
      if (!workspace) return json(res, 401, { error: '試用工作區已過期，請重新整理頁面。' });
      const data = await readJson(req);
      const result = path === '/api/borrow' ? await workspace.add(data) : await workspace.approve(data);
      return json(res, ...result);
    }

    const asset = ['GET', 'HEAD'].includes(req.method) && assets.get(path);
    if (!asset) return json(res, 404, { error: '找不到頁面。' });
    const [file, contentType] = asset;
    const content = await readFile(new URL(file, import.meta.url));
    res.writeHead(200, { ...browserHeaders, 'Content-Type': contentType });
    return res.end(req.method === 'GET' ? content : undefined);
  }

  return createServer({ requestTimeout: 10000 }, (req, res) => {
    handle(req, res).catch(() => json(res, 503, { error: '教具借用平台暫時無法連線。' }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 39301);
  const source = process.env.EQUIPMENT_DATA_DIR ? createSource({ directory: process.env.EQUIPMENT_DATA_DIR }) : null;
  source?.start();
  const server = createEquipmentServer({
    source,
    publicOrigin: process.env.EQUIPMENT_PUBLIC_ORIGIN || 'http://127.0.0.1:' + port
  });
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log('Equipment borrowing site ready'));
}
