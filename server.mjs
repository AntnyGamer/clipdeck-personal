import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { compressVideo, compressionPresets, findTools, processMedia, qualities, sourceUrl, stopCapture } from './media.mjs';
import { canConvert, conversionCatalog, ConversionError, convertFile } from './converter.mjs';

const root = import.meta.dirname;
const hosted = process.env.CLIPDECK_HOSTED === '1';
const port = Number(process.env.PORT ?? process.env.CLIPDECK_PORT ?? 4174);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CLIPDECK_PORT must be between 1024 and 65535.');

const local = `http://127.0.0.1:${port}`;
const localName = `http://localhost:${port}`;
const localHosts = new Set([new URL(local).host, new URL(localName).host]);
const external = process.env.CLIPDECK_ORIGIN || process.env.RENDER_EXTERNAL_URL;
if (hosted && (!external || new URL(external).origin !== external)) {
  throw new Error('Set CLIPDECK_ORIGIN to the site address without a trailing slash. Render sets its own address automatically.');
}
const publicHost = hosted && new URL(external).host;
const password = process.env.CLIPDECK_PASSWORD;
if (hosted && (password?.length ?? 0) < 16) throw new Error('Set CLIPDECK_PASSWORD to a strong password of at least 16 characters.');
const hash = value => createHash('sha256').update(value).digest();
const expectedAuth = hosted && hash(`Basic ${Buffer.from(`clipdeck:${password}`).toString('base64')}`);
const stash = await mkdtemp(join(tmpdir(), 'clipdeck-'));
const tools = await findTools(root);
const missing = ['yt-dlp', 'ffmpeg', 'ffprobe'].filter(tool => !tools[tool]);
const compressionMissing = missing.filter(tool => tool !== 'yt-dlp');
const outputTypes = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime',
  mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv', mpeg: 'video/mpeg', mpg: 'video/mpeg', gif: 'image/gif',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac',
  ogg: 'audio/ogg', opus: 'audio/ogg', png: 'image/png', jpg: 'image/jpeg',
  webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff',
};
const retention = 12 * 60 * 60 * 1000;
const maxUploadBytes = hosted ? 200_000_000 : Infinity;
const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.wmv', '.mpeg', '.mpg']);
const jobs = new Map();
const activeStates = new Set(['uploading', 'checking', 'downloading', 'connecting', 'recording', 'stopping', 'converting', 'cancelling']);
let latest = null;
let active = null;
let shuttingDown = false;

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

class UploadError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function publicJob(job) {
  if (!job) return null;
  const { id, kind, state, format, quality, goalKind, goalValue, progress, title, size, originalSize, lossless, originalPreserved, live, recorded, error, notice } = job;
  return { id, kind, state, format, quality, goalKind, goalValue, progress, title, size, originalSize, lossless, originalPreserved, live, recorded, error, notice };
}

function allowedOrigin(request, path) {
  const { host, origin } = request.headers;
  if (path.startsWith('/api/') && request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (hosted ? host !== publicHost : !localHosts.has(host)) return false;
  if (request.method === 'POST' && !origin) return false;
  return !origin || (hosted ? origin === external : origin === local || origin === localName);
}

async function readRequest(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return null;
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) return null;
  }
  try { return JSON.parse(body); } catch { return null; }
}

async function perform(job, worker = () => processMedia(tools, job, job.dir), uploadResponse) {
  try {
    await mkdir(job.dir);
    const output = await worker();
    if (job.cancelled) throw new Error('This conversion was cancelled.');
    Object.assign(job, output, { progress: 100, state: 'ready' });
  } catch (error) {
    job.state = job.cancelled ? 'cancelled' : 'failed';
    if (!job.cancelled) {
      job.error = error instanceof UploadError || error instanceof ConversionError || error.constructor.name === 'MediaError'
        ? error.message : 'Could not create the conversion. Check the host’s available storage.';
    }
    if (uploadResponse && !uploadResponse.headersSent && !uploadResponse.destroyed) {
      json(uploadResponse, error instanceof UploadError ? error.status : 500,
        { error: job.error || 'The upload was cancelled.' });
    }
  } finally {
    job.finished = Date.now();
    job.request = null;
    if (active === job) active = null;
    const entries = await readdir(job.dir).catch(() => []);
    await Promise.allSettled(entries.filter(name => join(job.dir, name) !== job.file)
      .map(name => rm(join(job.dir, name), { force: true })));
  }
}

function cancel(job) {
  job.cancelled = true;
  job.state = 'cancelling';
  job.child?.kill();
  job.request?.destroy();
}

