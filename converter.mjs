import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './media.mjs';

export const conversionCatalog = {
  video: {
    inputs: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'mpeg', 'mpg', 'flv', 'ts'],
    outputs: {
      video: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'gif'],
      audio: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus'],
    },
  },
  audio: {
    inputs: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif'],
    outputs: { audio: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus'] },
  },
  image: {
    inputs: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif'],
    outputs: { image: ['png', 'jpg', 'webp', 'bmp', 'tiff'] },
  },
};

const audioOptions = {
  mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
  wav: ['-c:a', 'pcm_s16le'],
  m4a: ['-c:a', 'aac', '-b:a', '192k'],
  flac: ['-c:a', 'flac'],
  ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-c:a', 'libopus', '-b:a', '128k'],
};

const videoOptions = {
  mp4: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p'],
  mkv: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p'],
  mov: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p'],
  webm: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '5', '-b:v', '0', '-crf', '32'],
  avi: ['-c:v', 'mpeg4', '-q:v', '4'],
};

const imageOptions = {
  png: ['-c:v', 'png', '-threads:v', '1'],
  jpg: ['-c:v', 'mjpeg', '-q:v', '2'],
  webp: ['-c:v', 'libwebp', '-q:v', '85'],
  bmp: ['-c:v', 'bmp'],
  tiff: ['-c:v', 'tiff'],
};

export class ConversionError extends Error {}

export function conversionTargets(extension) {
  const category = Object.keys(conversionCatalog).find(name => conversionCatalog[name].inputs.includes(extension));
  return category ? conversionCatalog[category].outputs : null;
}

export function canConvert(sourceExtension, outputExtension) {
  const options = conversionTargets(sourceExtension);
  return sourceExtension !== outputExtension
    && !!options && Object.values(options).some(list => list.includes(outputExtension));
}

export async function convertFile(tools, job, dir) {
  const input = join(dir, `upload${job.extension}`);
  const target = job.targetFormat;
  if (!canConvert(job.extension.slice(1), target)) {
    throw new ConversionError('This file type cannot be converted to the selected output format.');
  }

  job.state = 'converting';
  job.progress = null;
  const output = join(dir, `result.${target}`);
  try {
    let metadata;
    try {
      const raw = await run(tools.ffprobe,
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input],
        job, { capture: true, timeout: 20000 });
      metadata = JSON.parse(raw);
    } catch (error) {
      if (job.cancelled) throw error;
      throw new ConversionError('Could not read this file. It may be damaged or use an unsupported codec.');
    }

    const streams = metadata.streams ?? [];
    const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const audio = streams.find(stream => stream.codec_type === 'audio');
    const sourceCategory = Object.keys(conversionCatalog).find(name =>
      conversionCatalog[name].inputs.includes(job.extension.slice(1)));
    if ((sourceCategory !== 'audio' && !(video?.width > 0 && video?.height > 0)) ||
        (sourceCategory === 'audio' && !audio)) {
      throw new ConversionError('The file does not contain a valid media track.');
    }

    if ((job.extension === '.jpeg' && target === 'jpg') ||
        (job.extension === '.tif' && target === 'tiff')) {
      const { size } = await stat(input);
      return { file: input, size, format: target, originalPreserved: true,
        notice: 'Only the file extension changed; the original data was preserved.' };
    }

    const isAudio = Object.hasOwn(audioOptions, target);
    const isImage = Object.hasOwn(imageOptions, target);
    if (isAudio && !audio) throw new ConversionError('This file has no audio track to convert.');

    // Copy compatible encoded streams instead of introducing a lossy re-encode.
    const audioCopy = isAudio && ({
      mp3: 'mp3', wav: 'pcm_s16le', m4a: 'aac', flac: 'flac',
      ogg: 'vorbis', opus: 'opus',
    })[target] === audio.codec_name;
    const videoCopy = !isAudio && !isImage && target !== 'gif'
      && ['mp4', 'mov', 'mkv'].includes(target)
      && video.codec_name === 'h264' && video.pix_fmt === 'yuv420p'
      && (!audio || audio.codec_name === 'aac');

    const duration = Number(metadata.format?.duration);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-filter_threads', '1',
      '-progress', 'pipe:1', '-nostats', '-i', input, '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn'];
    if (isAudio) {
      args.push('-map', `0:${audio.index}`, '-vn',
        ...(audioCopy ? ['-c:a', 'copy'] : audioOptions[target]));
    } else if (isImage) {
      args.push('-map', `0:${video.index}`, '-an', '-frames:v', '1', ...imageOptions[target]);
    } else if (target === 'gif') {
      args.push('-map', `0:${video.index}`, '-an', '-vf',
        "fps=12,scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos",
        '-loop', '0');
    } else {
      args.push('-map', `0:${video.index}`,
        ...(videoCopy ? ['-c:v', 'copy'] : videoOptions[target]));
      if (audio) {
        const codec = target === 'webm' ? ['-c:a', 'libopus', '-b:a', '128k']
          : target === 'avi' ? ['-c:a', 'libmp3lame', '-b:a', '192k']
            : ['-c:a', 'aac', '-b:a', '192k'];
        args.push('-map', `0:${audio.index}`,
          ...(videoCopy ? ['-c:a', 'copy'] : codec));
      }
      if (target === 'mp4' || target === 'mov') args.push('-movflags', '+faststart');
    }

    await run(tools.ffmpeg, [...args, output], job, {
      onLine(line) {
        const time = /^out_time_us=(\d+)/.exec(line);
        if (time && duration > 0) job.progress = Math.min(99, Number(time[1]) / 10000 / duration);
      },
    });
    const { size } = await stat(output);
    if (!size) throw new Error('Empty converted output');
    return { file: output, size, format: target,
      notice: audioCopy || videoCopy ? 'Existing media streams copied without re-encoding.' : undefined };
  } catch (error) {
    if (error instanceof ConversionError || job.cancelled) throw error;
    if (/space|disk full|no space left/i.test(error.message)) {
      throw new ConversionError('The host ran out of storage during conversion.');
    }
    throw new ConversionError('FFmpeg could not convert this file. Try another supported format.');
  }
}
