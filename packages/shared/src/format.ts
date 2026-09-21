import type { Time } from './types';

export function toMillis(t: Time | number | Date): number | null {
  if (t === null || t === undefined) return null;
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  if (typeof (t as { toMillis?: unknown }).toMillis === 'function') return (t as { toMillis(): number }).toMillis();
  return null;
}

/** 83.4 → "1:23.4" (or "1:23" when `decimals` is 0). */
export function formatTimecode(sec: number, decimals = 1): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const whole = Math.floor(s);
  const frac = decimals > 0 ? `.${Math.floor((s - whole) * 10 ** decimals).toString().padStart(decimals, '0')}` : '';
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${(m % 60).toString().padStart(2, '0')}:${whole.toString().padStart(2, '0')}${frac}`;
  return `${m}:${whole.toString().padStart(2, '0')}${frac}`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.round(sec * 10) / 10}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${(m % 60).toString().padStart(2, '0')}m`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatUsd(usd: number | null | undefined, opts: { precise?: boolean } = {}): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return opts.precise ? `$${usd.toFixed(4)}` : '<$0.01';
  return `$${usd.toFixed(usd < 10 ? 2 : usd < 1000 ? 2 : 0)}`;
}

export function relativeTime(ms: number | null, now = Date.now()): string {
  if (ms === null) return '';
  const d = Math.round((now - ms) / 1000);
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
