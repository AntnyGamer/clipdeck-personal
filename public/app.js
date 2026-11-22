'use strict';

const byId = id => document.getElementById(id);
const form = byId('convert-form');
const source = byId('url');
const compressForm = byId('compress-form');
const fileField = byId('video-file');
const compressButton = byId('compress');
const goalField = byId('goal-value');
const maxUploadBytes = 200_000_000;
const convertButton = byId('convert');
const choices = byId('qualities');
const progress = byId('progress');
const cancelButton = byId('cancel');
const stopButton = byId('stop');
const download = byId('download');
const options = { mp4: [480, 720, 1080, 1440, 2160], mp3: [96, 128, 192, 256, 320] };
const selected = { mp4: 1080, mp3: 192 };
const labels = {
  idle: 'Idle', uploading: 'Uploading', checking: 'Checking link', downloading: 'Downloading', connecting: 'Connecting', recording: 'Recording',
  stopping: 'Saving recording', converting: 'Converting', cancelling: 'Cancelling', cancelled: 'Cancelled',
  ready: 'Ready', failed: 'Failed',
};
const working = new Set(['uploading', 'checking', 'downloading', 'connecting', 'recording', 'stopping', 'converting', 'cancelling']);
let job = null;
let health = 'connecting';
let commandRunning = false;
let uploadRequest = null;
const savedGoals = { percent: 25, mb: 20 };
let pollTimer;
let refreshing = false;
let revision = 0;

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function message(text) {
  const element = byId('form-message');
  setText(element, text);
  element.hidden = !text;
}

function updateSubmit() {
  const busy = working.has(job?.state);
  convertButton.disabled = health !== 'ready' || busy || commandRunning;
  compressButton.disabled = health !== 'ready' || busy || commandRunning || !fileField.files.length
    || !fileField.files[0].size || fileField.files[0].size > maxUploadBytes;
  const label = commandRunning && !busy ? 'Connecting…' : `Convert to ${form.elements.format.value.toUpperCase()}`;
  setText(convertButton, busy ? 'Conversion in progress' : label);
  setText(compressButton, busy ? 'Processing in progress' : 'Compress video');
}

function showQualities() {
  const format = form.elements.format.value;
  const video = format === 'mp4';
  setText(byId('quality-label'), video ? 'Maximum resolution' : 'Audio bitrate');
  setText(byId('quality-hint'), video ? 'Lower resolutions are used when the source is smaller.' : 'Higher bitrates use more space. Audio quality depends on the source.');
  choices.replaceChildren(...options[format].map(quality => {
    const label = document.createElement('label');
    label.className = 'quality-option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'quality';
    input.value = String(quality);
    input.checked = quality === selected[format];
    label.append(input, video ? `${quality}p` : `${quality} kbps`);
    return label;
  }));
  updateSubmit();
}

function timeLabel(seconds = 0) {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = String(whole % 60).padStart(2, '0');
  if (minutes < 60) return `${minutes}:${remainder}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}`;
}

function sizeLabel(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1000000000) return `${(bytes / 1000000).toFixed(1)} MB`;
  return `${(bytes / 1000000000).toFixed(2)} GB`;
}

function jobText(current) {
  switch (current.state) {
    case 'uploading': return current.progress == null ? 'Uploading your video.' : `Uploading video · ${Math.floor(current.progress)}%`;
    case 'checking': return 'Reading the YouTube link.';
    case 'downloading': return current.progress == null ? 'Fetching media from YouTube.' : `Downloading source · ${Math.floor(current.progress)}%`;
    case 'connecting': return 'Waiting for the first live segment.';
    case 'recording': return `${timeLabel(current.recorded)} recorded. Stop & save to finish.`;
    case 'stopping': return 'Finishing the captured segment.';
    case 'converting': {
      const action = current.kind === 'upload' ? 'Compressing video' : 'Preparing your file';
      return current.progress == null ? `${action}.` : `${action} · ${Math.floor(current.progress)}%`;
    }
    case 'cancelling': return 'Stopping the conversion.';
    case 'cancelled': return 'You can start another conversion.';
    case 'failed': return current.error;
    case 'ready': {
      if (current.kind === 'upload' && current.originalSize) {
        const saved = (100 * (current.originalSize - current.size) / current.originalSize).toFixed(1);
        return [`${current.format.toUpperCase()} · ${sizeLabel(current.size)} (original ${sizeLabel(current.originalSize)})`,
          current.lossless ? 'No quality loss' : 'Re-encoded',
          Number(saved) > 0 ? `${saved}% smaller` : 'Not smaller', current.notice].filter(Boolean).join(' · ');
      }
      return [`${current.format.toUpperCase()} · ${sizeLabel(current.size)}`, current.notice].filter(Boolean).join(' · ');
    }
    default: return 'Your file will appear here when it’s ready.';
  }
}

