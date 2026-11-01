import {
  allFacts,
  buildBriefPrompt,
  buildDirectionsPrompt,
  buildRevisePrompt,
  estimateSpeech,
  estimateText,
  estimateTranscription,
  LINKAD_LIMITS,
  LINKAD_MOTIONS,
  LINKAD_TONES,
  PLANNER_SYSTEM,
  type CostEstimate,
  type LinkAdDoc,
  type ReviseScope,
} from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { PRICING } from '../config/pricing';
import { recordUsage } from './usage';
import { callReasoning } from '../workers/text';
import { logInteraction } from './interactions';

/**
 * Link to Ad: the planning model behind a small interface so the provider can change without touching the flow.
 * The page material reaches the model only as quoted JSON data (see PLANNER_SYSTEM); its answer is parsed and
 * checked by the shared planners before anything is kept.
 */

type Schema = Record<string, unknown>;
const str = (d?: string): Schema => ({ type: 'string', ...(d ? { description: d } : {}) });
const num = (): Schema => ({ type: 'number' });
const arr = (items: Schema): Schema => ({ type: 'array', items });
const obj = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties) });
const enumOf = (values: readonly string[]): Schema => ({ type: 'string', enum: [...values] });

export const BRIEF_SCHEMA = obj({
  focus: str('What is promoted, in one sentence'),
  offerings: arr(obj({ name: str(), factIds: arr(str()) })),
  audience: str('Recommended audience (your suggestion, not a fact)'),
  message: str('The one central message'),
  benefit: obj({ text: str(), factId: str('Id of the supporting fact, or empty') }),
  action: str('What the viewer should do'),
  destination: obj({ kind: enumOf(['url', 'phone', 'email', 'text']), value: str(), factId: str('Id of the fact that contains it, or empty') }),
  tone: enumOf(LINKAD_TONES),
  usedFactIds: arr(str()),
  confirmNotes: arr(str()),
});

const SCENE = obj({
  narration: str('Spoken words for this scene'),
  overlay: str('Short on-screen text, or empty'),
  overlayPos: enumOf(['upper', 'middle', 'lower']),
  assetId: str('An id from images[], or empty for a text-led scene'),
  focal: obj({ x: num(), y: num() }),
  motion: enumOf(LINKAD_MOTIONS),
  factIds: arr(str()),
});

export const DIRECTIONS_SCHEMA = obj({
  directions: arr(obj({ kind: enumOf(['experience', 'showcase', 'problem_solution', 'other']), title: str(), summary: str(), hook: str(), scenes: arr(SCENE), closing: obj({ headline: str(), line: str() }), rationale: str() })),
});

export const REVISE_SCHEMA = obj({ scenes: arr(obj({ sceneId: str(), narration: str(), overlay: str(), factIds: arr(str()) })) });

export interface PlannerCtx {
  uid: string;
  projectId: string;
  jobId: string;
}

export interface PlannerResult {
  json: unknown;
  /** Cost reported for this call (published list prices applied to the tokens the provider counted). */
  usd: number;
  modelId: string;
  live: boolean;
}

export interface Planner {
  brief(doc: LinkAdDoc, bodyText: string, ctx: PlannerCtx): Promise<PlannerResult>;
  directions(doc: LinkAdDoc, feedback: string[], ctx: PlannerCtx): Promise<PlannerResult>;
  revise(doc: LinkAdDoc, scope: ReviseScope, sceneId: string | null, guidance: string, ctx: PlannerCtx): Promise<PlannerResult>;
}

async function ask(prompt: string, schema: Schema, task: string, ctx: PlannerCtx, thinking: 'LOW' | 'MEDIUM'): Promise<PlannerResult> {
  const r = await callReasoning([{ text: prompt }], { systemInstruction: PLANNER_SYSTEM, responseJsonSchema: schema }, thinking);
  const u = r.res.usageMetadata;
  const usd = await recordUsage({ uid: ctx.uid, projectId: ctx.projectId, jobId: ctx.jobId, modelId: r.modelId, kind: 'text', inputTokens: u?.promptTokenCount ?? 0, outputTokens: u?.candidatesTokenCount ?? 0, thoughtTokens: u?.thoughtsTokenCount ?? 0, countJob: false });
  await logInteraction({ uid: ctx.uid, projectId: ctx.projectId, jobId: ctx.jobId, modelId: r.modelId, api: 'generateContent', request: { task, inputChars: prompt.length }, response: { finishReason: r.res.candidates?.[0]?.finishReason ?? null, usage: u ?? null, costUsd: usd }, latencyMs: r.latencyMs });
  return { json: r.json, usd, modelId: r.modelId, live: true };
}

export const modelPlanner: Planner = {
  brief: (doc, bodyText, ctx) => ask(buildBriefPrompt(doc, bodyText), BRIEF_SCHEMA, 'linkad.brief', ctx, 'LOW'),
  directions: (doc, feedback, ctx) => ask(buildDirectionsPrompt(doc, feedback), DIRECTIONS_SCHEMA, 'linkad.directions', ctx, 'MEDIUM'),
  revise: (doc, scope, sceneId, guidance, ctx) => ask(buildRevisePrompt(doc, scope, sceneId, guidance), REVISE_SCHEMA, 'linkad.revise', ctx, 'LOW'),
};


// ---------------------------------------------------------------------------
// Estimates (published list prices; labelled as estimates in the interface)
// ---------------------------------------------------------------------------

export function briefEstimate(doc: LinkAdDoc, bodyChars: number): CostEstimate {
  return estimateText({ modelId: MODEL_REGISTRY.reasoning.id, inputChars: Math.min(9000, bodyChars) + allFacts(doc).length * 160 + 2400, expectedOutputTokens: 1800 }, PRICING);
}

export function directionsEstimate(doc: LinkAdDoc): CostEstimate {
  return estimateText({ modelId: MODEL_REGISTRY.reasoning.id, inputChars: allFacts(doc).length * 160 + doc.source.assets.length * 120 + 4200, expectedOutputTokens: 6000 }, PRICING);
}

export function reviseEstimate(doc: LinkAdDoc, scope: ReviseScope): CostEstimate {
  return estimateText({ modelId: MODEL_REGISTRY.reasoning.id, inputChars: doc.ad.scenes.reduce((n, s) => n + s.narration.length + s.overlay.length, 0) + allFacts(doc).length * 160 + 2000, expectedOutputTokens: scope === 'script' ? 2000 : 900 }, PRICING);
}

/** One scene's speech and its word timing. */
export function voiceEstimate(scenes: { narration: string }[]): CostEstimate {
  const chars = scenes.reduce((n, s) => n + s.narration.length, 0);
  const seconds = Math.max(1, (chars / 5 / LINKAD_LIMITS.wordsPerSecond) * 1);
  const speech = estimateSpeech({ chars, seconds, lines: scenes.length }, PRICING);
  const tr = estimateTranscription({ seconds, words: Math.round(chars / 5) }, PRICING);
  return { usd: Math.round((speech.usd + tr.usd) * 1e6) / 1e6, basis: 'published_rate', confidence: 'medium', breakdown: [...speech.breakdown, ...tr.breakdown], notes: ['Speech and word timing are billed per request at published list prices; length is estimated until the audio is measured.'], pricingVersion: PRICING.version };
}
