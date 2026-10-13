/* Video 1 — What Makes a Contribution Useful? */
const PHONE_W = 580, PHONE_X = 250, PHONE_Y = 450, PHONE_H = 980; // screen width inside = 548
const IMG_W = PHONE_W - 32;
const SC = IMG_W / 468;
const cue = (c, k, d) => (c && c[k] !== undefined ? c[k] : d);

scenes['v1-weak'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    heading(root, 'Start with meaning', 'The Kasem is there.', { text: 'But who says it?', t: cue(c, 'q', 2.2) });
    const p = phone(PHONE_X, PHONE_Y, PHONE_W, 'img/e8-weak.png', { h: PHONE_H });
    p.img.style.width = IMG_W + 'px';
    K(p, [[0.1, { o: 0, y: 120 }], [0.8, { o: 1, y: 0 }]]);
    K(p.img, [[0, { s: 1, x: 0, y: 0 }], [cue(c, 'zoom', 1.4), { s: 1, x: 0, y: 0 }], [cue(c, 'zoom', 1.4) + 1.1, zoomTo(IMG_W * 0.5, 250 * SC, 1.35, IMG_W / 2, 330)]], E.inOut);
    root.appendChild(p);
    const t0 = cue(c, 'elder', 4.6);
    chip(root, 'To an elder?', 40, 760, '', t0, -4);
    chip(root, 'A child?', 700, 900, '', cue(c, 'child', t0 + 1.2), 3);
    chip(root, 'A guest at the door?', 120, 1090, 'blue', cue(c, 'guest', t0 + 2.2), -2);
    const tag = el('div', 'abs', SAMPLE_TAG('Sample screen · bracketed placeholder, not real Kasem'), { right: '50px', top: '56px', textAlign: 'right', maxWidth: '640px' });
    root.appendChild(tag);
  },
};

scenes['v1-note'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    heading(root, 'Add context', 'The usage note', { text: 'tells the story.', t: 0.6 });
    const p = phone(PHONE_X, PHONE_Y, PHONE_W, 'img/e8-note-empty.png', { h: PHONE_H });
    p.img.style.width = IMG_W + 'px';
    root.appendChild(p);
    K(p, [[0.1, { o: 0, y: 120 }], [0.8, { o: 1, y: 0 }]]);
    // typed states stacked, revealed in order
    const states = ['img/e8-note-14.png', 'img/e8-note-38.png', 'img/e8-note-62.png', 'img/e8-note-84.png'];
    const t0 = cue(c, 'type', 4.6), t1 = cue(c, 'typeEnd', 8.8);
    const imgs = states.map((s, i) => {
      const im = el('img', 'shot'); im.src = s; im.style.width = IMG_W + 'px'; p.screen.appendChild(im);
      const at = t0 + ((t1 - t0) * i) / states.length;
      K(im, [[at - 0.001, { o: 0 }], [at, { o: 1 }]], E.lin);
      return im;
    });
    // before / after tag
    const b = chip(root, 'Before: translation only', 160, 366, 'warn', 0.9, 0);
    K(b, [[0.9, { o: 0, y: 20 }], [1.3, { o: 1, y: 0 }], [t0 - 0.2, { o: 1 }], [t0, { o: 0 }]]);
    const a = chip(root, 'After: with a usage note', 160, 366, 'ok', t0, 0);
    K(a, [[t0, { o: 0, y: 20 }], [t0 + 0.4, { o: 1, y: 0 }]]);
    chip(root, 'Who says it', 30, 700, 'blue', cue(c, 'who', t0 + 0.2), -3);
    chip(root, 'To whom', 740, 840, 'blue', cue(c, 'whom', t0 + 1.6), 3);
    chip(root, 'And when', 70, 1000, 'blue', cue(c, 'when', t0 + 2.4), -2);
    const r = chip(root, 'Reviewers read it first', 300, 1215, 'dark', cue(c, 'first', t1 + 0.6), 0);
    K(p.img, [[0, { s: 1, x: 0, y: 0 }], [t0 - 0.8, { s: 1, x: 0, y: 0 }], [t0 - 0.1, zoomTo(IMG_W * 0.5, 560 * SC, 1.0, IMG_W / 2, 560)]], E.inOut);
  },
};