function renderJob(current) {
  job = current;
  const state = job?.state ?? 'idle';
  const busy = working.has(state);
  const badge = byId('state');
  badge.dataset.state = state;
  badge.dataset.active = String(busy);
  byId('result').dataset.state = state;
  setText(badge, labels[state]);
  setText(byId('result-title'), job?.title ?? (state === 'idle' ? 'No conversion yet' : labels[state]));
  setText(byId('result-text'), jobText(job ?? { state }));
  progress.hidden = !busy || !['uploading', 'downloading', 'converting'].includes(state) || job.progress == null;
  if (!progress.hidden) progress.value = job.progress;
  download.hidden = state !== 'ready';
  if (!download.hidden) {
    download.href = `/api/jobs/${job.id}/file`;
    setText(download, `Download ${job.format.toUpperCase()}`);
  } else {
    download.removeAttribute('href');
  }
  stopButton.hidden = state !== 'recording';
  cancelButton.hidden = !busy || state === 'cancelling';
  stopButton.disabled = commandRunning;
  cancelButton.disabled = commandRunning && !uploadRequest;
  byId('actions').hidden = download.hidden && stopButton.hidden && cancelButton.hidden;
  updateSubmit();
}

function showHealth(next, text) {
  health = next;
  byId('host-status').dataset.health = next;
  setText(byId('host-label'), text);
  updateSubmit();
}

function scheduleRefresh(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, delay);
}

