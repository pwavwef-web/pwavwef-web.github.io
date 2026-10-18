import './player.css';

/**
 * The Pwavwe Papers public audio player (/embed/audio/{id}). Deliberately tiny: no Firebase SDK, no login,
 * no cookies, no studio code. It reads the published revision's public metadata from /api/public/audio/{id}
 * and plays the stable audio route, which resolves to a fresh short-lived media link on every load — so the
 * URL pasted into Blogger never expires. Nothing is downloaded until the listener presses play.
 */

interface PublicEdition {
  id: string;
  revision: number;
  title: string;
  author: string;
  publication: string;
  publishedDate: string | null;
  articleUrl: string | null;
  durationSec: number;
  sections: { title: string; startSec: number }[];
  peaks: number[];
  audio: { url: string; mimeType: string; bytes: number };
}

type Loaded = { kind: 'ok'; data: PublicEdition } | { kind: 'unpublished' } | { kind: 'not_found' } | { kind: 'error' };

const root = document.getElementById('player') as HTMLElement;
const standalone = window.top === window.self;
if (standalone) document.body.classList.add('pp-standalone');

const id = (/^\/embed\/audio\/([A-Za-z0-9]{12})\/?$/.exec(location.pathname) ?? [])[1] ?? null;

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11.13-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/></svg>',
  vol: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
  mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm15.6 3 2.1-2.1-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4z"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function spoken(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m} minute${m === 1 ? '' : 's'} ${r} second${r === 1 ? '' : 's'}`;
}

async function load(): Promise<Loaded> {
  if (!id) return { kind: 'not_found' };
  try {
    const res = await fetch(`/api/public/audio/${id}`, { credentials: 'omit', headers: { accept: 'application/json' } });
    if (res.status === 410) return { kind: 'unpublished' };
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) return { kind: 'error' };
    return { kind: 'ok', data: (await res.json()) as PublicEdition };
  } catch {
    return { kind: 'error' };
  }
}

function showState(title: string, body: string, retry = false) {
  root.replaceChildren();
  root.setAttribute('aria-busy', 'false');
  const p = el('p', { class: 'pp-state', role: 'status' });
  p.append(el('strong', {}, title), document.createTextNode(body));
  if (retry) {
    const b = el('button', { class: 'pp-btn', type: 'button' }, 'Try again');
    b.addEventListener('click', () => void start());
    p.append(el('br'), b);
  }
  root.append(p);
}

function drawWave(canvas: HTMLCanvasElement, peaks: number[], progress: number) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h || !peaks.length) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  if (!g) return;
  g.scale(dpr, dpr);
  const style = getComputedStyle(document.documentElement);
  const done = style.getPropertyValue('--pp-wave-done').trim() || '#1d4fb8';
  const rest = style.getPropertyValue('--pp-wave').trim() || 'rgba(29,79,184,.25)';
  const bars = Math.max(1, Math.floor(w / 3));
  const max = Math.max(0.05, ...peaks);
  for (let i = 0; i < bars; i++) {
    const a = Math.floor((i / bars) * peaks.length);
    const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length));
    let v = 0;
    for (let j = a; j < b; j++) v = Math.max(v, peaks[j] ?? 0);
    const bh = Math.max(2, (v / max) * (h - 2));
    g.fillStyle = i / bars < progress ? done : rest;
    g.fillRect(i * 3, (h - bh) / 2, 2, bh);
  }
}

