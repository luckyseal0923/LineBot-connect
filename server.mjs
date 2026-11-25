import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const files = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
files.set('/line-setup-options.js', ['line-setup-options.js', 'text/javascript; charset=utf-8']);
const sessions = new Map();
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const headers = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'", 'Cache-Control': 'no-store' };
function json(res, status, data, extra = {}) { res.writeHead(status, { ...headers, ...extra, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
async function bodyOf(req) {
  let size = 0; const parts = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw Error('too large'); parts.push(chunk); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
async function upstream(path, options = {}) {
  return fetch(`${supabaseUrl}${path}`, { ...options, headers: { apikey: supabaseKey, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(10000) });
}
function session(req) {
  const token = /(?:^|;\s*)sid=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const value = token && sessions.get(token);
  if (value && value.expires > Date.now()) return value;
  if (token) sessions.delete(token);
  return null;
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/health' && (req.method === 'GET' || req.method === 'HEAD')) { res.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(req.method === 'HEAD' ? undefined : 'ok'); }
  if (/^\/webhooks\/line\/[0-9a-f-]{36}$/i.test(path)) {
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    return json(res, 503, { error: 'Webhook 尚未啟用。' });
  }
  if (path.startsWith('/api/')) {
    // Shared Auth currently auto-confirms email; email_confirmed_at is not proof of mailbox ownership.
    // Keep account operations closed until app-specific verification is implemented and tested.
    if (['/api/signup', '/api/login', '/api/apply', '/api/me'].includes(path)) return json(res, 503, { error: '帳號功能尚未開放：共用服務的 Email 驗證需要先完成獨立設計。' });
    if (!supabaseUrl || !supabaseKey) return json(res, 503, { error: '帳號服務尚未設定。請參考本機設定文件。' });
    if (req.method === 'POST' && req.headers.origin !== `http://localhost:${port}` && req.headers.origin !== `http://127.0.0.1:${port}`) return json(res, 403, { error: '請從本機網站操作。' });
    try {
      if (path === '/api/signup' && req.method === 'POST') {
        const data = await bodyOf(req);
        if (typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || data.email.length > 254 || typeof data.password !== 'string' || data.password.length < 12 || data.password.length > 128) return json(res, 400, { error: '請確認 Email 和至少 12 字元的密碼。' });
        const response = await upstream('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email: data.email.trim(), password: data.password }) });
        if (!response.ok) return json(res, 400, { error: '目前無法完成申請，請檢查輸入或稍後再試。' });
        return json(res, 200, { message: '若這是新的共用帳號，請查看驗證信。已有帳號者可直接登入，再填寫接線站申請。' });
      }
      if (path === '/api/login' && req.method === 'POST') {
        const data = await bodyOf(req);
        if (typeof data.email !== 'string' || typeof data.password !== 'string' || data.email.length > 254 || data.password.length > 128) return json(res, 400, { error: '請輸入 Email 和密碼。' });
        const response = await upstream('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: data.email, password: data.password }) });
        if (!response.ok) return json(res, 401, { error: '登入失敗，請確認帳號、密碼及 Email 是否已驗證。' });
        const auth = await response.json();
        if (!auth.user?.email_confirmed_at || !auth.access_token) return json(res, 403, { error: '請先驗證 Email。' });
        const sid = randomBytes(32).toString('hex');
        sessions.set(sid, { accessToken: auth.access_token, expires: Date.now() + Math.min(auth.expires_in || 3600, 3600) * 1000 });
        return json(res, 200, { message: '登入成功。' }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` });
      }
      if (path === '/api/me' && req.method === 'GET') {
        const current = session(req); if (!current) return json(res, 401, { error: '請先登入。' });
        const response = await upstream('/rest/v1/rpc/linebot_my_application', { method: 'POST', headers: { Authorization: `Bearer ${current.accessToken}` }, body: '{}' });
        if (!response.ok) return json(res, 502, { error: '目前無法讀取申請狀態。' });
        const accounts = await response.json();
        return accounts.length === 1 ? json(res, 200, { account: accounts[0] }) : json(res, 404, { error: '尚未申請接線站，請填寫下方申請表。' });
      }
      if (path === '/api/apply' && req.method === 'POST') {
        const current = session(req); if (!current) return json(res, 401, { error: '請先登入並完成 Email 驗證。' });
        const data = await bodyOf(req);
        if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 100 || typeof data.purpose !== 'string' || !data.purpose.trim() || data.purpose.trim().length > 2000) return json(res, 400, { error: '請填寫姓名和用途。' });
        const response = await upstream('/rest/v1/rpc/linebot_submit_application', { method: 'POST', headers: { Authorization: `Bearer ${current.accessToken}` }, body: JSON.stringify({ p_name: data.name.trim(), p_purpose: data.purpose.trim() }) });
        if (response.status === 409) return json(res, 409, { error: '您已送出申請，請查看目前狀態。' });
        if (!response.ok) return json(res, 502, { error: '申請無法送出，請確認 Email 已驗證並稍後重試。' });
        return json(res, 200, { message: '申請已送出，等待審核。' });
      }
      if (path === '/api/logout' && req.method === 'POST') {
        const sid = /(?:^|;\s*)sid=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]; if (sid) sessions.delete(sid);
        return json(res, 200, { message: '已登出。' }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      return json(res, 404, { error: '找不到功能。' });
    } catch { return json(res, 502, { error: '服務暫時無法使用，請稍後再試。' }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  const file = files.get(path);
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  try { const body = await readFile(join(root, file[0])); res.writeHead(200, { ...headers, 'Content-Type': file[1] }); res.end(req.method === 'HEAD' ? undefined : body); } catch { res.writeHead(500); res.end('Server error'); }
});
server.listen(port, host, () => console.log(`LineBOT Connect: http://localhost:${port}`));
