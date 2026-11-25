import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { copyFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function startServer(t, hosted = false, cwd = fileURLToPath(new URL('..', import.meta.url))) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const password = 'local-limit-tests-only';
  const auth = hosted ? { Authorization: `Basic ${Buffer.from(`clipdeck:${password}`).toString('base64')}` } : {};
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd,
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

test('hosted static assets negotiate precompressed gzip without changing content or authorization', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clipdeck-assets-'));
  const source = fileURLToPath(new URL('..', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['server.mjs', 'media.mjs', 'converter.mjs']) {
    await copyFile(join(source, name), join(root, name));
  }
  await cp(join(source, 'public'), join(root, 'public'), { recursive: true });
  const original = await readFile(join(root, 'public', 'app.js'));
  const compressed = gzipSync(original);
  await writeFile(join(root, 'public', 'app.js.gz'), compressed);
  const { base, auth } = await startServer(t, true, root);
  for (const [encoding, gzip] of [['gzip', true], ['br, gzip;q=0.5', true],
    ['*;q=0.5', true], ['gzip;q=0, *;q=1', false], ['identity', false]]) {
    const response = await fetch(base + '/app.js', {
      headers: { ...auth, 'Accept-Encoding': encoding },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), gzip ? 'gzip' : null);
    assert.equal(Number(response.headers.get('content-length')), gzip ? compressed.length : original.length);
    assert.equal(response.headers.get('vary'), 'Accept-Encoding');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  }
  assert.ok(compressed.length < original.length);
  const head = await fetch(base + '/app.js', {
    method: 'HEAD', headers: { ...auth, 'Accept-Encoding': 'gzip' },
  });
  assert.equal(head.headers.get('content-encoding'), 'gzip');
  assert.equal(Number(head.headers.get('content-length')), compressed.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const fallback = await fetch(base + '/style.css', { headers: { ...auth, 'Accept-Encoding': 'gzip' } });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get('content-encoding'), null);
  assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), await readFile(join(root, 'public', 'style.css')));
  const denied = await fetch(base + '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('content-encoding'), null);
  await denied.arrayBuffer();
});

test('oversized or malformed JSON produces a useful response', async t => {
  const { base } = await startServer(t);
  for (const body of ['x'.repeat(8192), '{"url":', 'null']) {
    const response = await fetch(base + '/api/jobs', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /paste a full youtube link/i);
  }
  assert.equal((await fetch(base + '/api/status')).status, 200);
});

test('hosted mode returns 413 for oversized uploads without a Content-Length', async t => {
  const { base, auth } = await startServer(t, true);
  const buffer = Buffer.alloc(1_000_000);
  async function* chunks() {
    for (let i = 0; i < 200; i++) yield buffer;
    yield Buffer.alloc(1);
  }
  const result = await fetch(base + '/api/conversions?to=wav', {
    method: 'POST', headers: { ...auth, Origin: base, 'Content-Type': 'application/octet-stream',
      'X-Clipdeck-Filename': 'oversized.mp3' },
    body: Readable.from(chunks()), duplex: 'half',
  });
  assert.equal(result.status, 413);
  assert.match((await result.json()).error, /200 MB/);
  const status = await (await fetch(base + '/api/status', { headers: auth })).json();
  assert.equal(status.job.state, 'failed');
});

test('disconnecting mid-upload cancels the job and releases the converter', async t => {
  const { base } = await startServer(t);
  const req = request(base + '/api/conversions?to=wav', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/octet-stream',
      'X-Clipdeck-Filename': 'partial.mp3', 'Content-Length': '1000000' },
  });
  req.on('error', () => {});
  t.after(() => req.destroy());
  req.write(Buffer.alloc(100));
  let status;
  for (let attempt = 0; attempt < 50; attempt++) {
    status = await (await fetch(base + '/api/status')).json();
    if (status.job?.state === 'uploading') break;
    await delay(50);
  }
  assert.equal(status.job?.state, 'uploading');
  req.destroy();
  for (let attempt = 0; attempt < 50; attempt++) {
    status = await (await fetch(base + '/api/status')).json();
    if (status.job?.state === 'cancelled') break;
    await delay(50);
  }
  assert.equal(status.job?.state, 'cancelled');
  const next = await fetch(base + '/api/conversions?to=wav', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/octet-stream',
      'X-Clipdeck-Filename': 'next.mp3' }, body: 'not valid audio',
  });
  assert.equal(next.status, 202);
  await next.arrayBuffer();
});
