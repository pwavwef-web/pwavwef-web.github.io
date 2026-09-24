import type { CostEstimate } from './types';

/**
 * Pricing table supplied by the server (functions/src/config/pricing.ts). Values are Google's
 * published list prices; the token counts used for estimates are published where Google publishes
 * them (per-second video tokens, per-image tokens) and labelled as estimates where they are not
 * (thinking tokens, prompt tokens).
 */
export interface PricingTable {
  version: string;
  source: string;
  retrievedAt: string;
  currency: 'USD';
  video: {
    modelId: string;
    inputPerM: number;
    textOutputPerM: number;
    videoOutputPerM: number;
    outputTokensPerSecond: Record<string, number>;
    inputTokensPerImage: number;
    inputTokensPerVideoSecond: number;
    expectedThoughtTokens: number;
  };
  image: {
    modelId: string;
    inputPerM: number;
    textOutputPerM: number;
    imageOutputPerM: number;
    outputTokensPerImage: Record<string, number>;
    inputTokensPerImage: number;
    expectedThoughtTokens: number;
  };
  text: Record<
    string,
    { inputPerM: number; outputPerM: number; inputPerMLong: number; outputPerMLong: number; longContextThreshold: number; audioTokensPerSecond: number }
  >;
  /** Text-to-speech used for dialogue guide audio (tokens per second of generated audio). */
  speech: { modelId: string; inputPerM: number; outputPerM: number; audioTokensPerSecond: number };
  /** Speech-to-text with word timestamps. */
  transcription: { modelId: string; inputPerM: number; outputPerM: number; audioTokensPerSecond: number };
  /** Music generation, billed per generated song. */
  music: { modelId: string; perSongUsd: number; source: string };
  /** Cloud Vision (face, object and text detection), per image per feature; first 1,000 units a month are free. */
  vision?: { perThousandUnits: number; freeUnitsPerMonth: number; source: string };
  /** Stem separation on Cloud Run (compute per second of audio, estimate). */
  separation?: { vcpu: number; memoryGiB: number; perVcpuSecond: number; perGiBSecond: number; secondsPerAudioSecond: number; overheadSeconds: number; source: string };
  /** Video understanding with the reasoning model (inspection). Per-frame tokens are an AZ Studio assumption. */
  inspection: { videoTokensPerFrame: number; audioTokensPerSecond: number; framesPerSecond: number; expectedOutputTokens: number };
  render: {
    vcpu: number;
    memoryGiB: number;
    perVcpuSecond: number;
    perGiBSecond: number;
    /** Estimated wall-clock render seconds per output second. */
    secondsPerOutputSecond: { draft: number; final: number };
    overheadSeconds: number;
    source: string;
  };
}

const perM = (tokens: number, ratePerM: number) => (tokens * ratePerM) / 1_000_000;
const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
/** Rough prompt token count (Gemini tokenizers average ~4 characters per token for English). */
export const approxTokens = (chars: number) => Math.ceil(Math.max(0, chars) / 4);

function finish(parts: { label: string; usd: number }[], confidence: CostEstimate['confidence'], notes: string[], table: PricingTable, basis: CostEstimate['basis'] = 'published_rate'): CostEstimate {
  const usd = round(parts.reduce((s, p) => s + p.usd, 0));
  return { usd, basis, confidence, breakdown: parts.map((p) => ({ ...p, usd: round(p.usd) })), notes, pricingVersion: table.version };
}

export interface VideoEstimateInput {
  resolution: string;
  /** Seconds of video the model outputs. */
  outputSeconds: number;
  promptChars: number;
  imageInputs: number;
  videoInputSeconds: number;
  task: string;
}

