import { spawn } from 'node:child_process';
import { access, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

const executable = process.platform === 'win32' ? '.exe' : '';
const { CLIPDECK_PASSWORD, ...mediaEnv } = process.env;
const videoId = /^[\w-]{11}$/;
export const qualities = { mp4: [480, 720, 1080, 1440, 2160], mp3: [96, 128, 192, 256, 320] };

export function sourceUrl(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const [, first, second, ...rest] = url.pathname.split('/');
  if (rest.some(Boolean)) return null;
  if (url.hostname === 'youtu.be' && !second && videoId.test(first)) {
    return `https://www.youtube.com/watch?v=${first}`;
  }
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) return null;
  const id = first === 'watch' && !second ? url.searchParams.get('v') : undefined;
  if (id && videoId.test(id)) return `https://www.youtube.com/watch?v=${id}`;
  if (['shorts', 'live', 'embed'].includes(first) && second && videoId.test(second)) {
    return `https://www.youtube.com/watch?v=${second}`;
  }
  if (first?.startsWith('@') && first.length > 1 && second === 'live' && !/%2f|%5c/i.test(first)) {
    return `https://www.youtube.com/${first}/live`;
  }
  return null;
}

export async function findTools(root) {
  const searchPaths = [join(root, '.tools'), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)];
  const tools = {};
  for (const name of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
    for (const folder of searchPaths) {
      const candidate = join(folder, name + executable);
      try {
        await access(candidate);
        tools[name] = candidate;
        break;
      } catch { /* Try the next directory. */ }
    }
  }
  return tools;
}

class MediaError extends Error {}

function run(exe, args, job, options = {}) {
  if (job.cancelled) return Promise.reject(new MediaError('This conversion was cancelled.'));
  const { timeout = 0, onLine, capture = false, input = false } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env: mediaEnv, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    let tail = '';
    let timedOut = false;
    let tooMuchOutput = false;
    job.child = child;
    child.stdin?.on('error', () => {});
    const timer = timeout ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout) : undefined;
    child.stdout.setEncoding('utf8').on('data', chunk => {
      if (capture) {
        output += chunk;
        if (output.length > 16 * 1024 * 1024) {
          tooMuchOutput = true;
          child.kill();
        }
      }
      if (onLine) {
        const lines = (tail + chunk).split(/\r?\n/);
        tail = lines.pop();
        lines.forEach(onLine);
      }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { error = (error + chunk).slice(-12000); });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (job.child === child) job.child = null;
      if (job.cancelled) reject(new MediaError('This conversion was cancelled.'));
      else if (timedOut) reject(new MediaError('YouTube took too long to respond. Try the link again.'));
      else if (tooMuchOutput) reject(new MediaError('YouTube returned too much data for this link.'));
      else if (code !== 0) reject(new Error(error.trim() || `${exe} exited with status ${code}`));
      else resolve(output);
    });
  });
}

function ytArgs(tools) {
  return ['--ignore-config', '--no-playlist', '--no-cache-dir', '--encoding', 'utf-8', '--no-colors',
    '--js-runtimes', `node:${process.execPath}`, '--ffmpeg-location', dirname(tools.ffmpeg),
    '--socket-timeout', '15', '--retries', '3', '--fragment-retries', '3', '--extractor-retries', '1'];
}

async function inspect(url, tools, job) {
  try {
    const raw = await run(tools['yt-dlp'], [...ytArgs(tools), '--quiet', '--no-warnings', '--skip-download', '--dump-single-json', '--', url], job, { capture: true, timeout: 90000 });
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof MediaError) throw error;
    const details = error.message;
    if (/HTTP Error 429|sign in|bot|confirm your age|members.only|private video|login/i.test(details)) {
      throw new MediaError('YouTube restricted access to this link. Try a public video available from your device.');
    }
    if (/premiere|scheduled|will begin|upcoming|not currently live/i.test(details)) {
      throw new MediaError('This stream has yet to start. Open the link again when it goes live.');
    }
    if (/processing|post.live/i.test(details)) throw new MediaError('YouTube is preparing this replay. Try again when the replay is available.');
    if (/unavailable|removed|not available/i.test(details)) throw new MediaError('YouTube says this video or replay is unavailable. Check the link.');
    if (/resolve|connection|network|timed out/i.test(details)) throw new MediaError('Could not reach YouTube. Check the host’s internet connection.');
    throw new MediaError('Could not read this YouTube link. Try again or update yt-dlp using the setup guide.');
  }
}