function render(d: PublicEdition) {
  root.replaceChildren();
  root.setAttribute('aria-busy', 'false');
  root.setAttribute('aria-live', 'off');
  root.setAttribute('aria-label', `Audio edition: ${d.title}`);
  document.title = `${d.title} — ${d.publication} (audio)`;

  const head = el('div', { class: 'pp-head' });
  const meta = el('div', { class: 'pp-meta' });
  const kicker = el('p', { class: 'pp-kicker' }, d.publication);
  kicker.append(el('span', { class: 'pp-kicker-more' }, ' · Listen to this paper'));
  meta.append(kicker, el('h1', { class: 'pp-title' }, d.title), el('p', { class: 'pp-author' }, `Written and read by ${d.author}`));
  head.append(el('div', { class: 'pp-mark', 'aria-hidden': 'true' }, 'PP'), meta);

  const audio = el('audio', { preload: 'none' });
  audio.src = d.audio.url;
  let total = d.durationSec;
  let revision = d.revision;

  const play = el('button', { class: 'pp-play', type: 'button', 'aria-label': 'Play' });
  play.innerHTML = ICON.play;
  const seekWrap = el('div', { class: `pp-seekwrap${d.peaks.length ? '' : ' pp-noWave'}` });
  const canvas = el('canvas', { class: 'pp-wave', 'aria-hidden': 'true' });
  const seek = el('input', { class: 'pp-seek', type: 'range', min: '0', max: String(Math.round(total * 10) / 10), step: '0.1', value: '0', 'aria-label': 'Seek' });
  seekWrap.append(canvas, seek);
  const main = el('div', { class: 'pp-main' });
  main.append(play, seekWrap);

  const time = el('span', { class: 'pp-time', 'aria-hidden': 'true' }, `0:00 / ${clock(total)}`);
  const back = el('button', { class: 'pp-btn', type: 'button', 'aria-label': 'Back 15 seconds' });
  back.innerHTML = `${ICON.back}<span>15</span>`;
  const fwd = el('button', { class: 'pp-btn', type: 'button', 'aria-label': 'Forward 15 seconds' });
  fwd.innerHTML = `${ICON.fwd}<span>15</span>`;
  const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];
  let speedIx = 0;
  const speed = el('button', { class: 'pp-btn', type: 'button', 'aria-label': 'Playback speed 1 times' }, '1×');
  const vol = el('span', { class: 'pp-vol' });
  const mute = el('button', { class: 'pp-btn', type: 'button', 'aria-label': 'Mute', 'aria-pressed': 'false' });
  mute.innerHTML = ICON.vol;
  const volume = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': 'Volume' });
  vol.append(mute, volume);
  // Some devices (iOS) do not let pages set the volume: offer only what works.
  audio.volume = 0.5;
  const volumeWorks = Math.abs(audio.volume - 0.5) < 0.01;
  audio.volume = 1;
  if (!volumeWorks) volume.classList.add('pp-hidden');
  const bar = el('div', { class: 'pp-bar' });
  bar.append(time, back, fwd, speed, vol);

  const live = el('span', { class: 'pp-sr', 'aria-live': 'polite' });
  root.append(head, main, bar, live, audio);
  if (standalone && d.articleUrl) {
    const foot = el('p', { class: 'pp-foot' });
    const a = el('a', { class: 'pp-link', href: d.articleUrl, rel: 'noopener' }, 'Read the paper');
    foot.append(a, document.createTextNode(` · ${d.publication}`));
    root.append(foot);
  }

  let dragging = false;
  let pendingSeek: number | null = null;
  const current = () => (pendingSeek ?? audio.currentTime) || 0;
  const update = () => {
    const t = current();
    if (!dragging) seek.value = String(Math.round(t * 10) / 10);
    seek.setAttribute('aria-valuetext', `${spoken(t)} of ${spoken(total)}`);
    time.textContent = `${clock(t)} / ${clock(total)}`;
    drawWave(canvas, d.peaks, total ? t / total : 0);
  };
  const goTo = (t: number) => {
    const target = Math.max(0, Math.min(total, t));
    // Before the first play, nothing has been fetched: remember the position and apply it on play.
    if (audio.readyState < 1) pendingSeek = target;
    else audio.currentTime = target;
    update();
  };
  const toggle = () => {
    if (audio.paused) {
      void audio.play().catch(() => {
        live.textContent = 'Playback could not start.';
      });
    } else audio.pause();
  };

  play.addEventListener('click', toggle);
  back.addEventListener('click', () => goTo(current() - 15));
  fwd.addEventListener('click', () => goTo(current() + 15));
  speed.addEventListener('click', () => {
    speedIx = (speedIx + 1) % SPEEDS.length;
    audio.playbackRate = SPEEDS[speedIx]!;
    speed.textContent = `${SPEEDS[speedIx]}×`;
    speed.setAttribute('aria-label', `Playback speed ${SPEEDS[speedIx]} times`);
  });
  mute.addEventListener('click', () => {
    audio.muted = !audio.muted;
    mute.innerHTML = audio.muted ? ICON.mute : ICON.vol;
    mute.setAttribute('aria-pressed', String(audio.muted));
    mute.setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute');
  });
  volume.addEventListener('input', () => {
    audio.volume = Number(volume.value);
    if (audio.muted && audio.volume > 0) mute.click();
  });
  seek.addEventListener('input', () => {
    dragging = true;
    time.textContent = `${clock(Number(seek.value))} / ${clock(total)}`;
    drawWave(canvas, d.peaks, total ? Number(seek.value) / total : 0);
  });
  seek.addEventListener('change', () => {
    dragging = false;
    goTo(Number(seek.value));
  });
  root.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')) return;
    if (e.key === ' ' || e.key === 'k') {
      if (e.target instanceof HTMLButtonElement && e.key === ' ') return;
      e.preventDefault();
      toggle();
    } else if (e.key === 'j' || e.key === 'ArrowLeft') goTo(current() - 15);
    else if (e.key === 'l' || e.key === 'ArrowRight') goTo(current() + 15);
  });

  audio.addEventListener('play', () => {
    play.innerHTML = ICON.pause;
    play.setAttribute('aria-label', 'Pause');
  });
  audio.addEventListener('pause', () => {
    play.innerHTML = ICON.play;
    play.setAttribute('aria-label', 'Play');
  });
  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      total = audio.duration;
      seek.max = String(Math.round(total * 10) / 10);
    }
    if (pendingSeek !== null) {
      audio.currentTime = pendingSeek;
      pendingSeek = null;
    }
    audio.playbackRate = SPEEDS[speedIx]!;
  });
  audio.addEventListener('timeupdate', update);
  audio.addEventListener('ended', update);
  audio.addEventListener('ratechange', () => (live.textContent = `Speed ${audio.playbackRate} times`));

  // A media link can expire or the revision can be replaced while the page is open: re-resolve once.
  let recovering = false;
  audio.addEventListener('error', async () => {
    if (recovering) return;
    recovering = true;
    const at = audio.currentTime;
    const wasPlaying = !audio.paused;
    const fresh = await load();
    if (fresh.kind === 'unpublished') return showState('This audio edition is no longer available', 'The author has withdrawn it.');
    if (fresh.kind !== 'ok') {
      recovering = false;
      live.textContent = 'The audio could not be loaded. Press play to try again.';
      return;
    }
    if (fresh.data.revision !== revision) {
      revision = fresh.data.revision;
      live.textContent = 'This audio edition was updated.';
    }
    audio.src = `${fresh.data.audio.url}?t=${Date.now()}`;
    pendingSeek = at;
    if (wasPlaying) void audio.play().catch(() => undefined);
    recovering = false;
  });

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: d.title, artist: d.author, album: d.publication });
    navigator.mediaSession.setActionHandler('seekbackward', () => goTo(current() - 15));
    navigator.mediaSession.setActionHandler('seekforward', () => goTo(current() + 15));
  }
  new ResizeObserver(() => drawWave(canvas, d.peaks, total ? current() / total : 0)).observe(canvas);
  update();
}

async function start() {
  root.setAttribute('aria-busy', 'true');
  root.replaceChildren(el('p', { class: 'pp-state', role: 'status' }, 'Loading the audio edition…'));
  const r = await load();
  if (r.kind === 'ok') render(r.data);
  else if (r.kind === 'unpublished') showState('This audio edition is no longer available', 'The author has withdrawn it.');
  else if (r.kind === 'not_found') showState('Audio edition not found', 'Check the link, or read the paper on The Pwavwe Papers.');
  else showState('The audio could not be loaded', 'Check your connection. ', true);
}

void start();
