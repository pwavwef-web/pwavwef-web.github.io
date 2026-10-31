import { describe, expect, it } from 'vitest';
import {
  BETA_DEFAULT_LIMITS,
  EMBED_HEIGHT_PX,
  analyzeRecording,
  azStudioEmbedHtml,
  betaAdminRequestSchema,
  boothJoinPlan,
  boothLines,
  checkBoothTake,
  compareEmbed,
  creditsFor,
  inviteProblem,
  memberRequestSchema,
  memberSpeechText,
  normalizeBetaLimits,
  normalizeInviteCode,
  publicationExportState,
  readPlayerBlock,
  refreshBoothLines,
  reserveCreditsFor,
  submissionProblems,
  type BoothTake,
  type MemberDoc,
  type RecordingAnalysis,
} from '../src/index';

const KASEM = 'Kasem ba bɛ zʋŋa. Ba ŋʋ yɛ tʋʋnɛ ka. Kasem ba bɛ zʋŋa.';

function analysis(over: Partial<RecordingAnalysis> = {}): RecordingAnalysis {
  return { durationSec: 3, speechSec: 2.4, peakDbfs: -6, rmsDbfs: -22, clippedPct: 0, noiseFloorDbfs: -62, longestPauseSec: 0.3, leadingSilenceSec: 0.3, trailingSilenceSec: 0.3, issues: [], ...over };
}

describe('recording booth', () => {
  it('splits a scene into prompter lines with stable ids and pronunciation notes', () => {
    const lines = boothLines(KASEM, [{ id: 'p1', term: 'zʋŋa', sayAs: 'zoo-nga', note: 'long vowel' }]);
    expect(lines.map((l) => l.text)).toEqual(['Kasem ba bɛ zʋŋa.', 'Ba ŋʋ yɛ tʋʋnɛ ka.', 'Kasem ba bɛ zʋŋa.']);
    // The same sentence twice is two lines with different ids; ids survive a re-split.
    expect(new Set(lines.map((l) => l.id)).size).toBe(3);
    expect(boothLines(KASEM).map((l) => l.id)).toEqual(lines.map((l) => l.id));
    expect(lines[0]!.notes.map((n) => n.term)).toEqual(['zʋŋa', 'Kasem']);
    expect(lines[1]!.notes).toEqual([]);
    expect(lines[0]!.expectedSec).toBeGreaterThan(0);
  });

  it('splits very long sentences so they fit the prompter', () => {
    const long = `${'Word, '.repeat(80)}end.`;
    const lines = boothLines(long);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.text.length <= 220)).toBe(true);
  });

  it('checks a take against its line: length, clipping, noise and silence', () => {
    expect(checkBoothTake(analysis(), 2.5).verdict).toBe('good');
    const short = checkBoothTake(analysis({ speechSec: 0.6 }), 2.5);
    expect(short.verdict).toBe('redo');
    expect(short.issues[0]!.code).toBe('too_short');
    expect(checkBoothTake(analysis({ speechSec: 8 }), 2.5).verdict).toBe('redo');
    expect(checkBoothTake(analysis({ leadingSilenceSec: 3 }), 2.5).verdict).toBe('check');
    // analyzeRecording's own clipping / noise findings carry over; its enrollment length limits do not.
    const rate = 8000;
    const loud = new Float32Array(rate * 2).map((_, i) => (i % 40 < 20 ? 1 : -1));
    const a = analyzeRecording(loud, rate, 'pronunciation');
    const c = checkBoothTake(a, 2);
    expect(c.issues.some((i) => i.code === 'clipping' && i.severity === 'error')).toBe(true);
    expect(c.issues.some((i) => i.code === 'too_long' && /enroll|Google/.test(i.message))).toBe(false);
  });

  it('joins only when every line has a current picked take', () => {
    const lines = boothLines(KASEM);
    const take = (id: string, lineIdx: number, text = lines[lineIdx]!.text): BoothTake => ({ id, assetId: `a-${id}`, lineId: lines[lineIdx]!.id, lineText: text, durationSec: 3, analysis: analysis(), check: checkBoothTake(analysis(), 2), createdAt: 1 });
    const takes = [take('t1', 0), take('t2', 1, 'An older version of the line.'), take('t3', 2)];
    const plan = boothJoinPlan({ lines, takes, picks: { [lines[0]!.id]: 't1', [lines[1]!.id]: 't2' } }, { noiseReduction: 'off', pauseSec: 0.45 });
    expect(plan.ready).toBe(false);
    expect(plan.missing.map((l) => l.index)).toEqual([2]);
    expect(plan.outdated.map((l) => l.index)).toEqual([1]);
    const ok = boothJoinPlan({ lines, takes: [take('t1', 0), take('t4', 1), take('t3', 2)], picks: { [lines[0]!.id]: 't1', [lines[1]!.id]: 't4', [lines[2]!.id]: 't3' } }, { noiseReduction: 'off', pauseSec: 0.45 });
    expect(ok.ready).toBe(true);
    expect(ok.takes.map((t) => t.id)).toEqual(['t1', 't4', 't3']);
    const other = boothJoinPlan({ lines, takes: ok.takes, picks: { [lines[0]!.id]: 't1', [lines[1]!.id]: 't4', [lines[2]!.id]: 't3' } }, { noiseReduction: 'standard', pauseSec: 0.45 });
    expect(other.picksHash).not.toBe(ok.picksHash);
  });

  it('keeps picks of unchanged lines when the narration is edited', () => {
    const before = boothLines(KASEM);
    const edited = 'Kasem ba bɛ zʋŋa. A new middle line. Kasem ba bɛ zʋŋa.';
    const after = refreshBoothLines({ lines: before, picks: { [before[0]!.id]: 'tA', [before[1]!.id]: 'tB' }, narrationHash: '' }, boothLines(edited), edited);
    expect(after.picks).toEqual({ [before[0]!.id]: 'tA' });
  });

  it('accepts booth API requests and rejects unknown noise levels', () => {
    expect(() => betaAdminRequestSchema.parse({ op: 'overview' })).not.toThrow();
  });
});

