import { describe, expect, it } from 'vitest';
import { ONE_TAKE, alignSpansFromWords, alignTakeSpans, balancedPartition, buildScript, planTakes, takeOfPassage } from '../src';

const voice = { id: 'v1', modelId: 'gemini-3.8-flash-tts' };
const settings = { preset: 'conversational' as const, customStyle: '', includeClosing: true };
const words = (n: number, w = 'word') => Array.from({ length: n }, () => w).join(' ') + '.';

function script(sectionWords: number[]) {
  let i = 0;
  const body = sectionWords.map((n, s) => `## Section ${s + 1}\n\n${words(Math.ceil(n / 2))}\n\n${words(Math.floor(n / 2))}`).join('\n\n');
  return buildScript({ title: 'A Paper', body }, () => `p${i++}`).script;
}

describe('one-take planning', () => {
  it('reads a normal-length paper in ONE take, every passage its own styled block, opening and closing included', () => {
    const s = script([200, 300, 250, 300, 200]); // 1,250 words: under one take
    const takes = planTakes({ script: s, settings, notebook: [], voice });
    expect(takes).toHaveLength(1);
    const t = takes[0]!;
    expect(t.passages[0]!.kind).toBe('opening');
    expect(t.passages[t.passages.length - 1]!.kind).toBe('closing');
    expect(t.segments.length).toBeGreaterThanOrEqual(t.passages.length);
    expect(t.segments.every((x) => x.style === 'natural and conversational')).toBe(true);
    expect(t.key).toBe(`take-${t.passages[0]!.passageId}`);
    expect(t.plannedSec).toBeLessThanOrEqual(ONE_TAKE.maxTakeSec);
  });

  it('splits a long paper only at section breaks, into the fewest, evenly sized takes', () => {
    const s = script([650, 650, 650, 650]); // 2,600 words at 140 wpm ≈ 1,115 s: two takes of two sections
    const takes = planTakes({ script: s, settings, notebook: [], voice });
    expect(takes).toHaveLength(2);
    const secOf = (t: (typeof takes)[number]) => [...new Set(t.passages.map((p) => p.sectionId).filter(Boolean))];
    expect(secOf(takes[0]!)).toHaveLength(2);
    expect(secOf(takes[1]!)).toHaveLength(2);
    // No section is spread over two takes.
    expect(secOf(takes[0]!).some((id) => secOf(takes[1]!).includes(id))).toBe(false);
    expect(takes.every((t) => t.plannedSec <= ONE_TAKE.maxTakeSec)).toBe(true);
  });

  it('a single section longer than a take is split at a paragraph break', () => {
    let i = 0;
    const body = `## Long\n\n${Array.from({ length: 6 }, () => words(300)).join('\n\n')}`;
    const s = buildScript({ title: 'T', body }, () => `q${i++}`).script;
    const takes = planTakes({ script: s, settings, notebook: [], voice });
    expect(takes.length).toBe(2);
    expect(takes.every((t) => t.plannedSec <= ONE_TAKE.maxTakeSec)).toBe(true);
  });

  it('a take becomes out of date when any passage in it changes; the takes of other sections do not', () => {
    const s = script([650, 650, 650, 650]);
    const before = planTakes({ script: s, settings, notebook: [], voice });
    const edited = structuredClone(s);
    edited.sections[3]!.passages[1]!.text += ' One more sentence.';
    const after = planTakes({ script: edited, settings, notebook: [], voice });
    expect(after[0]!.inputHash).toBe(before[0]!.inputHash);
    expect(after[1]!.inputHash).not.toBe(before[1]!.inputHash);
    expect(planTakes({ script: s, settings, notebook: [], voice: { ...voice, id: 'v2' } })[0]!.inputHash).not.toBe(before[0]!.inputHash);
    const map = takeOfPassage(after);
    expect(map.get(edited.sections[3]!.passages[1]!.id)!.key).toBe(after[1]!.key);
  });

  it('balanced partition keeps order and minimises the largest group', () => {
    expect(balancedPartition([5, 5, 5, 5], 10)).toEqual([[0, 1], [2, 3]]);
    expect(balancedPartition([9, 1, 1, 9], 11)).toEqual([[0, 1], [2, 3]]);
    expect(balancedPartition([3], 10)).toEqual([[0]]);
  });
});

describe('passage spans inside one take', () => {
  it('places boundaries at the natural pauses nearest each passage’s share of the text', () => {
    const rate = 8000;
    // Speech 0.5–3.0 s, pause, 3.6–5.0 s, pause, 5.5–9.0 s (tone = speech, zeros = pause).
    const s = new Float32Array(rate * 9.5);
    const speak = (a: number, b: number) => {
      for (let i = Math.round(a * rate); i < Math.round(b * rate); i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / rate);
    };
    speak(0.5, 3.0);
    speak(3.6, 5.0);
    speak(5.5, 9.0);
    const spans = alignTakeSpans(s, rate, [5, 3, 7]);
    expect(spans).toHaveLength(3);
    expect(spans[0]!.startSec).toBeCloseTo(0.5, 1);
    expect(spans[0]!.endSec).toBeCloseTo(3.0, 1);
    expect(spans[1]!.startSec).toBeCloseTo(3.6, 1);
    expect(spans[1]!.endSec).toBeCloseTo(5.0, 1);
    expect(spans[2]!.startSec).toBeCloseTo(5.5, 1);
    expect(spans[2]!.endSec).toBeCloseTo(9.0, 1);
  });
});

describe('passage spans from a word-timed transcript', () => {
  it('starts each passage at its first heard word, tolerating misheard names and reporting what was missed', () => {
    const texts = ['The Pwavwe Papers.', 'A heading', 'First paragraph about Kasem and more.'];
    const heard = [
      ['The', 0.2], ['Puovie', 0.5], ['Papers.', 0.9],
      ['A', 2.0], ['heading', 2.2],
      ['First', 3.5], ['paragraph', 3.8], ['about', 4.3], ['Kassim', 4.6], ['and', 5.0], ['more.', 5.2],
    ].map(([text, start]) => ({ text: text as string, start: start as number, end: (start as number) + 0.25 }));
    const a = alignSpansFromWords(texts, heard);
    expect(a.passagesHeard).toBe(3);
    expect(a.spans.map((x) => x.startSec)).toEqual([0.2, 2.0, 3.5]);
    expect(a.spans[2]!.endSec).toBeCloseTo(5.45, 2);
    expect(a.coverage).toBeCloseTo(9 / 11, 2);
  });

  it('a skipped passage is reported and placed between its neighbours', () => {
    const texts = ['One two three.', 'Skipped words here.', 'Four five six.'];
    const heard = ['One', 'two', 'three', 'Four', 'five', 'six'].map((text, i) => ({ text, start: i, end: i + 0.5 }));
    const a = alignSpansFromWords(texts, heard);
    expect(a.passagesHeard).toBe(2);
    expect(a.spans[1]).toEqual({ startSec: 2.5, endSec: 3 });
    expect(a.coverage).toBeCloseTo(6 / 9, 2);
  });
});
