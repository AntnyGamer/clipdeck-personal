import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeMedia, run } from '../media.mjs';

test('file inspection has no fixed timeout locally but is bounded when hosted', () => {
  const fileUrl = new URL('../media.mjs', import.meta.url).href;
  const script = `import { fileProbeTimeout } from ${JSON.stringify(fileUrl)};
process.stdout.write(String(fileProbeTimeout));`;

  for (const [hosted, expected] of [['0', 0], ['1', 20000]]) {
    const timeout = Number(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, CLIPDECK_HOSTED: hosted },
    }));
    assert.equal(timeout, expected, `CLIPDECK_HOSTED=${hosted}`);
  }
});

test('subprocess timeouts show tool-appropriate errors', async () => {
  const command = ['-e', 'setTimeout(() => {}, 10000)'];
  await assert.rejects(run(process.execPath, command, {}, { timeout: 50 }),
    /media tool took too long/i);
  await assert.rejects(run(process.execPath, command, {}, {
    timeout: 50, timeoutMessage: 'YouTube took too long to respond. Try the link again.',
  }), /YouTube took too long/);
});

test('focused probe preserves every field needed for media processing, including cover art', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'clipdeck-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const video = join(dir, 'video.mp4');
  const cover = join(dir, 'cover.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1',
    '-c:v', 'libx264', '-c:a', 'aac', video]);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-f', 'lavfi', '-i', 'color=red:s=64x64', '-t', '1', '-map', '0:a', '-map', '1:v',
    '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', '-frames:v', '1', cover]);
  const fields = ['index', 'codec_type', 'codec_name', 'pix_fmt', 'width', 'height', 'duration'];
  function project(metadata) {
    return {
      streams: metadata.streams.map(stream => [
        ...fields.map(field => stream[field]), stream.disposition?.attached_pic,
      ]),
      duration: metadata.format.duration,
    };
  }
  for (const input of [video, cover]) {
    const full = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams',
      '-show_format', '-of', 'json', input]));
    const focused = await probeMedia({ ffprobe: 'ffprobe' }, input, {});
    assert.deepEqual(project(focused), project(full));
    assert.ok(JSON.stringify(focused).length < JSON.stringify(full).length);
    if (input === cover) assert.ok(focused.streams.some(stream => stream.disposition?.attached_pic));
  }
});

test('unused subprocess output is discarded without blocking the child', async () => {
  const job = {};
  const output = await run(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024 * 1024))'],
    job, { timeout: 5000 });
  assert.equal(output, '');
  assert.equal(job.child, null);
});

test('line-only subprocess output includes a final unterminated line without accumulating output', async () => {
  const lines = [];
  const script = 'process.stdout.write("first\\r\\nsecond\\nlast")';
  const output = await run(process.execPath, ['-e', script], {}, {
    onLine: line => lines.push(line), timeout: 5000,
  });
  assert.deepEqual(lines, ['first', 'second', 'last']);
  assert.equal(output, '');
});

test('line-only subprocess output remains bounded for malformed giant lines', async () => {
  await assert.rejects(run(process.execPath,
    ['-e', 'process.stdout.write("x".repeat(17 * 1024 * 1024))'], {},
    { onLine() {}, timeout: 10000 }), /too much data/i);
});
