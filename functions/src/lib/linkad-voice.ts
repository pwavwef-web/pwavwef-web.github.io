import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { reconcileTranscript, sheetWords, type LiteWord } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { speakLine, transcribe } from './audio-models';
import { withTmpDir } from './assets';
import { gsUri } from './firebase';
import { FFMPEG } from './media';
import { pcm16ToFloat, speechBounds } from './signal';
import { recordUsage } from './usage';
import { takeFlags } from '../workers/lite-narration';

const run = promisify(execFile);

/**
 * Link to Ad voice: one spoken take per scene, then its words timed from the real audio.
 * The speaker and the aligner are separate so a recording can be re-timed without paying for the speech again.
 */

export interface VoiceCtx {
  uid: string;
  projectId: string;
  jobId: string;
}

export interface SpokenScene {
  wav: Buffer;
  fileSeconds: number;
  speech: { start: number; end: number } | null;
  usd: number;
  modelId: string;
  /** Present only for fixture audio, whose word times are known by construction. */
  words?: LiteWord[];
  fixture: boolean;
}

export interface Speaker {
  speak(text: string, voice: string, direction: string, ctx: VoiceCtx): Promise<SpokenScene>;
}

export const liveSpeaker: Speaker = {
  async speak(text, voice, direction, ctx) {
    const s = await speakLine(text, voice, direction);
    const usd = await recordUsage({ uid: ctx.uid, projectId: ctx.projectId, jobId: ctx.jobId, modelId: MODEL_REGISTRY.speech.id, kind: 'speech', inputTokens: s.usage.input, outputTokens: s.usage.output, thoughtTokens: 0, countJob: false });
    return { wav: s.wav, fileSeconds: s.fileSeconds, speech: s.speech ? { start: s.speech.start, end: s.speech.end } : null, usd, modelId: MODEL_REGISTRY.speech.id, fixture: false };
  },
};

/**
 * Fixture audio for tests and demos only: a short beep per word at a steady pace, so the whole pipeline (timing,
 * captions, mix, render) can run without a speech provider. It is never presented as a recording of the script.
 */
export const fixtureSpeaker: Speaker = {
  async speak(text) {
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    const per = 0.28;
    const lead = 0.12;
    const total = lead + tokens.length * per + 0.2;
    const expr = tokens.map((_, i) => `between(t,${(lead + i * per).toFixed(3)},${(lead + i * per + per * 0.7).toFixed(3)})*0.28*sin(2*PI*${240 + (i % 5) * 40}*t)`).join('+') || '0';
    const wav = await withTmpDir(async (dir) => {
      const out = path.join(dir, 'fixture.wav');
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=24000:d=${total.toFixed(3)}`, '-ac', '1', '-c:a', 'pcm_s16le', out], { maxBuffer: 16 * 1024 * 1024 });
      return readFile(out);
    });
    const words: LiteWord[] = tokens.map((t, i) => ({ text: t, start: Math.round((lead + i * per) * 1000) / 1000, end: Math.round((lead + i * per + per * 0.7) * 1000) / 1000, confidence: 0.99, sentenceEnd: /[.!?]$/.test(t) }));
    const samples = pcm16ToFloat(wav.subarray(44));
    const bounds = speechBounds(samples, 24000);
    return { wav, fileSeconds: Math.round(total * 1000) / 1000, speech: bounds ? { start: bounds.start, end: bounds.end } : { start: lead, end: lead + tokens.length * per }, usd: 0, modelId: 'fixture-tones', words, fixture: true };
  },
};

export interface Aligned {
  words: LiteWord[];
  alignment: 'aligned' | 'estimated';
  coverage: number | null;
  flags: string[];
  speechStart: number | null;
  speechEnd: number | null;
  usd: number;
}

/** Times the script's words against the real audio (transcription with word timestamps, then reconciliation with the script). */
export async function alignScene(opts: { storagePath: string; text: string; fileSeconds: number; ctx: VoiceCtx; voiced: SpokenScene; languageCode?: string }): Promise<Aligned> {
  if (opts.voiced.words) {
    const w = opts.voiced.words;
    return { words: w, alignment: 'aligned', coverage: 1, flags: ['fixture_audio: test tones, not a recording of the words'], speechStart: w[0]?.start ?? null, speechEnd: w[w.length - 1]?.end ?? null, usd: 0 };
  }
  const languageCode = opts.languageCode ?? 'en';
  try {
    const t = await transcribe({ fileUri: gsUri(opts.storagePath), mimeType: 'audio/wav', languageCode, vocabulary: [] });
    const usd = await recordUsage({ uid: opts.ctx.uid, projectId: opts.ctx.projectId, jobId: opts.ctx.jobId, modelId: t.modelId, kind: 'transcription', inputTokens: t.usage.input, outputTokens: t.usage.output, thoughtTokens: t.usage.thoughts, countJob: false });
    const { sheet, report } = reconcileTranscript(t.words.map((w) => ({ text: w.text, start: w.start, end: w.end })), opts.text, { durationSec: opts.fileSeconds, protectedTerms: [], languageCode, audioAssetId: null, maxPhraseWords: 14, maxPhraseChars: 90 });
    const words = sheetWords(sheet);
    const flags = takeFlags(report, { generated: true, speechSec: (opts.voiced.speech ? opts.voiced.speech.end - opts.voiced.speech.start : opts.fileSeconds), text: opts.text, languageCode });
    if (!words.length) return { words: [], alignment: 'estimated', coverage: null, flags: [...flags, 'alignment_empty: no words could be timed from the audio'], speechStart: opts.voiced.speech?.start ?? null, speechEnd: opts.voiced.speech?.end ?? null, usd };
    return { words, alignment: 'aligned', coverage: Math.round(report.coverage * 1000) / 1000, flags, speechStart: words[0]!.start, speechEnd: words[words.length - 1]!.end, usd };
  } catch (e) {
    // The speech is already saved: keep it, say the timing is estimated, and let a later re-time cost only a transcription.
    return { words: [], alignment: 'estimated', coverage: null, flags: [`alignment_unavailable: ${String((e as Error)?.message ?? e).slice(0, 200)}`], speechStart: opts.voiced.speech?.start ?? null, speechEnd: opts.voiced.speech?.end ?? null, usd: 0 };
  }
}

