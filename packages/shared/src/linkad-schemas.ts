import { z } from 'zod';
import { LINKAD_URL_MAX_CHARS } from './linkad-url';
import { linkAdEditSchema } from './linkad';

/** Request schema for Link to Ad (`azsApi` action `linkAd`, one `op` per operation). */

const id = z.string().min(1).max(128).regex(/^[\w-]+$/, 'Invalid id');
/** Client-chosen key that makes a paid or long operation safe to repeat: the same key never starts a second run. */
const requestId = z.string().min(8).max(64).regex(/^[\w-]+$/, 'Invalid request id');
const projectId = id;

export const linkAdRequestSchema = z.discriminatedUnion('op', [
  /** Feature availability, provider setup and limits for the signed-in owner. */
  z.object({ op: z.literal('config') }),
  z.object({
    op: z.literal('create'),
    requestId,
    url: z.string().max(LINKAD_URL_MAX_CHARS).default(''),
    promote: z.string().max(300).default(''),
    manualText: z.string().max(6000).default(''),
    maxPages: z.number().int().min(1).max(5).nullish(),
    extraUrls: z.array(z.string().max(LINKAD_URL_MAX_CHARS)).max(4).default([]),
    fixture: z.boolean().default(false),
  }),
  z.object({ op: z.literal('edit'), projectId, revision: z.number().int().nonnegative(), edit: linkAdEditSchema }),
  z.object({ op: z.literal('analyse'), projectId, requestId, manualOnly: z.boolean().default(false), estimateOnly: z.boolean().default(false) }),
  z.object({ op: z.literal('approveBrief'), projectId, revision: z.number().int().nonnegative() }),
  z.object({ op: z.literal('plan'), projectId, requestId, estimateOnly: z.boolean().default(false) }),
  z.object({ op: z.literal('selectDirection'), projectId, directionId: id }),
  z.object({ op: z.literal('revise'), projectId, requestId, scope: z.enum(['hook', 'script', 'scene']), sceneId: id.nullable().default(null), guidance: z.string().max(400).default(''), estimateOnly: z.boolean().default(false) }),
  z.object({ op: z.literal('voice'), projectId, requestId, sceneIds: z.array(id).max(8).nullish(), estimateOnly: z.boolean().default(false), confirmedUsd: z.number().nonnegative().nullable().default(null), acknowledgeInterrupted: z.boolean().default(false) }),
  z.object({ op: z.literal('export'), projectId, requestId, quality: z.enum(['draft', 'final']), estimateOnly: z.boolean().default(false), confirmedUsd: z.number().nonnegative().nullable().default(null) }),
  z.object({ op: z.literal('addAsset'), projectId, assetId: id, role: z.enum(['logo', 'image']), rightsConfirmed: z.boolean() }),
  z.object({ op: z.literal('enhance'), projectId, requestId, sceneId: id, estimateOnly: z.boolean().default(true), confirmedUsd: z.number().nonnegative().nullable().default(null) }),
  z.object({ op: z.literal('cancel'), projectId }),
  z.object({ op: z.literal('refresh'), projectId }),
  z.object({ op: z.literal('duplicate'), projectId, requestId }),
]);
/** What the server works with (defaults applied). */
export type LinkAdRequest = z.output<typeof linkAdRequestSchema>;
/** What a caller sends (fields with defaults may be left out). */
export type LinkAdRequestInput = z.input<typeof linkAdRequestSchema>;
