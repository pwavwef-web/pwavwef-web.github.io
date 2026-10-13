/* Glass jars, pump and pipes in the style of indigenworld.com/progress (blue liquid). Illustrative only: no figures. */
let __jarId = 0;
const BODY = 'M30 78 Q30 58 52 56 L148 56 Q170 58 170 78 L170 268 Q170 292 146 292 L54 292 Q30 292 30 268 Z';
function jarSVG(uid) {
  return `<svg viewBox="0 0 200 310" width="100%" height="100%" style="overflow:visible">
  <defs>
    <linearGradient id="gl${uid}" x1="0" x2="1"><stop offset="0" stop-color="#cfe4f3"/><stop offset=".5" stop-color="#eaf5fc"/><stop offset="1" stop-color="#c3dcee"/></linearGradient>
    <linearGradient id="lq${uid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset=".45" stop-color="#2f9bff"/><stop offset="1" stop-color="#1a4ff0"/></linearGradient>
    <linearGradient id="lid${uid}" x1="0" x2="1"><stop offset="0" stop-color="#8fa7bd"/><stop offset=".5" stop-color="#dbe8f2"/><stop offset="1" stop-color="#8aa2b8"/></linearGradient>
    <clipPath id="cp${uid}"><path d="${BODY}" transform="translate(100 174) scale(.93) translate(-100 -174)"/></clipPath>
  </defs>
  <path d="${BODY}" fill="url(#gl${uid})" opacity=".92"/>
  <g clip-path="url(#cp${uid})"><path id="wave${uid}" d="" fill="url(#lq${uid})"/><g id="bub${uid}"></g></g>
  <path d="M42 84 Q40 70 52 68" stroke="#fff" stroke-width="6" stroke-linecap="round" fill="none" opacity=".85"/>
  <path d="M40 98 L40 250" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".6"/>
  <path d="${BODY}" fill="none" stroke="#8db3cf" stroke-width="3"/>
  <g stroke="#9db8cc" stroke-width="2.5" opacity=".7"><path d="M160 130h-14M160 170h-14M160 210h-14M160 250h-14"/></g>
  <rect x="44" y="28" width="112" height="34" rx="9" fill="url(#lid${uid})" stroke="#7d97ad" stroke-width="2.5"/>
  <g stroke="#7d97ad" stroke-width="2" opacity=".7"><path d="M62 30v30M80 30v30M100 30v30M120 30v30M138 30v30"/></g>
  <rect x="90" y="4" width="20" height="26" rx="5" fill="url(#lid${uid})" stroke="#7d97ad" stroke-width="2.5"/>
</svg>`;
}
/** Adds a jar to root at (x,y) with width w. Returns {el, update(level,t,glow)}. */
function makeJar(root, x, y, w) {
  const uid = ++__jarId;
  const h = (w * 310) / 200;
  const holder = el('div', 'abs', jarSVG(uid), { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  root.appendChild(holder);
  const glow = el('div', 'abs', null, { left: x - w * 0.25 + 'px', top: y - h * 0.05 + 'px', width: w * 1.5 + 'px', height: h * 1.2 + 'px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(34,211,238,.55) 0%, transparent 62%)', opacity: 0, zIndex: -1 });
  root.insertBefore(glow, holder);
  const wave = holder.querySelector('#wave' + uid), bub = holder.querySelector('#bub' + uid);
  const bubbles = Array.from({ length: 9 }, (_, i) => ({ x: 55 + ((i * 37) % 90), s: 0.5 + ((i * 53) % 10) / 14, p: (i * 0.37) % 1 }));
  return {
    el: holder, glow, x, y, w, h,
    /** y (in root px) of the liquid surface for a given level */
    surfaceY(level) { return y + ((292 - (292 - 70) * level) / 310) * h; },
    update(level, t, glowAmt = 0) {
      const top = 288 - (288 - 72) * Math.max(0, Math.min(1, level));
      let d = `M0 ${top}`;
      for (let i = 0; i <= 40; i++) { const px = (i / 40) * 200; d += ` L${px} ${top + Math.sin(i * 0.55 + t * 3.2) * 3.2 + Math.sin(i * 0.23 - t * 2.1) * 2}`; }
      d += ' L200 300 L0 300 Z';
      wave.setAttribute('d', d);
      let b = '';
      if (level > 0.03) for (const q of bubbles) { const k = (q.p + t * 0.16 * q.s) % 1; const by = 285 - k * (285 - top - 8); if (by > top + 6) b += `<circle cx="${q.x + Math.sin(t * 2 + q.p * 9) * 3}" cy="${by}" r="${2.4 + q.s * 2.4}" fill="#fff" opacity="${0.55 * (1 - k)}"/>`; }
      bub.innerHTML = b;
      glow.style.opacity = glowAmt;
    },
  };
}
/** A glass pipe along an SVG path string. Returns {svg, len, pulse(t0,dur,t)}. */
function makePipes(root, paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', 1080); svg.setAttribute('height', 1920); svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
  const items = paths.map((d) => {
    const mk = (stroke, w, op = 1) => { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', stroke); p.setAttribute('stroke-width', w); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); p.setAttribute('opacity', op); svg.appendChild(p); return p; };
    const outer = mk('#9fbdd3', 30); mk('#eef7fc', 21); mk('#ffffff', 5, 0.8);
    const pulse = mk('#22d3ee', 14, 0); pulse.setAttribute('filter', 'drop-shadow(0 0 10px #22d3ee)');
    const core = mk('#ffffff', 5, 0);
    return { outer, pulse, core, len: outer.getTotalLength() };
  });
  root.appendChild(svg);
  return {
    svg,
    /** sends a pulse along path i: it travels between t0 and t0+dur */
    pulse(i, t0, dur, t) {
      const it = items[i]; const k = (t - t0) / dur;
      if (k < 0 || k > 1.08) { it.pulse.setAttribute('opacity', 0); it.core.setAttribute('opacity', 0); return; }
      const head = Math.min(1, k) * it.len, seg = 110;
      const dash = `0 ${Math.max(0, head - seg)} ${Math.min(seg, head)} ${it.len * 2}`;
      for (const p of [it.pulse, it.core]) { p.setAttribute('stroke-dasharray', dash); p.setAttribute('opacity', k > 1 ? Math.max(0, 1 - (k - 1) * 12) : 1); }
    },
  };
}
function makePump(root, x, y, w, label = 'TribeStudio') {
  const h = Math.round(w * 0.3);
  const d = el('div', 'abs', `<div style="display:flex;align-items:center;gap:${w * 0.05}px;height:100%">
    <div class="turb" style="width:${h * 0.78}px;height:${h * 0.78}px;border-radius:50%;background:radial-gradient(circle,#e6f4ff 0%,#2f9bff 55%,#1a4ff0 100%);box-shadow:0 0 0 ${h * 0.06}px #cfe2f1 inset,0 8px 20px rgba(26,79,240,.35);position:relative;margin-left:${h * 0.12}px">
      <svg viewBox="0 0 100 100" style="position:absolute;inset:0"><g class="blades" style="transform-origin:50px 50px"><path d="M50 50 L50 10 Q70 28 50 50Z M50 50 L90 50 Q72 70 50 50Z M50 50 L50 90 Q30 72 50 50Z M50 50 L10 50 Q28 30 50 50Z" fill="#fff" opacity=".92"/></g><circle cx="50" cy="50" r="7" fill="#1a4ff0"/></svg></div>
    <div class="sora" style="font:700 ${w * 0.085}px 'Sora';color:#0f1830">${label}</div></div>`,
    { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px', borderRadius: h + 'px', background: 'linear-gradient(180deg,#fff,#e6f1f9)', boxShadow: '0 20px 50px rgba(15,24,48,.18), 0 0 0 4px #cfe2f1', border: '2px solid #fff' });
  d.blades = d.querySelector('.blades');
  d.spin = (t, speed = 1) => { d.blades.style.transform = `rotate(${t * 120 * speed}deg)`; };
  root.appendChild(d);
  d.h = h;
  return d;
}
const ILLUS_BADGE = (root, dark) => {
  const b = el('div', 'abs', 'ILLUSTRATION · NOT LIVE FIGURES', { right: '50px', top: '56px', font: "700 24px 'Sora'", letterSpacing: '.12em', padding: '12px 22px', borderRadius: '999px', background: dark ? 'rgba(255,255,255,.12)' : 'rgba(15,24,48,.08)', color: dark ? '#bcd2ff' : '#3d4559' });
  root.appendChild(b);
  return b;
};
