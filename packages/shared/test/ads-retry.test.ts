import { describe, expect, it } from 'vitest';
import {
  adReadiness,
  assembleAdTimeline,
  backoffDelaySec,
  checkLyricSync,
  decideRetry,
  defaultAdSpec,
  DEFAULT_RETRY_POLICY,
  EMPTY_RETRY_COUNTERS,
  evaluateAdScene,
  labelNarrationSections,
  maxSubmissions,
  planSceneWindows,
  reconcileTranscript,
  resolveRetryPolicy,
  retimeEditedLine,
  sanitizeDiagnostics,
  sceneGenerationSeconds,
  sceneWindowProblems,
  timelineDuration,
  validateTimeline,
  type AdAssemblyScene,
  type AsrWord,
  type RetryCounters,
} from '../src/index';

const SCRIPT = `You know that moment when someone speaks your language, and you immediately feel at home?
That feeling matters.
But sometimes, you know what you want to say, and the words just won’t come. So you switch to English and carry on.
With Indigen World, we want to make more room for our languages in everyday life.
A place to learn a phrase, hear a story, enjoy a song, and share what you know.
We’re starting with Kasem, and building with people who speak it.
You don’t have to know everything to take part.
Start with one word. One expression. One story.
Let’s keep the conversation going.`;

const DURATION = 44.832;

/** A word-timed transcript of the script as a transcriber might hear it (with typical mishearings). */
function heardScript(): AsrWord[] {
  const out: AsrWord[] = [];
  let t = 0.9;
  const sentences = SCRIPT.split(/\n/).flatMap((l) => l.match(/[^.!?]+[.!?]+/g) ?? [l]);
  for (const s of sentences) {
    let words = s.trim().split(/\s+/);
    // Transcription errors on the brand and language names, a swallowed "and", and a filler.
    words = words.flatMap((w) => (w.startsWith('Kasem') ? ['Kassim,'] : w === 'Indigen' ? ['Indigenous'] : [w]));
    if (s.includes('carry on')) words = words.filter((w, i, all) => !(w === 'and' && all[i + 1] === 'carry'));
    if (s.startsWith('Start with')) words = ['uh', ...words];
    for (const w of words) {
      out.push({ text: w, start: Math.round(t * 1000) / 1000, end: Math.round((t + 0.26) * 1000) / 1000 });
      t += 0.3;
    }
    t += 0.55;
  }
  return out;
}

