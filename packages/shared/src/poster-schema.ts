import { z } from 'zod';
import { isoDaySchema, KIT_CONTACT_KINDS, kitFontSchema, priceSchema } from './brand-primitives';

/**
 * Motion Poster Ad: the facts form stored on a Link to Ad document (`project.linkad.poster`, project type
 * `poster_ad`). The poster and the motion ad are both made from these fields; the layout and the script live in
 * `poster.ts`.
 */

export const POSTER_TEMPLATES = ['product_hero', 'price_list', 'event', 'service_promo'] as const;
export type PosterTemplate = (typeof POSTER_TEMPLATES)[number];

export const POSTER_FORMAT_IDS = ['4:5', '9:16', '1:1'] as const;
export type PosterFormatId = (typeof POSTER_FORMAT_IDS)[number];
export const POSTER_FORMATS: Record<PosterFormatId, { width: number; height: number; label: string }> = {
  '4:5': { width: 1080, height: 1350, label: 'Feed 4:5 · 1080 × 1350' },
  '9:16': { width: 1080, height: 1920, label: 'Status / Story 9:16 · 1080 × 1920' },
  '1:1': { width: 1080, height: 1080, label: 'Square 1:1 · 1080 × 1080' },
};

const id = z.string().min(1).max(80).regex(/^[\w.-]+$/, 'Invalid id');
const text = (max: number) => z.string().max(max);

export const posterPriceSchema = z.object({
  id,
  item: text(60).default(''),
  price: priceSchema,
  currency: text(8).default('GH₵'),
  unit: text(40).default(''),
  /** The brand-kit entry it was taken from, and that entry's review-by day. */
  kitEntryId: id.nullable().default(null),
  reviewBy: isoDaySchema.nullable().default(null),
});
export type PosterPrice = z.infer<typeof posterPriceSchema>;

export const posterContactSchema = z.object({
  id,
  kind: z.enum(KIT_CONTACT_KINDS),
  value: text(160),
  kitEntryId: id.nullable().default(null),
  reviewBy: isoDaySchema.nullable().default(null),
});
export type PosterContact = z.infer<typeof posterContactSchema>;

export const posterExportSchema = z.object({
  assetId: id,
  /** `posterInputHash` of the form, brand and format the PNG was drawn from. */
  hash: text(40),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  at: z.number().int().nonnegative(),
});
export type PosterExport = z.infer<typeof posterExportSchema>;

const defaultFont = kitFontSchema.parse({});

export const posterSchema = z.object({
  template: z.enum(POSTER_TEMPLATES).default('product_hero'),
  headline: text(80).default(''),
  subhead: text(160).default(''),
  /** A short offer line ("Free delivery in Accra"); figures in it must be facts like any other. */
  offer: text(100).default(''),
  prices: z.array(posterPriceSchema).max(8).default([]),
  contacts: z.array(posterContactSchema).max(4).default([]),
  date: text(60).default(''),
  time: text(40).default(''),
  place: text(120).default(''),
  cta: text(60).default(''),
  /** Entries of the ad's pictures (`source.assets`), in order: the first is the hero photo. */
  photoIds: z.array(id).max(4).default([]),
  focal: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).default({ x: 0.5, y: 0.5 }),
  fonts: z.object({ heading: kitFontSchema.default(defaultFont), body: kitFontSchema.default(defaultFont) }).default({ heading: defaultFont, body: defaultFont }),
  formats: z.array(z.enum(POSTER_FORMAT_IDS)).min(1).max(3).default(['4:5', '9:16']),
  /** Saved poster PNGs per format (written by the API after the browser uploads the drawing). */
  exports: z.record(z.string(), posterExportSchema).default({}),
  /** `posterFormHash` when the motion-ad script was last built from the form. */
  scriptFor: text(40).nullable().default(null),
});
export type PosterForm = z.infer<typeof posterSchema>;

/**
 * What the browser may change in the form (exports and the script stamp are server-written). Spelled out without
 * defaults: zod 4 applies a field's default inside `.partial()`, which would wipe fields a caller left out.
 */
export const posterEditSchema = z.object({
  template: z.enum(POSTER_TEMPLATES).optional(),
  headline: text(80).optional(),
  subhead: text(160).optional(),
  offer: text(100).optional(),
  prices: z.array(posterPriceSchema).max(8).optional(),
  contacts: z.array(posterContactSchema).max(4).optional(),
  date: text(60).optional(),
  time: text(40).optional(),
  place: text(120).optional(),
  cta: text(60).optional(),
  photoIds: z.array(id).max(4).optional(),
  focal: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  fonts: z.object({ heading: kitFontSchema, body: kitFontSchema }).optional(),
  formats: z.array(z.enum(POSTER_FORMAT_IDS)).min(1).max(3).optional(),
});
export type PosterEdit = z.infer<typeof posterEditSchema>;

export function defaultPoster(template: PosterTemplate = 'product_hero'): PosterForm {
  return posterSchema.parse({ template });
}
