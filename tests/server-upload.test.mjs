import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

for (const hasDownloader of [true, false]) test(
  `video upload works ${hasDownloader ? 'with' : 'without'} a YouTube downloader`,
  { skip: !hasDownloader && process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'clipdeck-http-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  if (hasDownloader) {
    const stub = join(bin, 'yt-dlp');
    await writeFile(stub, '#!/bin/sh\nexit 1\n');
    await chmod(stub, 0o755);
  } else {
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const executable = execFileSync('which', [tool], { encoding: 'utf8' }).trim();
      await symlink(executable, join(bin, tool));
    }
  }
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, CLIPDECK_PORT: String(port), PATH: hasDownloader ? `${bin}:${process.env.PATH}` : bin },
    stdio: 'ignore',
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });

  let status;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Clipdeck server exited before responding.');
    try {
      const response = await fetch(`${base}/api/status`);
      if (response.ok) { status = await response.json(); break; }
    } catch { /* The server is starting. */ }
    await delay(100);
  }
  assert.ok(status, 'Server did not respond.');
  assert.deepEqual(status.compressionMissing, []);
  assert.deepEqual(status.missing, hasDownloader ? [] : ['yt-dlp']);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ready: true, youtubeReady: hasDownloader });

  const input = join(root, 'sample.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', input]);
  const data = await readFile(input);
  assert.ok(data.length > 20000);
  const response = await fetch(`${base}/api/uploads?preset=best&goal=percent&value=25`, {
    method: 'POST',
    headers: {
      Origin: base,
      'Content-Type': 'application/octet-stream',
      'X-Clipdeck-Filename': encodeURIComponent('sample.mp4'),
    },
    body: data,
  });
  const responseText = await response.text();
  assert.equal(response.status, 202, responseText);
  const { job: submitted } = JSON.parse(responseText);
  assert.equal(submitted.state, 'converting');
  let completed;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = await (await fetch(`${base}/api/status`)).json();
    if (['ready', 'failed', 'cancelled'].includes(status.job?.state)) {
      completed = status.job;
      break;
    }
    await delay(150);
  }
  assert.equal(completed?.state, 'ready', completed?.error || 'The compression did not complete.');
  assert.equal(completed.kind, 'upload');
  assert.ok(completed.size > 0);
  assert.ok(completed.size < data.length);
  const download = await fetch(`${base}/api/jobs/${completed.id}/file`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /compressed\.mp4/);
  assert.equal((await download.arrayBuffer()).byteLength, completed.size);
});
