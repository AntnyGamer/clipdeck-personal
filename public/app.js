'use strict';

const byId = id => document.getElementById(id);
const form = byId('convert-form');
const source = byId('url');
const convertButton = byId('convert');
const choices = byId('qualities');
const progress = byId('progress');
const cancelButton = byId('cancel');
const stopButton = byId('stop');
const download = byId('download');
const options = { mp4: [480, 720, 1080, 1440, 2160], mp3: [96, 128, 192, 256, 320] };
const selected = { mp4: 1080, mp3: 192 };
const labels = {
  idle: 'Idle', checking: 'Checking link', downloading: 'Downloading', connecting: 'Connecting', recording: 'Recording',
  stopping: 'Saving recording', converting: 'Converting', cancelling: 'Cancelling', cancelled: 'Cancelled',
  ready: 'Ready', failed: 'Failed',
};
const working = new Set(['checking', 'downloading', 'connecting', 'recording', 'stopping', 'converting', 'cancelling']);
let job = null;
let health = 'connecting';
let commandRunning = false;
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
  const label = commandRunning && !busy ? 'Connecting…' : `Convert to ${form.elements.format.value.toUpperCase()}`;
  setText(convertButton, busy ? 'Conversion in progress' : label);
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
    case 'checking': return 'Reading the YouTube link.';
    case 'downloading': return current.progress == null ? 'Fetching media from YouTube.' : `Downloading source · ${Math.floor(current.progress)}%`;
    case 'connecting': return 'Waiting for the first live segment.';
    case 'recording': return `${timeLabel(current.recorded)} recorded. Stop & save to finish.`;
    case 'stopping': return 'Finishing the captured segment.';
    case 'converting': return current.progress == null ? 'Preparing your file.' : `Preparing your file · ${Math.floor(current.progress)}%`;
    case 'cancelling': return 'Stopping the conversion.';
    case 'cancelled': return 'You can start another conversion.';
    case 'failed': return current.error;
    case 'ready': return [`${current.format.toUpperCase()} · ${sizeLabel(current.size)}`, current.notice].filter(Boolean).join(' · ');
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
  progress.hidden = !busy || !['downloading', 'converting'].includes(state) || job.progress == null;
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
  stopButton.disabled = cancelButton.disabled = commandRunning;
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

form.addEventListener('change', event => {
  if (event.target.name === 'format') showQualities();
  if (event.target.name === 'quality') selected[form.elements.format.value] = Number(event.target.value);
});
source.addEventListener('input', () => message(''));
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
cancelButton.addEventListener('click', () => command(`/api/jobs/${job.id}/cancel`));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh(0);
});
showQualities();
refresh();