scenes['v1-accuracy'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    heading(root, 'Accuracy first', 'Say it your way.', null);
    const rows = [
      { t: cue(c, 'a', 1.6), txt: 'Write it the way you really say it', sub: null },
      { t: cue(c, 'b', 5.0), txt: 'Check the spelling', sub: 'Kasem letter keys and the dictionary check' },
      { t: cue(c, 'c', 8.6), txt: "Not sure? Say so", sub: 'Choose “Skip / I’m not sure” instead of guessing' },
    ];
    rows.forEach((r, i) => {
      const y = 420 + i * 300;
      const card = el('div', 'card', `<div style="display:flex;gap:30px;align-items:center"><span class="tick"></span><div><div class="sora" style="font:700 46px/1.15 Sora">${r.txt}</div>${r.sub ? `<div style="font:500 32px/1.3 Inter;color:#5d667b;margin-top:10px">${r.sub}</div>` : ''}</div></div>`, { left: '70px', top: y + 'px', width: '940px', height: '240px', display: 'flex', alignItems: 'center' });
      K(card, [[r.t, { o: 0, x: -80 }], [r.t + 0.6, { o: 1, x: 0 }]]);
      root.appendChild(card);
    });
    // crop of the real Kasem letter keys
    const keys = el('div', 'abs', null, { left: '110px', top: '1330px', width: '860px', height: '170px', borderRadius: '30px', overflow: 'hidden', boxShadow: '0 20px 60px rgba(15,24,48,.2)', background: '#fff' });
    const ki = el('img', null, null, { position: 'absolute', width: '1170px', left: '-200px', top: '-1480px', transform: 'scale(.9)', transformOrigin: '0 0' });
    ki.src = 'img/e8-weak.png';
    keys.appendChild(ki);
    K(keys, [[cue(c, 'b', 5.0) + 0.3, { o: 0, y: 30 }], [cue(c, 'b', 5.0) + 0.9, { o: 1, y: 0 }], [cue(c, 'c', 8.6) - 0.2, { o: 1 }], [cue(c, 'c', 8.6), { o: 0 }]]);
    root.appendChild(keys);
  },
};