function fileHeader(job) {
  let title = (job.title || 'YouTube clip').replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '_').trim().replace(/[. ]+$/, '');
  if (!title) title = 'YouTube clip';
  const suffix = job.kind === 'convert' ? 'converted'
    : job.kind === 'upload' ? job.originalPreserved ? 'original' : 'compressed'
      : `${job.quality}${job.format === 'mp4' ? 'p' : 'kbps'}`;
  const filename = `${title} - ${suffix}.${job.format}`.toWellFormed();
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function sendFile(response, job) {
  if (!job || job.state !== 'ready') return json(response, 404, { error: 'This file has expired or is still being prepared.' });
  job.readers += 1;
  try {
    response.writeHead(200, {
      'Content-Type': outputTypes[job.format] ?? 'application/octet-stream',
      'Content-Length': job.size,
      'Content-Disposition': fileHeader(job),
    });
    await pipeline(createReadStream(job.file), response);
  } catch {
    response.destroy();
  } finally {
    job.readers -= 1;
  }
}

async function handle(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
  const path = (request.url ?? '').split('?')[0];
  const method = request.method;
  if (method === 'GET' && path === '/healthz') return json(response, compressionMissing.length ? 503 : 200,
    { ready: !compressionMissing.length, youtubeReady: !missing.length });
  if (!allowedOrigin(request, path)) return json(response, 403, { error: 'Open Clipdeck from its configured address.' });
  if (hosted && !timingSafeEqual(hash(request.headers.authorization ?? ''), expectedAuth)) {
    response.setHeader('WWW-Authenticate', 'Basic realm="Clipdeck", charset="UTF-8"');
    return json(response, 401, { error: 'Sign in as clipdeck with your hosting password.' });
  }
  const asset = assets.get(path);
  if ((method === 'GET' || method === 'HEAD') && asset) {
    const [name, contentType] = asset;
    const content = await readFile(join(root, 'public', name));
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': content.length });
    return response.end(method === 'HEAD' ? undefined : content);
  }
  if (method === 'GET' && path === '/api/status') {
    return json(response, 200, { hosted, missing, compressionMissing,
      maxUploadBytes: hosted ? maxUploadBytes : null, conversionCatalog, job: publicJob(active ?? latest) });
  }
  if (method === 'POST' && (path === '/api/uploads' || path === '/api/conversions')) {
    const convertingFile = path === '/api/conversions';
    if (request.headers['content-type'] !== 'application/octet-stream') {
      return json(response, 415, { error: 'Choose a supported file to upload.' });
    }
    const params = new URL(request.url, local).searchParams;
    const preset = params.get('preset');
    const goalKind = params.get('goal');
    const goalValue = Number(params.get('value'));
    const targetFormat = params.get('to');
    if (!convertingFile) {
      if (!compressionPresets.includes(preset)) {
        return json(response, 400, { error: 'Choose a supported compression level.' });
      }
      if (!['auto', 'percent', 'mb'].includes(goalKind)
          || (goalKind === 'percent' && !(goalValue >= 1 && goalValue <= 95))
          || (goalKind === 'mb' && (!Number.isFinite(goalValue) || goalValue < .1 || (hosted && goalValue > 200)))) {
        return json(response, 400, { error: hosted
          ? 'Choose Auto, a reduction of 1–95%, or a target from 0.1–200 MB.'
          : 'Choose Auto, a reduction of 1–95%, or a target of at least 0.1 MB.' });
      }
    }
    let filename;
    try { filename = decodeURIComponent(request.headers['x-clipdeck-filename'] ?? ''); } catch { /* Invalid encoding. */ }
    if (!filename || filename.length > 240 || filename.includes('/') || filename.includes('\\')
        || [...filename].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      return json(response, 400, { error: 'Choose a file with a valid filename.' });
    }
    const extension = extname(filename).toLowerCase();
    if (convertingFile) {
      if (!canConvert(extension.slice(1), targetFormat)) {
        return json(response, 415, { error: 'This source and output combination is not supported. Choose a compatible file type.' });
      }
    } else if (!videoExtensions.has(extension)) {
      return json(response, 415, { error: 'Supported video types: MP4, MOV, MKV, WEBM, AVI, WMV and MPEG.' });
    }
    const lengthHeader = request.headers['content-length'];
    const length = Number(lengthHeader);
    if (lengthHeader !== undefined && (!Number.isSafeInteger(length) || length <= 0)) {
      return json(response, 400, { error: 'Choose a nonempty file.' });
    }
    if (length > maxUploadBytes) {
      return json(response, 413, { error: 'Files must be 200 MB or smaller.' });
    }
    if (compressionMissing.length) return json(response, 503, { error: `Missing ${compressionMissing.join(', ')}. Install the media tools first.` });
    if (active || shuttingDown) return json(response, 409, { error: 'A conversion is already in progress.' });
    const id = randomUUID();
    const job = {
      id, kind: convertingFile ? 'convert' : 'upload', dir: join(stash, id),
      format: convertingFile ? targetFormat : 'mp4', targetFormat, quality: preset, goalKind, goalValue, extension,
      title: filename.slice(0, 160).replace(/\.[^.]+$/, '') || 'Video',
      state: 'uploading', readers: 0, request,
    };
    jobs.set(id, job);
    active = latest = job;
    job.completion = perform(job, async () => {
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxUploadBytes) {
            return callback(new UploadError(413, 'Files must be 200 MB or smaller.'));
          }
          if (length > 0) job.progress = Math.min(99, Math.floor(bytes * 100 / length));
          callback(null, chunk);
        },
      });
      try {
        await pipeline(request, limiter, createWriteStream(join(job.dir, `upload${extension}`), { flags: 'wx' }));
      } catch (error) {
        if (request.destroyed && !request.complete && !(error instanceof UploadError)) job.cancelled = true;
        throw error;
      }
      if (!bytes) throw new UploadError(400, 'Choose a nonempty file.');
      if (job.cancelled) throw new UploadError(400, 'Upload cancelled.');
      job.originalSize = bytes;
      job.request = null;
      job.progress = null;
      job.state = 'converting';
      if (!response.destroyed) json(response, 202, { job: publicJob(job) });
      return convertingFile ? convertFile(tools, job, job.dir) : compressVideo(tools, job, job.dir);
    }, response);
    return;
  }
  if (method === 'POST' && path === '/api/jobs') {
    const data = await readRequest(request);
    const url = typeof data?.url === 'string' && sourceUrl(data.url.trim());
    const format = data?.format;
    const quality = data?.quality;
    if (!url) return json(response, 400, { error: 'Paste a full YouTube link to a video, Short, or livestream.' });
    if ((format !== 'mp3' && format !== 'mp4') || !qualities[format].includes(quality)) {
      return json(response, 400, { error: 'Choose a supported format and quality.' });
    }
    if (missing.length) return json(response, 503, { error: `Missing ${missing.join(', ')}. Run the Windows launcher or follow the setup guide.` });
    if (active || shuttingDown) return json(response, 409, { error: 'A conversion is already in progress.' });
    const id = randomUUID();
    const job = { id, dir: join(stash, id), url, format, quality, state: 'checking', readers: 0 };
    jobs.set(id, job);
    active = latest = job;
    job.completion = perform(job);
    return json(response, 202, { job: publicJob(job) });
  }
  const match = /^\/api\/jobs\/([\da-f-]{36})\/(file|stop|cancel)$/.exec(path);
  const job = match && jobs.get(match[1]);
  if (method === 'GET' && match?.[2] === 'file') return sendFile(response, job);
  if (method === 'POST' && job && job === active && activeStates.has(job.state)) {
    if (match[2] === 'stop' && stopCapture(job)) return json(response, 200, { job: publicJob(job) });
    if (match[2] === 'cancel' && job.state !== 'cancelling') {
      cancel(job);
      return json(response, 200, { job: publicJob(job) });
    }
    return json(response, 409, { error: 'This action is no longer available.' });
  }
  return json(response, 404, { error: 'Page not found.' });
}

