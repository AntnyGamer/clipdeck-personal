import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processMedia } from '../media.mjs';

test('download processing uses the final path without buffering progress logs',
  { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'clipdeck download test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'fixture.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', source]);
  const downloader = join(root, 'yt-dlp');
  // Exercise the real processMedia and FFmpeg path, with a deterministic stand-in
  // for the external YouTube service. Include CRLF and an unterminated final path.
  await writeFile(downloader, '#!' + process.execPath + '\n' + [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args.includes('--dump-single-json')) {",
    "  process.stdout.write(JSON.stringify({ title: 'Fixture', duration: 1, is_live: false }));",
    "} else {",
    "  const metadata = JSON.parse(fs.readFileSync(args[args.indexOf('--load-info-json') + 1]));",
    "  if (metadata.title !== 'Fixture') process.exit(1);",
    "  const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');",
    "  fs.copyFileSync(" + JSON.stringify(source) + ", output);",
    "  process.stdout.write('clipdeck: 1%\\r\\n');",
    "  const progress = 'clipdeck: 50%\\n'.repeat(4096);",
    "  for (let i = 0; i < 320; i++) process.stdout.write(progress);",
    "  process.stdout.write('clipdeck: 100%\\r\\n');",
    "  process.stdout.write(output);",
    "}",
  ].join('\n'), { mode: 0o700 });
  const tools = { 'yt-dlp': downloader, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  const dir = join(root, 'output');
  await mkdir(dir);
  const job = { url: 'https://www.youtube.com/watch?v=abcdefghijk', format: 'mp4', quality: 480 };
  const result = await processMedia(tools, job, dir);
  assert.equal(job.title, 'Fixture');
  assert.equal(result.file, join(dir, 'result.mp4'));
  assert.equal(result.size, (await stat(result.file)).size);
  for (const stream of ['v', 'a']) {
    const hash = path => execFileSync('ffmpeg', ['-v', 'error', '-i', path,
      '-map', '0:' + stream + ':0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'],
    { encoding: 'utf8' });
    assert.equal(hash(result.file), hash(source));
  }
});
