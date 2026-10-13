/* Deterministic scene engine: window.__render(t) positions everything from time alone. */
const E = {
  clamp: (x, a = 0, b = 1) => Math.min(b, Math.max(a, x)),
  lerp: (a, b, k) => a + (b - a) * k,
  out: (k) => 1 - Math.pow(1 - k, 3),
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  back: (k) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); },
  lin: (k) => k,
};
const scenes = {};
let current = null;
let stage = null;

function el(tag, cls, html, style) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (style) Object.assign(e.style, style);
  return e;
}
/** Keyframes: [[t, {o,x,y,s,r,sx,sy}], ...] with per-segment easing from the later key (default out). */
function K(node, keys, ease = E.out) {
  node.__keys = keys;
  node.__ease = ease;
  node.__base = node.style.transform || '';
  return node;
}
function sample(keys, t, ease) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a] = keys[i - 1], [t1, b] = keys[i];
      const k = (ease || E.out)(E.clamp((t - t0) / Math.max(1e-6, t1 - t0)));
      const o = {};
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const av = a[key] ?? b[key], bv = b[key] ?? a[key];
        o[key] = av + (bv - av) * k;
      }
      return o;
    }
  }
  return keys[keys.length - 1][1];
}
function applyAll(root, t) {
  const nodes = root.querySelectorAll('*');
  const list = [root, ...nodes];
  for (const n of list) {
    if (!n.__keys) continue;
    const v = sample(n.__keys, t, n.__ease);
    if (v.o !== undefined) n.style.opacity = v.o;
    const parts = [];
    if (v.x !== undefined || v.y !== undefined) parts.push(`translate(${v.x ?? 0}px, ${v.y ?? 0}px)`);
    if (v.r !== undefined) parts.push(`rotate(${v.r}deg)`);
    if (v.s !== undefined) parts.push(`scale(${v.s})`);
    if (v.sx !== undefined || v.sy !== undefined) parts.push(`scale(${v.sx ?? 1}, ${v.sy ?? 1})`);
    if (parts.length) n.style.transform = `${n.__base} ${parts.join(' ')}`.trim();
    if (v.w !== undefined) n.style.width = v.w + 'px';
    if (v.h !== undefined) n.style.height = v.h + 'px';
    if (v.top !== undefined) n.style.top = v.top + 'px';
    if (v.left !== undefined) n.style.left = v.left + 'px';
    if (v.blur !== undefined) n.style.filter = `blur(${v.blur}px)`;
  }
}
/** Show-only-between helper: opacity 0 outside [a,b], with fade. */
const vis = (a, b, f = 0.25) => [[a - f, { o: 0 }], [a, { o: 1 }], [b, { o: 1 }], [b + f, { o: 0 }]];
const appear = (t0, d = 0.5, y = 40) => [[t0, { o: 0, y }], [t0 + d, { o: 1, y: 0 }]];
const appearScale = (t0, d = 0.5) => [[t0, { o: 0, s: 0.8 }], [t0 + d, { o: 1, s: 1 }]];

window.__init = async (name, dur, cues) => {
  stage = document.getElementById('stage');
  stage.innerHTML = '';
  const def = scenes[name];
  if (!def) throw new Error('unknown scene ' + name);
  current = { def, root: stage, dur, state: {}, cues: cues || {} };
  def.build(stage, dur, current.state, current.cues);
  await document.fonts.ready;
  await Promise.all([...document.images].map((i) => (i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; }))));
  return true;
};
window.__render = (t) => {
  if (current.def.update) current.def.update(t, current.dur, current.state, stage);
  applyAll(stage, t);
  // continuous, subtle motion on every graphics scene: drifting dot grid and a very slow push-in
  for (const d of stage.querySelectorAll('.grid-dots, .grid-dots-dark')) d.style.backgroundPosition = ((t * 40) % 54) + 'px ' + ((t * 26) % 54) + 'px';
  // two soft colour blobs drifting behind the content so no moment of a scene is ever fully still
  if (!stage.__amb) {
    const dark = stage.firstChild && stage.firstChild.classList && stage.firstChild.classList.contains('bg-dark');
    const mk = (c) => { const b = document.createElement('div'); b.style.cssText = 'position:absolute;width:900px;height:900px;border-radius:50%;pointer-events:none;background:radial-gradient(circle, ' + c + ' 0%, transparent 65%)'; return b; };
    stage.__amb = [mk(dark ? 'rgba(47,107,255,.28)' : 'rgba(47,107,255,.16)'), mk(dark ? 'rgba(34,211,238,.18)' : 'rgba(34,211,238,.14)')];
    stage.insertBefore(stage.__amb[1], stage.children[1] || null); stage.insertBefore(stage.__amb[0], stage.children[1] || null);
  }
  stage.__amb[0].style.left = (-150 + 420 * Math.sin(t * 0.55)) + 'px'; stage.__amb[0].style.top = (200 + 300 * Math.cos(t * 0.42)) + 'px';
  stage.__amb[1].style.left = (400 + 380 * Math.cos(t * 0.47)) + 'px'; stage.__amb[1].style.top = (900 + 350 * Math.sin(t * 0.5)) + 'px';
  stage.style.transformOrigin = '50% 45%';
  stage.style.transform = 'scale(' + (1 + 0.03 * Math.min(1, t / Math.max(1, current.dur))) + ')';
  return true;
};

