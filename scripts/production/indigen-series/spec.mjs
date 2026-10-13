// Edit decision spec for each video: scene boundaries, cue times (from the narration's word timings), titles, SFX, captions.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WORK = path.resolve('exports/indigen-contributor-series/_work');
const state = JSON.parse(readFileSync(path.join(WORK, 'state.json'), 'utf8'));
const r3 = (x) => Math.round(x * 1000) / 1000;
const ONE_SHOT = { 'reviewer-puzzled': 6.037, 'reviewer-approve': 6.037, 'quiet-room': 6.037, 'elder-hands': 6.037, 'elder-guest': 6.037, 'record-voice': 6.037, 'teen-listening': 6.037, 'compound-wide': 5.0 };

export const LEAD = 0.5;
export const FPS = 30;

export function buildSpec(key) {
  const words = JSON.parse(readFileSync(path.join(WORK, 'audio', key, 'words.json'), 'utf8'));
  // a line lasts until its last spoken word ends (the measured length can be up to 0.6 s short of the audio)
  const lines = state.speech[key].map((l) => { const ws = words[l.index].words; return { ...l, words: ws, secs: Math.max(l.seconds, ws[ws.length - 1].end + 0.05) }; });
  const gap = key === 'v3' ? 0.22 : key === 'v4' ? 0.3 : 0.35;
  const lineStart = [];
  let t = key === 'v3' ? 0.4 : LEAD;
  for (const l of lines) { lineStart.push(r3(t)); t += l.secs + gap; }
  const lineEnd = lines.map((l, i) => r3(lineStart[i] + l.secs));
  /** absolute time of the nth script token of line i matching re (timing from the aligned ASR word) */
  const wordFor = (l, idx) => (l.tokens.length === l.words.length ? l.words[idx] : l.words[Math.round((idx * (l.words.length - 1)) / Math.max(1, l.tokens.length - 1))]);
  for (const l of lines) l.tokens = l.text.split(/\s+/);
  const wt = (i, re, nth = 0, edge = 'start') => {
    const rx = new RegExp(re.source, 'i');
    let k = 0;
    for (let j = 0; j < lines[i].tokens.length; j++) {
      if (rx.test(lines[i].tokens[j].replace(/[^\w']/g, ''))) { if (k++ === nth) { const w = wordFor(lines[i], j); return r3(lineStart[i] + (edge === 'end' ? w.end : w.start)); } }
    }
    throw new Error(key + ': token ' + re + ' (#' + nth + ') not in line ' + i + ': ' + lines[i].text);
  };
  const spec = { key, lines, lineStart, lineEnd, wt, segs: [], titles: [], sfx: [], captions: [], total: 0 };
  const scene = (id, name, start, end, cuesAbs = {}) => {
    const cues = {};
    for (const [k, v] of Object.entries(cuesAbs)) cues[k] = r3(v - start);
    spec.segs.push({ type: 'scene', id, scene: name, start: r3(start), end: r3(end), cues });
  };
  const human = (id, shot, start, dur, inPoint = 0) => {
    const avail = ONE_SHOT[shot] - inPoint;
    const speed = dur > avail ? avail / dur : 1;
    if (speed < 0.72) throw new Error(key + ': ' + id + ' needs ' + dur.toFixed(2) + ' s but ' + shot + ' only has ' + avail.toFixed(2));
    spec.segs.push({ type: 'human', id, shot, start: r3(start), end: r3(start + dur), inPoint, speed: r3(speed) });
  };
  const title = (text, start, end, o = {}) => spec.titles.push({ text, start: r3(start), end: r3(end), ...o });
  const sfx = (name, at, vol = 0.4) => spec.sfx.push({ name, t: r3(at), vol });
  const L = (i) => lineStart[i];
  const E = (i) => lineEnd[i];
  const TAIL = key === 'v4' ? 1.4 : key === 'v3' ? 1.2 : key === 'v2' ? 1.8 : 3.0;
  const last = lines.length - 1;

  if (key === 'v1') {
    human('hook', 'reviewer-puzzled', 0, 6.037);
    title('FOR CONTRIBUTORS', 0.3, 5.8, { kicker: true });
    title('Complete,\nbut is it clear?', 0.6, 5.8, {});
    scene('title', 'v1-title', 6.037, L(1) - 0.1, { });
    scene('weak', 'v1-weak', L(1) - 0.1, L(2) - 0.1, { q: wt(1, /^who$/), elder: wt(1, /^elder$/), child: wt(1, /^child$/), guest: wt(1, /^guest$/), zoom: wt(1, /^greeting$/) });
    scene('note', 'v1-note', L(2) - 0.1, L(3) - 0.1, { type: wt(2, /^write$/), typeEnd: wt(2, /^when$/, 0, 'end'), who: wt(2, /^who$/), whom: wt(2, /^whom$/), when: wt(2, /^when$/), first: wt(2, /^reviewer$/) });
    scene('accuracy', 'v1-accuracy', L(3) - 0.1, L(4) - 0.1, { a: wt(3, /^write$/), b: wt(3, /^spelling$/) - 0.3, c: wt(3, /^unsure$/) - 0.3 });
    scene('audio1', 'v1-audio', L(4) - 0.1, wt(4, /^quiet$/) - 0.25, { clean: 999, door: 999, hand: 999, listen: 999 });
    human('quiet', 'quiet-room', wt(4, /^quiet$/) - 0.25, 6.037);
    title('A quiet room beats\na noisy market.', wt(4, /^quiet$/) - 0.1, wt(4, /^quiet$/) + 5.2, {});
    scene('audio2', 'v1-audio', wt(4, /^quiet$/) - 0.25 + 6.037, L(5) - 0.1, { clean: -1, door: -1, hand: wt(4, /^hand/), listen: wt(4, /^listen$/) });
    scene('original', 'v1-original', L(5) - 0.1, L(6) - 0.1, { there: L(5) + 0.9, new: wt(5, /^new$/), copy: wt(5, /^exact$/) });
    scene('feedback', 'v1-feedback', L(6) - 0.1, L(7) - 0.1, { read: wt(6, /^reviewer$/), fix: wt(6, /^fix$/), resub: wt(6, /^send$|^again$/) - 0.2, record: wt(6, /^first$/) });
    scene('end', 'v1-end', L(7) - 0.1, E(7) + TAIL, {});
    sfx('whoosh', L(1) - 0.1, 0.22); sfx('whoosh', L(2) - 0.1, 0.18); sfx('whoosh', L(3) - 0.1, 0.18); sfx('whoosh', L(5) - 0.1, 0.18); sfx('whoosh', L(6) - 0.1, 0.18); sfx('whoosh', L(7) - 0.1, 0.22);
    sfx('pop', wt(1, /^elder$/), 0.3); sfx('pop', wt(1, /^child$/), 0.3); sfx('pop', wt(1, /^guest$/), 0.3);
    sfx('tick', wt(2, /^write$/), 0.3);
    sfx('chime', wt(5, /^new$/) + 0.4, 0.28);
    sfx('lock', wt(4, /^door$/) - 0.3, 0.3);
  }

  if (key === 'v2') {
    human('hands', 'elder-hands', 0, L(1) - 0.1);
    title('EVERYDAY KNOWLEDGE', 0.3, 5.8, { kicker: true });
    title('You know this\nby heart.', 0.5, 5.8, {});
    human('guest', 'elder-guest', L(1) - 0.1, 6.037);
    title('Learned from\nfamily.', wt(1, /^family\.?$/) - 0.5, wt(1, /^family\.?$/) + 1.8, {});
    human('compound1', 'compound-wide', L(1) - 0.1 + 6.037, L(2) - 0.1 - (L(1) - 0.1 + 6.037), 0.3);
    human('teen', 'teen-listening', L(2) - 0.1, L(3) - L(2));
    title('Far from home.', L(2) + 0.6, L(2) + 3.6, {});
    human('record', 'record-voice', L(3) - 0.1, wt(3, /^means$/) - L(3) + 0.1, 0.3);
    const cs = wt(3, /^means$/);
    scene('card', 'v2-card', cs, wt(4, /^approved$/) + 2.9, { record: cs + 0.1, meaning: wt(3, /^means$/), when: wt(3, /^said$/), review: wt(4, /^reviewer$/), approved: wt(4, /^approved$/) });
    const pubStart = wt(4, /^published$/) - 0.4;
    scene('publish', 'v2-publish', wt(4, /^approved$/) + 2.9, wt(4, /^learners$/) + 1.8, { find: wt(4, /^learners$/), entry: wt(4, /^published$/), meaning: wt(4, /^meaning$/), context: wt(4, /^context$/) });
    scene('kawuri', 'v2-kawuri', wt(4, /^learners$/) + 1.8, L(5) - 0.1, { text: wt(4, /^Kawuri$/) , note: E(4) - 1.0 });
    human('compound2', 'compound-wide', L(5) - 0.1, 4.8);
    human('guest2', 'elder-guest', L(5) - 0.1 + 4.8, L(6) - 0.1 - (L(5) - 0.1 + 4.8), 3.2);
    title('One at a time.', L(5) + 0.2, L(5) + 2.8, {});
    title('Not only\nin memory.', wt(5, /^live$/) - 0.3, E(5) + 0.1, {});
    scene('end', 'v2-end', L(6) - 0.1, E(6) + TAIL, {});
    sfx('whoosh', L(1) - 0.1, 0.2); sfx('whoosh', L(2) - 0.1, 0.2);
    sfx('tick', wt(3, /^record$/), 0.3);
    sfx('whoosh', cs, 0.2);
    sfx('lock', wt(4, /^reviewer$/) + 0.3, 0.28);
    sfx('chime', wt(4, /^approved$/) + 0.1, 0.32);
    sfx('whoosh', wt(4, /^approved$/) + 2.9, 0.2);
    sfx('pop', wt(4, /^learners$/), 0.25);
    sfx('whoosh', L(6) - 0.1, 0.22);
  }

  if (key === 'v3') {
    scene('jars', 'v3-jars', 0, L(1) - 0.1, { pulse: wt(0, /^yours$/) + 0.2, yours: wt(0, /^yours$/) });
    scene('flow', 'v3-flow', L(1) - 0.1, L(2) - 0.1, { add: wt(1, /^add$/), review: wt(1, /^reviewer$/), approved: wt(1, /^approved$/) });
    scene('count', 'v3-count', L(2) - 0.1, L(3) - 0.1, { draft: wt(2, /^drafts$/), wait: wt(2, /^waiting$/), ok: wt(2, /^approved$/) });
    scene('choose', 'v3-choose', L(3) - 0.1, L(6) - 0.1, { expr: wt(4, /^expressions$/) - 0.05, words: wt(4, /^words$/), prov: wt(4, /^proverbs$/), pron: wt(4, /^pronunciation$/) });
    scene('real', 'v3-real', L(6) - 0.1, L(7) - 0.1, { live: wt(6, /^real$/), url: wt(6, /^progress$/) });
    scene('full', 'v3-full', L(7) - 0.1, L(8) - 0.1, { notlaunch: wt(7, /^launch$/), notmodel: wt(7, /^model$/) - 0.3, rev: wt(7, /^reviewed$/) });
    scene('end', 'v3-end', L(8) - 0.1, E(8) + TAIL, {});
    for (const i of [1, 2, 3, 6, 7, 8]) sfx('whoosh', L(i) - 0.1, 0.2);
    sfx('pulse', wt(0, /^yours$/) + 0.2, 0.35); sfx('fill', wt(0, /^yours$/) + 1.4, 0.3);
    sfx('lock', wt(1, /^reviewer$/) + 0.2, 0.25); sfx('pulse', wt(1, /^approved$/) + 0.3, 0.35); sfx('fill', wt(1, /^approved$/) + 2.0, 0.3); sfx('chime', wt(1, /^approved$/), 0.28);
    sfx('pulse', wt(2, /^approved$/) + 0.5, 0.3); sfx('fill', wt(2, /^approved$/) + 1.5, 0.3);
    for (const re of [/^expressions$/, /^words$/, /^proverbs$/, /^pronunciation$/]) sfx('pop', wt(4, re), 0.28);
    sfx('chime', wt(7, /^reviewed$/), 0.25);
  }

  if (key === 'v4') {
    scene('submit', 'v4-submit', 0, L(1) + 0.5, { tap: wt(0, /^tap$/) + 0.35, confirm: L(1) - 0.4 });
    scene('locked', 'v4-locked', L(1) + 0.5, L(2) - 0.1, { await: wt(1, /^awaiting$/), lock: wt(1, /^locks$/), sees: wt(1, /^sees$/) });
    human('review', 'reviewer-approve', L(2) - 0.1, L(3) - 0.1 - (L(2) - 0.1));
    title('Usage note first.', wt(2, /^usage$/) - 0.2, wt(2, /^first$/) + 0.6, {});
    title('Then meaning\nand context.', wt(2, /^meaning$/) - 0.2, E(2) + 0.2, {});
    scene('branch', 'v4-branch', L(3) - 0.1, L(4) - 0.1, { approve: wt(3, /^approve$/), back: wt(3, /^send$/), revise: wt(3, /^revise$/), resub: wt(3, /^resubmit$/), record: wt(3, /^version$/) });
    const hardAt = wt(4, /^expression$/) - 0.25;
    scene('why', 'v4-why', L(4) - 0.1, hardAt, { reliable: wt(4, /^rely$/) - 0.6, noheard: wt(4, /^recording$/) - 0.3, noctx: 999, hard: 999, rely: wt(4, /^rely$/) });
    human('puzzled', 'reviewer-puzzled', hardAt, L(5) - 0.1 - hardAt);
    title('Hard to use.', wt(4, /^hard$/) - 0.3, E(4) + 0.1, {});
    scene('jar', 'v4-jar', L(5) - 0.1, L(6) - 0.1, { count: wt(5, /^adds$/) - 0.2, url: wt(5, /^progress$/) });
    const kEnd = wt(6, /^records$/, 0, 'end') + 0.3;
    scene('kawuri', 'v4-kawuri', L(6) - 0.1, kEnd, { text: wt(6, /^Kawuri$/) });
    scene('notauto', 'v4-notauto', kEnd, L(7) - 0.1, { model: wt(6, /^instantly$/) - 0.3, every: wt(6, /^every$/) - 0.3, decide: wt(6, /^review$/) });
    scene('activity', 'v4-activity', L(7) - 0.1, E(7) + 0.1, { dec: wt(7, /^activity$/), fb: wt(7, /^feedback$/) - 0.4, again: wt(7, /^again$/) - 0.8 });
    scene('end', 'v4-end', E(7) + 0.1, E(7) + TAIL + 1.0, {});
    for (const [id] of [['locked'], ['branch'], ['jar'], ['kawuri'], ['activity']]) { const s = spec.segs.find((x) => x.id === id); sfx('whoosh', s.start, 0.2); }
    sfx('tick', wt(0, /^tap$/) + 0.35, 0.35); sfx('tick', L(1) - 0.4, 0.35); sfx('lock', wt(1, /^locks$/) + 0.1, 0.3);
    sfx('chime', wt(3, /^approve$/) + 0.2, 0.28);
    const jar = spec.segs.find((x) => x.id === 'jar'); const k = jar.start + jar.cues.count;
    sfx('pulse', k + 0.2, 0.35); sfx('fill', k + 1.4, 0.3);
  }

  spec.total = r3(Math.max(...spec.segs.map((s) => s.end)));
  // sanity: segments of the picture track must be contiguous
  const sorted = [...spec.segs].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) if (Math.abs(sorted[i].start - sorted[i - 1].end) > 0.02) throw new Error(`${key}: gap/overlap between ${sorted[i - 1].id} (${sorted[i - 1].end}) and ${sorted[i].id} (${sorted[i].start})`);
  spec.segs = sorted;
  spec.captions = buildCaptions(spec);
  return spec;
}

function buildCaptions(spec) {
  const out = [];
  spec.lines.forEach((line, li) => {
    const text = line.text;
    const tokens = text.split(/\s+/);
    const asr = line.words;
    const wordAt = (i) => asr[tokens.length === asr.length ? i : Math.round((i * (asr.length - 1)) / Math.max(1, tokens.length - 1))];
    // split into phrases at sentence ends and commas
    const phrases = [];
    let cur = [];
    tokens.forEach((tk, i) => { cur.push(i); if (/[.?!]$/.test(tk) || (/,$/.test(tk) && cur.length >= 3)) { phrases.push(cur); cur = []; } });
    if (cur.length) phrases.push(cur);
    // split long phrases, merge tiny ones
    const chunks = [];
    for (const ph of phrases) {
      let rest = ph;
      while (rest.length > 8 || rest.map((i) => tokens[i]).join(' ').length > 46) {
        const half = Math.ceil(rest.length / 2);
        chunks.push(rest.slice(0, half)); rest = rest.slice(half);
      }
      chunks.push(rest);
    }
    const merged = [];
    for (const c of chunks) {
      const prev = merged[merged.length - 1];
      if (prev && (c.length < 3 || prev.length < 3) && prev.length + c.length <= 8 && prev.concat(c).map((i) => tokens[i]).join(' ').length <= 46) merged[merged.length - 1] = prev.concat(c);
      else merged.push(c);
    }
    merged.forEach((c, ci) => {
      const s = spec.lineStart[li] + wordAt(c[0]).start - 0.04;
      const nextStart = ci + 1 < merged.length ? spec.lineStart[li] + wordAt(merged[ci + 1][0]).start - 0.04 : Infinity;
      let e = spec.lineStart[li] + wordAt(c[c.length - 1]).end + 0.28;
      e = Math.min(e, nextStart - 0.02);
      let txt = c.map((i) => tokens[i]).join(' ');
      if (txt.length > 24) {
        const mid = txt.length / 2; let best = -1;
        for (let i = 0; i < txt.length; i++) if (txt[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
        if (best > 0) txt = txt.slice(0, best) + '\n' + txt.slice(best + 1);
      }
      out.push({ text: txt, start: Math.round(Math.max(0, s) * 1000) / 1000, end: Math.round(e * 1000) / 1000 });
    });
  });
  return out;
}
