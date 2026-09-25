import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export const WEB_PORT = 5199;
const root = path.resolve(import.meta.dirname, '../..');

async function waitForHttp(url: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`${url} did not start in ${ms / 1000} s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

let vite: ChildProcess | null = null;

/** Starts the web app in emulator mode (demo project, no App Check, no real Firebase config). */
export async function setup(): Promise<void> {
  vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(root, 'apps/web'),
    env: {
      ...process.env,
      VITE_USE_EMULATORS: 'true',
      VITE_FIREBASE_API_KEY: 'demo-key',
      VITE_FIREBASE_APP_ID: '1:1:web:e2e',
      VITE_FIREBASE_PROJECT_ID: 'demo-az-studio',
      VITE_FIREBASE_AUTH_DOMAIN: 'demo-az-studio.firebaseapp.com',
      VITE_FIRESTORE_DATABASE: 'az-studio',
      VITE_MEDIA_BUCKET: 'az-studio-media-az-learner',
      VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: '',
    },
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  await waitForHttp(`http://127.0.0.1:${WEB_PORT}/`, 120_000);
}

export async function teardown(): Promise<void> {
  if (!vite?.pid) return;
  // Only the dev server this setup started (and its children) is stopped.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
  else vite.kill('SIGTERM');
}
