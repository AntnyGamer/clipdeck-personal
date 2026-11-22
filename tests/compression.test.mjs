import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressVideo } from '../media.mjs';

test('compresses uploaded videos with lossless and target-size choices', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clipdeck-compression-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'source.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', fixture]);
  const originalSize = (await stat(fixture)).size;
  assert.ok(originalSize > 150000);
  const tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };

  async function runCase(name, quality, goalKind, goalValue) {
    const dir = join(root, name);
    await mkdir(dir);
    await copyFile(fixture, join(dir, 'upload.mp4'));
    const job = { extension: '.mp4', originalSize, format: 'mp4',
      quality, goalKind, goalValue };
    return { job, ...await compressVideo(tools, job, dir) };
  }

  const lossless = await runCase('lossless', 'lossless', 'auto', 0);
  assert.equal(lossless.lossless, true);
  assert.ok(lossless.size <= originalSize, 'Lossless mode should never increase file size.');
  assert.ok(['mkv', 'mp4'].includes(lossless.job.format));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', lossless.file]));
  assert.deepEqual(probe.streams.map(stream => stream.codec_name), ['h264', 'aac']);

  await assert.rejects(runCase('strict-target', 'lossless', 'percent', 50),
    /Lossless compression cannot meet that size goal/);
  for (const quality of ['lossless', 'best']) {
    const result = await runCase(`already-small-${quality}`, quality, 'mb', 100);
    assert.equal(result.lossless, true);
    assert.equal(result.originalPreserved, true);
    assert.equal(result.size, originalSize);
    assert.equal(result.job.format, 'mp4');
    assert.equal(result.file, join(root, `already-small-${quality}`, 'upload.mp4'));
  }


  const targeted = await runCase('percent-target', 'best', 'percent', 25);
  assert.equal(targeted.lossless, false);
  assert.equal(targeted.job.format, 'mp4');
  assert.ok(targeted.size < originalSize * .80, 'Expected meaningful size reduction');
  assert.ok(targeted.size <= originalSize * .75 * 1.10, 'Should be close to target size');

  const mbTarget = await runCase('mb-target', 'balanced', 'mb', .5);
  assert.equal(mbTarget.job.format, 'mp4');
  assert.ok(mbTarget.size < originalSize);
  assert.ok(mbTarget.size <= 550000, 'Should approach the requested MB target');
});

test('rejects an invalid video input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'clipdeck-invalid-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'upload.mp4'), 'not video');
  await assert.rejects(compressVideo({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, {
    extension: '.mp4', originalSize: 9, quality: 'best', goalKind: 'auto', goalValue: 0,
  }, dir), /Could not read this video/);
});
