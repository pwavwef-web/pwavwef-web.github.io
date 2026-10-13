// Bundles a production entry (TypeScript, may import the studio's server modules and @az-studio/shared)
// with esbuild and runs it with Node, against the live az-learner project using Application Default Credentials.
//   AZS_ACCEPTANCE=1 node scripts/production/run.mjs scripts/production/de-n-lei/01-setup.ts [args...]
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [entry, ...args] = process.argv.slice(2);
if (!entry) throw new Error('Usage: node scripts/production/run.mjs <entry.ts> [args…]');
const outDir = path.join(root, '.tmp-diagnose', 'dist');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, `${path.basename(entry, '.ts')}.mjs`);
await build({
  entryPoints: [path.resolve(root, entry)],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile,
  sourcemap: 'inline',
  packages: 'external',
  alias: { '@az-studio/shared': path.join(root, 'packages/shared/src/index.ts') },
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
  logLevel: 'error',
});
const res = spawnSync(process.execPath, ['--enable-source-maps', outfile, ...args], { stdio: 'inherit', cwd: root, env: { ...process.env, AZS_ACCEPTANCE: '1' } });
process.exit(res.status ?? 1);
