// Bundles the renderer (and @az-studio/shared) into dist/main.js for the Cloud Run image.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pkg = JSON.parse(readFileSync(here('./package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});

rmSync(here('./dist'), { recursive: true, force: true });
await build({
  entryPoints: [here('./src/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: here('./dist/main.js'),
  sourcemap: true,
  external: [...deps, ...deps.map((d) => `${d}/*`)],
  banner: { js: "import { createRequire as __azsCreateRequire } from 'node:module'; const require = __azsCreateRequire(import.meta.url);" },
  logLevel: 'info',
});