describe('bounded retry policy', () => {
  const p = DEFAULT_RETRY_POLICY;
  const c = (x: Partial<RetryCounters> = {}): RetryCounters => ({ ...EMPTY_RETRY_COUNTERS, ...x });

  it('retries temporary submission failures with backoff, then stops at the attempt limit', () => {
    const first = decideRetry({ category: 'transient', phase: 'submit', counters: c({ submissions: 1 }), policy: p });
    expect(first.action).toBe('retry');
    const second = decideRetry({ category: 'transient', phase: 'submit', counters: first.counters, policy: p });
    expect(second.action).toBe('retry');
    const third = decideRetry({ category: 'transient', phase: 'submit', counters: { ...second.counters, submissions: 3 }, policy: p });
    expect(third).toMatchObject({ action: 'stop', remedy: 'retry' });
    expect(third.counters.transient).toBe(3);
  });

  it('respects Retry-After but stops when Google asks to wait longer than allowed', () => {
    const d = decideRetry({ category: 'transient', phase: 'submit', counters: c({ submissions: 1 }), policy: p, retryAfterSec: 42 });
    expect(d.action).toBe('retry');
    if (d.action === 'retry') expect(d.delaySec).toBeGreaterThanOrEqual(42);
    expect(decideRetry({ category: 'transient', phase: 'submit', counters: c({ submissions: 1 }), policy: p, retryAfterSec: 3600 })).toMatchObject({ action: 'stop', remedy: 'retry' });
  });

  it('never resends a paid generation whose acceptance Google did not confirm', () => {
    expect(decideRetry({ category: 'transient', phase: 'submit', counters: c({ submissions: 1 }), policy: p, ambiguous: true, createsOperation: true })).toMatchObject({ action: 'stop', remedy: 'retry' });
    // A synchronous call (no operation) may be retried.
    expect(decideRetry({ category: 'transient', phase: 'submit', counters: c({ submissions: 1 }), policy: p, ambiguous: true }).action).toBe('retry');
  });

  it('rewrites a blocked prompt once, then waits for the director', () => {
    const once = decideRetry({ category: 'policy', phase: 'submit', counters: c({ submissions: 1 }), policy: p, rewriteAllowed: true, promptRelated: true });
    expect(once.action).toBe('rewrite');
    const twice = decideRetry({ category: 'policy', phase: 'submit', counters: { ...once.counters, submissions: 2 }, policy: p, rewriteAllowed: true, promptRelated: true });
    expect(twice).toMatchObject({ action: 'stop', remedy: 'fix_prompt' });
    expect(decideRetry({ category: 'policy', phase: 'submit', counters: c({ submissions: 1 }), policy: p, rewriteAllowed: false })).toMatchObject({ action: 'stop', remedy: 'fix_prompt' });
  });

  it('repairs a documented configuration once and never resends an unchanged invalid request', () => {
    const r = decideRetry({ category: 'invalid_request', phase: 'submit', counters: c({ submissions: 1 }), policy: p, repairAvailable: true });
    expect(r.action).toBe('repair');
    expect(decideRetry({ category: 'invalid_request', phase: 'submit', counters: { ...r.counters, submissions: 2 }, policy: p, repairAvailable: true })).toMatchObject({ action: 'stop' });
    expect(decideRetry({ category: 'invalid_request', phase: 'submit', counters: c({ submissions: 1 }), policy: p, repairAvailable: false })).toMatchObject({ action: 'stop', remedy: 'fix_settings' });
  });

  it('stops at once for access, billing or quota problems and offers a retry for unexplained ones', () => {
    expect(decideRetry({ category: 'auth_quota', phase: 'submit', counters: c({ submissions: 1 }), policy: p })).toMatchObject({ action: 'stop', remedy: 'fix_settings' });
    expect(decideRetry({ category: 'unknown', phase: 'submit', counters: c({ submissions: 1 }), policy: p })).toMatchObject({ action: 'stop', remedy: 'retry' });
  });

  it('checks an accepted job again after a failed status check and pauses it as resumable at the limit', () => {
    let counters = c({ submissions: 1 });
    for (let i = 1; i < p.pollFailures; i++) {
      const d = decideRetry({ category: 'transient', phase: 'poll', counters, policy: p, resumable: true });
      expect(d.action).toBe('poll');
      counters = d.counters;
    }
    expect(decideRetry({ category: 'transient', phase: 'poll', counters, policy: p, resumable: true })).toMatchObject({ action: 'stop', remedy: 'resume' });
    expect(decideRetry({ category: 'transient', phase: 'finish', counters, policy: p, resumable: true })).toMatchObject({ action: 'stop', remedy: 'resume' });
  });

  it('caps the total number of requests whatever the mix of failures, and honours cancellation', () => {
    expect(maxSubmissions(p)).toBe(5);
    expect(decideRetry({ category: 'policy', phase: 'submit', counters: c({ submissions: 5 }), policy: p, rewriteAllowed: true })).toMatchObject({ action: 'stop' });
    expect(decideRetry({ category: 'transient', phase: 'submit', counters: c({ submissions: 1 }), policy: p, cancelled: true })).toMatchObject({ action: 'stop', remedy: 'none' });
  });

  it('computes truncated exponential backoff with jitter and clamps owner settings', () => {
    expect(backoffDelaySec(0, p, null, () => 0)).toBe(4);
    expect(backoffDelaySec(0, p, null, () => 1)).toBe(8);
    expect(backoffDelaySec(10, p, null, () => 1)).toBe(p.maxDelaySec);
    expect(backoffDelaySec(0, p, 20, () => 0)).toBe(20);
    expect(resolveRetryPolicy({ transientAttempts: 99, promptRewrites: 7, baseDelaySec: 1 })).toMatchObject({ transientAttempts: 5, promptRewrites: 1, baseDelaySec: 2 });
  });

  it('redacts keys, tokens and signed-URL secrets from diagnostics', () => {
    const s = sanitizeDiagnostics('GET https://x.googleapis.com/v1/models?key=AIzaSyA-1234567890abcdefghijklmnop&alt=json Bearer ya29.a0AfH6SMBx X-Goog-Signature=abcdef0123');
    expect(s).not.toMatch(/AIzaSy|ya29\.a0|abcdef0123/);
    expect(s).toContain('[redacted]');
  });
});

