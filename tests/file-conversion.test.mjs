import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canConvert, conversionCatalog, convertFile } from '../converter.mjs';

test('format choices allow only compatible outputs', () => {
  assert.ok(canConvert('mp4', 'webm'));
  assert.ok(canConvert('mp4', 'mp3'));
  assert.ok(canConvert('wav', 'flac'));
  assert.ok(canConvert('png', 'webp'));
  assert.equal(canConvert('png', 'mp3'), false);
  assert.equal(canConvert('pdf', 'mp4'), false);
  assert.equal(canConvert('mp4', 'mp4'), false);
  assert.ok(conversionCatalog.video.outputs.audio.includes('wav'));
});

test('converts video, audio, and image files without changing the input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clipdeck-formats-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = join(root, 'video.mp4');
  const audio = join(root, 'audio.wav');
  const image = join(root, 'image.png');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=500',
    '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', video]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1',
    '-c:a', 'pcm_s16le', audio]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=1',
    '-frames:v', '1', '-threads:v', '1', image]);

  const files = { mp4: video, wav: audio, png: image };
  const originalSizes = Object.fromEntries(await Promise.all(Object.entries(files)
    .map(async ([ext, path]) => [ext, (await stat(path)).size])));
  const tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };

  async function check(name, source, target, expectedCodec) {
    const dir = join(root, name);
    await mkdir(dir);
    await copyFile(files[source], join(dir, `upload.${source}`));
    const job = { extension: `.${source}`, targetFormat: target, format: target };
    const output = await convertFile(tools, job, dir);
    assert.equal(output.format, target);
    assert.ok(output.size > 0);
    const raw = execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output.file]);
    assert.ok(JSON.parse(raw).streams.some(stream => stream.codec_name === expectedCodec),
      `Expected ${expectedCodec} in ${source} to ${target} output`);
    assert.equal((await stat(files[source])).size, originalSizes[source]);
    return output;
  }

  const webm = await check('video-to-webm', 'mp4', 'webm', 'vp9');
  assert.equal(webm.notice, undefined, 'Incompatible output codec must still re-encode');
  await check('video-to-audio', 'mp4', 'mp3', 'mp3');
  await check('audio-to-flac', 'wav', 'flac', 'flac');
  await check('image-to-jpg', 'png', 'jpg', 'mjpeg');
  await check('image-to-webp', 'png', 'webp', 'webp');
  await check('video-to-gif', 'mp4', 'gif', 'gif');

  // A different container must not force a lossy video/audio transcode.
  function streamHash(file, stream) {
    return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-map', `0:${stream}:0`, `-c:${stream}`, 'copy', '-f', 'hash', '-hash', 'sha256', '-'],
    { encoding: 'utf8' }).trim();
  }
  async function convertOriginal(name, target) {
    const dir = join(root, name);
    await mkdir(dir);
    await copyFile(video, join(dir, 'upload.mp4'));
    return convertFile(tools, { extension: '.mp4', targetFormat: target }, dir);
  }

  const remuxed = await convertOriginal('lossless-mkv', 'mkv');
  assert.match(remuxed.notice, /without re-encoding/);
  assert.equal(streamHash(remuxed.file, 'v'), streamHash(video, 'v'));
  assert.equal(streamHash(remuxed.file, 'a'), streamHash(video, 'a'));

  const extracted = await convertOriginal('lossless-m4a', 'm4a');
  assert.match(extracted.notice, /without re-encoding/);
  assert.equal(streamHash(extracted.file, 'a'), streamHash(video, 'a'));

  const quicktime = await convertOriginal('lossless-mov', 'mov');
  assert.match(quicktime.notice, /without re-encoding/);
  assert.equal(streamHash(quicktime.file, 'v'), streamHash(video, 'v'));
  assert.equal(streamHash(quicktime.file, 'a'), streamHash(video, 'a'));

  const roundtripDir = join(root, 'mkv-to-mp4');
  await mkdir(roundtripDir);
  await copyFile(remuxed.file, join(roundtripDir, 'upload.mkv'));
  const roundtrip = await convertFile(tools, { extension: '.mkv', targetFormat: 'mp4' }, roundtripDir);
  assert.match(roundtrip.notice, /without re-encoding/);
  assert.equal(streamHash(roundtrip.file, 'v'), streamHash(video, 'v'));
  assert.equal(streamHash(roundtrip.file, 'a'), streamHash(video, 'a'));

  for (const [extension, target] of [['jpeg', 'jpg'], ['tif', 'tiff']]) {
    const imageFile = join(root, `photo.${extension}`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', image,
      '-frames:v', '1', '-update', '1', imageFile]);
    const dir = join(root, `alias-${extension}`);
    await mkdir(dir);
    const input = join(dir, `upload.${extension}`);
    await copyFile(imageFile, input);
    const originalBytes = await readFile(input);
    const job = { extension: `.${extension}`, targetFormat: target };
    const result = await convertFile(tools, job, dir);
    assert.equal(result.format, target);
    assert.equal(result.originalPreserved, true, 'An extension alias must not re-encode its image');
    assert.equal(result.file, input);
    assert.deepEqual(await readFile(result.file), originalBytes);
  }
});

test('rejects damaged or incompatible inputs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'clipdeck-bad-formats-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'upload.mp4'), 'corrupt');
  await assert.rejects(convertFile({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    { extension: '.mp4', targetFormat: 'webm' }, dir),
  /Could not read this file/);
  await assert.rejects(convertFile({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    { extension: '.mp4', targetFormat: 'png' }, dir),
  /cannot be converted/);
  await writeFile(join(dir, 'upload.jpeg'), 'not a JPEG');
  await assert.rejects(convertFile({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    { extension: '.jpeg', targetFormat: 'jpg' }, dir),
  /Could not read this file|does not contain a valid media track/);
});
