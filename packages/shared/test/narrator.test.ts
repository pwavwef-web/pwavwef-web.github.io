import { describe, expect, it } from 'vitest';
import {
  AUDITION_SCRIPT,
  CONSENT_STATEMENTS,
  DEFAULT_CLOSING,
  DEFAULT_EDITION_SETTINGS,
  NARRATOR,
  REFERENCE_SCRIPT,
  SEED_PRONUNCIATIONS,
  analyzeRecording,
  applyCleanup,
  applyPronunciations,
  bloggerEmbedHtml,
  buildScript,
  chunkText,
  cleanupEdits,
  decodePcm16Wav,
  encodePcm16Wav,
  estimateNarration,
  exportFileNames,
  extractArticle,
  flattenScript,
  joinWithPauses,
  loudnessTarget,
  narratorRequestSchema,
  numberToWords,
  parseSoundCloudInput,
  passageAudioState,
  passageSynthesisInput,
  proposeCleanup,
  proposeSkips,
  providerTextFor,
  speechBounds,
  transcriptText,
  trimClip,
  yearToWords,
  type PronunciationEntry,
} from '../src/index';

const ids = () => {
  let n = 0;
  return () => `id${n++}`;
};

const ARTICLE = `## Why this matters

AI can help you move faster. But speed is not the same as quality.

If you don't know what good work looks like, you might simply arrive at the wrong answer sooner.

## What to do instead

Check the work. Read the sources. Ask a better question.`;

describe('script building', () => {
  it('keeps every paragraph, in order, as the source of a passage, and adds one opening and the closing', () => {
    const { script } = buildScript({ title: 'Convincing is not correct', body: ARTICLE }, ids());
    const flat = flattenScript(script);
    expect(flat[0]!.passage.kind).toBe('opening');
    expect(flat[0]!.passage.text).toBe("Convincing is not correct. Written by Francis Pwavwe. You're listening to The Pwavwe Papers.");
    expect(flat[flat.length - 1]!.passage.text).toBe(DEFAULT_CLOSING);
    const body = flat.filter((f) => f.passage.kind === 'heading' || f.passage.kind === 'paragraph').map((f) => f.passage.source);
    expect(body).toEqual(['Why this matters', 'AI can help you move faster. But speed is not the same as quality.', "If you don't know what good work looks like, you might simply arrive at the wrong answer sooner.", 'What to do instead', 'Check the work. Read the sources. Ask a better question.']);
    expect(script.sections.map((s) => s.title)).toEqual(['Why this matters', 'What to do instead']);
    // Spoken text starts identical to the article: nothing is rewritten or summarised.
    for (const f of flat) if (f.passage.source) expect(f.passage.text).toBe(f.passage.source);
  });

  it('never prepends a second introduction when the article already has one, and does not read the title twice', () => {
    const body = `Convincing is not correct\n\nConvincing is not correct. Written by Francis Pwavwe. You’re listening to The Pwavwe Papers.\n\nFirst paragraph.`;
    const { script, notes } = buildScript({ title: 'Convincing is not correct', body }, ids());
    const flat = flattenScript(script);
    expect(flat.filter((f) => /listening to The Pwavwe Papers/.test(f.passage.text) && f.passage.kind !== 'closing')).toHaveLength(1);
    expect(flat[0]!.passage.source).toContain('Written by Francis Pwavwe');
    expect(flat.map((f) => f.passage.text)).toContain('First paragraph.');
    expect(notes.join(' ')).toMatch(/no second introduction/);
  });

  it('uses a supplied package opening instead of the default', () => {
    const { script } = buildScript({ title: 'T', body: 'One.', existingOpening: 'T. A paper by Francis Pwavwe, read by the author.' }, ids());
    expect(script.opening!.text).toBe('T. A paper by Francis Pwavwe, read by the author.');
  });

  it('respects the closing switch', () => {
    const { script } = buildScript({ title: 'T', body: 'One.' }, ids());
    expect(flattenScript(script, false).some((f) => f.passage.kind === 'closing')).toBe(false);
  });
});

