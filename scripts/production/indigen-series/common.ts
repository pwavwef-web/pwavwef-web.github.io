import '../../../tests/acceptance/setup';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export * from '../../../tests/acceptance/harness';
export { col, bucket, db, FieldValue } from '../../../functions/src/lib/firebase';

/** The runner always starts in the repository root. */
export const ROOT = process.cwd();
export const OUT = path.join(ROOT, 'exports', 'indigen-contributor-series');
export const WORK = path.join(OUT, '_work');
export const STATE_FILE = path.join(WORK, 'state.json');

export type State = Record<string, any>;
export function loadState(): State {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
}
export function saveState(s: State): void {
  mkdirSync(WORK, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
export function patchState(p: State): State {
  const s = { ...loadState(), ...p };
  saveState(s);
  return s;
}
export const say = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
