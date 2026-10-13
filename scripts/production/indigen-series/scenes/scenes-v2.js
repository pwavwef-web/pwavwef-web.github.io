/* Video 2 — Someone Knows This Because You Shared It */
const c2 = (c, k, d) => (c && c[k] !== undefined ? c[k] : d);

function pill(text, bg, color) { return `<span style="display:inline-block;padding:14px 28px;border-radius:999px;background:${bg};color:${color};font:700 32px 'Sora'">${text}</span>`; }

scenes['v2-card'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('dark'));
    const badge = el('div', 'abs', 'ILLUSTRATION · SAMPLE CARD', { right: '50px', top: '56px', font: "700 24px 'Sora'", letterSpacing: '.12em', padding: '12px 22px', borderRadius: '999px', background: 'rgba(255,255,255,.12)', color: '#bcd2ff' });
    root.appendChild(badge);
    heading(root, 'Your contribution', 'Meaning and context', { text: 'travel with it.', t: c2(c, 'ctx', 1.0) }, true);
    const card = el('div', 'abs', null, { left: '80px', top: '560px', width: '920px', height: '640px', borderRadius: '48px', background: '#fff', boxShadow: '0 50px 120px rgba(0,0,0,.5)', padding: '48px 56px' });
    K(card, [[0.3, { o: 0, y: 120, s: 0.94 }], [1.1, { o: 1, y: 0, s: 1 }]]);
    root.appendChild(card);
    const row = (label, value, y, t, hint) => {
      const r = el('div', 'abs', `<div style="font:700 26px 'Sora';letter-spacing:.12em;text-transform:uppercase;color:#2c66f5">${label}</div><div style="font:600 44px/1.2 'Inter';color:#0f1830;margin-top:10px">${value}</div>`, { left: '56px', top: y + 'px', width: '808px' });
      K(r, appear(t, 0.5, 24)); card.appendChild(r); return r;
    };
    row('Expression', '“Welcome, come in.”', 48, 1.0);
    row('Kasem', '[ the way you say it ]', 178, c2(c, 'record', 1.8));
    row('Meaning', 'A warm welcome to a guest', 308, c2(c, 'meaning', 3.0));
    row('Said when', 'A guest arrives at your home', 438, c2(c, 'when', 4.0));
    // status pill
    const s1 = el('div', 'abs', pill('Draft', '#eef1f8', '#5d667b'), { right: '56px', top: '46px' });
    const s2 = el('div', 'abs', pill('● Awaiting review', '#fff7e6', '#92400e'), { right: '56px', top: '46px' });
    const s3 = el('div', 'abs', pill('✓ Approved', '#ecfdf5', '#047857'), { right: '56px', top: '46px' });
    const tReview = c2(c, 'review', 5.4), tOk = c2(c, 'approved', 8.6);
    K(s1, [[tReview - 0.01, { o: 1 }], [tReview, { o: 0 }]], E.lin);
    K(s2, [[tReview - 0.01, { o: 0 }], [tReview, { o: 1 }], [tOk - 0.01, { o: 1 }], [tOk, { o: 0 }]], E.lin);
    K(s3, [[tOk - 0.01, { o: 0 }], [tOk, { o: 1 }]], E.lin);
    card.appendChild(s1); card.appendChild(s2); card.appendChild(s3);
    // voice recording indicator
    st.rec = el('div', 'abs', null, { left: '56px', top: '560px', width: '808px', height: '50px' });
    K(st.rec, [[c2(c, 'record', 1.8), { o: 0 }], [c2(c, 'record', 1.8) + 0.3, { o: 1 }], [c2(c, 'meaning', 3.0), { o: 1 }], [c2(c, 'meaning', 3.0) + 0.3, { o: 0.25 }]]);
    card.appendChild(st.rec);
    st.recT = [c2(c, 'record', 1.8), c2(c, 'meaning', 3.0)];
    // reviewer check
    const rv = chip(root, 'A reviewer who speaks Kasem checks it', 140, 1290, 'blue', tReview + 0.3, 0, { font: "700 36px 'Sora'" });
    K(rv, [[tReview + 0.3, { o: 0, y: 30 }], [tReview + 0.8, { o: 1, y: 0 }], [tOk - 0.2, { o: 1 }], [tOk + 0.2, { o: 0 }]]);
    const ok = chip(root, 'Approved and published', 250, 1290, 'ok', tOk + 0.5, 0, { font: "700 36px 'Sora'" });
    st.t = c2(c, 'approved', 8.6);
    st.glow = el('div', 'abs', null, { left: '40px', top: '520px', width: '1000px', height: '720px', borderRadius: '70px', boxShadow: '0 0 120px 20px rgba(34,211,238,.55)', opacity: 0 });
    root.insertBefore(st.glow, card);
  },
  update(t, dur, st) {
    const [a, b] = st.recT;
    let bars = '';
    const on = t > a ? 1 : 0, live = t > a && t < b ? 1 : 0.0;
    for (let i = 0; i < 40; i++) { const h = on ? (live ? 8 + Math.abs(Math.sin(i * 0.7 + t * 9)) * 30 * (0.5 + 0.5 * Math.sin(i * 0.2)) : 6) : 6; bars += `<rect x="${i * 20}" y="${25 - h / 2}" width="10" height="${h}" rx="5" fill="${live ? '#2c66f5' : '#c9d5ee'}"/>`; }
    st.rec.innerHTML = `<svg width="808" height="50">${bars}</svg>`;
    st.glow.style.opacity = E.clamp((t - st.t) / 0.5) * (1 - E.clamp((t - st.t - 2.5) / 1.2)) * 0.9;
  },
};