async function download(info, tools, job, dir) {
  const metadata = join(dir, 'source.json');
  await writeFile(metadata, JSON.stringify(info), { mode: 0o600 });
  const selection = job.format === 'mp3'
    ? ['-f', 'ba/b']
    : ['-f', 'bv*+ba/b', '-S', `res:${job.quality},vcodec:h264,acodec:aac`];
  job.state = 'downloading';
  const line = value => {
    const match = /^clipdeck:\s*(\d+(?:\.\d+)?)%/.exec(value);
    if (match) job.progress = Math.min(100, +match[1]);
  };
  try {
    const output = await run(tools['yt-dlp'], [
      ...ytArgs(tools), ...selection, '--load-info-json', metadata, '--no-warnings', '--quiet',
      '--progress', '--newline', '--progress-template', 'download:clipdeck:%(progress._percent_str)s',
      '--merge-output-format', 'mkv', '-o', join(dir, 'source.%(ext)s'),
      '--print', 'after_move:filepath',
    ], job, { onLine: line, capture: true });
    const file = output.split(/\r?\n/).findLast(value => value.startsWith(join(dir, 'source.')));
    if (file && dirname(file) === dir) return file;
    throw new Error('Downloader did not return the expected output path.');
  } catch (error) {
    if (error instanceof MediaError) throw error;
    if (/403|429|download.*data|forbidden/i.test(error.message)) {
      throw new MediaError('YouTube blocked the media download. Try again, choose another quality, or update yt-dlp.');
    }
    if (/space|disk full/i.test(error.message)) throw new MediaError('The host ran out of storage while downloading.');
    throw new MediaError('The download failed before conversion. Try the link again or update yt-dlp.');
  }
}

function liveInput(formats, format, limit) {
  const streams = (formats ?? []).filter(item => {
    if (!item.protocol?.startsWith('m3u8') || item.acodec === 'none') return false;
    if (format === 'mp4' && item.vcodec === 'none') return false;
    try {
      const url = new URL(item.url);
      return url.protocol === 'https:' && (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com') || url.hostname === 'www.youtube.com');
    } catch { return false; }
  });
  const size = stream => Math.min(stream.width || Infinity, stream.height || Infinity);
  if (format === 'mp3') {
    streams.sort((a, b) => Number(b.vcodec === 'none') - Number(a.vcodec === 'none') || (a.tbr || Infinity) - (b.tbr || Infinity));
  } else {
    streams.sort((a, b) => {
      const aFits = size(a) <= limit;
      const bFits = size(b) <= limit;
      return Number(bFits) - Number(aFits) || (aFits ? size(b) - size(a) : size(a) - size(b)) || (b.fps ?? 0) - (a.fps ?? 0);
    });
  }
  return streams[0];
}

export async function captureStream(stream, tools, job, dir) {
  const target = join(dir, 'capture.mkv');
  const args = ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    '-rw_timeout', '12000000', '-protocol_whitelist', 'http,https,tcp,tls,crypto',
    '-live_start_index', '-1', '-i', stream.url];
  args.push(...(job.format === 'mp3' ? ['-map', '0:a:0', '-vn'] : ['-map', '0:v:0', '-map', '0:a:0?']));
  args.push('-c', 'copy', target);
  job.state = 'connecting';
  let failure;
  try {
    await run(tools.ffmpeg, args, job, {
      input: true,
      onLine(line) {
        const time = /^out_time_us=(\d+)/.exec(line);
        if (time && +time[1] > 0) {
          job.recorded = Math.max(job.recorded ?? 0, +time[1] / 1000000);
          if (!job.stopRequested) job.state = 'recording';
        }
      },
    });
  } catch (error) {
    if (job.cancelled) throw error;
    failure = error;
  } finally {
    clearTimeout(job.stopTimer);
  }
  const file = await stat(target).catch(() => null);
  if (!file?.size || !(job.recorded > 0)) throw new MediaError('Could not capture data from this live stream. Check that it is still live and try again.');
  if (failure && !job.stopRequested) job.notice = 'The stream disconnected. Your file contains the portion captured.';
  return target;
}

