/* Video 3 — Help Fill the Jars (illustrative jars; no figures) */
const c3 = (c, k, d) => (c && c[k] !== undefined ? c[k] : d);
const smooth = (t, a, b) => E.inOut(E.clamp((t - a) / (b - a)));

scenes['v3-jars'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    ILLUS_BADGE(root);
    heading(root, 'Help fill the jars', 'Yours can move', { text: 'one forward.', t: c3(c, 'yours', 3.6) });
    st.pump = makePump(root, 330, 440, 420);
    K(st.pump, appear(0.3, 0.6));
    const cx = [150, 410, 670, 930], W = 220, JY = 880;
    st.jars = cx.map((x, i) => { const j = makeJar(root, x - W / 2, JY, W); K(j.el, [[0.5 + i * 0.18, { o: 0, y: 60 }], [1.2 + i * 0.18, { o: 1, y: 0 }]]); return j; });
    const names = ['Everyday Expressions', 'Words & Meanings', 'Proverbs & Wisdom', 'Pronunciation Takes'];
    names.forEach((n, i) => { const l = el('div', 'abs center sora', n, { left: cx[i] - 125 + 'px', width: '250px', top: JY + 360 + 'px', font: "700 28px/1.15 'Sora'", color: '#0f1830' }); K(l, appear(1.2 + i * 0.18, 0.5, 20)); root.appendChild(l); });
    // pipes: pump down to a bus, bus to each jar's lid
    const busY = 740, lidY = JY + 8;
    const paths = [`M540 ${440 + st.pump.h} L540 ${busY}`, `M${cx[0]} ${busY} L${cx[3]} ${busY}`, ...cx.map((x) => `M${x} ${busY} L${x} ${lidY}`)];
    st.pipes = makePipes(root, paths);
    st.cx = cx; st.JY = JY; st.W = W;
    st.pop = chip(root, '+1 approved', cx[0] - 105, JY - 90, 'blue', c3(c, 'pulse', 4.9) + 1.5, 0);
    K(st.pop, [[c3(c, 'pulse', 4.9) + 1.4, { o: 0, y: 30, s: 0.7 }], [c3(c, 'pulse', 4.9) + 1.9, { o: 1, y: 0, s: 1 }], [c3(c, 'pulse', 4.9) + 4.2, { o: 1, y: -10, s: 1 }], [c3(c, 'pulse', 4.9) + 4.7, { o: 0, y: -30, s: 1 }]], E.back);
    st.pulseT = c3(c, 'pulse', 4.9);
  },
  update(t, dur, st) {
    st.pump.spin(t, 1 + (t > st.pulseT && t < st.pulseT + 1.6 ? 2.5 : 0));
    const base = [0.34, 0.46, 0.22, 0.14];
    const rise = smooth(t, st.pulseT + 1.3, st.pulseT + 3.3) * 0.09;
    st.jars.forEach((j, i) => j.update(base[i] + (i === 0 ? rise : 0) + smooth(t, 0.5, 2.5) * 0.04 * (i + 1) * 0.5, t, i === 0 ? Math.min(1, smooth(t, st.pulseT + 1.3, st.pulseT + 2.2)) * (1 - smooth(t, st.pulseT + 4.4, st.pulseT + 5.5)) : 0));
    // pulse goes pump -> bus -> first jar
    st.pipes.pulse(0, st.pulseT, 0.5, t); st.pipes.pulse(1, st.pulseT + 0.5, 0.5, t); st.pipes.pulse(2, st.pulseT + 0.95, 0.5, t);
  },
};

