#!/usr/bin/env node
// Cuts a release: tags the clean HEAD as studio-vYYYY.MM.DD.N (annotated), then optionally deploys it.
//   node scripts/release.mjs              → tag only (prints the tag)
//   node scripts/release.mjs --deploy …   → tag, then scripts/deploy.mjs with the remaining arguments
import { execFileSync } from 'node:child_process';
import { dirtyFiles, git, headTag, nextTag, root, TAG_PREFIX } from './lib/release.mjs';

const args = process.argv.slice(2);
const dirty = dirtyFiles();
if (dirty.length) {
  console.error(`Refusing to release: the working tree has changes that would not be in the release:\n  ${dirty.join('\n  ')}`);
  process.exit(1);
}
let tag = headTag();
if (tag) {
  console.log(`HEAD is already released as ${tag}.`);
} else {
  tag = nextTag(git(['tag', '--list', `${TAG_PREFIX}*`]).split('\n').filter(Boolean));
  const subject = git(['log', '-1', '--format=%s']);
  git(['tag', '-a', tag, '-m', `AZ Studio ${tag.slice(TAG_PREFIX.length)}\n\n${subject}`]);
  console.log(`Tagged ${git(['rev-parse', '--short=8', 'HEAD'])} as ${tag}.`);
}
if (args.includes('--deploy')) {
  execFileSync('node', ['scripts/deploy.mjs', ...args.filter((a) => a !== '--deploy')], { cwd: root, stdio: 'inherit' });
}