function noise(i, t) { const x = Math.sin(i * 12.9898 + Math.floor(t * 24) * 78.233) * 43758.5453; return x - Math.floor(x); }
scenes['v1-audio'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('dark'));
    heading(root, 'Recordings', 'The sound is', { text: 'the whole contribution.', t: 0.8 }, true);
    const card = el('div', 'card dark', null, { left: '70px', top: '560px', width: '940px', height: '440px' });
    root.appendChild(card);
    K(card, appear(0.4, 0.6));
    st.svg = el('div', 'abs', null, { left: '90px', top: '620px', width: '900px', height: '320px' });
    root.appendChild(st.svg);
    st.label = el('div', 'chip warn', 'Noisy market', { left: '90px', top: '480px' });
    st.label2 = el('div', 'chip ok', 'Quiet room', { left: '90px', top: '480px' });
    K(st.label, [[0.5, { o: 0, y: 20 }], [1, { o: 1, y: 0 }], [cue(c, 'clean', 3.2) - 0.1, { o: 1 }], [cue(c, 'clean', 3.2) + 0.2, { o: 0 }]]);
    K(st.label2, [[cue(c, 'clean', 3.2), { o: 0, y: 20 }], [cue(c, 'clean', 3.2) + 0.5, { o: 1, y: 0 }]]);
    root.appendChild(st.label); root.appendChild(st.label2);
    const items = [['Close the door', cue(c, 'door', 5.0)], ['A hand’s width away', cue(c, 'hand', 7.4)], ['Listen back before you send', cue(c, 'listen', 10.4)]];
    items.forEach(([txt, t], i) => {
      const r = el('div', 'card dark', `<div style="display:flex;gap:26px;align-items:center"><span class="tick"></span><span class="sora" style="font:700 44px Sora">${txt}</span></div>`, { left: '70px', top: 1040 + i * 118 + 'px', width: '940px', padding: '20px 40px', height: '100px', display: 'flex', alignItems: 'center' });
      K(r, [[t, { o: 0, x: 80 }], [t + 0.5, { o: 1, x: 0 }]]);
      root.appendChild(r);
    });
    st.clean = cue(c, 'clean', 3.2);
  },
  update(t, dur, st) {
    const N = 90, W = 900, H = 320, mid = H / 2;
    const k = E.clamp((t - st.clean) / 0.9);
    const pts = [];
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * W;
      const env = Math.sin((i / N) * Math.PI * 3) * 0.5 + 0.5; // speech-like envelope
      const speech = Math.abs(Math.sin(i * 0.55 + t * 5)) * env * 0.55 + 0.04;
      const grit = (0.28 + noise(i, t) * 0.55) * (1 - E.inOut(k));
      const a = Math.min(1, speech + grit);
      pts.push([x, a * mid * 0.95]);
    }
    const color = k < 0.5 ? '#f59e0b' : '#22d3ee';
    const bars = pts.map(([x, a]) => `<rect x="${x - 4}" y="${mid - a}" width="8" height="${a * 2}" rx="4" fill="${color}" opacity="${0.55 + 0.4 * (a / mid)}"/>`).join('');
    st.svg.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bars}</svg>`;
  },
};

scenes['v1-original'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    heading(root, 'Originality', 'Share what you know.', null);
    const mk = (label, cls, y, t, ghost) => {
      const d = el('div', 'card', `<div style="font:700 30px Sora;letter-spacing:.1em;text-transform:uppercase;color:${cls === 'ok' ? '#047857' : cls === 'no' ? '#b91c1c' : '#5d667b'}">${label}</div><div style="margin-top:18px;display:flex;flex-direction:column;gap:16px"><div style="height:30px;border-radius:15px;background:#e3e8f4;width:92%"></div><div style="height:30px;border-radius:15px;background:#e3e8f4;width:64%"></div></div>`, { left: '90px', top: y + 'px', width: '900px', height: '240px', opacity: ghost ? 0.7 : 1 });
      K(d, [[t, { o: 0, y: 60 }], [t + 0.6, { o: ghost ? 0.75 : 1, y: 0 }]]);
      root.appendChild(d);
      return d;
    };
    mk('Already there', 'neutral', 420, cue(c, 'there', 1.5));
    const n = mk('A new way of saying it', 'ok', 720, cue(c, 'new', 4.5));
    n.style.boxShadow = '0 30px 80px rgba(16,185,129,.28)';
    n.insertAdjacentHTML('beforeend', '<span class="tick" style="position:absolute;right:40px;top:40px"></span>');
    const x = mk('An exact copy', 'no', 1020, cue(c, 'copy', 8.0), true);
    x.insertAdjacentHTML('beforeend', '<span class="cross" style="position:absolute;right:40px;top:40px"></span>');
    const l = chip(root, 'Welcome', 780, 640, 'ok', cue(c, 'new', 4.5) + 0.5, 4);
    const l2 = chip(root, 'Not needed', 700, 940, 'warn', cue(c, 'copy', 8.0) + 0.6, -3);
    const l3 = el('div', 'abs', SAMPLE_TAG('Illustration · placeholder entries'), { right: '50px', top: '56px', textAlign: 'right', maxWidth: '640px' });
    root.appendChild(l3);
  },
};

scenes['v1-feedback'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    heading(root, 'Review feedback', 'Help, not a verdict.', null);
    const p = phone(PHONE_X, PHONE_Y, PHONE_W, 'img/ed-e3.png', { h: PHONE_H });
    p.img.style.width = IMG_W + 'px';
    root.appendChild(p);
    K(p, [[0.1, { o: 0, y: 120 }], [0.8, { o: 1, y: 0 }]]);
    K(p.img, [[0, { s: 1, x: 0, y: 0 }], [cue(c, 'read', 1.8), { s: 1, x: 0, y: 0 }], [cue(c, 'read', 1.8) + 1.0, zoomTo(IMG_W * 0.5, 260 * SC, 1.3, IMG_W / 2, 330)], [cue(c, 'fix', 6.0), zoomTo(IMG_W * 0.5, 260 * SC, 1.3, IMG_W / 2, 330)], [cue(c, 'fix', 6.0) + 1.0, zoomTo(IMG_W * 0.5, 560 * SC, 1.0, IMG_W / 2, 560)]], E.inOut);
    chip(root, 'Read what they point to', 60, 640, 'blue', cue(c, 'read', 1.8) + 0.6, -3);
    chip(root, 'Fix it', 760, 900, '', cue(c, 'fix', 6.0), 3);
    chip(root, 'Resubmit', 80, 1100, 'blue', cue(c, 'resub', 7.4), -2);
    const rec = chip(root, 'Your first version stays on record', 100, 1225, 'dark', cue(c, 'record', 9.4), 0);
    const tag = el('div', 'abs', SAMPLE_TAG('Sample feedback · local preview'), { right: '50px', top: '56px', textAlign: 'right', maxWidth: '640px' });
    root.appendChild(tag);
  },
};

function endcard(headLines, cta, sub, opts = {}) {
  return {
    build(root, dur, st, c) {
      root.appendChild(bgLayer('dark'));
      const glow = el('div', 'abs', null, { left: '140px', top: '260px', width: '800px', height: '800px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(47,107,255,.45) 0%, transparent 65%)' });
      K(glow, [[0, { o: 0, s: 0.7 }], [1.2, { o: 1, s: 1 }]]);
      root.appendChild(glow);
      const logo = el('div', 'abs', MARK(190), { left: '445px', top: '250px' });
      K(logo, [[0.1, { o: 0, s: 0.6, y: 40 }], [0.9, { o: 1, s: 1, y: 0 }]], E.back);
      root.appendChild(logo);
      const word = el('div', 'abs center sora', 'Indigen World', { left: '0', width: '1080px', top: '470px', font: "700 56px 'Sora'", color: '#fff', letterSpacing: '-.01em' });
      K(word, appear(0.5, 0.6, 20)); root.appendChild(word);
      headLines.forEach((l, i) => {
        const h = el('div', 'abs center h2 white', l, { left: '60px', width: '960px', top: 640 + i * 96 + 'px', font: "800 84px/1.05 'Sora'" });
        K(h, appear(1.0 + i * 0.25, 0.6)); root.appendChild(h);
      });
      const y = 640 + headLines.length * 96 + 70;
      const btn = el('div', 'chip blue', cta, { left: '140px', width: '800px', justifyContent: 'center', top: y + 'px', font: "700 46px 'Sora'", padding: '34px 40px' });
      K(btn, [[1.9, { o: 0, s: 0.8 }], [2.5, { o: 1, s: 1 }]], E.back);
      root.appendChild(btn);
      const u = el('div', 'abs center', sub, { left: '40px', width: '1000px', top: y + 150 + 'px', font: "600 38px 'Inter'", color: '#bcd2ff' });
      K(u, appear(2.4, 0.6, 20)); root.appendChild(u);
      if (opts.extra) opts.extra(root, y + 230);
    },
  };
}
scenes['v1-end'] = endcard(['Make one careful', 'contribution today.'], 'Open the contributor portal', 'tribestudio.indigenworld.com/contributor');

scenes['v1-title'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('dark'));
    const glow = el('div', 'abs', null, { left: '140px', top: '300px', width: '800px', height: '800px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(47,107,255,.4) 0%, transparent 65%)' });
    K(glow, [[0, { o: 0, s: 0.7 }], [1.0, { o: 1, s: 1 }]]);
    root.appendChild(glow);
    const logo = el('div', 'abs', MARK(150), { left: '465px', top: '420px' });
    K(logo, [[0.05, { o: 0, s: 0.6 }], [0.7, { o: 1, s: 1 }]], E.back);
    root.appendChild(logo);
    const k = el('div', 'abs center kicker dark', 'Contributor series · 1', { left: '0', width: '1080px', top: '620px' });
    K(k, appear(0.3, 0.5, 20)); root.appendChild(k);
    const h = el('div', 'abs center white', 'What makes a<br>contribution<br><span style="color:#22d3ee">useful?</span>', { left: '60px', width: '960px', top: '690px', font: "800 108px/1.04 'Sora'", letterSpacing: '-.02em' });
    K(h, appear(0.5, 0.7)); root.appendChild(h);
  },
};
