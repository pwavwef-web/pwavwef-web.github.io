/* Video 4 — What Happens After You Submit? */
const c4 = (c, k, d) => (c && c[k] !== undefined ? c[k] : d);
const P4 = { W: 580, X: 250, Y: 450, H: 980 };
const I4 = P4.W - 32, S4 = I4 / 468;

scenes['v4-submit'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    heading(root, 'After you submit', 'You tap Submit.', null);
    const p = phone(P4.X, P4.Y, P4.W, 'img/e8-ready.png', { h: P4.H });
    p.img.style.width = I4 + 'px';
    root.appendChild(p);
    K(p, [[0.1, { o: 0, y: 120 }], [0.8, { o: 1, y: 0 }]]);
    const conf = el('img', 'shot'); conf.src = 'img/e8-confirm.png'; conf.style.width = I4 + 'px';
    p.screen.appendChild(conf);
    const tTap = c4(c, 'tap', 1.8), tConf = c4(c, 'confirm', 4.2);
    K(conf, [[tTap + 0.45, { o: 0 }], [tTap + 0.8, { o: 1 }]], E.lin);
    // tap ripple on the Submit button (approx screen position)
    const rip = el('div', 'abs', null, { left: P4.X + 16 + I4 * 0.5 - 40 + 'px', top: P4.Y + 16 + 770 * S4 * 0.85 + 'px', width: '80px', height: '80px', borderRadius: '50%', background: 'rgba(47,107,255,.5)' });
    K(rip, [[tTap, { o: 0.9, s: 0.4 }], [tTap + 0.6, { o: 0, s: 2.6 }]], E.lin);
    root.appendChild(rip);
    const rip2 = el('div', 'abs', null, { left: P4.X + 16 + I4 * 0.72 - 40 + 'px', top: P4.Y + 16 + 805 * S4 * 0.98 + 'px', width: '80px', height: '80px', borderRadius: '50%', background: 'rgba(47,107,255,.5)' });
    K(rip2, [[tConf, { o: 0.9, s: 0.4 }], [tConf + 0.6, { o: 0, s: 2.6 }]], E.lin);
    root.appendChild(rip2);
    chip(root, 'Confirm submission', 160, 1230, 'blue', tConf - 0.4, 0);
    const tag = el('div', 'abs', SAMPLE_TAG('Sample screen · placeholder Kasem'), { right: '50px', top: '56px', textAlign: 'right', maxWidth: '640px' });
    root.appendChild(tag);
  },
};

scenes['v4-locked'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    heading(root, 'Step 1', 'Locked and', { text: 'awaiting review.', t: 0.6 });
    const p = phone(P4.X, P4.Y, P4.W, 'img/ed-e2.png', { h: P4.H });
    p.img.style.width = I4 + 'px';
    root.appendChild(p);
    K(p, [[0.1, { o: 0, y: 120 }], [0.8, { o: 1, y: 0 }]]);
    K(p.img, [[0, { s: 1, x: 0, y: 0 }], [1.5, { s: 1, x: 0, y: 0 }], [2.6, zoomTo(I4 * 0.45, 330 * S4, 1.35, I4 / 2, 330)]], E.inOut);
    chip(root, 'Awaiting review', 40, 760, 'warn', c4(c, 'await', 1.8), -3);
    chip(root, 'Locked while under review', 380, 960, 'dark', c4(c, 'lock', 3.6), 2);
    chip(root, 'The reviewer sees what you sent', 100, 1180, 'blue', c4(c, 'sees', 5.6), -2, { font: "700 36px 'Sora'" });
  },
};

