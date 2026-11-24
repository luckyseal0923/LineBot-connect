import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const origin = 'https://linebot-next.wfhai.org';
export const message = '有一筆教具借用申請已送出，請登入平台查看。';
function writeAtomic(path, data) {
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}
export function createSource({ directory, fetcher = fetch, interval = 5000 }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const configPath = join(directory, 'connection.json');
  const jobsPath = join(directory, 'source-state.json');
  const read = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  let state = read(jobsPath, { sessions: {}, jobs: [] });
  const save = next => { writeAtomic(jobsPath, next); state = next; };
  let running = false;
  let timer;
  const config = () => {
    const key = process.env.EQUIPMENT_LINEBOT_API_KEY;
    const stored = key ? { apiKey: key } : read(configPath, null);
    if (!stored) return null;
    const endpoint = process.env.EQUIPMENT_LINEBOT_ENDPOINT || origin + '/api/v1/send';
    const url = new URL(endpoint);
    if (url.origin !== origin || url.search || url.hash || !(/^\/api\/v1\/webhooks\/[0-9a-f-]{36}$/i.test(url.pathname) || url.pathname === '/api/v1/send')) {
      throw new Error('Invalid LINEBOT endpoint');
    }
    return { ...stored, endpoint, integrationId: stored.integrationId || createHash('sha256').update(key + ':' + endpoint).digest('hex') };
  };
  function createSession(id, expires) {
    const sessions = Object.fromEntries(Object.entries(state.sessions).filter(([, value]) => value.expires > Date.now()));
    save({ ...state, sessions: { ...sessions, [id]: { expires, loans: [] } } });
  }
  function getSession(id) { return state.sessions[id]; }
  function persist(id, loans, submitted) {
    const session = state.sessions[id];
    if (!session) throw new Error('工作區不存在');
    const connection = config();
    const jobs = submitted && connection ? [...state.jobs, {
      id: 'loan-submitted-' + submitted.id, message, integrationId: connection.integrationId, status: 'pending'
    }] : state.jobs;
    save({ sessions: { ...state.sessions, [id]: { ...session, loans } }, jobs });
  }
  async function flush() {
    if (running) return;
    running = true;
    try {
      const connection = config();
      if (!connection) return;
      for (const job of state.jobs.filter(x => x.status === 'pending' && x.integrationId === connection.integrationId)) {
        try {
          const response = await fetcher(connection.endpoint, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { Authorization: 'Bearer ' + connection.apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': job.id },
            body: JSON.stringify({ message: job.message })
          });
          if (response.ok) {
            const result = await response.json();
            if (typeof result.messageId !== 'string') continue;
            const jobs = state.jobs.map(x => x.id === job.id ? { ...x, status: 'submitted', messageId: result.messageId } : x);
            save({ ...state, jobs });
          }
        } catch { /* Retry later with the identical event ID and message. */ }
      }
    } finally { running = false; }
  }
  function start() { timer = setInterval(() => void flush(), interval); timer.unref(); void flush(); }
  function stop() { clearInterval(timer); }
  return { createSession, getSession, persist, flush, start, stop };
}
export async function pair({ directory, fetcher = fetch, output = console.log, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const start = await fetcher(origin + '/api/v1/source-pairings', {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceName: '教具借用平台', eventName: '送出借用申請', challenge })
  });
  if (start.status !== 201) throw new Error('無法建立配對：HTTP ' + start.status);
  const p = await start.json();
  if (!p.pairingCode || !p.deviceToken || !p.expiresIn) throw new Error('配對回應不完整');
  output('配對碼：' + p.pairingCode + '（有效 ' + p.expiresIn + ' 秒）');
  output('請至接線站選擇收件者並允許連接；此程序會在後端領取金鑰。');
  const deadline = Date.now() + p.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.max(5, Number(p.pollInterval) || 5) * 1000);
    let response;
    try {
      response = await fetcher(origin + '/api/v1/source-pairings/claim', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceToken: p.deviceToken, verifier })
      });
    } catch { continue; }
    if (response.status === 202 || response.status === 429) continue;
    if (response.status !== 200) throw new Error('領取金鑰失敗：HTTP ' + response.status);
    const data = await response.json();
    if (!data.apiKey || !data.integrationId || data.endpoint !== origin + '/api/v1/send') throw new Error('接線站回應不完整');
    writeAtomic(join(directory, 'connection.json'), { apiKey: data.apiKey, integrationId: data.integrationId });
    output('授權完成，金鑰已儲存於來源後端。');
    return;
  }
  throw new Error('配對已過期，請重新建立。');
}