function stationCard(root, n, title, sub, y, t0, tone) {
  const colors = { blue: ['#eaf0ff', '#2c66f5'], ok: ['#ecfdf5', '#047857'], plain: ['#fff', '#0f1830'] }[tone || 'plain'];
  const d = el('div', 'card', `<div style="display:flex;align-items:center;gap:28px"><div class="sora" style="flex:none;width:84px;height:84px;border-radius:50%;background:${colors[1]};color:#fff;font:800 44px/84px 'Sora';text-align:center">${n}</div><div><div class="sora" style="font:700 40px/1.15 'Sora';color:${colors[1]}">${title}</div><div style="font:500 30px/1.3 Inter;color:#5d667b;margin-top:6px">${sub}</div></div></div>`, { left: '60px', top: y + 'px', width: '640px', height: '190px', display: 'flex', alignItems: 'center', background: colors[0], padding: '30px 36px' });
  K(d, [[t0, { o: 0, x: -80 }], [t0 + 0.6, { o: 1, x: 0 }]]);
  root.appendChild(d);
  return d;
}
scenes['v3-flow'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    ILLUS_BADGE(root);
    heading(root, 'How a jar rises', 'Review comes first.', null);
    const t1 = c3(c, 'add', 1.4), t2 = c3(c, 'review', 3.4), t3 = c3(c, 'approved', 6.0);
    stationCard(root, '1', 'You add an expression', 'Sample card · placeholder text', 400, t1);
    stationCard(root, '2', 'A reviewer checks it', 'Meaning, context and quality', 640, t2);
    st.s3 = stationCard(root, '3', 'Approved and published', 'Now it counts', 880, t3, 'ok');
    for (const [y, t] of [[590, t2], [830, t3]]) { const a = el('div', 'abs', null, { left: '372px', top: y + 'px', width: '16px', height: '50px', borderRadius: '8px', background: '#9fbdd3' }); K(a, [[t, { o: 0 }], [t + 0.4, { o: 1 }]]); root.appendChild(a); }
    st.jar = makeJar(root, 770, 1010, 230);
    K(st.jar.el, appear(0.6, 0.7, 60));
    const paths = ['M700 975 L885 975 L885 1022'];
    st.pipes = makePipes(root, paths);
    st.pump = makePump(root, 730, 400, 300);
    K(st.pump, appear(0.5, 0.6));
    const p2 = makePipes(root, ['M880 ' + (400 + st.pump.h) + ' L880 975']);
    st.pipes2 = p2;
    st.t3 = t3;
    st.pop = chip(root, '+1 approved', 700, 930, 'blue', t3 + 1.9, 0);
    st.sub = null;
  },
  update(t, dur, st) {
    const k = st.t3;
    st.pump.spin(t, 1 + (t > k + 0.3 && t < k + 2 ? 2.5 : 0));
    st.pipes2.pulse(0, k + 0.3, 0.9, t);
    st.pipes.pulse(0, k + 1.2, 0.8, t);
    const lvl = 0.3 + smooth(t, k + 2.0, k + 3.8) * 0.12;
    st.jar.update(lvl, t, smooth(t, k + 2.0, k + 2.6) * (1 - smooth(t, k + 5, k + 6)));
  },
};

scenes['v3-count'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    ILLUS_BADGE(root);
    heading(root, 'What counts', 'Only approved work', { text: 'fills a jar.', t: 0.6 });
    const mk = (label, sub, y, t, ok) => {
      const d = el('div', 'card', `<div style="display:flex;align-items:center;gap:26px"><span class="${ok ? 'tick' : 'cross'}"></span><div><div class="sora" style="font:700 40px 'Sora';color:${ok ? '#047857' : '#0f1830'}">${label}</div><div style="font:500 30px Inter;color:#5d667b;margin-top:4px">${sub}</div></div></div>`, { left: '60px', top: y + 'px', width: '600px', height: '170px', display: 'flex', alignItems: 'center', background: ok ? '#ecfdf5' : '#fff' });
      K(d, [[t, { o: 0, x: -80 }], [t + 0.6, { o: ok ? 1 : 0.78, x: 0 }]]);
      root.appendChild(d); return d;
    };
    mk('Draft', 'Not counted', 430, c3(c, 'draft', 1.4), false);
    mk('Awaiting review', 'Not counted yet', 640, c3(c, 'wait', 3.0), false);
    const ap = mk('Approved', 'Counts', 850, c3(c, 'ok', 5.4), true);
    st.jar = makeJar(root, 740, 560, 260);
    K(st.jar.el, appear(0.5, 0.7, 60));
    st.t = c3(c, 'ok', 5.4);
    const drop = el('div', 'abs', null, { left: '850px', width: '40px', height: '56px', borderRadius: '50% 50% 50% 50% / 62% 62% 38% 38%', background: 'linear-gradient(180deg,#7dd3fc,#2f6bff)', top: '420px' });
    K(drop, [[st.t + 0.5, { o: 0, y: 0 }], [st.t + 0.6, { o: 1, y: 0 }], [st.t + 1.5, { o: 1, y: 330 }], [st.t + 1.6, { o: 0, y: 330 }]], E.lin);
    root.appendChild(drop);
  },
  update(t, dur, st) {
    st.jar.update(0.36 + smooth(t, st.t + 1.5, st.t + 3.2) * 0.1, t, smooth(t, st.t + 1.5, st.t + 2.2) * (1 - smooth(t, st.t + 4, st.t + 5)));
  },
};