export function stopCapture(job) {
  if (job.state !== 'recording' || !job.child?.stdin) return false;
  const child = job.child;
  job.stopRequested = true;
  job.state = 'stopping';
  child.stdin.write('q\n');
  job.stopTimer = setTimeout(() => {
    if (job.child === child) child.kill();
  }, 20000);
  return true;
}

export async function finalize(input, tools, job, dir) {
  if (job.cancelled) throw new MediaError('This conversion was cancelled.');
  job.state = 'converting';
  job.progress = null;
  const output = join(dir, `result.${job.format}`);
  const temp = join(dir, `encoding.${job.format}`);
  try {
    const raw = await run(tools.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input], job, { capture: true, timeout: 20000 });
    const { streams, format } = JSON.parse(raw);
    const audio = streams.find(stream => stream.codec_type === 'audio');
    const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const duration = Number(format.duration) || job.recorded || job.duration;
    const flags = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats',
      '-threads', '2', '-filter_threads', '1', '-i', input, '-map_metadata', '-1'];
    if (job.format === 'mp3') {
      if (!audio) throw new MediaError('This source has no audio track.');
      flags.push('-map', `0:${audio.index}`, '-vn', '-c:a', 'libmp3lame', '-b:a', `${job.quality}k`, '-ac', '2');
    } else {
      if (!video) throw new MediaError('This source has no video track.');
      flags.push('-map', `0:${video.index}`);
      if (audio) flags.push('-map', `0:${audio.index}`);
      const edge = Math.min(video.width, video.height);
      if (video.codec_name === 'h264' && video.pix_fmt === 'yuv420p' && edge <= job.quality) {
        flags.push('-c:v', 'copy');
      } else {
        const factor = `min(1,${job.quality}/min(iw,ih))`;
        const resize = `scale=w='trunc(iw*${factor}/2)*2':h='trunc(ih*${factor}/2)*2'`;
        flags.push('-vf', resize, '-c:v', 'libx264', '-threads:v', '2', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
      }
      if (audio) flags.push('-c:a', audio.codec_name === 'aac' ? 'copy' : 'aac');
      flags.push('-movflags', '+faststart');
    }
    await run(tools.ffmpeg, [...flags, temp], job, {
      onLine(line) {
        const time = /^out_time_us=(\d+)/.exec(line);
        if (time && duration) job.progress = Math.min(99, +time[1] / 10000 / duration);
      },
    });
    const { size } = await stat(temp);
    if (!size) throw new Error('Empty output.');
    await rename(temp, output);
    return { file: output, size };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    if (/space|disk full/i.test(error.message)) throw new MediaError('The host ran out of storage during conversion.');
    throw new MediaError('FFmpeg could not finish this file. Try another quality or format.');
  }
}

export async function processMedia(tools, job, dir) {
  const info = await inspect(job.url, tools, job);
  if (job.cancelled) throw new MediaError('This conversion was cancelled.');
  if (info.live_status === 'is_upcoming') throw new MediaError('This stream is scheduled. Try again once it goes live.');
  if (info.live_status === 'post_live') throw new MediaError('YouTube is preparing this replay. Try again when the replay is available.');
  if (info._type === 'playlist') throw new MediaError('Paste a link to a single video, Short, or live stream.');
  job.title = String(info.title || 'YouTube clip').slice(0, 160);
  job.duration = info.duration;
  job.live = info.is_live || info.live_status === 'is_live';
  let input;
  if (job.live) {
    const stream = liveInput(info.formats, job.format, job.quality);
    if (!stream) throw new MediaError('YouTube did not provide a compatible live stream. Try the replay after the broadcast ends.');
    input = await captureStream(stream, tools, job, dir);
  } else {
    input = await download(info, tools, job, dir);
  }
  return finalize(input, tools, job, dir);
}
