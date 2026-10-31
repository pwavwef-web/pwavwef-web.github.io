#!/usr/bin/env node
// Orchestrated AZ Studio deploy. Everything is scoped so the shared `az-learner` project's other
// apps (their Hosting sites, databases, buckets and functions) are never touched:
//   hosting:studio  → site az-studio only
//   firestore       → database az-studio only (rules + indexes)
//   storage         → bucket az-studio-media-az-learner only
//   functions:az-studio → codebase az-studio only
// Usage: node scripts/deploy.mjs [--skip-checks] [--only=renderer,stems,rules,functions,hosting]
//
// Release train: only a clean commit tagged studio-v… (scripts/release.mjs) is deployed, and the tag and commit are
// stamped into the web build, the functions and the renderer. A commit whose GitHub `check` run failed (or is still
// running) is refused; when no run is known the checks run here instead. Rules are always re-rendered for the
// production owner and verified, and the network steps that often fail half way are retried (they are idempotent).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { ciStatus, dirtyFiles, releaseInfo, root, withRetries } from './lib/release.mjs';

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

const dirty = dirtyFiles();
if (dirty.length) {
  console.error(`Refusing to deploy: the working tree has changes that are not in a release:\n  ${dirty.join('\n  ')}`);
  process.exit(1);
}
const release = releaseInfo();
if (!release.tag) {
  console.error(`Refusing to deploy ${release.short}: it is not a release. Run \`node scripts/release.mjs --deploy\` to tag and deploy it.`);
  process.exit(1);
}
console.log(`Deploying AZ Studio ${release.version} (${release.short}).`);

const ci = ciStatus(release.commit);
if (ci === 'failure' || ci === 'pending') {
  console.error(`Refusing to deploy: the GitHub check run for ${release.short} is ${ci === 'failure' ? 'red' : 'still running'}.`);
  process.exit(1);
}
if (ci === 'success') console.log('GitHub checks passed for this commit.');
else if (!args.includes('--skip-checks')) {
  console.log('No GitHub check run found for this commit; running the checks here.');
  run('npm', ['run', 'lint']);
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);
}

// Rules are re-rendered for the production owner on every deploy (emulator runs leave a test owner behind) and the
// result is verified before anything ships.
run('node', ['scripts/render-rules.mjs']);
run('node', ['scripts/render-rules.mjs', '--verify']);
run('node', ['scripts/write-web-env.mjs']);

const stamp = { AZS_RELEASE: release.version, AZS_COMMIT: release.short };
// The functions read the stamp from process.env (Firebase loads functions/.env.<project> at deploy time; gitignored).
const envFile = `${root}/functions/.env.${project}`;
const kept = (() => {
  try {
    return readFileSync(envFile, 'utf8').split('\n').filter((l) => l && !/^AZS_(RELEASE|COMMIT)=/.test(l));
  } catch {
    return [];
  }
})();
writeFileSync(envFile, [...kept, ...Object.entries(stamp).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n');
const buildEnv = { env: { ...process.env, VITE_AZS_RELEASE: release.version, VITE_AZS_COMMIT: release.short } };

if (only.includes('renderer')) {
  run('npm', ['run', 'build', '-w', 'services/renderer']);
  withRetries('Renderer deploy', () =>
    run('gcloud', [
      'run', 'jobs', 'deploy', 'az-studio-renderer',
      '--source', 'services/renderer',
      '--region', region,
      '--project', project,
      `--service-account=az-studio-renderer@${project}.iam.gserviceaccount.com`,
      '--tasks=1', '--max-retries=0', '--task-timeout=6h',
      '--cpu=4', '--memory=16Gi',
      `--set-env-vars=AZS_FIRESTORE_DATABASE=az-studio,AZS_MEDIA_BUCKET=az-studio-media-az-learner,MEDIA_ROOT=/media,FONTS_DIR=/app/fonts,AZS_RELEASE=${release.version},AZS_COMMIT=${release.short}`,
      '--add-volume=name=media,type=cloud-storage,bucket=az-studio-media-az-learner,readonly=true',
      '--add-volume-mount=volume=media,mount-path=/media',
      '--labels=app=az-studio',
      '--quiet',
    ]),
  );
  withRetries('Renderer IAM', () => run('gcloud', ['run', 'jobs', 'add-iam-policy-binding', 'az-studio-renderer', '--region', region, '--project', project, `--member=serviceAccount:az-studio-api@${project}.iam.gserviceaccount.com`, '--role=roles/run.developer', '--format=none']));
}

if (only.includes('stems')) {
  // Demucs stem separation (Python + CPU torch; the model weights are baked into the image).
  withRetries('Stems deploy', () =>
    run('gcloud', [
      'run', 'jobs', 'deploy', 'az-studio-stems',
      '--source', 'services/stems',
      '--region', region,
      '--project', project,
      `--service-account=az-studio-renderer@${project}.iam.gserviceaccount.com`,
      '--tasks=1', '--max-retries=0', '--task-timeout=2h',
      '--cpu=4', '--memory=16Gi',
      `--set-env-vars=AZS_MEDIA_BUCKET=az-studio-media-az-learner,AZS_RELEASE=${release.version}`,
      '--labels=app=az-studio',
      '--quiet',
    ]),
  );
  withRetries('Stems IAM', () => run('gcloud', ['run', 'jobs', 'add-iam-policy-binding', 'az-studio-stems', '--region', region, '--project', project, `--member=serviceAccount:az-studio-api@${project}.iam.gserviceaccount.com`, '--role=roles/run.developer', '--format=none']));
}

const targets = [];
if (only.includes('rules')) targets.push('firestore', 'storage');
if (only.includes('functions')) targets.push('functions:az-studio');
if (only.includes('hosting')) {
  run('npm', ['run', 'build', '-w', 'apps/web'], buildEnv);
  targets.push('hosting:studio');
}
if (targets.length) withRetries('Firebase deploy', () => run('firebase', ['deploy', '--only', targets.join(','), '--project', project, '--non-interactive', '--message', `AZ Studio ${release.version} (${release.short})`]));
console.log(`\nAZ Studio ${release.version} deployed.`);