scenes['v4-branch'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    heading(root, 'Step 2', 'Approved,', { text: 'or sent back to improve.', t: c4(c, 'back', 3.2) });
    const ap = el('div', 'card', `<div style="display:flex;align-items:center;gap:26px"><span class="tick"></span><div><div class="sora" style="font:700 44px 'Sora';color:#047857">Approved</div><div style="font:500 32px Inter;color:#5d667b;margin-top:6px">Locked, then published</div></div></div>`, { left: '80px', top: '470px', width: '920px', height: '170px', display: 'flex', alignItems: 'center', background: '#ecfdf5' });
    K(ap, [[c4(c, 'approve', 0.9), { o: 0, x: -80 }], [c4(c, 'approve', 0.9) + 0.6, { o: 1, x: 0 }]]);
    root.appendChild(ap);
    const rt = el('div', 'card', null, { left: '80px', top: '680px', width: '920px', height: '470px', padding: '40px 48px' });
    rt.innerHTML = `<div style="display:flex;align-items:center;gap:26px"><span style="display:inline-block;width:54px;height:54px;border-radius:50%;background:#f59e0b;color:#fff;font:800 34px/54px Sora;text-align:center">↩</span><div><div class="sora" style="font:700 44px 'Sora';color:#92400e">Returned with feedback</div></div></div>`;
    const crop = el('div', 'abs', null, { left: '48px', top: '120px', width: '824px', height: '300px', borderRadius: '24px', overflow: 'hidden', background: '#fff7e6' });
    const im = el('img', null, null, { position: 'absolute', width: '1170px', left: '-45px', top: '-500px', transform: 'scale(.745)', transformOrigin: '45px 500px' });
    im.src = 'img/ed-e3.png'; crop.appendChild(im); rt.appendChild(crop);
    K(rt, [[c4(c, 'back', 3.2) - 0.2, { o: 0, x: 80 }], [c4(c, 'back', 3.2) + 0.5, { o: 1, x: 0 }]]);
    root.appendChild(rt);
    const rev = chip(root, 'Revise', 80, 1170, 'blue', c4(c, 'revise', 6.2), -2);
    const res = chip(root, 'Resubmit', 380, 1170, 'blue', c4(c, 'resub', 7.0), 2);
    const rec = chip(root, 'First version stays on record', 250, 1262, 'dark', c4(c, 'record', 8.6), 0);
    const tag = el('div', 'abs', SAMPLE_TAG('Sample feedback · local preview'), { right: '50px', top: '56px', textAlign: 'right', maxWidth: '640px' });
    root.appendChild(tag);
  },
};

