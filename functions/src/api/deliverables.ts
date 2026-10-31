import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { isTerminal, PACK_PRESET_LABELS, type ApiRequest, type JobRequest, type PackDoc, type PackPreset, type RenderDoc, type TimelineDoc } from '@az-studio/shared';
import { PRICING } from '../config/pricing';
import { col, db } from '../lib/firebase';
import type { Owner } from '../lib/owner';
import { signedReadUrl } from '../lib/storage';
import { createInternalJob } from '../lib/submit';

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];

export const packsCol = () => db.collection('packs');

async function ownedPack(uid: string, id: string): Promise<PackDoc> {
  const d = (await packsCol().doc(id).get()).data() as PackDoc | undefined;
  if (!d || d.ownerUid !== uid) throw new HttpsError('not-found', 'Pack not found.');
  return d;
}

/**
 * Moves a pack on when its renders change: waits for every render and its export check, holds on a blocked check,
 * fails when a render failed, and starts the assembly once everything is ready. Idempotent (called after every render,
 * from maintenance every 10 minutes and from the API).
 */
export async function advancePack(packId: string): Promise<PackDoc | null> {
  const ref = packsCol().doc(packId);
  const pack = (await ref.get()).data() as PackDoc | undefined;
  if (!pack || ['assembling', 'ready', 'failed'].includes(pack.status)) return pack ?? null;
  const renders = (await col.renders().where('packId', '==', packId).get()).docs.map((d) => ({ ...(d.data() as RenderDoc), id: d.id }));
  const byPreset = new Map(renders.map((r) => [r.preset as PackPreset, r]));
  const missing = pack.presets.filter((p) => !byPreset.has(p));
  const failed = renders.find((r) => isTerminal(r.status) && r.status !== 'completed');
  let status: PackDoc['status'] = 'rendering';
  let message = '';
  if (failed) {
    status = 'failed';
    message = `The ${PACK_PRESET_LABELS[failed.preset as PackPreset] ?? failed.preset} render ${failed.status}${failed.error?.message ? `: ${failed.error.message}` : '.'} Start the pack again.`;
  } else if (missing.length || renders.some((r) => !isTerminal(r.status))) {
    message = missing.length ? `Waiting for ${missing.length} render${missing.length === 1 ? '' : 's'} to be submitted.` : `Rendering ${renders.filter((r) => r.status === 'completed').length} of ${pack.presets.length}.`;
  } else {
    const blocked = renders.find((r) => r.inspect && r.finalInspection?.readiness === 'blocked');
    const pending = renders.filter((r) => r.inspect && !['ready', 'overridden'].includes(String(r.finalInspection?.readiness ?? '')));
    if (blocked) {
      status = 'blocked';
      message = `The ${PACK_PRESET_LABELS[blocked.preset as PackPreset]} render did not pass its export check (${blocked.finalInspection?.errors ?? 0} error${blocked.finalInspection?.errors === 1 ? '' : 's'}). Fix it or override the check, then the pack continues.`;
    } else if (pending.length) {
      status = 'waiting_checks';
      message = `Waiting for ${pending.length} export check${pending.length === 1 ? '' : 's'}.`;
    } else {
      status = 'assembling';
      message = 'Checking every file and building the pack.';
    }
  }
  const renderIds = Object.fromEntries(renders.map((r) => [r.preset, r.id]));
  // Only one assembly per pack, even when two callers get here together.
  const start = await db.runTransaction(async (tx) => {
    const fresh = (await tx.get(ref)).data() as PackDoc | undefined;
    if (!fresh || ['assembling', 'ready', 'failed'].includes(fresh.status)) return false;
    tx.set(ref, { status, message, renderIds, updatedAt: Date.now() }, { merge: true });
    return status === 'assembling';
  });
  if (start) {
    const jobId = await createInternalJob(pack.ownerUid, {
      type: 'pack.assemble',
      projectId: pack.projectId,
      modelId: null,
      label: `${pack.title} · deliverables pack`,
      params: { packId },
      estimate: { usd: 0, basis: 'published_rate', confidence: 'high', breakdown: [], notes: ['Checks and packs the finished renders on the functions worker (no model calls).'], pricingVersion: PRICING.version },
      target: null,
      productionId: null,
    });
    await ref.set({ jobId }, { merge: true });
  }
  return (await ref.get()).data() as PackDoc;
}

/** After a render finishes: move its pack on (best effort). */
export async function advancePackForRender(renderId: string): Promise<void> {
  const packId = (await col.renders().doc(renderId).get()).get('packId') as string | undefined;
  if (packId) await advancePack(packId).catch((e) => logger.warn('pack advance failed', { packId, error: String(e) }));
}

/** Maintenance: packs waiting on renders or export checks. */
export async function advanceOpenPacks(): Promise<number> {
  const open = await packsCol().where('status', 'in', ['rendering', 'waiting_checks', 'blocked']).limit(50).get();
  for (const d of open.docs) await advancePack(d.id).catch((e) => logger.warn('pack advance failed', { packId: d.id, error: String(e) }));
  return open.size;
}

export async function deliverables(owner: Owner, p: Payload<'deliverables'>) {
  if (p.op === 'create') {
    const tl = (await col.timelines(p.projectId).doc(p.timelineId).get()).data() as TimelineDoc | undefined;
    const project = await col.projects().doc(p.projectId).get();
    if (!tl || !project.exists || project.get('ownerUid') !== owner.uid) throw new HttpsError('not-found', 'Timeline not found.');
    const presets = [...new Set(p.presets)] as PackPreset[];
    const ref = packsCol().doc();
    const now = Date.now();
    const title = (p.title?.trim() || String(project.get('title') ?? 'Deliverables')).slice(0, 160);
    const pack: PackDoc = {
      id: ref.id,
      ownerUid: owner.uid,
      projectId: p.projectId,
      timelineId: p.timelineId,
      title,
      presets,
      posterAtSec: Math.min(Math.max(0, p.posterAtSec ?? Math.min(2, Number(tl.durationSec ?? 0) / 3)), Math.max(0, Number(tl.durationSec ?? 0) - 0.1)),
      audioMaster: p.audioMaster,
      status: 'rendering',
      message: 'Waiting for the renders to be submitted.',
      renderIds: {},
      files: [],
      zip: null,
      jobId: null,
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(pack);
    // The client submits these through the usual estimate and confirmation.
    const jobs: JobRequest[] = presets.map((preset) => ({ type: 'render.timeline', projectId: p.projectId, timelineId: p.timelineId, preset, quality: 'final', inspect: true, acceptLyricSync: false, audioMaster: p.audioMaster, packId: ref.id, label: `${title} · ${PACK_PRESET_LABELS[preset]} · pack` }) as JobRequest);
    return { pack, jobs };
  }
  if (p.op === 'advance') return { pack: await advancePack((await ownedPack(owner.uid, p.packId)).id) };
  if (p.op === 'download') {
    const pack = await ownedPack(owner.uid, p.packId);
    if (pack.status !== 'ready' || !pack.zip) throw new HttpsError('failed-precondition', 'The pack is not ready yet.');
    return signedReadUrl(pack.zip.storagePath, { downloadName: `${pack.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'deliverables'}.zip` });
  }
  // list
  let q = packsCol().where('ownerUid', '==', owner.uid);
  if (p.projectId) q = q.where('projectId', '==', p.projectId);
  const packs = (await q.get()).docs.map((d) => d.data() as PackDoc).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  return { packs };
}
