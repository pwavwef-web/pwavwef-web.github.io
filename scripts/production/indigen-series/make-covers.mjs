// Renders the four cover images (1080x1920 PNG) from the 'cover' scene.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const out = path.resolve('exports/indigen-contributor-series/_work/covers');
mkdirSync(out, { recursive: true });
const covers = {
  v1: { n: 1, lines: ['What makes a', 'contribution', 'useful?'], art: 'phone', phone: 'img/e8-note-84.png', accent: 'Make it clear for the reviewer' },
  v2: { n: 2, lines: ['Someone knows', 'this because', 'you shared it.'], art: 'none', bg: 'img/cover-v2.jpg', accent: 'Your everyday knowledge matters' },
  v3: { n: 3, lines: ['Help fill', 'the jars.'], art: 'jars', accent: 'Illustration · not live figures' },
  v4: { n: 4, lines: ['What happens', 'after you', 'submit?'], art: 'phone', phone: 'img/e8-confirm.png', accent: 'Review, feedback, approval' },
};
for (const [k, c] of Object.entries(covers)) {
  const r = spawnSync(process.execPath, ['scripts/production/indigen-series/render-scene.mjs', 'cover', '3', path.join(out, `${k}.png`), '--at=1', `--cues=${JSON.stringify(c)}`], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('cover failed ' + k);
}
