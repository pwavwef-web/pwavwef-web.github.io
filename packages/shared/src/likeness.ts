import { approxTokens, type PricingTable } from './cost';
import type { CostEstimate } from './types';

/**
 * Wardrobe and likeness lock for Film Studio Lite and Music Video Lite stills. A still whose shot uses character
 * likeness references is compared, after it is made, with each character's approved reference image(s) for face
 * and outfit by the reasoning model (both images in one request, JSON verdict). The verdict is stored on the
 * candidate; a still that fails is never approved automatically (the shot keeps its previous image, the
 * candidate is kept and marked), and an export that uses one carries a warning.
 */

export interface LikenessSubject {
  characterId: string;
  name: string;
  /** Approved reference images (likeness), first first. */
  assetIds: string[];
  /** The wardrobe the shot asks for ('' = as in the reference). */
  outfit: string;
  /** True when the wardrobe text, not the reference image, decides the outfit (Music Video Lite's wardrobe rule). */
  outfitFromText: boolean;
}

export interface LikenessCharacterVerdict {
  name: string;
  /** Visible in the still at all (a wide shot may hide the face: then face is not judged). */
  visible: boolean;
  faceMatch: boolean | null;
  outfitMatch: boolean | null;
  differences: string[];
}

export interface LikenessVerdict {
  verdict: 'pass' | 'fail' | 'unchecked';
  faceMatch: boolean | null;
  outfitMatch: boolean | null;
  differences: string[];
  characters: LikenessCharacterVerdict[];
  checkedAt: number;
  modelId: string | null;
  /** Why the check could not run (verdict 'unchecked'). */
  error?: string | null;
}

/** Most reference images compared per character (the first is the approved likeness). */
export const LIKENESS_REFS_PER_CHARACTER = 2;
/** Characters checked per still. */
export const LIKENESS_MAX_CHARACTERS = 4;

/** Characters of a shot with likeness references, as the check needs them. */
export function likenessSubjects(chars: readonly { id: string; name: string; refAssetIds: string[]; clothing: string }[], opts: { outfitFromText: boolean }): LikenessSubject[] {
  return chars
    .filter((c) => c.refAssetIds.length > 0)
    .slice(0, LIKENESS_MAX_CHARACTERS)
    .map((c) => ({ characterId: c.id, name: c.name.trim() || 'Character', assetIds: c.refAssetIds.slice(0, LIKENESS_REFS_PER_CHARACTER), outfit: c.clothing.trim(), outfitFromText: opts.outfitFromText && Boolean(c.clothing.trim()) }));
}

export const LIKENESS_SCHEMA = {
  type: 'object',
  properties: {
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          visible: { type: 'boolean', description: 'The character appears in the new image.' },
          faceMatch: { type: 'boolean', description: 'Same person as the reference: face shape, features, skin tone, hair, apparent age.' },
          outfitMatch: { type: 'boolean', description: 'Clothing and accessories match what is required.' },
          differences: { type: 'array', items: { type: 'string' }, description: 'Each concrete difference, in a few words.' },
        },
        required: ['name', 'visible', 'faceMatch', 'outfitMatch', 'differences'],
      },
    },
  },
  required: ['characters'],
} as const;

export const LIKENESS_SYSTEM =
  'You check a newly generated still against approved character references before it is used in a film. Compare faces strictly (same person: face shape, eyes, nose, mouth, skin tone, hair, apparent age, build) and clothing exactly as instructed. ' +
  'Ignore pose, expression, lighting, framing and background. Report only differences you can see. Return only JSON.';

