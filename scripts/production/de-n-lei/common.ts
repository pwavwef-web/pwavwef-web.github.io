import '../../../tests/acceptance/setup';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export * from '../../../tests/acceptance/harness';
export { col, bucket, db, FieldValue } from '../../../functions/src/lib/firebase';

export const ROOT = process.cwd(); // the runner always starts in the repository root
export const OUT = path.join(ROOT, 'exports', 'de-n-lei-come-learn-kasem-2026-10');
export const STATE_FILE = path.join(OUT, 'production-state.json');
export const SONG_WAV = 'C:/Users/DELL/Downloads/De N Lei — Come Learn Kasem.wav';
export const PORTRAIT = 'C:/Users/DELL/AppData/Local/Temp/claude/C--Users-DELL-Desktop-indigen-world/fd8ab698-812b-498a-b697-d07efd7e3b48/images/1.jpg';

/** Everything the later steps need (ids of the project, song, assets, characters, shots…). Small, human-readable, resumable. */
export type State = Record<string, any>;
export function loadState(): State {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
}
export function saveState(s: State): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
export function patchState(p: State): State {
  const s = { ...loadState(), ...p };
  saveState(s);
  return s;
}
export const say = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
