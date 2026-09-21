#!/usr/bin/env node
// Renders firebase/generated/{firestore,storage}.rules from the templates.
// The owner UID comes from Secret Manager (AZ_STUDIO_OWNER_UID) so it is never committed.
//   node scripts/render-rules.mjs          → production (reads the secret with gcloud)
//   node scripts/render-rules.mjs --test   → emulator tests (fixed test owner UID)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const test = process.argv.includes('--test');
const project = process.env.AZS_PROJECT ?? 'az-learner';

function ownerUid() {
  if (test) return 'owner-test-uid';
  if (process.env.AZ_STUDIO_OWNER_UID) return process.env.AZ_STUDIO_OWNER_UID.trim();
  const out = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret', 'AZ_STUDIO_OWNER_UID', '--project', project], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return out.trim();
}

const uid = ownerUid();
if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) {
  console.error('AZ_STUDIO_OWNER_UID is missing or malformed.');
  process.exit(1);
}
mkdirSync(`${root}/firebase/generated`, { recursive: true });
for (const name of ['firestore', 'storage']) {
  const tpl = readFileSync(`${root}/firebase/${name}.rules.template`, 'utf8');
  if (!tpl.includes('{{OWNER_UID}}')) throw new Error(`${name}.rules.template has no {{OWNER_UID}} placeholder`);
  writeFileSync(`${root}/firebase/generated/${name}.rules`, tpl.replaceAll('{{OWNER_UID}}', uid));
}
if (test) {
  // The functions emulator reads defineSecret() values from functions/.secret.local (gitignored).
  writeFileSync(`${root}/functions/.secret.local`, `AZ_STUDIO_OWNER_UID=${uid}\nAZ_STUDIO_OWNER_EMAIL=owner@test.dev\n`);
}
console.log(`Rendered security rules for ${test ? 'emulator tests' : 'production'} owner.`);