/** The text part of the check (the images go first: the new still, then each character's references in order). */
export function likenessPrompt(subjects: readonly LikenessSubject[]): string {
  let n = 1;
  const lines = ['Image 1 is the NEW still to check.'];
  for (const s of subjects) {
    const ids = s.assetIds.map(() => ++n);
    lines.push(`Image${ids.length > 1 ? 's' : ''} ${ids.join(', ')}: approved likeness reference${ids.length > 1 ? 's' : ''} of ${s.name}.`);
  }
  lines.push('', 'For each character below, say whether they appear in the new still, whether the face matches their reference, whether the outfit matches, and list every difference.');
  for (const s of subjects) {
    const outfit = s.outfitFromText ? `must wear exactly: ${s.outfit} (judge the outfit by this description, not by the reference)` : s.outfit ? `outfit as described: ${s.outfit} (the reference shows the person; judge clothing against this description)` : 'outfit should match the reference image';
    lines.push(`- ${s.name}: ${outfit}.`);
  }
  return lines.join('\n');
}

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Reads the model's reply; a character the reply leaves out, or a malformed reply, is never a pass. */
export function normalizeLikenessVerdict(raw: unknown, subjects: readonly LikenessSubject[], meta: { modelId: string | null; at?: number }): LikenessVerdict {
  const list = Array.isArray((raw as { characters?: unknown })?.characters) ? ((raw as { characters: unknown[] }).characters as Record<string, unknown>[]) : [];
  const characters: LikenessCharacterVerdict[] = subjects.map((s, i) => {
    const r = list.find((x) => String(x?.name ?? '').trim().toLowerCase() === s.name.toLowerCase()) ?? list[i] ?? null;
    if (!r) return { name: s.name, visible: false, faceMatch: null, outfitMatch: null, differences: ['not judged by the reviewer'] };
    const visible = bool(r.visible) ?? true;
    return {
      name: s.name,
      visible,
      faceMatch: visible ? bool(r.faceMatch) : null,
      outfitMatch: visible ? bool(r.outfitMatch) : null,
      differences: (Array.isArray(r.differences) ? r.differences : []).map((d) => String(d).slice(0, 160)).filter(Boolean).slice(0, 6),
    };
  });
  const judged = characters.filter((c) => c.visible);
  const faceMatch = judged.length ? (judged.some((c) => c.faceMatch === false) ? false : judged.every((c) => c.faceMatch === true) ? true : null) : null;
  const outfitMatch = judged.length ? (judged.some((c) => c.outfitMatch === false) ? false : judged.every((c) => c.outfitMatch === true) ? true : null) : null;
  const malformed = !list.length || characters.some((c) => c.differences[0] === 'not judged by the reviewer');
  const verdict: LikenessVerdict['verdict'] = faceMatch === false || outfitMatch === false ? 'fail' : malformed || faceMatch === null ? 'unchecked' : 'pass';
  return {
    verdict,
    faceMatch,
    outfitMatch,
    differences: characters.flatMap((c) => c.differences.map((d) => `${c.name}: ${d}`)).slice(0, 10),
    characters,
    checkedAt: meta.at ?? Date.now(),
    modelId: meta.modelId,
    ...(malformed ? { error: 'The reviewer did not judge every character.' } : {}),
  };
}

/** A candidate that must not become a shot's image automatically. */
export const likenessBlocksAutoApproval = (v: Pick<LikenessVerdict, 'verdict'> | null | undefined) => v?.verdict === 'fail';

/** Approved stills that failed the check (asset id → what differs), for the export checks. */
export function likenessFailures(assets: Record<string, { likeness?: LikenessVerdict | null } | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, a] of Object.entries(assets)) if (a?.likeness?.verdict === 'fail') out[id] = a.likeness.differences.slice(0, 2).join('; ');
  return out;
}

/** Short label for the shot UI. */
export function likenessLabel(v: LikenessVerdict | null | undefined): string | null {
  if (!v) return null;
  if (v.verdict === 'pass') return 'Likeness and wardrobe match';
  if (v.verdict === 'unchecked') return `Likeness not checked${v.error ? ` — ${v.error}` : ''}`;
  const what = [v.faceMatch === false ? 'face' : '', v.outfitMatch === false ? 'outfit' : ''].filter(Boolean).join(' and ');
  return `${what ? `${what[0]!.toUpperCase()}${what.slice(1)} differ${what.includes(' and ') ? '' : 's'}` : 'Does not match'} from the approved reference`;
}

/** Cost of one check: the reasoning model reading the still and the references, answering a short JSON. */
export function estimateLikenessCheck(input: { modelId: string; images: number; promptChars: number }, table: PricingTable): CostEstimate {
  const t = table.text[input.modelId];
  if (!t) return { usd: 0, basis: 'none', confidence: 'low', breakdown: [], notes: [`No pricing configured for ${input.modelId}.`], pricingVersion: table.version };
  const inputTokens = approxTokens(input.promptChars + LIKENESS_SYSTEM.length) + input.images * table.image.inputTokensPerImage;
  const outputTokens = 1200;
  const usd = (inputTokens * t.inputPerM + outputTokens * t.outputPerM) / 1_000_000;
  const r = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  return { usd: r(usd), basis: 'published_rate', confidence: 'medium', breakdown: [{ label: `Likeness and wardrobe check (${input.images} images, ≈${outputTokens} output and reasoning tokens, estimated)`, usd: r(usd) }], notes: ['The likeness check reads the new still with the approved references.'], pricingVersion: table.version };
}