describe('narration transcript reconciliation', () => {
  const asr = heardScript();
  const { sheet, report } = reconcileTranscript(asr, SCRIPT, { durationSec: DURATION, protectedTerms: ['Kasem', 'Indigen World'], languageCode: 'en' });
  const text = sheet.lines.map((l) => l.text).join(' ');

  it('keeps the exact spelling of protected names when the recording plainly says them', () => {
    expect(text).toContain('Kasem,');
    expect(text).toContain('Indigen World,');
    expect(text).not.toMatch(/Kassim|Indigenous/);
    expect(report.protectedTerms).toEqual(expect.arrayContaining([expect.objectContaining({ term: 'Kasem', expected: 1, found: 1 }), expect.objectContaining({ term: 'Indigen World', expected: 1, found: 1 })]));
    expect(report.corrected.some((c) => c.kind === 'protected_term' && c.heard.startsWith('Kassim'))).toBe(true);
  });

  it('times every caption from the recording and stays inside the audio', () => {
    expect(sheet.lines[0]!.start).toBeCloseTo(asr[0]!.start, 3);
    const lastWord = asr[asr.length - 1]!;
    expect(sheet.lines[sheet.lines.length - 1]!.end).toBeCloseTo(lastWord.end, 3);
    for (const l of sheet.lines) {
      expect(l.start!).toBeGreaterThanOrEqual(0);
      expect(l.end!).toBeLessThanOrEqual(DURATION);
      expect(l.end!).toBeGreaterThan(l.start!);
    }
    for (let i = 1; i < sheet.lines.length; i++) expect(sheet.lines[i]!.start!).toBeGreaterThanOrEqual(sheet.lines[i - 1]!.end! - 1e-6);
  });

  it('keeps sentences as sections, short caption phrases as lines, and drops fillers', () => {
    expect(sheet.sections.length).toBe(12);
    expect(new Set(sheet.sections.map((x) => x.paragraph)).size).toBe(9);
    expect(sheet.lines.every((l) => l.words.length <= 9 && l.text.length <= 42)).toBe(true);
    expect(text).not.toMatch(/\buh\b/);
    expect(report.extra.some((x) => x.text === 'uh' && !x.kept)).toBe(true);
    // The swallowed "and" is a function word with room for it: kept and timed between its neighbours.
    expect(text).toContain('English and carry on');
    expect(report.coverage).toBeGreaterThan(0.95);
  });

  it('never treats the script as proof: words the recording lacks are reported', () => {
    const missing = asr.filter((w) => !/^(feeling)$/.test(w.text));
    const r = reconcileTranscript(missing, SCRIPT, { durationSec: DURATION, protectedTerms: ['Kasem'] });
    expect(r.report.notDetected.some((n) => n.text === 'feeling')).toBe(true);
  });

  it('re-times one corrected line without touching the others', () => {
    const target = sheet.lines.find((l) => l.text.startsWith('That feeling'))!;
    const edited = retimeEditedLine(sheet, target.id, 'That feeling matters!', asr, DURATION);
    const changed = edited.lines.find((l) => l.id === target.id)!;
    expect(changed.text).toBe('That feeling matters!');
    expect(changed.start).toBeCloseTo(target.start!, 2);
    edited.lines.filter((l) => l.id !== target.id).forEach((l, i) => expect(l).toEqual(sheet.lines.filter((x) => x.id !== target.id)[i]));
  });

  it('builds a transcript from the recording alone when there is no script', () => {
    const r = reconcileTranscript(asr, null, { durationSec: DURATION });
    expect(r.report.method).toBe('transcript_only');
    expect(r.sheet.lines.length).toBeGreaterThan(5);
  });
});