async function refresh() {
  if (commandRunning || refreshing) return;
  refreshing = true;
  const priorRevision = revision;
  try {
    const timeout = working.has(job?.state) ? 8000 : 90000;
    const response = await fetch('/api/status', { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error('Host unreachable');
    const status = await response.json();
    if (priorRevision !== revision || commandRunning) return;
    if (status.missing.length) {
      showHealth('setup', 'Setup needed');
      message(`Missing ${status.missing.join(', ')}. Run the Windows launcher or follow the setup guide.`);
    } else {
      showHealth('ready', status.hosted ? 'Private converter online' : 'This device online');
    }
    renderJob(status.job);
  } catch {
    if (priorRevision === revision && !commandRunning) showHealth('offline', 'Host offline');
  } finally {
    refreshing = false;
    if (working.has(job?.state)) scheduleRefresh(1000);
    else if (health === 'offline' && !document.hidden) scheduleRefresh(15000);
  }
}

async function command(path, data = {}) {
  commandRunning = true;
  revision += 1;
  renderJob(job);
  message('');
  try {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      signal: AbortSignal.timeout(path === '/api/jobs' ? 90000 : 12000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    renderJob(result.job);
    return true;
  } catch (error) {
    message(error.name === 'TimeoutError' || error instanceof TypeError ? 'The host didn’t respond. Check that Clipdeck is running.' : error.message);
    return false;
  } finally {
    commandRunning = false;
    renderJob(job);
    scheduleRefresh(250);
  }
}

function showMode(next) {
  const uploading = next === 'upload';
  form.hidden = uploading;
  compressForm.hidden = !uploading;
  byId('youtube-tab').setAttribute('aria-selected', String(!uploading));
  byId('upload-tab').setAttribute('aria-selected', String(uploading));
  updateSubmit();
}

function showGoal() {
  const kind = compressForm.elements.goal.value;
  const visible = kind !== 'auto';
  byId('goal-input-container').hidden = !visible;
  goalField.disabled = !visible;
  goalField.required = visible;
  if (visible) {
    const percent = kind === 'percent';
    goalField.min = percent ? '1' : '0.1';
    goalField.max = percent ? '95' : '200';
    goalField.step = percent ? '1' : '0.1';
    goalField.value = String(savedGoals[kind]);
    setText(byId('goal-value-label'), percent ? 'Reduce original size by (%)' : 'Target size (MB)');
  }
}

function startCompression(event) {
  event.preventDefault();
  if (compressButton.disabled || !compressForm.reportValidity()) return;
  const file = fileField.files[0];
  if (!/\.(mp4|mov|m4v|mkv|webm|avi|wmv|mpeg|mpg)$/i.test(file.name)) {
    message('Choose a supported video file (MP4, MOV, MKV, WEBM, AVI, WMV or MPEG).');
    return;
  }
  const goal = compressForm.elements.goal.value;
  const value = goal === 'auto' ? 0 : Number(goalField.value);
  if (goal !== 'auto' && (goal === 'percent' ? !(value >= 1 && value <= 95) : !(value >= .1 && value <= 200))) {
    message('Choose a valid reduction percentage or target size.');
    return;
  }
  const preset = compressForm.elements.preset.value;
  const params = new URLSearchParams({ preset, goal, value: String(value) });
  const xhr = new XMLHttpRequest();
  uploadRequest = xhr;
  commandRunning = true;
  revision += 1;
  clearTimeout(pollTimer);
  message('');
  renderJob({ kind: 'upload', state: 'uploading', progress: 0, format: 'mp4', title: file.name });
  xhr.open('POST', `/api/uploads?${params}`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('X-Clipdeck-Filename', encodeURIComponent(file.name));
  xhr.upload.onprogress = event => {
    if (event.lengthComputable && job?.state === 'uploading') {
      renderJob({ ...job, progress: Math.min(99, 100 * event.loaded / event.total) });
    }
  };
  xhr.onload = () => {
    let data;
    try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
    if (xhr.status >= 200 && xhr.status < 300 && data.job) renderJob(data.job);
    else {
      const error = data.error || 'The upload failed. Check that the server is online.';
      renderJob({ kind: 'upload', state: 'failed', error, title: file.name });
      message(error);
    }
  };
  xhr.onerror = () => {
    const error = 'The upload failed. Check your connection and try again.';
    renderJob({ kind: 'upload', state: 'failed', title: file.name, error });
    message(error);
  };
  xhr.onabort = () => renderJob({ kind: 'upload', state: 'cancelled', title: file.name });
  xhr.onloadend = () => {
    if (uploadRequest === xhr) uploadRequest = null;
    commandRunning = false;
    renderJob(job);
    scheduleRefresh(250);
  };
  xhr.send(file);
}

form.addEventListener('change', event => {
  if (event.target.name === 'format') showQualities();
  if (event.target.name === 'quality') selected[form.elements.format.value] = Number(event.target.value);
});
source.addEventListener('input', () => message(''));
fileField.addEventListener('change', () => {
  message(fileField.files[0]?.size > maxUploadBytes ? 'Files must be 200 MB or smaller.' : '');
  updateSubmit();
});
goalField.addEventListener('change', () => {
  const kind = compressForm.elements.goal.value;
  if (kind !== 'auto' && goalField.validity.valid) savedGoals[kind] = Number(goalField.value);
});
compressForm.addEventListener('change', event => {
  if (event.target.name === 'goal') showGoal();
});
byId('youtube-tab').addEventListener('click', () => showMode('youtube'));
byId('upload-tab').addEventListener('click', () => showMode('upload'));
compressForm.addEventListener('submit', startCompression);
byId('paste').addEventListener('click', async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) {
      source.value = text;
      message('');
    }
  } catch {
    message('Paste the link into the field using your usual paste shortcut.');
  }
  source.focus();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (convertButton.disabled) return;
  const data = new FormData(form);
  const ok = await command('/api/jobs', { url: String(data.get('url')).trim(), format: data.get('format'), quality: Number(data.get('quality')) });
  if (ok && matchMedia('(max-width: 800px)').matches) byId('result').scrollIntoView({ block: 'center' });
});
stopButton.addEventListener('click', () => command(`/api/jobs/${job.id}/stop`));
cancelButton.addEventListener('click', () => {
  if (uploadRequest) uploadRequest.abort();
  else if (job?.id) command(`/api/jobs/${job.id}/cancel`);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh(0);
});
showQualities();
showGoal();
refresh();