const server = createServer({ requestTimeout: hosted ? 10 * 60 * 1000 : 0, headersTimeout: 10000 }, (request, response) => {
  handle(request, response).catch(error => {
    console.error(error.code ?? error.message);
    if (response.headersSent) response.destroy();
    else json(response, 500, { error: 'The converter encountered a host error.' });
  });
});

const garbageCollection = setInterval(() => {
  for (const job of jobs.values()) {
    if (!job.finished || job.readers || Date.now() - job.finished < retention) continue;
    jobs.delete(job.id);
    if (latest === job) latest = null;
    rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }
}, 60000).unref();

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(garbageCollection);
  const pending = active;
  if (pending) cancel(pending);
  const closed = new Promise(resolve => server.close(resolve));
  await pending?.completion;
  server.closeAllConnections();
  await closed;
  await rm(stash, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.once('error', async error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set CLIPDECK_PORT to use another port.` : error.message);
  await rm(stash, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
server.listen(port, hosted ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Clipdeck is running at ${hosted ? external : local}`);
  if (missing.length) console.log(`Setup needed: ${missing.join(', ')}`);
  if (!hosted && process.platform === 'win32' && process.argv.includes('--open')) {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', local], { detached: true, stdio: 'ignore', windowsHide: true })
      .on('error', () => {}).unref();
  }
});