scenes['v4-why'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('dark'));
    heading(root, 'Why review exists', 'Collected is not', { text: 'the same as reliable.', t: c4(c, 'reliable', 4.6) }, true);
    const col = (title, x, tone) => { const h = el('div', 'abs sora', title, { left: x + 'px', top: '470px', width: '430px', font: "700 34px 'Sora'", letterSpacing: '.1em', textTransform: 'uppercase', color: tone }); root.appendChild(h); return h; };
    const h1 = col('Collected', 70, '#f59e0b'); K(h1, appear(1.0, 0.5, 20));
    const h2 = col('Reliable', 580, '#22d3ee'); K(h2, appear(c4(c, 'reliable', 4.6), 0.5, 20));
    const item = (x, y, label, bad, t, wave) => {
      const d = el('div', 'card dark', null, { left: x + 'px', top: y + 'px', width: '430px', height: '250px', padding: '30px 34px', background: bad ? '#1b2a52' : '#143a5a' });
      d.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><div class="sora" style="font:700 34px 'Sora'">${label}</div><span class="${bad ? 'cross' : 'tick'}" style="width:46px;height:46px"></span></div><div style="margin-top:26px">${wave}</div>`;
      K(d, [[t, { o: 0, y: 60 }], [t + 0.6, { o: 1, y: 0 }]]);
      root.appendChild(d); return d;
    };
    const wv = (bad) => { let b = ''; for (let i = 0; i < 20; i++) { const h = bad ? 10 + ((i * 53) % 9) * 7 : 10 + Math.abs(Math.sin(i * 0.5)) * 46 * (0.4 + 0.6 * Math.sin(i / 20 * Math.PI)); b += `<rect x="${i * 20}" y="${35 - h / 2}" width="10" height="${h}" rx="5" fill="${bad ? '#f59e0b' : '#22d3ee'}" opacity="${bad ? 0.85 : 1}"/>`; } return `<svg width="390" height="70">${b}</svg>`; };
    const lines = (bad) => `<div style="display:flex;flex-direction:column;gap:14px"><div style="height:24px;border-radius:12px;background:${bad ? '#314273' : '#2a6a96'};width:${bad ? 52 : 92}%"></div><div style="height:24px;border-radius:12px;background:${bad ? '#314273' : '#2a6a96'};width:${bad ? 30 : 70}%"></div>${bad ? '' : `<div style="height:24px;border-radius:12px;background:#2a6a96;width:80%"></div>`}</div>`;
    item(70, 560, 'Can’t be heard', true, c4(c, 'noheard', 8.0), wv(true));
    item(70, 840, 'No context', true, c4(c, 'noctx', 11.0), lines(true));
    item(580, 560, 'Clear recording', false, c4(c, 'reliable', 4.6) + 0.6, wv(false));
    item(580, 840, 'Meaning + context', false, c4(c, 'reliable', 4.6) + 1.2, lines(false));
    const hard = chip(root, 'Hard to use', 70, 1150, 'warn', c4(c, 'hard', 12.4), -2);
    const rely = chip(root, 'Material people can rely on', 330, 1250, 'ok', c4(c, 'rely', 6.8), 2);
  },
};

scenes['v4-jar'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    ILLUS_BADGE(root);
    heading(root, 'Step 3', 'Published,', { text: 'then it counts.', t: 1.0 });
    const card = el('div', 'card', `<div style="display:flex;align-items:center;gap:26px"><span class="tick"></span><div><div class="sora" style="font:700 40px 'Sora';color:#047857">Approved expression</div><div style="font:500 30px Inter;color:#5d667b;margin-top:4px">Published whole, with its meaning</div></div></div>`, { left: '60px', top: '470px', width: '640px', height: '170px', display: 'flex', alignItems: 'center', background: '#ecfdf5' });
    K(card, appear(0.4, 0.6, 40)); root.appendChild(card);
    st.pump = makePump(root, 730, 470, 300);
    K(st.pump, appear(0.5, 0.6));
    st.jar = makeJar(root, 770, 940, 230);
    K(st.jar.el, appear(0.6, 0.7, 60));
    st.pipes = makePipes(root, ['M880 ' + (470 + st.pump.h) + ' L880 950']);
    st.t = c4(c, 'count', 3.0);
    const lab = el('div', 'abs sora', 'Everyday Expressions', { left: '650px', width: '420px', textAlign: 'center', top: '1255px', font: "700 32px 'Sora'", color: '#0f1830' });
    K(lab, appear(1.0, 0.5, 20)); root.appendChild(lab);
    chip(root, '+1 approved', 90, 880, 'blue', st.t + 1.8, -2);
    const u = el('div', 'abs', 'See it on indigenworld.com/progress', { left: '60px', top: '1070px', width: '600px', font: "700 38px 'Sora'", color: '#2c66f5' });
    K(u, appear(c4(c, 'url', 5.2), 0.6, 20)); root.appendChild(u);
  },
  update(t, dur, st) {
    const k = st.t;
    st.pump.spin(t, 1 + (t > k && t < k + 2 ? 2.5 : 0));
    st.pipes.pulse(0, k + 0.2, 1.0, t);
    st.jar.update(0.3 + smooth(t, k + 1.2, k + 3.0) * 0.12, t, smooth(t, k + 1.2, k + 1.9) * (1 - smooth(t, k + 4, k + 5)));
  },
};

scenes['v4-kawuri'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('dark'));
    const ring = (s, t0) => { const r = el('div', 'abs', null, { left: 540 - s / 2 + 'px', top: 640 - s / 2 + 'px', width: s + 'px', height: s + 'px', borderRadius: '50%', border: '3px solid rgba(142,180,255,.45)' }); K(r, [[t0, { o: 0, s: 0.6 }], [t0 + 1.6, { o: 0.6, s: 1 }], [t0 + 3.2, { o: 0, s: 1.25 }]], E.lin); root.appendChild(r); };
    ring(480, 0.2); ring(480, 1.4); ring(480, 2.6);
    const av = el('img', null, null, { position: 'absolute', left: '350px', top: '450px', width: '380px', height: '380px', borderRadius: '50%', boxShadow: '0 0 0 10px rgba(255,255,255,.14), 0 40px 100px rgba(0,0,0,.5)' });
    av.src = 'img/kawuri-hires.png';
    K(av, [[0.1, { o: 0, s: 0.6 }], [0.9, { o: 1, s: 1 }]], E.back);
    root.appendChild(av);
    const t = el('div', 'abs center', null, { left: '60px', width: '960px', top: '930px' });
    t.innerHTML = `<div class="sora white" style="font:800 72px/1.08 'Sora'">Kawuri answers only<br><span style="color:#22d3ee">from reviewed records.</span></div>`;
    K(t, appear(c4(c, 'text', 0.9), 0.7)); root.appendChild(t);
  },
};

scenes['v4-notauto'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('dark'));
    heading(root, 'Keeping it honest', 'Approval is not', { text: 'automatic use.', t: 0.6 }, true);
    const row = (txt, y, t, ok) => {
      const d = el('div', 'card dark', `<div style="display:flex;align-items:center;gap:30px"><span class="${ok ? 'tick' : 'cross'}"></span><span class="sora" style="font:700 46px/1.15 'Sora'">${txt}</span></div>`, { left: '70px', top: y + 'px', width: '940px', height: '170px', display: 'flex', alignItems: 'center' });
      K(d, [[t, { o: 0, x: 80 }], [t + 0.6, { o: 1, x: 0 }]]);
      root.appendChild(d);
    };
    row('Not an instant model', 480, c4(c, 'model', 1.6), false);
    row('Not in every resource', 690, c4(c, 'every', 3.4), false);
    row('Review and quality checks decide what is used', 900, c4(c, 'decide', 6.0), true);
  },
};

scenes['v4-activity'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('light'));
    heading(root, 'After you submit', 'Check Activity.', null);
    const p = phone(P4.X, P4.Y, P4.W, 'img/activity-decisions.png', { h: P4.H });
    p.img.style.width = I4 + 'px';
    root.appendChild(p);
    K(p, [[0.1, { o: 0, y: 120 }], [0.8, { o: 1, y: 0 }]]);
    chip(root, 'Decisions appear here', 40, 700, 'blue', c4(c, 'dec', 1.4), -3);
    chip(root, 'Read the feedback', 560, 940, '', c4(c, 'fb', 3.8), 3);
    chip(root, 'Send it again if asked', 120, 1160, 'blue', c4(c, 'again', 5.6), -2);
    const tag = el('div', 'abs', SAMPLE_TAG('Sample data · local preview'), { right: '50px', top: '56px', textAlign: 'right', maxWidth: '640px' });
    root.appendChild(tag);
  },
};

scenes['v4-end'] = endcard(['Check your Activity.', 'Use the feedback.'], 'Open the contributor portal', 'tribestudio.indigenworld.com/contributor');

/* Covers / thumbnails (1080x1920; also cropped to 1:1 for previews). cues = { n, lines:[…], accent, art, bg, phone } */
scenes['cover'] = {
  build(root, dur, st, c) {
    root.appendChild(bgLayer('dark'));
    if (c.bg) {
      const im = el('img', null, null, { position: 'absolute', left: 0, top: 0, width: '1080px', height: '1920px', objectFit: 'cover' });
      im.src = c.bg; root.appendChild(im);
      root.appendChild(el('div', 'layer', null, { background: 'linear-gradient(180deg, rgba(8,14,32,.15) 0%, rgba(8,14,32,.25) 40%, rgba(8,14,32,.9) 100%)' }));
    }
    const brand = el('div', 'abs', BRAND_LOCKUP(true), { left: '70px', top: '90px' });
    root.appendChild(brand);
    const k = el('div', 'abs kicker dark', 'Contributor series · ' + c.n, { left: '70px', top: c.art === 'none' ? '1020px' : '250px' });
    root.appendChild(k);
    if (c.art === 'phone') {
      const p = phone(300, 340, 480, c.phone, { h: 800 }); p.img.style.width = '448px'; p.style.transform = 'rotate(-4deg)'; root.appendChild(p);
    }
    if (c.art === 'jars') {
      [[90, 0.55], [390, 0.78], [690, 0.35]].forEach(([x, lvl], i) => { const j = makeJar(root, x, 420 + (i === 1 ? -50 : 0), 300); j.update(lvl, 1.2 + i, i === 1 ? 0.8 : 0); });
    }
    const h = el('div', 'abs white', c.lines.join('<br>'), { left: '70px', width: '940px', top: c.art === 'none' ? '1090px' : '1270px', font: "800 100px/1.03 'Sora'", letterSpacing: '-.02em' });
    
    root.appendChild(h);
    if (c.accent) { const a = el('div', 'abs cyan sora', c.accent, { left: '70px', top: '1760px', font: "700 40px 'Sora'" }); root.appendChild(a); }
  },
};
