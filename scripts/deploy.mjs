#!/usr/bin/env node
// Orchestrated AZ Studio deploy. Everything is scoped so the shared `az-learner` project's other
// apps (their Hosting sites, databases, buckets and functions) are never touched:
//   hosting:studio  → site az-studio only
//   firestore       → database az-studio only (rules + indexes)
//   storage         → bucket az-studio-media-az-learner only
//   functions:az-studio → codebase az-studio only
// Usage: node scripts/deploy.mjs [--skip-checks] [--only=renderer,stems,rules,functions,hosting]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const project = process.env.AZS_PROJECT ?? 'az-learner';
const region = 'us-central1';
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only='))?.slice(7) ?? 'renderer,stems,rules,functions,hosting').split(',');
const win = process.platform === 'win32';
// The CLI loads the functions bundle locally to read its triggers and gives up after 10 s by default,
// which a busy workstation can exceed; allow two minutes.
process.env.FUNCTIONS_DISCOVERY_TIMEOUT ??= '120';

function run(cmd, cmdArgs, opts = {}) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`);
  execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root, shell: win, ...opts });
}

if (!args.includes('--skip-checks')) {
  run('npm', ['run', 'lint']);
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);
}

run('node', ['scripts/render-rules.mjs']);
run('node', ['scripts/write-web-env.mjs']);

if (only.includes('renderer')) {
  run('npm', ['run', 'build', '-w', 'services/renderer']);
  run('gcloud', [
    'run', 'jobs', 'deploy', 'az-studio-renderer',
    '--source', 'services/renderer',
    '--region', region,
    '--project', project,
    `--service-account=az-studio-renderer@${project}.iam.gserviceaccount.com`,
    '--tasks=1', '--max-retries=0', '--task-timeout=6h',
    '--cpu=4', '--memory=16Gi',
    '--set-env-vars=AZS_FIRESTORE_DATABASE=az-studio,AZS_MEDIA_BUCKET=az-studio-media-az-learner,MEDIA_ROOT=/media,FONTS_DIR=/app/fonts',
    '--add-volume=name=media,type=cloud-storage,bucket=az-studio-media-az-learner,readonly=true',
    '--add-volume-mount=volume=media,mount-path=/media',
    '--labels=app=az-studio',
    '--quiet',
  ]);
  run('gcloud', ['run', 'jobs', 'add-iam-policy-binding', 'az-studio-renderer', '--region', region, '--project', project, `--member=serviceAccount:az-studio-api@${project}.iam.gserviceaccount.com`, '--role=roles/run.developer', '--format=none']);
}

if (only.includes('stems')) {
  // Demucs stem separation (Python + CPU torch; the model weights are baked into the image).
  run('gcloud', [
    'run', 'jobs', 'deploy', 'az-studio-stems',
    '--source', 'services/stems',
    '--region', region,
    '--project', project,
    `--service-account=az-studio-renderer@${project}.iam.gserviceaccount.com`,
    '--tasks=1', '--max-retries=0', '--task-timeout=2h',
    '--cpu=4', '--memory=16Gi',
    '--set-env-vars=AZS_MEDIA_BUCKET=az-studio-media-az-learner',
    '--labels=app=az-studio',
    '--quiet',
  ]);
  run('gcloud', ['run', 'jobs', 'add-iam-policy-binding', 'az-studio-stems', '--region', region, '--project', project, `--member=serviceAccount:az-studio-api@${project}.iam.gserviceaccount.com`, '--role=roles/run.developer', '--format=none']);
}

const targets = [];
if (only.includes('rules')) targets.push('firestore', 'storage');
if (only.includes('functions')) targets.push('functions:az-studio');
if (only.includes('hosting')) {
  run('npm', ['run', 'build', '-w', 'apps/web']);
  targets.push('hosting:studio');
}
if (targets.length) run('firebase', ['deploy', '--only', targets.join(','), '--project', project, '--non-interactive']);
console.log('\nAZ Studio deploy finished.');