scenes['v3-choose'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    ILLUS_BADGE(root);
    heading(root, 'Pick the one you know best', null, null);
    const cells = [
      { n: 'Everyday Expressions', a: 'Share an expression', cue: 'expr', d: 2.0, lvl: 0.4 },
      { n: 'Words & Meanings', a: 'Suggest a word', cue: 'words', d: 4.4, lvl: 0.5 },
      { n: 'Proverbs & Wisdom', a: 'Share a proverb', cue: 'prov', d: 6.2, lvl: 0.25 },
      { n: 'Pronunciation Takes', a: 'Record audio', cue: 'pron', d: 7.8, lvl: 0.18 },
    ];
    st.cells = cells.map((cell, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 60 + col * 500, y = 300 + row * 600;
      const j = makeJar(root, x + 120, y + 30, 200);
      const t = c3(c, cell.cue, cell.d);
      K(j.el, [[0.3 + i * 0.12, { o: 0, y: 50 }], [1 + i * 0.12, { o: 1, y: 0 }]]);
      const lab = el('div', 'abs center sora', cell.n, { left: x + 'px', width: '440px', top: y + 345 + 'px', font: "700 34px 'Sora'", color: '#0f1830' });
      K(lab, appear(0.9 + i * 0.12, 0.5, 20)); root.appendChild(lab);
      const pill = el('div', 'chip', `${cell.a} <span style="color:#2c66f5">→</span>`, { left: x + 40 + 'px', top: y + 410 + 'px', font: "700 32px 'Sora'", padding: '16px 30px', border: '2px solid #cfe2f1' });
      K(pill, [[t - 0.1, { o: 0.5, s: 0.9 }], [t + 0.3, { o: 1, s: 1.08 }], [t + 1.6, { o: 1, s: 1 }]], E.back);
      pill.__keys = [[0, { o: 0, y: 20 }], [1.3 + i * 0.12, { o: 0.55, y: 0 }], [t, { o: 0.55, y: 0 }], [t + 0.35, { o: 1, y: 0 }]];
      pill.__ease = E.out;
      root.appendChild(pill);
      return { j, t, lvl: cell.lvl };
    });
  },
  update(t, dur, st) {
    st.cells.forEach((c, i) => c.j.update(c.lvl + 0.02 * i, t, smooth(t, c.t - 0.1, c.t + 0.4) * (1 - smooth(t, c.t + 1.8, c.t + 2.6)) * 0.9));
  },
};

scenes['v3-real'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    heading(root, 'See the real jars', 'Illustration here.', { text: 'Live on the page.', t: c3(c, 'live', 2.2) });
    const card = el('div', 'abs', null, { left: '90px', top: '520px', width: '900px', height: '235px', borderRadius: '44px', overflow: 'hidden', boxShadow: '0 40px 100px rgba(15,24,48,.25)', background: '#fff' });
    const im = el('img', null, null, { position: 'absolute', width: '900px', left: '0', top: '-285px' });
    im.src = 'img/progress-top.png';
    card.appendChild(im);
    K(card, appear(0.5, 0.8, 80));
    root.appendChild(card);
    const live = chip(root, '● Live page', 90, 940, 'ok', c3(c, 'live', 2.2) + 0.5, -2);
    const url = chip(root, 'indigenworld.com/progress', 130, 1090, 'blue', c3(c, 'url', 3.6), 0, { font: "700 44px 'Sora'", padding: '30px 44px' });
    const note = el('div', 'abs center', 'Real jars show approved work only', { left: '60px', width: '960px', top: '1260px', font: "600 36px 'Inter'", color: '#5d667b' });
    K(note, appear(c3(c, 'url', 3.6) + 0.8, 0.6, 20)); root.appendChild(note);
  },
};

scenes['v3-full'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('dark'));
    ILLUS_BADGE(root, true);
    heading(root, 'Keep it in proportion', 'A full jar is', { text: 'reviewed material.', t: c3(c, 'rev', 4.4) }, true);
    st.jar = makeJar(root, 380, 560, 320);
    K(st.jar.el, appear(0.4, 0.8, 60));
    const a = chip(root, 'Not a launch date', 60, 1150, 'warn', c3(c, 'notlaunch', 1.0), -3);
    const b = chip(root, 'Not a finished model', 520, 1250, 'warn', c3(c, 'notmodel', 2.4), 3);
    const g = chip(root, 'Material to build on', 280, 1020, 'ok', c3(c, 'rev', 4.4) + 0.5, 0);
    st.full = c3(c, 'rev', 4.4);
  },
  update(t, dur, st) {
    st.jar.update(0.55 + smooth(t, 0.5, 4.5) * 0.4, t, smooth(t, st.full, st.full + 0.8) * 0.8);
  },
};

scenes['v3-end'] = endcard(['Choose a jar.', 'Add something', 'you know.'], 'Open the contributor portal', 'tribestudio.indigenworld.com/contributor', {
  extra(root, y) {
    const l = el('div', 'abs center', 'See the live jars: indigenworld.com/progress', { left: '40px', width: '1000px', top: y + 'px', font: "600 34px 'Inter'", color: '#8eb4ff' });
    K(l, appear(3.0, 0.6, 20)); root.appendChild(l);
  },
});
