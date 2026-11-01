import { z } from 'zod';

/**
 * Building blocks shared by brand kits (`brand-kit.ts`) and the Motion Poster Ad (`poster-schema.ts`, stored on a
 * Link to Ad document). Kept free of other studio modules so the schemas can be imported anywhere without cycles.
 */

/** Fonts the renderer has installed (fontconfig in the Cloud Run image); the motion ad's text always uses one of them. */
export const RENDER_FONTS = ['Inter', 'EB Garamond', 'DejaVu Sans', 'Noto Sans'] as const;
export type RenderFont = (typeof RENDER_FONTS)[number];

export const KIT_CONTACT_KINDS = ['phone', 'whatsapp', 'email', 'website', 'address', 'social'] as const;
export type KitContactKind = (typeof KIT_CONTACT_KINDS)[number];
export const KIT_CONTACT_LABELS: Record<KitContactKind, string> = { phone: 'Phone', whatsapp: 'WhatsApp', email: 'Email', website: 'Website', address: 'Address', social: 'Social' };

export const isoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');

/** A price as written: digits with optional thousands commas and up to two decimals ("450", "1,200", "12.50"). */
export const priceSchema = z.string().max(20).regex(/^\d[\d,]*(?:\.\d{1,2})?$/, 'Write the price as a number, e.g. 450 or 12.50');

export const kitFontSchema = z.object({
  /** A font the renderer has; the video uses it, and the poster falls back to it. */
  family: z.enum(RENDER_FONTS).default('Inter'),
  /** An uploaded .ttf/.otf studio asset (document kind) the poster draws with, once its licence is confirmed. */
  uploadAssetId: z.string().min(1).max(80).regex(/^[\w.-]+$/).nullable().default(null),
  uploadFamily: z.string().max(80).default(''),
  licenceConfirmed: z.boolean().default(false),
});
export type KitFont = z.infer<typeof kitFontSchema>;

/** The family a browser drawing uses: the licensed upload when there is one, else the renderer font. */
export function drawingFamily(f: KitFont): string {
  return f.uploadAssetId && f.licenceConfirmed ? `kit-${f.uploadAssetId}` : f.family;
}