/* ---- shared components ---- */
const MARK = (size, c = { frame: '#8eb4ff', bar: '#fff', sun: '#22d3ee' }, tile = true) =>
  `<svg viewBox="0 0 64 64" width="${size}" height="${size}">${tile ? '<defs><linearGradient id="mg" x1="0" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="#13224a"/><stop offset=".7" stop-color="#0f1830"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#mg)"/>' : ''}<g fill="none" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" transform="translate(4.5 4.5) scale(.86)"><path d="M15 47V23l17-9 17 9v24" stroke="${c.frame}"/><path d="M24 44V29m8 15V24m8 20V29" stroke="${c.bar}"/></g><circle cx="32" cy="16.5" r="3.6" fill="${c.sun}"/></svg>`;
const BRAND_LOCKUP = (dark) => `<div style="display:flex;align-items:center;gap:22px">${MARK(84)}<div class="sora" style="font:700 44px 'Sora';letter-spacing:-.01em;color:${dark ? '#fff' : '#0f1830'}">Indigen World</div></div>`;

function phone(x, y, w, src, opts = {}) {
  const h = opts.h ?? Math.round((w * 2532) / 1170 + 0);
  const p = el('div', 'phone', null, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  const s = el('div', 'screen');
  const img = el('img', 'shot'); img.src = src; s.appendChild(img); p.appendChild(s);
  p.img = img; p.screen = s;
  return p;
}
function bgLayer(kind) {
  const l = el('div', 'layer ' + (kind === 'dark' ? 'bg-dark' : 'bg-light'));
  l.appendChild(el('div', 'layer ' + (kind === 'dark' ? 'grid-dots-dark' : 'grid-dots'), null, { opacity: 0.55 }));
  return l;
}

/* zoom an <img> displayed at width W (px) about displayed point (px,py) so it sits at screen centre (cx,cy) */
const zoomTo = (px, py, s, cx, cy) => ({ s, x: cx - px * s, y: cy - py * s });
const SAMPLE_TAG = (txt = 'Sample screen · placeholder Kasem') => `<div style="font:700 22px 'Sora';letter-spacing:.08em;text-transform:uppercase;color:#3d4559;padding:12px 22px;border-radius:999px;background:rgba(15,24,48,.08)">${txt}</div>`;
function heading(root, kicker, l1, l2, dark, t0 = 0.1) {
  const wrap = el('div', 'abs', null, { left: '70px', top: '110px', width: '940px' });
  if (kicker) { const k = el('div', 'kicker' + (dark ? ' dark' : ''), kicker); K(k, appear(t0, 0.5, 20)); wrap.appendChild(k); }
  if (l1) { const a = el('div', 'h2' + (dark ? ' white' : ''), l1, { marginTop: '18px' }); K(a, appear(t0 + 0.15, 0.6)); wrap.appendChild(a); }
  let b = null;
  if (l2) { b = el('div', 'h2 ' + (dark ? 'cyan' : 'blue'), l2.text, { marginTop: '6px' }); K(b, appear(l2.t, 0.6)); wrap.appendChild(b); }
  root.appendChild(wrap);
  return { wrap, second: b };
}
function chip(root, text, x, y, cls, t0, rot = 0, extra) {
  const c = el('div', 'chip ' + (cls || ''), text, { left: x + 'px', top: y + 'px' });
  c.style.transform = '';
  K(c, [[t0, { o: 0, s: 0.6, r: rot, y: 30 }], [t0 + 0.45, { o: 1, s: 1, r: rot, y: 0 }]], E.back);
  if (extra) Object.assign(c.style, extra);
  root.appendChild(c);
  return c;
}
