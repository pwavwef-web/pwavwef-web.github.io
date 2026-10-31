// Release train helpers shared by scripts/release.mjs and scripts/deploy.mjs.
// A release is an annotated git tag `studio-vYYYY.MM.DD.N` on a clean commit; deploys ship only tagged commits and
// stamp the tag and commit into every component (web build, functions env, renderer env) so Settings can show them.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const TAG_PREFIX = 'studio-v';
// Client production folders and exports are working files, not part of a studio release.
const IGNORED_UNTRACKED = [/^scripts\/production\//, /^exports\//];

export function git(args, { raw = false } = {}) {
  const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return raw ? out : out.trim();
}

/** Tracked changes and untracked files that would be left out of the release (empty = clean). */
export function dirtyFiles() {
  // Untrimmed: the first porcelain line can start with a space (" M file").
  return git(['status', '--porcelain'], { raw: true })
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2), path: l.slice(3).replace(/^"|"$/g, '') }))
    .filter((f) => !(f.code === '??' && IGNORED_UNTRACKED.some((re) => re.test(f.path))))
    .map((f) => `${f.code} ${f.path}`);
}

/** The release tag on HEAD, if any (the newest when several). */
export function headTag() {
  const tags = git(['tag', '--points-at', 'HEAD', '--list', `${TAG_PREFIX}*`]).split('\n').filter(Boolean);
  return tags.sort(compareTags).at(-1) ?? null;
}

export function compareTags(a, b) {
  const pa = a.slice(TAG_PREFIX.length).split('.').map(Number);
  const pb = b.slice(TAG_PREFIX.length).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Next tag for the given day: studio-v2026.10.31.1, .2, … */
export function nextTag(existing, now = new Date()) {
  const day = `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, '0')}.${String(now.getUTCDate()).padStart(2, '0')}`;
  const n = existing.filter((t) => t.startsWith(`${TAG_PREFIX}${day}.`)).map((t) => Number(t.split('.').at(-1)) || 0);
  return `${TAG_PREFIX}${day}.${Math.max(0, ...n) + 1}`;
}

export function releaseInfo() {
  const tag = headTag();
  return { tag, version: tag ? tag.slice(TAG_PREFIX.length) : null, commit: git(['rev-parse', 'HEAD']), short: git(['rev-parse', '--short=8', 'HEAD']) };
}

/**
 * CI status of a commit on GitHub (the `check` workflow): 'success' | 'failure' | 'pending' | 'unknown'.
 * 'unknown' means no run was found (commit not pushed, or gh not signed in) — the deploy then runs the checks locally.
 */
export function ciStatus(commit) {
  try {
    const out = execFileSync('gh', ['run', 'list', '--commit', commit, '--workflow', 'check.yml', '--json', 'status,conclusion', '--limit', '5'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    });
    const runs = JSON.parse(out);
    if (!runs.length) return 'unknown';
    if (runs.some((r) => r.status !== 'completed')) return 'pending';
    return runs.every((r) => r.conclusion === 'success') ? 'success' : 'failure';
  } catch {
    return 'unknown';
  }
}

/** Runs a step, retrying the whole (idempotent) step after a failure — this network often drops deploys half way. */
export function withRetries(label, fn, { attempts = 3, waitMs = 15_000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= attempts) throw e;
      console.warn(`\n${label} failed (attempt ${i} of ${attempts}); retrying in ${Math.round((waitMs * i) / 1000)} s…`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs * i);
    }
  }
}