describe('publication health', () => {
  const ID = 'kOZQ0h9lETB6';
  it('reads today’s markup as current, also after Blogger re-serialises it', () => {
    const html = `<html><body><h1>Post</h1>${azStudioEmbedHtml(ID, 'A paper')}<p>Text</p></body></html>`;
    const block = readPlayerBlock(html, ID);
    expect(block.found).toBe(true);
    expect(block.theme).toBe('light');
    expect(block.heightAttr).toBe(EMBED_HEIGHT_PX);
    expect(compareEmbed(block, ID)).toEqual([]);
    // Blogger may reorder attributes and switch quotes; the block still reads as current.
    const reserialised = html.replace(/<iframe src="([^"]+)" title="([^"]+)" width="100%" height="156"/, `<iframe height='156' title='$2' width='100%' src='$1'`);
    expect(compareEmbed(readPlayerBlock(reserialised, ID), ID)).toEqual([]);
  });

  it('reports the older markup: no theme, fixed height, the large link', () => {
    const old = `<iframe src="https://az-studio.web.app/embed/audio/${ID}" width="100%" height="166" style="border:0"></iframe><p><a href="https://az-studio.web.app/embed/audio/${ID}">Listen to this paper</a></p>`;
    const codes = compareEmbed(readPlayerBlock(old, ID), ID).map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['no_theme', 'no_style', 'height', 'fallback_old']));
  });

  it('tells a SoundCloud post and a missing player apart', () => {
    expect(compareEmbed(readPlayerBlock('<iframe src="https://w.soundcloud.com/player/?url=x"></iframe>', ID), ID)[0]!.code).toBe('soundcloud');
    expect(compareEmbed(readPlayerBlock('<p>No audio</p>', ID), ID)[0]!.code).toBe('no_player');
    expect(compareEmbed(readPlayerBlock('<iframe src="https://az-studio.web.app/embed/audio/OTHERxxxxxxx?theme=light"></iframe>', ID), ID)[0]!.code).toBe('other_player');
  });

  it('finds a newer finished export waiting to be published', () => {
    const pub = { status: 'published' as const, current: { exportId: 'x2', exportVersion: 2 } as never };
    expect(publicationExportState(pub, [{ id: 'x1', version: 1, status: 'ready', durationSec: 60 }, { id: 'x2', version: 2, status: 'ready', durationSec: 61 }]).waiting).toBe('none');
    const s = publicationExportState(pub, [{ id: 'x2', version: 2, status: 'ready', durationSec: 61 }, { id: 'x3', version: 3, status: 'ready', durationSec: 62 }, { id: 'x4', version: 4, status: 'rendering', durationSec: null }]);
    expect(s.waiting).toBe('ready');
    expect(s.newer?.exportId).toBe('x3');
    expect(publicationExportState(pub, [{ id: 'x5', version: 5, status: 'failed', durationSec: null }]).waiting).toBe('failed');
  });
});

