import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('preview serves only the intended static files', async () => {
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '39173' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('server exited early'); })]);
    const home = await fetch('http://127.0.0.1:39173/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /LineBOT 接線站/);
    assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await fetch('http://127.0.0.1:39173/server.mjs')).status, 404);
    assert.equal((await fetch('http://127.0.0.1:39173/health')).status, 200);
    assert.equal((await fetch('http://127.0.0.1:39173/webhooks/line/00000000-0000-0000-0000-000000000001', {method:'POST'})).status, 503);
    assert.equal((await fetch('http://127.0.0.1:39173/', { method: 'POST' })).status, 405);
  } finally { child.kill(); }
});

test('account routes fail closed even if a shared service is configured', async () => {
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '39174', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited early'); })]);
    for (const path of ['signup', 'login', 'apply', 'me']) {
      const response = await fetch(`http://127.0.0.1:39174/api/${path}`, { method: path === 'me' ? 'GET' : 'POST', headers: { Origin: 'http://localhost:39174', 'Content-Type': 'application/json' }, ...(path === 'me' ? {} : { body: '{}' }) });
      assert.equal(response.status, 503);
    }
  } finally { child.kill(); }
});