describe('scenes aligned to the narration', () => {
  const { sheet } = reconcileTranscript(heardScript(), SCRIPT, { durationSec: DURATION, protectedTerms: ['Kasem', 'Indigen World'] });
  const windows = planSceneWindows(sheet, DURATION);

  it('tiles the whole audio exactly, cutting just before each first word', () => {
    expect(windows[0]!.start).toBe(0);
    expect(windows[windows.length - 1]!.end).toBe(DURATION);
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.start).toBe(windows[i - 1]!.end);
    expect(sceneWindowProblems(windows, DURATION)).toEqual([]);
    for (const w of windows.slice(1)) {
      const first = sheet.lines.find((l) => l.id === w.lineIds[0])!;
      expect(first.start! - w.start).toBeGreaterThanOrEqual(0);
      expect(first.start! - w.start).toBeLessThanOrEqual(0.6);
    }
  });

  it('keeps every window short enough for one generation and merges very short sentences', () => {
    // The closing window keeps the music tail after the last word; every other window fits one generation.
    expect(windows.slice(0, -1).every((w) => w.end - w.start <= 8.5 + 1e-6)).toBe(true);
    expect(windows[windows.length - 1]!.narration).toMatch(/keep the conversation going/);
    expect(windows.some((w) => w.narration === 'Start with one word. One expression. One story.')).toBe(true);
    expect(windows.every((w) => w.end - w.start >= 1.5 || w === windows[windows.length - 1])).toBe(true);
    expect(sceneGenerationSeconds(4.2)).toBe(5);
    expect(sceneGenerationSeconds(1.2)).toBe(3);
    expect(sceneGenerationSeconds(12)).toBe(10);
  });

  it('reports gaps, overlaps and scenes too long to generate', () => {
    expect(sceneWindowProblems([{ start: 0, end: 5 }, { start: 5.5, end: 10 }], 10)[0]).toMatch(/Gap/);
    expect(sceneWindowProblems([{ start: 0, end: 6 }, { start: 5, end: 10 }], 10)[0]).toMatch(/overlap/);
    expect(sceneWindowProblems([{ start: 0, end: 12, kind: 'generated_video' }], 12)[0]).toMatch(/longer than one generation/);
  });
});

