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
    assert.equal((await fetch('http://127.0.0.1:39173/', { method: 'POST' })).status, 405);
  } finally { child.kill(); }
});
