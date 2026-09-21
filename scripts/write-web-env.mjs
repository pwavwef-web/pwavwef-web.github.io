#!/usr/bin/env node
// Writes apps/web/.env.production.local (gitignored) with the AZ Studio web app's public client config.
// Values are identifiers, not secrets: access is enforced by Auth, App Check, rules and the owner-only API.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const project = process.env.AZS_PROJECT ?? 'az-learner';
const appId = process.env.AZS_WEB_APP_ID ?? '1:12958795950:web:06bec3bbdd07bc1c40453f';
const keyUid = process.env.AZS_API_KEY_UID ?? '285f1999-1230-459c-8130-b92997351c30';
const siteKey = process.env.AZS_RECAPTCHA_SITE_KEY ?? '6LdFocctAAAAALokyF-11B8GNs0NZwC7_SL56ES4';
const win = process.platform === 'win32';

const raw = execFileSync('firebase', ['apps:sdkconfig', 'WEB', appId, '--project', project], { encoding: 'utf8', shell: win });
const cfg = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
// Use the referrer-restricted "AZ Studio Web" API key instead of the project-wide browser key.
const apiKey = execFileSync('gcloud', ['services', 'api-keys', 'get-key-string', keyUid, '--project', project, '--format=value(keyString)'], { encoding: 'utf8', shell: win }).trim();
if (!apiKey.startsWith('AIza')) throw new Error('Could not read the AZ Studio API key.');

const env = {
  VITE_FIREBASE_API_KEY: apiKey,
  VITE_FIREBASE_AUTH_DOMAIN: cfg.authDomain,
  VITE_FIREBASE_PROJECT_ID: cfg.projectId,
  VITE_FIREBASE_APP_ID: cfg.appId,
  VITE_FIREBASE_MESSAGING_SENDER_ID: cfg.messagingSenderId,
  VITE_FIRESTORE_DATABASE: 'az-studio',
  VITE_MEDIA_BUCKET: 'az-studio-media-az-learner',
  VITE_FUNCTIONS_REGION: 'us-central1',
  VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: siteKey,
  VITE_USE_EMULATORS: 'false',
};
writeFileSync(`${root}/apps/web/.env.production.local`, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
console.log('Wrote apps/web/.env.production.local');