describe('advert timeline assembly', () => {
  const { sheet: raw } = reconcileTranscript(heardScript(), SCRIPT, { durationSec: DURATION, protectedTerms: ['Kasem', 'Indigen World'] });
  const windows = planSceneWindows(raw, DURATION);
  const ad = defaultAdSpec('audio_first', '9:16');
  const brand = { ...ad.brand, logoAssetId: 'logo1' };
  const scenes: AdAssemblyScene[] = windows.map((w, i) => {
    const last = i === windows.length - 1;
    const kind = last ? 'end_card' : i === 3 ? 'product_screen' : i === windows.length - 2 ? 'typography' : 'generated_video';
    const media = kind === 'generated_video' ? { assetId: `v${i}`, kind: 'video' as const, durationSec: Math.ceil(w.end - w.start + 0.25), width: 1080, height: 1920 } : kind === 'product_screen' ? { assetId: 'screen', kind: 'image' as const, durationSec: null, width: 1080, height: 2400 } : null;
    return { id: `s${i}`, kind, title: `Scene ${i + 1}`, start: w.start, end: w.end, media, inPoint: 0, motion: 'push_in', onScreenText: last ? 'Discover Indigen World' : '', subText: last ? 'indigenworld.com' : '', captions: true };
  });
  const sheet = labelNarrationSections(raw, scenes);
  const { state, issues } = assembleAdTimeline({ aspect: '9:16', fps: 24, durationSec: DURATION, audio: { assetId: 'audio1', songId: 'song1', label: 'Keep the Conversation Going.mp3' }, sheet, captions: true, brand, tagline: { text: 'Starting with Kasem', start: 0.5, end: 4.5 }, scenes });

  it('lays the approved soundtrack once, untouched, for exactly the measured length', () => {
    const audio = state.clips.filter((c) => c.kind === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({ start: 0, duration: DURATION, inPoint: 0, volume: 1, fadeIn: 0, fadeOut: 0, assetId: 'audio1', songId: 'song1' });
    expect(timelineDuration(state.clips)).toBeCloseTo(DURATION, 6);
    expect(state.clips.filter((c) => c.kind === 'video').every((c) => c.useSourceAudio === false)).toBe(true);
  });

  it('cuts scenes on their windows without stretching any clip', () => {
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    for (const c of state.clips.filter((x) => x.kind === 'video')) {
      expect(c.inPoint + c.duration).toBeLessThanOrEqual((c.sourceDuration ?? 0) + 1e-6);
    }
    expect(validateTimeline(state)).toEqual([]);
  });

  it('flags a clip that is shorter than its slot instead of slowing it down', () => {
    const short = scenes.map((s, i) => (i === 0 && s.media ? { ...s, media: { ...s.media, durationSec: 1 } } : s));
    const r = assembleAdTimeline({ aspect: '9:16', fps: 24, durationSec: DURATION, audio: { assetId: 'audio1', songId: 'song1', label: 'a' }, sheet, captions: true, brand, tagline: null, scenes: short });
    expect(r.issues.some((i) => /never stretched/.test(i.message))).toBe(true);
    expect(r.state.clips.find((c) => c.kind === 'video' && c.label === 'Scene 1')!.duration).toBe(1);
  });

  it('places product screens and the official logo in boxes, and composes text instead of generating it', () => {
    const screen = state.clips.find((c) => c.assetId === 'screen')!;
    expect(screen.layout?.box.h).toBeGreaterThan(0.4);
    expect(state.clips.some((c) => c.kind === 'title' && c.style?.background && c.start === screen.start)).toBe(true);
    const logo = state.clips.find((c) => c.assetId === 'logo1')!;
    expect(logo.layout).toBeTruthy();
    expect(state.clips.some((c) => c.kind === 'title' && c.text === 'Discover Indigen World')).toBe(true);
    expect(state.clips.some((c) => c.kind === 'title' && c.text === 'indigenworld.com')).toBe(true);
    const tagline = state.clips.find((c) => c.label === 'Tagline')!;
    expect(tagline).toMatchObject({ text: 'Starting with Kasem', kind: 'caption' });
    expect(tagline.start).toBeLessThan(1);
  });

  it('captions every narration line in sync with the recording', () => {
    const captions = state.clips.filter((c) => c.lyric);
    expect(captions).toHaveLength(sheet.lines.length);
    expect(checkLyricSync(state, { song1: sheet })).toEqual([]);
    expect(captions.every((c) => c.start + c.duration <= DURATION + 1e-6)).toBe(true);
    expect(sheet.sections.some((s) => s.label === 'outro')).toBe(true);
    expect(sheet.sections.some((s) => s.label === 'hook')).toBe(true);
  });

  it('warns when no official logo is available rather than inventing one', () => {
    const r = assembleAdTimeline({ aspect: '9:16', fps: 24, durationSec: DURATION, audio: { assetId: 'a', songId: 'song1', label: 'a' }, sheet, captions: true, brand: { ...brand, logoAssetId: null }, tagline: null, scenes });
    expect(r.issues.some((i) => /No logo file/.test(i.message))).toBe(true);
    expect(r.state.clips.some((c) => c.kind === 'image' && c.layout && c.label === 'Logo')).toBe(false);
  });
});

describe('scene validation verdicts and readiness', () => {
  const m = { durationSec: 6, width: 1080, height: 1920, fps: 24, decodeErrors: 0, blackSec: 0 };
  it('passes a clean take and fails one that is too short, wrongly shaped or shows generated text', () => {
    expect(evaluateAdScene({ kind: 'generated_video', windowSec: 5, neededSec: 5, expectedAspect: '9:16', outputHeight: 1920, measurements: m, probeOk: true, review: { matchesBrief: 86, summary: 'Two friends laugh at a market stall', issues: [] }, modelId: 'r' }).verdict).toBe('pass');
    expect(evaluateAdScene({ kind: 'generated_video', windowSec: 7, neededSec: 7, expectedAspect: '9:16', outputHeight: 1920, measurements: m, probeOk: true, review: null, modelId: null }).verdict).toBe('fail');
    expect(evaluateAdScene({ kind: 'generated_video', windowSec: 5, neededSec: 5, expectedAspect: '9:16', outputHeight: 1920, measurements: { ...m, width: 1920, height: 1080 }, probeOk: true, review: null, modelId: null }).verdict).toBe('fail');
    const text = evaluateAdScene({ kind: 'generated_video', windowSec: 5, neededSec: 5, expectedAspect: '9:16', outputHeight: 1920, measurements: m, probeOk: true, review: { matchesBrief: 80, summary: '', issues: [{ type: 'text_in_frame', severity: 'major', note: 'A shop sign with letters' }] }, modelId: 'r' });
    expect(text.verdict).toBe('fail');
    expect(evaluateAdScene({ kind: 'generated_video', windowSec: 5, neededSec: 5, expectedAspect: '9:16', outputHeight: 1920, measurements: { ...m, decodeErrors: 3 }, probeOk: true, review: null, modelId: null }).verdict).toBe('fail');
  });

  it('lists what still blocks the export', () => {
    const ad = defaultAdSpec('audio_first', '9:16');
    const r = adReadiness({ ad, sheet: null, scenes: [] });
    expect(r.some((x) => x.step === 'assets' && x.severity === 'error')).toBe(true);
    expect(r.some((x) => x.step === 'storyboard')).toBe(true);
  });
});