export function estimateVideo(input: VideoEstimateInput, table: PricingTable): CostEstimate {
  const v = table.video;
  const perSecond = v.outputTokensPerSecond[input.resolution];
  const notes: string[] = [];
  if (perSecond === undefined) {
    return finish([], 'low', [`No published token rate for resolution ${input.resolution}.`], table, 'none');
  }
  const outputTokens = perSecond * input.outputSeconds;
  const inputTokens = approxTokens(input.promptChars) + input.imageInputs * v.inputTokensPerImage + input.videoInputSeconds * v.inputTokensPerVideoSecond;
  const parts = [
    { label: `Video output (${input.outputSeconds}s @ ${input.resolution}, ${perSecond} tokens/s)`, usd: perM(outputTokens, v.videoOutputPerM) },
    { label: 'Inputs (prompt, images, video)', usd: perM(inputTokens, v.inputPerM) },
    { label: `Model reasoning (≈${v.expectedThoughtTokens} tokens, estimated)`, usd: perM(v.expectedThoughtTokens, v.textOutputPerM) },
  ];
  notes.push('Video output uses Google’s published tokens-per-second rate; reasoning tokens vary per request.');
  const confidence: CostEstimate['confidence'] = 'medium';
  if (input.task === 'extend') {
    // Observed on Vertex AI (2026-09-24): a 4 s extension of a 4 s take returned 8 s of video and was
    // billed 7,724 video output tokens (4 s × 1,931) plus the earlier video as input.
    notes.push('Extensions are billed for the new seconds of video; the earlier video is billed as input (observed usage — Google does not publish a separate extension rate).');
  }
  return finish(parts, confidence, notes, table);
}

export interface ImageEstimateInput {
  imageSize: string;
  referenceImages: number;
  promptChars: number;
  outputs: number;
}

export function estimateImage(input: ImageEstimateInput, table: PricingTable): CostEstimate {
  const im = table.image;
  const perImage = im.outputTokensPerImage[input.imageSize];
  if (perImage === undefined) {
    return finish([], 'low', [`No published token rate for image size ${input.imageSize}.`], table, 'none');
  }
  const n = Math.max(1, input.outputs);
  const inputTokens = approxTokens(input.promptChars) + input.referenceImages * im.inputTokensPerImage;
  const parts = [
    { label: `Image output (${n} × ${input.imageSize}, ${perImage} tokens each)`, usd: perM(perImage * n, im.imageOutputPerM) },
    { label: 'Inputs (prompt, reference images)', usd: perM(inputTokens * n, im.inputPerM) },
    { label: `Model reasoning (≈${im.expectedThoughtTokens} tokens each, estimated)`, usd: perM(im.expectedThoughtTokens * n, im.textOutputPerM) },
  ];
  return finish(parts, 'high', ['Image output uses Google’s published per-image token counts.'], table);
}

export interface TextEstimateInput {
  modelId: string;
  inputChars: number;
  expectedOutputTokens: number;
  audioSeconds?: number;
}

export function estimateText(input: TextEstimateInput, table: PricingTable): CostEstimate {
  const t = table.text[input.modelId];
  if (!t) return finish([], 'low', [`No pricing configured for ${input.modelId}.`], table, 'none');
  const audioTokens = Math.ceil((input.audioSeconds ?? 0) * t.audioTokensPerSecond);
  const inputTokens = approxTokens(input.inputChars) + audioTokens;
  const long = inputTokens > t.longContextThreshold;
  const parts = [
    { label: `Input (≈${inputTokens.toLocaleString('en-US')} tokens${audioTokens ? ', incl. audio' : ''})`, usd: perM(inputTokens, long ? t.inputPerMLong : t.inputPerM) },
    { label: `Output & reasoning (≈${input.expectedOutputTokens.toLocaleString('en-US')} tokens, estimated)`, usd: perM(input.expectedOutputTokens, long ? t.outputPerMLong : t.outputPerM) },
  ];
  return finish(parts, 'medium', ['Text costs depend on the length of the model’s answer and reasoning.'], table);
}

