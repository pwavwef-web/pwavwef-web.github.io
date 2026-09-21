// Bundles the functions source (and @az-studio/shared) into lib/index.js.
// npm dependencies stay external: Cloud Build installs them from package.json on deploy.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pkg = JSON.parse(readFileSync(here('./package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});

rmSync(here('./lib'), { recursive: true, force: true });
await build({
  entryPoints: [here('./src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: here('./lib/index.js'),
  sourcemap: true,
  external: [...deps, ...deps.map((d) => `${d}/*`)],
  banner: { js: "import { createRequire as __azsCreateRequire } from 'node:module'; const require = __azsCreateRequire(import.meta.url);" },
  logLevel: 'info',
});