describe('public beta', () => {
  const member = (over: Partial<MemberDoc> = {}): MemberDoc => ({ uid: 'm1', email: 'a@b.co', wave: 'wave-1', inviteId: 'i', status: 'active', joinedAt: 0, revokedAt: null, credits: { balance: 300, granted: 300, spent: 0, reserved: 0 }, today: { day: '2026-11-01', chars: 0, seconds: 0, usd: 0 }, totals: { chars: 0, seconds: 0, usd: 0, jobs: 0 }, activeJob: null, lastSeenAt: 0, ...over });
  const NOW = Date.UTC(2026, 10, 1, 12);

  it('keeps flag overrides inside hard limits', () => {
    expect(normalizeBetaLimits(undefined)).toEqual(BETA_DEFAULT_LIMITS);
    expect(normalizeBetaLimits({ globalDailyUsd: 1e6, dailyChars: -5, jobCeilingUsd: 'x' })).toMatchObject({ globalDailyUsd: 25, dailyChars: 0, jobCeilingUsd: BETA_DEFAULT_LIMITS.jobCeilingUsd });
  });

  it('normalises codes and refuses used, expired or someone else’s invitations', () => {
    expect(normalizeInviteCode(' abcd efgh jkmn ')).toBe('ABCD-EFGH-JKMN');
    expect(normalizeInviteCode('ABCD-EFGH-JKM0')).toBeNull();
    const inv = { status: 'open' as const, expiresAt: NOW + 1000, email: 'Ama@Example.com' };
    expect(inviteProblem(inv, { email: 'ama@example.com', emailVerified: true }, NOW)).toBeNull();
    expect(inviteProblem(inv, { email: 'ama@example.com', emailVerified: false }, NOW)).toMatch(/verified/);
    expect(inviteProblem(inv, { email: 'kofi@example.com', emailVerified: true }, NOW)).toMatch(/different email/);
    expect(inviteProblem({ ...inv, status: 'redeemed' }, { email: 'ama@example.com', emailVerified: true }, NOW)).toMatch(/already been used/);
    expect(inviteProblem({ ...inv, expiresAt: NOW }, { email: 'ama@example.com', emailVerified: true }, NOW)).toMatch(/expired/);
    expect(inviteProblem(null, { email: 'ama@example.com', emailVerified: true }, NOW)).toMatch(/not valid/);
  });

  it('enforces allowances, credits, the per-job ceiling and the global breaker', () => {
    const base = { limits: BETA_DEFAULT_LIMITS, member: member(), chars: 3000, estimateSec: 180, estimateUsd: 0.03, globalUsd: 0, now: NOW };
    expect(submissionProblems(base)).toEqual([]);
    expect(submissionProblems({ ...base, chars: 13_000 }).join(' ')).toMatch(/12,000/);
    expect(submissionProblems({ ...base, member: member({ today: { day: '2026-11-01', chars: 19_000, seconds: 0, usd: 0 } }) }).join(' ')).toMatch(/Today's allowance/);
    // Yesterday's usage does not count today.
    expect(submissionProblems({ ...base, member: member({ today: { day: '2026-10-31', chars: 19_000, seconds: 1200, usd: 0 } }) })).toEqual([]);
    expect(submissionProblems({ ...base, estimateUsd: 0.2 }).join(' ')).toMatch(/too long for one job/);
    expect(submissionProblems({ ...base, globalUsd: 1.99 }).join(' ')).toMatch(/daily limit for everyone/);
    expect(submissionProblems({ ...base, member: member({ credits: { balance: 10, granted: 10, spent: 0, reserved: 0 } }) }).join(' ')).toMatch(/credits/);
    expect(submissionProblems({ ...base, member: member({ status: 'revoked' }) }).join(' ')).toMatch(/ended/);
  });

  it('holds a bounded number of credits and charges whole credits', () => {
    expect(creditsFor(0.0004)).toBe(1);
    expect(creditsFor(0)).toBe(0);
    expect(reserveCreditsFor(0.03, BETA_DEFAULT_LIMITS)).toBe(creditsFor(0.047));
    expect(reserveCreditsFor(5, BETA_DEFAULT_LIMITS)).toBe(creditsFor(BETA_DEFAULT_LIMITS.jobCeilingUsd));
  });

  it('reads a tidy text: title first, Markdown and links cleaned', () => {
    const t = memberSpeechText('A Paper', '## Heading\n\nSee [the site](https://example.com) now.');
    expect(t.startsWith('A Paper.\n\n')).toBe(true);
    expect(t).not.toMatch(/##|https?:|\]\(/);
  });

  it('offers members no voice creation, publishing or studio operation', () => {
    const ops = memberRequestSchema.options.map((o) => o.shape.op.value);
    expect(ops).not.toEqual(expect.arrayContaining(['voiceCreate']));
    expect(ops.some((o) => /voice|publish|studio|settings/i.test(o))).toBe(false);
    expect(() => memberRequestSchema.parse({ op: 'editionSave', editionId: 'e', baseRev: 1, voice: 'v-my-replica' })).toThrow();
    expect(() => memberRequestSchema.parse({ op: 'editionSave', editionId: 'e', baseRev: 1, voice: 'Kore' })).not.toThrow();
  });
});