describe('chunking', () => {
  it('splits at sentence boundaries within the limit and preserves every word in order', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${numberToWords(i + 1)} says something “quoted” here, and then it ends.`);
    const text = sentences.join(' ');
    const chunks = chunkText(text, 400);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
    expect(chunks.join(' ')).toBe(text);
    for (const c of chunks) expect(c).toMatch(/[.!?”]$/);
  });

  it('splits an over-long sentence at clause or word boundaries without losing words', () => {
    const long = `${'word, '.repeat(200)}end.`;
    const chunks = chunkText(long, 300);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim());
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
  });
});

describe('pronunciation spellings', () => {
  const book: PronunciationEntry[] = [
    { id: 'a', term: 'Pwavwe', spokenAs: 'PWAH-vweh', hint: '', caseSensitive: false, recordingId: null },
    { id: 'b', term: 'The Pwavwe Papers', spokenAs: 'The PWAH-vweh Papers', hint: '', caseSensitive: false, recordingId: null },
    { id: 'c', term: 'Kasem', spokenAs: '', hint: '', caseSensitive: false, recordingId: null },
  ];
  it('replaces whole terms (longest first) only in the text sent to the voice', () => {
    const visible = "I'm Francis Pwavwe and this is The Pwavwe Papers. Pwavwes is not a term. Kasem stays.";
    const r = applyPronunciations(visible, book);
    expect(r.text).toBe("I'm Francis PWAH-vweh and this is The PWAH-vweh Papers. Pwavwes is not a term. Kasem stays.");
    expect(r.applied.map((a) => a.term).sort()).toEqual(['Pwavwe', 'The Pwavwe Papers']);
    expect(visible).toContain('Pwavwe'); // the original string is untouched
  });
  it('seeds names without guessing how they are pronounced', () => {
    expect(SEED_PRONUNCIATIONS.map((s) => s.term)).toEqual(['Francis Pwavwe', 'The Pwavwe Papers', 'Indigen World', 'Kasem', 'University of Cape Coast']);
    expect(SEED_PRONUNCIATIONS.every((s) => s.spokenAs === '')).toBe(true);
    expect(providerTextFor('Francis Pwavwe', SEED_PRONUNCIATIONS).text).toBe('Francis Pwavwe');
  });
});

describe('per-passage invalidation', () => {
  const voice = { id: 'v1', modelId: 'm1' };
  const { script } = buildScript({ title: 'T', body: 'First paragraph.\n\nSecond paragraph.' }, ids());
  const flat = flattenScript(script);
  const hashes = () => Object.fromEntries(flat.map((f) => [f.passage.id, passageSynthesisInput(f.passage, DEFAULT_EDITION_SETTINGS, [], voice).inputHash]));

  it('editing one passage changes only that passage’s hash', () => {
    const before = hashes();
    const target = script.sections[0]!.passages[1]!;
    const edited = { ...target, text: 'Second paragraph, revised.' };
    const after = { ...before, [target.id]: passageSynthesisInput(edited, DEFAULT_EDITION_SETTINGS, [], voice).inputHash };
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    expect(changed).toEqual([target.id]);
  });

  it('a selected take made from other inputs is stale, never current', () => {
    const p = script.sections[0]!.passages[0]!;
    const h = passageSynthesisInput(p, DEFAULT_EDITION_SETTINGS, [], voice).inputHash;
    expect(passageAudioState(p, h, { status: 'ready', inputHash: h }, null, false)).toBe('current');
    expect(passageAudioState(p, h, { status: 'ready', inputHash: 'old' }, null, false)).toBe('stale');
    expect(passageAudioState(p, h, { status: 'ready', inputHash: 'old' }, { status: 'needs_recovery' }, false)).toBe('needs_recovery');
    expect(passageAudioState(p, h, null, null, true)).toBe('generating');
    expect(passageAudioState({ ...p, skip: true }, h, null, null, false)).toBe('skipped');
  });

  it('voice, model, style and pronunciation changes also invalidate audio', () => {
    const p = script.sections[0]!.passages[0]!;
    const base = passageSynthesisInput(p, DEFAULT_EDITION_SETTINGS, [], voice).inputHash;
    expect(passageSynthesisInput(p, DEFAULT_EDITION_SETTINGS, [], { id: 'v2', modelId: 'm1' }).inputHash).not.toBe(base);
    expect(passageSynthesisInput(p, DEFAULT_EDITION_SETTINGS, [], { id: 'v1', modelId: 'm2' }).inputHash).not.toBe(base);
    expect(passageSynthesisInput(p, { ...DEFAULT_EDITION_SETTINGS, preset: 'firm' }, [], voice).inputHash).not.toBe(base);
    expect(passageSynthesisInput(p, DEFAULT_EDITION_SETTINGS, [{ id: 'x', term: 'First', spokenAs: 'Furst', hint: '', caseSensitive: false, recordingId: null }], voice).inputHash).not.toBe(base);
  });
});

describe('cleanup proposals', () => {
  it('proposes reviewable edits and preserves all other text exactly', () => {
    const text = 'Read **this** [study](https://example.org/x) [3] (https://example.org/raw) today — it found 45% growth in 2026 & beyond, e.g. here.';
    const edits = cleanupEdits(text);
    expect(edits.map((e) => e.kind).sort()).toEqual(['abbreviation', 'citation', 'link', 'markdown', 'numbers', 'numbers', 'symbols', 'url']);
    const { script } = buildScript({ title: 'T', body: text }, ids());
    const proposals = proposeCleanup(script);
    // Nothing changes until something is accepted.
    expect(applyCleanup(script, new Set())).toEqual(script);
    const out = applyCleanup(script, new Set(proposals.map((p) => p.id)));
    const spoken = out.sections[0]!.passages[0]!.text;
    expect(spoken).toBe('Read this study today — it found forty-five percent growth in twenty twenty-six and beyond, for example here.');
    expect(out.sections[0]!.passages[0]!.source).toBe(text);
  });

  it('only proposes leaving out credits and interface text (never deletes it)', () => {
    const { script } = buildScript({ title: 'T', body: 'Photo by Ama Mensah on Unsplash\n\nShare this:\n\nA real paragraph about Kasem.' }, ids());
    const skips = proposeSkips(script);
    expect(skips.map((s) => s.reason)).toEqual(['image_credit', 'interface_text']);
    const out = applyCleanup(script, new Set(), new Set(skips.map((s) => s.passageId)));
    expect(out.sections[0]!.passages.map((p) => [p.text, Boolean(p.skip)])).toEqual([
      ['Photo by Ama Mensah on Unsplash', true],
      ['Share this:', true],
      ['A real paragraph about Kasem.', false],
    ]);
  });

  it('reads numbers the usual way', () => {
    expect(yearToWords(1984)).toBe('nineteen eighty-four');
    expect(yearToWords(2005)).toBe('two thousand and five');
    expect(numberToWords(1250)).toBe('one thousand two hundred and fifty');
  });
});

describe('recording analysis', () => {
  const rate = 24000;
  const speechLike = (sec: number, amp = 0.3) => {
    const s = new Float32Array(Math.round(sec * rate));
    for (let i = 0; i < s.length; i++) {
      const t = i / rate;
      const syllable = Math.sin(Math.PI * ((t * 4) % 1)) ** 2; // 4 syllables per second
      s[i] = amp * syllable * Math.sin(2 * Math.PI * 180 * t) + 0.0005 * Math.sin(i * 12.9898);
    }
    return s;
  };
  it('accepts clean 15 s speech-like audio', () => {
    const a = analyzeRecording(speechLike(15), rate, 'reference');
    expect(a.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(a.durationSec).toBeCloseTo(15, 1);
  });
  it('flags silence, invalid duration and severe clipping', () => {
    expect(analyzeRecording(new Float32Array(rate * 12), rate, 'reference').issues.map((i) => i.code)).toContain('silent');
    expect(analyzeRecording(speechLike(6), rate, 'reference').issues.map((i) => i.code)).toContain('too_short');
    expect(analyzeRecording(speechLike(34), rate, 'reference').issues.map((i) => i.code)).toContain('too_long');
    const hot = speechLike(15, 3).map((x) => Math.max(-1, Math.min(1, x)));
    expect(analyzeRecording(hot, rate, 'reference').issues.find((i) => i.code === 'clipping')?.severity).toBe('error');
  });

  it('joins decoded clips sample-accurately and trims without clipping speech', () => {
    const a = new Float32Array(rate).fill(0);
    a.set(speechLike(0.5), rate / 4);
    const t = trimClip(a, rate);
    const b = speechBounds(a, rate)!;
    expect(t.length / rate).toBeGreaterThanOrEqual(b.endSec - b.startSec);
    const joined = joinWithPauses([{ samples: t, pauseAfterSec: 0.7 }, { samples: t, pauseAfterSec: 99 }], rate);
    expect(joined.samples.length).toBe(t.length * 2 + Math.round(0.7 * rate));
    expect(joined.spans[1]!.startSec).toBeCloseTo((t.length + 0.7 * rate) / rate, 3);
  });

  it('round-trips 16-bit PCM WAV', () => {
    const s = speechLike(1);
    const d = decodePcm16Wav(encodePcm16Wav(s, rate))!;
    expect(d.sampleRate).toBe(rate);
    expect(d.samples.length).toBe(s.length);
    expect(Math.max(...d.samples.map((x, i) => Math.abs(x - s[i]!)))).toBeLessThan(0.001);
  });
});

describe('estimates', () => {
  it('prices speech from the published per-token rates', () => {
    const rates = { modelId: 'm', inputPerM: 0.5, outputPerM: 9, audioTokensPerSecond: 25, source: 's', retrievedAt: '2026-10-17', validNote: 'x' };
    const e = estimateNarration([AUDITION_SCRIPT], rates, { wordsPerMinute: 150, source: 'default' });
    expect(e.requests).toBe(1);
    expect(e.speechSec).toBeGreaterThan(15);
    expect(e.usd).toBeCloseTo((e.inputTokens / 1e6) * 0.5 + (e.outputTokens / 1e6) * 9, 5);
    expect(e.notes[0]).toMatch(/^Estimate/);
  });
  it('uses AES streaming loudness targets for mono and stereo', () => {
    expect(loudnessTarget({ loudness: 'podcast', channels: 1 })).toEqual({ integratedLufs: -19, truePeakDbtp: -1.5 });
    expect(loudnessTarget({ loudness: 'podcast', channels: 2 }).integratedLufs).toBe(-16);
  });
});

describe('SoundCloud and Blogger', () => {
  it('accepts a track URL (with a secret token) and builds the player URL', () => {
    const r = parseSoundCloudInput('https://soundcloud.com/francis-pwavwe/low-resource-language/s-AbC123');
    expect(r).toMatchObject({ ok: true, pageUrl: 'https://soundcloud.com/francis-pwavwe/low-resource-language/s-AbC123' });
    if (r.ok) expect(r.playerSrc.startsWith('https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2F')).toBe(true);
  });
  it('refuses playlists, short links, other hosts and non-https', () => {
    expect(parseSoundCloudInput('https://soundcloud.com/francis/sets/papers').ok).toBe(false);
    expect(parseSoundCloudInput('https://on.soundcloud.com/abc').ok).toBe(false);
    expect(parseSoundCloudInput('http://soundcloud.com/a/b').ok).toBe(false);
    expect(parseSoundCloudInput('https://evil.example/a/b').ok).toBe(false);
    expect(parseSoundCloudInput('<iframe src="https://evil.example/player/?url=https://api.soundcloud.com/tracks/1"></iframe>').ok).toBe(false);
  });
  it('reads only the player URL from pasted embed code and never copies other markup', () => {
    const pasted = `<iframe width="100%" height="166" onload="alert(1)" src="https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/123456789&amp;color=%23ff5500&amp;auto_play=true"></iframe><script>steal()</script><div style="font-size: 10px;"><a href="https://soundcloud.com/francis" title="Francis">Francis</a> · <a href="https://soundcloud.com/francis/a-paper">A paper</a></div>`;
    const r = parseSoundCloudInput(pasted);
    expect(r).toMatchObject({ ok: true, trackUrl: 'https://api.soundcloud.com/tracks/123456789', pageUrl: 'https://soundcloud.com/francis/a-paper' });
    if (!r.ok) return;
    for (const v of ['theme', 'standalone'] as const) {
      const html = bloggerEmbedHtml(r, 'A "quoted" <title>', v);
      expect(html).not.toMatch(/onload|script|steal|auto_play=true/);
      expect(html).toContain('auto_play=false');
      expect(html).toContain('&quot;quoted&quot; &lt;title&gt;');
    }
    expect(bloggerEmbedHtml(r, 'T', 'standalone')).toContain('Listen to this paper');
    // The theme variant is what blogs.pwavwe.com's script looks for: a w.soundcloud.com player plus a 10px credit line.
    expect(bloggerEmbedHtml(r, 'T', 'theme')).toMatch(/src="https:\/\/w\.soundcloud\.com\/player\/\?url=[^"]+"[\s\S]*font-size: 10px/);
  });
});

describe('article extraction', () => {
  const page = `<!doctype html><html><head><title>Ignored | The Pwavwe Papers</title><meta content='2026-10-07T04:54:00-07:00' itemprop='datePublished'/><script>var x = "<p>not text</p>";</script></head>
<body><nav><a href="/">Home</a><p>Menu paragraph</p></nav>
<header class='article-header'><h1 class='article-title' itemprop='headline'>Does &#8220;Low-Resource Language&#8221; Mean My People Are Low?</h1><div class='article-byline'><span>By <strong>Francis Pwavwe</strong></span></div></header>
<section class='paper-audio' hidden='hidden'><p class='paper-audio-title'>Listen to this paper</p></section>
<div class='post-content' id='postContent' itemprop='articleBody'>
<figure><img src="x.jpg"/><figcaption>Photograph by <a href="#">Someone</a>, CC BY-SA 4.0.</figcaption></figure>
<p>Yesterday, during our Indigen World contributors&#8217; discussion, I spoke about collecting the words we need for Kasem. Somewhere inside that work sits a phrase: <em>low-resource language</em>.</p>
<p>I understand what it means in technology. Still, put it beside the language of your own people and it starts to sound uncomfortable, and that discomfort deserves a careful look rather than a quick dismissal.</p>
<h2>What exactly is supposed to be low?</h2>
<p>In language technology, resources include things a computer can use: digital text, recorded speech, translations and dictionaries checked by people who know the language well enough to judge them.</p>
<div class="share-box"><p>Share this paper</p></div>
<p><strong>A database can be small while the world it describes is enormous.</strong> That is the point I keep returning to, again and again, in every conversation about it.</p>
<script>document.write('<p>injected</p>')</script>
</div>
<footer class='article-footer'><p>About the author</p></footer><div id="comments"><p>A comment</p></div></body></html>`;

  it('extracts the title, date and article body only', () => {
    const a = extractArticle(page);
    expect(a.title).toBe('Does “Low-Resource Language” Mean My People Are Low?');
    expect(a.publishedDate).toBe('2026-10-07');
    expect(a.author).toBe('Francis Pwavwe');
    expect(a.container).toBe('#postContent');
    expect(a.confidence).toBe('high');
    const blocks = a.body.split('\n\n');
    expect(blocks[0]).toMatch(/^Yesterday, during our Indigen World contributors’ discussion/);
    expect(blocks).toContain('## What exactly is supposed to be low?');
    expect(a.body).not.toMatch(/Menu paragraph|Photograph by|Share this paper|injected|About the author|A comment|not text|Listen to this paper/);
  });

  it('marks pages without an article body for review instead of narrating the whole page', () => {
    const a = extractArticle('<html><body><nav>Home</nav><p>Some page text.</p></body></html>');
    expect(a.confidence).toBe('review');
    expect(a.body).toBe('');
  });
});

describe('exports and fixed texts', () => {
  it('names files from the title and date', () => {
    expect(exportFileNames('Does “Low-Resource Language” Mean My People Are Low?', '2026-10-07', 1).mp3).toBe('pwavwe-papers-2026-10-07-does-low-resource-language-mean-my-people-are-low.mp3');
    expect(exportFileNames('Café ñandú', null, 2).wav).toBe('pwavwe-papers-cafe-nandu-v2.wav');
  });
  it('writes a readable transcript of what is spoken', () => {
    const { script } = buildScript({ title: 'T', body: ARTICLE }, ids());
    const t = transcriptText({ title: 'T', author: 'Francis Pwavwe', publishedDate: null, sourceUrl: null, script, settings: DEFAULT_EDITION_SETTINGS });
    expect(t).toContain('WHY THIS MATTERS');
    expect(t).toContain(DEFAULT_CLOSING);
  });
  it('keeps the mandatory consent statement verbatim and the brief’s scripts unchanged', () => {
    expect(CONSENT_STATEMENTS.find((c) => c.locale === 'en-US')!.text).toBe('I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.');
    expect(REFERENCE_SCRIPT.startsWith("Hello, I'm Francis Pwavwe, and this is The Pwavwe Papers.")).toBe(true);
    expect(NARRATOR.voiceDisplayName).toBe('Francis — Pwavwe Papers');
  });
  it('requires an explicit same-speaker attestation to create a voice', () => {
    const base = { op: 'voiceCreate', referenceId: 'r1', consentId: 'c1', consentLocale: 'en-GB', requestId: 'req-12345678' };
    expect(narratorRequestSchema.safeParse(base).success).toBe(false);
    expect(narratorRequestSchema.safeParse({ ...base, attestSameAdultSpeaker: true }).success).toBe(true);
  });
});
