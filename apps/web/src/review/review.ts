import './review.css';

/**
 * Client review page (/review/{token}). No Firebase SDK, no login, no cookies, no studio code: it reads the review
 * from /api/public/review/{token}, plays the render through the stable media route (a fresh 1-hour signed link on
 * every load), and posts comments pinned to the playhead and an approve / request-changes decision.
 */

interface Decision {
  decision: 'approved' | 'changes_requested';
  name: string;
  note: string;
  at: number;
}
interface Review {
  title: string;
  projectTitle: string;
  versionLabel: string;
  durationSec: number;
  expiresAt: number;
  status: 'open' | 'approved' | 'changes_requested';
  decisions: Decision[];
  comments: { id: string; atSec: number; text: string; name: string; createdAt: number }[];
  mediaUrl: string;
}

const root = document.getElementById('review') as HTMLElement;
const token = (/^\/review\/([A-Za-z0-9_-]{32})\/?$/.exec(location.pathname) ?? [])[1] ?? null;
const api = `/api/public/review/${token}`;
const NAME_KEY = 'az-review-name';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null) e.append(k);
  return e;
};
const tc = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const STATUS: Record<Review['status'], string> = { open: 'Waiting for review', approved: 'Approved', changes_requested: 'Changes requested' };

function state(message: string) {
  root.replaceChildren(el('p', { class: 'rv-state' }, message));
}

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
function saveName(n: string) {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    /* private mode: the name is simply not remembered */
  }
}

async function post(path: string, body: unknown): Promise<Review> {
  const r = await fetch(`${api}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as Review & { message?: string };
  if (!r.ok) throw new Error(j.message ?? (r.status === 410 ? 'This review link is no longer open.' : 'That did not go through. Try again.'));
  return j;
}

function render(data: Review) {
  const video = el('video', { controls: '', preload: 'metadata', playsinline: '', src: data.mediaUrl });
  const list = el('ul', { class: 'rv-comments' });
  const fill = (d: Review) => {
    list.replaceChildren(
      ...(d.comments.length
        ? d.comments.map((c) => {
            const t = el('button', { class: 'rv-time', type: 'button', 'aria-label': `Play from ${tc(c.atSec)}` }, tc(c.atSec));
            t.addEventListener('click', () => {
              video.currentTime = c.atSec;
              void video.play().catch(() => undefined);
            });
            return el('li', {}, t, el('span', { class: 'rv-who' }, c.name), el('p', { class: 'rv-text' }, c.text));
          })
        : [el('li', {}, el('p', { class: 'rv-empty' }, 'No comments yet. Pause where something should change and write it below.'))]),
    );
    badge.textContent = STATUS[d.status];
    badge.className = `rv-badge ${d.status}`;
    decisions.replaceChildren(...d.decisions.map((x) => el('li', {}, `${x.decision === 'approved' ? 'Approved' : 'Changes requested'} by ${x.name} · ${new Date(x.at).toLocaleString()}${x.note ? ` — ${x.note}` : ''}`)));
  };

  const name = el('input', { id: 'rv-name', maxlength: '60', autocomplete: 'name', placeholder: 'Your name', value: savedName() });
  const text = el('textarea', { id: 'rv-text', maxlength: '1000', placeholder: 'What should change at this moment?' });
  const at = el('span', { class: 'rv-hint' }, 'at 0:00');
  video.addEventListener('timeupdate', () => (at.textContent = `at ${tc(video.currentTime)}`));
  const send = el('button', { class: 'rv-btn primary', type: 'button' }, 'Add comment');
  const error = el('p', { class: 'rv-error', role: 'alert' });
  const busy = (b: boolean) => [send, approve, changes].forEach((x) => (x.disabled = b));
  const submit = async (path: 'comments' | 'decision', body: Record<string, unknown>) => {
    error.textContent = '';
    busy(true);
    try {
      saveName(name.value.trim());
      const d = await post(path, { ...body, name: name.value });
      fill(d);
      return true;
    } catch (e) {
      error.textContent = (e as Error).message;
      return false;
    } finally {
      busy(false);
    }
  };
  send.addEventListener('click', () => {
    void submit('comments', { atSec: video.currentTime, text: text.value }).then((ok) => ok && (text.value = ''));
  });

  const note = el('textarea', { id: 'rv-note', maxlength: '1000', placeholder: 'Optional when approving; say what should change when requesting changes.' });
  const approve = el('button', { class: 'rv-btn approve', type: 'button' }, 'Approve this version');
  const changes = el('button', { class: 'rv-btn', type: 'button' }, 'Request changes');
  approve.addEventListener('click', () => void submit('decision', { decision: 'approved', note: note.value }));
  changes.addEventListener('click', () => void submit('decision', { decision: 'changes_requested', note: note.value }));

  const badge = el('span', { class: 'rv-badge' });
  const decisions = el('ul', { class: 'rv-decisions' });
  root.replaceChildren(
    el(
      'header',
      { class: 'rv-head' },
      el('div', {}, el('p', { class: 'rv-eyebrow' }, 'AZ Studio · review'), el('h1', { class: 'rv-title' }, data.title), el('p', { class: 'rv-meta' }, [data.projectTitle !== data.title ? data.projectTitle : '', data.versionLabel, `${tc(data.durationSec)} long`, `link open until ${new Date(data.expiresAt).toLocaleDateString()}`].filter(Boolean).join(' · '))),
      badge,
    ),
    el(
      'div',
      { class: 'rv-grid' },
      el('div', { class: 'rv-player' }, video),
      el(
        'aside',
        {},
        el('section', { class: 'rv-card' }, el('h2', {}, 'Comments'), list),
        el('section', { class: 'rv-card' }, el('h2', {}, 'Add a comment'), el('label', { for: 'rv-name' }, 'Name'), name, el('label', { for: 'rv-text' }, 'Comment'), text, el('div', { class: 'rv-row' }, send, at), error),
        el('section', { class: 'rv-card' }, el('h2', {}, 'Decision'), el('label', { for: 'rv-note' }, 'Note'), note, el('div', { class: 'rv-row' }, approve, changes), decisions),
      ),
    ),
    el('p', { class: 'rv-foot' }, 'This private link was shared with you for review. Please do not forward it.'),
  );
  fill(data);
}

async function load() {
  if (!token) return state('This review link is not valid.');
  try {
    const r = await fetch(api, { headers: { Accept: 'application/json' } });
    if (r.status === 410) return state(((await r.json().catch(() => ({}))) as { message?: string }).message ?? 'This review link is no longer open.');
    if (!r.ok) return state(r.status === 404 ? 'This review link is not valid.' : 'The review could not be loaded. Try again in a moment.');
    const data = (await r.json()) as Review;
    document.title = `${data.title} — review`;
    render(data);
  } catch {
    state('The review could not be loaded. Check your connection and try again.');
  }
}

void load();
