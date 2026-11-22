import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

async function startServer(t, hosted = false) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const password = 'local-limit-tests-only';
  const auth = hosted ? { Authorization: `Basic ${Buffer.from(`clipdeck:${password}`).toString('base64')}` } : {};
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, CLIPDECK_PORT: String(port),
      CLIPDECK_HOSTED: hosted ? '1' : '0',
      ...(hosted ? { CLIPDECK_ORIGIN: base, CLIPDECK_PASSWORD: password } : {}) },
    stdio: 'ignore',
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error('ClipDeck server exited during startup.');
    try {
      const response = await fetch(`${base}/api/status`, { headers: auth });
      if (response.ok) return { base, auth };
    } catch { /* Startup in progress. */ }
    await delay(100);
  }
  throw new Error('ClipDeck server did not start.');
}

test('local mode accepts uploaded files larger than the hosted cap', async t => {
  const { base } = await startServer(t);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.hosted, false);
  assert.equal(status.maxUploadBytes, null);
  assert.deepEqual(status.compressionMissing, []);

  const total = 200_000_001;
  const buffer = Buffer.alloc(1_000_000);
  async function* largeFile() {
    for (let i = 0; i < 200; i += 1) yield buffer;
    yield Buffer.alloc(1);
  }
  const response = await fetch(`${base}/api/conversions?to=wav`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/octet-stream',
      'X-Clipdeck-Filename': encodeURIComponent('oversized.mp3'),
      'Content-Length': String(total) },
    body: Readable.from(largeFile()),
    duplex: 'half',
  });
  assert.equal(response.status, 202, await response.text());
});

test('hosted mode still rejects uploads over 200 MB before receiving the body', async t => {
  const { base, auth } = await startServer(t, true);
  const status = await (await fetch(`${base}/api/status`, { headers: auth })).json();
  assert.equal(status.hosted, true);
  assert.equal(status.maxUploadBytes, 200_000_000);

  const code = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/conversions?to=wav`, {
      method: 'POST',
      headers: { ...auth, Origin: base, 'Content-Type': 'application/octet-stream',
        'X-Clipdeck-Filename': encodeURIComponent('oversized.mp3'),
        'Content-Length': '200000001' },
    }, res => {
      res.resume();
      res.once('end', () => { resolve(res.statusCode); req.destroy(); });
    });
    req.once('error', reject);
    req.flushHeaders();
  });
  assert.equal(code, 413);
});
