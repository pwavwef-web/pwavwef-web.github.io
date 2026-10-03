import { IMAGE_CAPABILITIES, VIDEO_CAPABILITIES } from '../config/models';
import type { ProviderFailure } from './provider-errors';

/**
 * Repairs for rejected requests. Two kinds, both bounded by the retry policy and recorded on the job:
 *  - configuration repairs, only where the correct value is established by the model registry or a verified
 *    Google rule (never guessed); an unchanged request is never resent;
 *  - one benign prompt rewrite after a content-policy block, which removes accidental ambiguity and keeps the
 *    creative intent — never coded language, never weakened safety constraints.
 */

export interface ConfigRepair {
  params: Record<string, unknown>;
  change: string;
  source: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A documented repair for an invalid video or image request, or null when none applies. */
export function configRepairFor(jobType: string, params: Record<string, unknown>, f: Pick<ProviderFailure, 'category' | 'code' | 'message' | 'details'>): ConfigRepair | null {
  if (f.category !== 'invalid_request') return null;
  const text = `${f.message} ${f.details}`;
  let out: ConfigRepair | null = null;
  if (jobType === 'video.generate') {
    const caps = VIDEO_CAPABILITIES;
    if (params.task && params.previousInteractionId && /previous_interaction_id is not allowed when video task is set|task.*previous_interaction|previous_interaction.*task/i.test(text)) {
      out = { params: { ...params, task: null }, change: 'Removed the video task: Vertex AI rejects a task together with previous_interaction_id; the prompt states the change instead.', source: 'Verified on Vertex AI 2026-09-24 (docs/ARCHITECTURE.md → Omni chains)' };
    } else if (/aspect[_ ]?ratio/i.test(text) && typeof params.aspectRatio === 'string' && !caps.aspectRatios.includes(params.aspectRatio)) {
      out = { params: { ...params, aspectRatio: params.aspectRatio === '1:1' || params.aspectRatio === '4:5' ? '9:16' : '16:9' }, change: `Aspect ratio ${String(params.aspectRatio)} → a supported one (${caps.aspectRatios.join(' or ')}); the renderer reframes to the export shape.`, source: 'Model registry: VIDEO_CAPABILITIES.aspectRatios' };
    } else if (/duration/i.test(text) && typeof params.durationSec === 'number' && (params.durationSec < caps.durationSec.min || params.durationSec > caps.durationSec.max || !Number.isInteger(params.durationSec))) {
      const d = Math.min(caps.durationSec.max, Math.max(caps.durationSec.min, Math.round(params.durationSec)));
      out = { params: { ...params, durationSec: d }, change: `Duration ${String(params.durationSec)} s → ${d} s (the model generates ${caps.durationSec.min}–${caps.durationSec.max} s).`, source: 'Model registry: VIDEO_CAPABILITIES.durationSec' };
    } else if (/resolution/i.test(text) && typeof params.resolution === 'string' && !caps.resolutions.includes(params.resolution)) {
      out = { params: { ...params, resolution: caps.defaultResolution }, change: `Resolution ${String(params.resolution)} → ${caps.defaultResolution}.`, source: 'Model registry: VIDEO_CAPABILITIES.resolutions' };
    }
  } else if (jobType === 'image.generate') {
    const caps = IMAGE_CAPABILITIES;
    if (/image[_ ]?size/i.test(text) && typeof params.imageSize === 'string' && !caps.imageSizes.includes(params.imageSize)) {
      out = { params: { ...params, imageSize: caps.defaultImageSize }, change: `Image size ${String(params.imageSize)} → ${caps.defaultImageSize}.`, source: 'Model registry: IMAGE_CAPABILITIES.imageSizes' };
    } else if (/aspect[_ ]?ratio/i.test(text) && typeof params.aspectRatio === 'string' && !caps.aspectRatios.includes(params.aspectRatio)) {
      out = { params: { ...params, aspectRatio: '1:1' }, change: `Aspect ratio ${String(params.aspectRatio)} → 1:1.`, source: 'Model registry: IMAGE_CAPABILITIES.aspectRatios' };
    }
  }
  if (out && same(out.params, params)) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Prompt rewrites
// ---------------------------------------------------------------------------

/** The media binding declaration Omni prompts start with (kept verbatim), and the body that may be rewritten. */
export function splitDeclaration(prompt: string): { declaration: string; body: string } {
  const lines = prompt.split('\n');
  let i = 0;
  while (i < lines.length && /^\s*\[#\s/.test(lines[i]!)) i++;
  return { declaration: lines.slice(0, i).join('\n'), body: lines.slice(i).join('\n') };
}

export const REWRITE_SYSTEM =
  'You help a private film and advert studio fix prompts that Google’s content filters blocked by accident. ' +
  'First decide whether the creative intent is benign and allowed under Google’s Generative AI Prohibited Use Policy. ' +
  'If it is, rewrite the prompt once to remove accidental ambiguity: describe people, bodies, clothing, touch, actions and objects in plain, literal, neutral words; ' +
  'drop wording that could be misread as violence, sexual content, risk to children, self-harm, hate, weapons, drugs, real public figures or trademarks where it is not essential; ' +
  'keep every essential element (setting, people, action, mood, camera, lighting, style, duration) and keep every tag such as <FIRST_FRAME> or <IMAGE_REF_0> exactly as written. ' +
  'Keep every sentence that starts with "Do not" and every safety restriction. Never use euphemisms, misspellings, coded words or indirection to express anything the policy forbids, and never add new subject matter. ' +
  'If the intended content itself is not allowed, set benign to false and return an empty revisedPrompt. Explain the change in one or two plain sentences. Return only JSON.';

export const REWRITE_SCHEMA = {
  type: 'object',
  properties: {
    benign: { type: 'boolean', description: 'True when the intended content is allowed and only the wording was ambiguous.' },
    revisedPrompt: { type: 'string', description: 'The rewritten prompt body (empty when benign is false).' },
    explanation: { type: 'string', description: 'One or two sentences on what changed and why.' },
    changes: { type: 'array', items: { type: 'string' }, description: 'Each specific wording change, e.g. "smooths her blouse → stands calmly".' },
  },
  required: ['benign', 'revisedPrompt', 'explanation', 'changes'],
};

export function rewriteRequest(kind: 'video' | 'image' | 'music', body: string, f: Pick<ProviderFailure, 'code' | 'reason' | 'message'>): string {
  return [
    `This ${kind} prompt was blocked by Google (${[f.code, f.reason].filter(Boolean).join(', ')}): ${f.message}`,
    'Rewrite it following your instructions. The prompt:',
    '---',
    body,
    '---',
  ].join('\n');
}

export interface RewriteCheck {
  ok: boolean;
  reason: string;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Deterministic checks a proposed rewrite must pass before it is ever sent. */
export function checkRewrite(original: string, revised: string, benign: boolean): RewriteCheck {
  if (!benign) return { ok: false, reason: 'The intended content itself is not allowed, so it was not rewritten.' };
  if (!revised.trim()) return { ok: false, reason: 'No rewrite was proposed.' };
  if (norm(revised) === norm(original)) return { ok: false, reason: 'The proposal is the same as the blocked prompt.' };
  if (revised.length > 12000) return { ok: false, reason: 'The proposal is too long.' };
  const tags = original.match(/<[A-Z][A-Z0-9_]*>/g) ?? [];
  const missing = tags.filter((t) => !revised.includes(t));
  if (missing.length) return { ok: false, reason: `The proposal dropped reference tags (${[...new Set(missing)].join(', ')}).` };
  const restrictions = (s: string) => (s.match(/\bDo not\b/gi) ?? []).length;
  if (restrictions(revised) < restrictions(original)) return { ok: false, reason: 'The proposal removed restrictions (“Do not …”).' };
  return { ok: true, reason: '' };
}