scenes['v2-publish'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    heading(root, 'In the Kasem resources', 'Published whole,', { text: 'so learners can find it.', t: c2(c, 'find', 2.4) });
    const mk = (src, top, h, y0, w, t) => {
      const card = el('div', 'abs', null, { left: '90px', top: top + 'px', width: '900px', height: h + 'px', borderRadius: '40px', overflow: 'hidden', boxShadow: '0 40px 100px rgba(15,24,48,.22)', background: '#fff' });
      const im = el('img', null, null, { position: 'absolute', width: w + 'px', left: (900 - w) / 2 + 'px', top: -y0 + 'px' });
      im.src = src; card.appendChild(im);
      K(card, appear(t, 0.8, 90));
      root.appendChild(card); return card;
    };
    // heading of the real Common phrases page, then one real entry
    mk('img/dict-phrases.png', 470, 300, 620 * 0.77, 1170 * 0.77, 0.6);
    mk('img/dict-phrases.png', 810, 250, 1935 * 0.77, 1170 * 0.77, c2(c, 'entry', 1.6));
    const src = el('div', 'abs center', 'Kasem Dictionary · Common phrases · reviewed entries', { left: '60px', width: '960px', top: '1090px', font: "600 32px 'Inter'", color: '#5d667b' });
    K(src, appear(c2(c, 'entry', 1.6) + 0.5, 0.6, 20)); root.appendChild(src);
    chip(root, 'With its meaning', 90, 1170, 'blue', c2(c, 'meaning', 3.6), -2);
    chip(root, 'and its context', 520, 1250, 'ok', c2(c, 'context', 4.6), 2);
  },
};

scenes['v2-kawuri'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('dark'));
    const ring = (s, t0) => { const r = el('div', 'abs', null, { left: 540 - s / 2 + 'px', top: 700 - s / 2 + 'px', width: s + 'px', height: s + 'px', borderRadius: '50%', border: '3px solid rgba(142,180,255,.45)' }); K(r, [[t0, { o: 0, s: 0.6 }], [t0 + 1.6, { o: 0.6, s: 1 }], [t0 + 3.2, { o: 0, s: 1.25 }]], E.lin); root.appendChild(r); };
    ring(520, 0.2); ring(520, 1.4); ring(520, 2.6);
    const av = el('img', null, null, { position: 'absolute', left: '340px', top: '500px', width: '400px', height: '400px', borderRadius: '50%', boxShadow: '0 0 0 10px rgba(255,255,255,.14), 0 40px 100px rgba(0,0,0,.5)' });
    av.src = 'img/kawuri-hires.png';
    K(av, [[0.1, { o: 0, s: 0.6 }], [0.9, { o: 1, s: 1 }]], E.back);
    root.appendChild(av);
    const t = el('div', 'abs center', null, { left: '60px', width: '960px', top: '1000px' });
    t.innerHTML = `<div class="sora white" style="font:800 74px/1.08 'Sora'">Kawuri answers<br><span style="color:#22d3ee">from reviewed records.</span></div>`;
    K(t, appear(c2(c, 'text', 1.0), 0.7)); root.appendChild(t);
    const n = el('div', 'abs center', 'It does not know everything.', { left: '60px', width: '960px', top: '1260px', font: "600 38px 'Inter'", color: '#bcd2ff' });
    K(n, appear(c2(c, 'note', 2.6), 0.6, 20)); root.appendChild(n);
  },
};

scenes['v2-end'] = endcard(['Share one you', 'know well.'], 'Open the contributor portal', 'tribestudio.indigenworld.com/contributor', {
  extra(root, y) {
    const l = el('div', 'abs center', 'An expression, or a recording', { left: '40px', width: '1000px', top: y + 'px', font: "600 36px 'Inter'", color: '#8eb4ff' });
    K(l, appear(3.0, 0.6, 20)); root.appendChild(l);
  },
});