export function estimateRender(input: { durationSec: number; quality: 'draft' | 'final' }, table: PricingTable): CostEstimate {
  const r = table.render;
  const seconds = r.overheadSeconds + input.durationSec * r.secondsPerOutputSecond[input.quality];
  const usd = seconds * (r.vcpu * r.perVcpuSecond + r.memoryGiB * r.perGiBSecond);
  return finish(
    [{ label: `Cloud Run compute (≈${Math.round(seconds / 60)} min on ${r.vcpu} vCPU / ${r.memoryGiB} GiB)`, usd }],
    'low',
    ['Rendering uses FFmpeg on Cloud Run, not Vertex AI. Duration is an estimate.'],
    table,
    'compute',
  );
}

/** Dialogue guide audio: one TTS request per line. */
export function estimateSpeech(input: { chars: number; seconds: number; lines: number }, table: PricingTable): CostEstimate {
  const t = table.speech;
  const inTokens = approxTokens(input.chars) + input.lines * 20;
  const outTokens = Math.ceil(input.seconds * t.audioTokensPerSecond);
  return finish(
    [
      { label: `Dialogue guide audio (≈${Math.round(input.seconds)} s, ${input.lines} line${input.lines === 1 ? '' : 's'})`, usd: perM(outTokens, t.outputPerM) },
      { label: 'Script text input', usd: perM(inTokens, t.inputPerM) },
    ],
    'medium',
    ['Speech is billed per generated audio token (published rate); line lengths are estimated until measured.'],
    table,
  );
}

/** Word-timed transcription of audio. */
export function estimateTranscription(input: { seconds: number; words?: number }, table: PricingTable): CostEstimate {
  const t = table.transcription;
  const inTokens = Math.ceil(input.seconds * t.audioTokensPerSecond) + 20;
  const outTokens = Math.ceil((input.words ?? input.seconds * 3) * 1.6) + 50;
  return finish([{ label: `Transcription (${Math.round(input.seconds)} s of audio)`, usd: perM(inTokens, t.inputPerM) + perM(outTokens, t.outputPerM) }], 'medium', ['Transcription is billed on audio input tokens and text output tokens.'], table);
}

/** Watching a generated scene with the reasoning model (video + audio + reference images). */
export function estimateInspection(input: { modelId: string; durationSec: number; referenceImages: number; promptChars: number }, table: PricingTable): CostEstimate {
  const t = table.text[input.modelId];
  const q = table.inspection;
  if (!t) return finish([], 'low', [`No pricing configured for ${input.modelId}.`], table, 'none');
  const inTokens = Math.ceil(input.durationSec * (q.framesPerSecond * q.videoTokensPerFrame + q.audioTokensPerSecond)) + input.referenceImages * 560 + approxTokens(input.promptChars);
  const long = inTokens > t.longContextThreshold;
  const review = finish(
    [
      { label: `Scene review (≈${inTokens.toLocaleString('en-US')} input tokens incl. video at ${q.framesPerSecond} fps)`, usd: perM(inTokens, long ? t.inputPerMLong : t.inputPerM) },
      { label: `Review output & reasoning (≈${q.expectedOutputTokens.toLocaleString('en-US')} tokens, estimated)`, usd: perM(q.expectedOutputTokens, long ? t.outputPerMLong : t.outputPerM) },
    ],
    'medium',
    ['Inspection = transcription with word timestamps + a structured review by the reasoning model.'],
    table,
  );
  return sumEstimates([review, estimateTranscription({ seconds: input.durationSec }, table)], table);
}

/** Music generation (per song, published rate). */
export function estimateMusic(input: { songs: number }, table: PricingTable): CostEstimate {
  const m = table.music;
  return finish([{ label: `Music generation (${input.songs} × ${m.modelId})`, usd: input.songs * m.perSongUsd }], 'high', ['Music is billed per generated song at the published rate.'], table);
}

/** Cloud Vision feature detection on sampled frames (published per-unit price; free tier not deducted). */
export function estimateVision(input: { images: number; features: number }, table: PricingTable): CostEstimate {
  const v = table.vision;
  if (!v) return finish([], 'low', ['No Cloud Vision pricing configured.'], table, 'none');
  const units = input.images * input.features;
  return finish([{ label: `Face / object / text detection (${input.images} frame${input.images === 1 ? '' : 's'} × ${input.features} feature${input.features === 1 ? '' : 's'})`, usd: (units * v.perThousandUnits) / 1000 }], 'high', [`Cloud Vision is billed per image per feature; the first ${v.freeUnitsPerMonth.toLocaleString('en-US')} units a month are free (not deducted here).`], table);
}

/** Stem separation (Demucs on Cloud Run) — compute time is an estimate. */
export function estimateSeparation(input: { audioSeconds: number }, table: PricingTable): CostEstimate {
  const s = table.separation;
  if (!s) return finish([], 'low', ['No stem-separation pricing configured.'], table, 'none');
  const seconds = s.overheadSeconds + input.audioSeconds * s.secondsPerAudioSecond;
  const usd = seconds * (s.vcpu * s.perVcpuSecond + s.memoryGiB * s.perGiBSecond);
  return finish([{ label: `Stem separation compute (≈${Math.round(seconds / 60)} min on ${s.vcpu} vCPU)`, usd }], 'low', ['Stems are separated by an open-source model (Demucs) on Cloud Run; duration is an estimate.'], table, 'compute');
}

/** FFmpeg work inside AZ Studio's own functions (colour match, arrangement, mixdown): no model call. */
export function estimateLocalCompute(label: string, table: PricingTable): CostEstimate {
  return finish([{ label, usd: 0 }], 'high', ['Runs inside AZ Studio (FFmpeg); no model is called.'], table, 'compute');
}

export function sumEstimates(estimates: CostEstimate[], table: PricingTable): CostEstimate {
  const parts = estimates.flatMap((e) => e.breakdown);
  const order = { high: 0, medium: 1, low: 2 } as const;
  const worst = estimates.reduce<CostEstimate['confidence']>((w, e) => (order[e.confidence] > order[w] ? e.confidence : w), 'high');
  const usd = round(estimates.reduce((s, e) => s + e.usd, 0));
  const notes = Array.from(new Set(estimates.flatMap((e) => e.notes)));
  return { usd, basis: estimates.every((e) => e.basis === 'compute') ? 'compute' : 'published_rate', confidence: worst, breakdown: parts, notes, pricingVersion: table.version };
}

/** Cost of recorded usage (tokens reported by the API) at published rates. */
export function costFromUsage(
  kind: 'video' | 'image' | 'text' | 'speech' | 'transcription',
  usage: { inputTokens: number; outputTokens: number; thoughtTokens: number; outputByModality?: Record<string, number> },
  table: PricingTable,
  modelId?: string,
): number {
  if (kind === 'video') {
    const v = table.video;
    const videoOut = usage.outputByModality?.video ?? usage.outputTokens;
    const textOut = Math.max(0, usage.outputTokens - videoOut) + usage.thoughtTokens;
    return round(perM(usage.inputTokens, v.inputPerM) + perM(videoOut, v.videoOutputPerM) + perM(textOut, v.textOutputPerM));
  }
  if (kind === 'image') {
    const im = table.image;
    const imageOut = usage.outputByModality?.image ?? usage.outputTokens;
    const textOut = Math.max(0, usage.outputTokens - imageOut) + usage.thoughtTokens;
    return round(perM(usage.inputTokens, im.inputPerM) + perM(imageOut, im.imageOutputPerM) + perM(textOut, im.textOutputPerM));
  }
  if (kind === 'speech' || kind === 'transcription') {
    const r = table[kind];
    return round(perM(usage.inputTokens, r.inputPerM) + perM(usage.outputTokens + usage.thoughtTokens, r.outputPerM));
  }
  const t = modelId ? table.text[modelId] : undefined;
  if (!t) return 0;
  const long = usage.inputTokens > t.longContextThreshold;
  return round(perM(usage.inputTokens, long ? t.inputPerMLong : t.inputPerM) + perM(usage.outputTokens + usage.thoughtTokens, long ? t.outputPerMLong : t.outputPerM));
}
