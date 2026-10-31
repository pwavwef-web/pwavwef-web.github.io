import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  BOOTH_LANGUAGE,
  BOOTH_LIMITS,
  BOOTH_TRIM,
  analyzeRecording,
  boothJoinPlan,
  boothNarrationHash,
  checkBoothTake,
  encodePcm16Wav,
  joinWithPauses,
  normalizeLiteSpec,
  refreshBoothLines,
  sceneBoothLines,
  storagePaths,
  trimClip,
  type AssetDoc,
  type BoothSceneDoc,
  type BoothTake,
  type LiteBoothRequest,
  type LiteScene,
  type LiteSpec,
  type NoiseReduction,
} from '@az-studio/shared';
import { createAsset, withTmpDir } from '../lib/assets';
import { bucket, col, db } from '../lib/firebase';
import { decodeToFloat, reduceNoise } from '../lib/narrator-audio';
import type { Owner } from '../lib/owner';
import { assertRateLimit } from '../lib/usage';

type Req<O extends LiteBoothRequest['op']> = Extract<LiteBoothRequest, { op: O }>;

/** Takes are decoded at the Narrator's working rate (24 kHz mono float). */
const RATE = 24_000;

/**
 * Media I/O for the booth, kept behind one object so tests can run the API without Storage or FFmpeg.
 * Takes are short (one sentence each), so they are downloaded and decoded whole.
 */
export const boothIo = {
  async decode(storagePath: string): Promise<Float32Array> {
    return withTmpDir(async (dir) => {
      const local = path.join(dir, `take${path.extname(storagePath) || '.audio'}`);
      await bucket.file(storagePath).download({ destination: local } as never);
      return decodeToFloat(local, RATE, 60_000);
    });
  },
  reduceNoise: (samples: Float32Array, level: NoiseReduction) => reduceNoise(samples, RATE, level, 120_000),
  /** Stores the joined recording as a derived audio asset of the film. */
  async store(input: { uid: string; projectId: string; sceneId: string; title: string; samples: Float32Array; firstTakeAssetId: string }): Promise<string> {
    const assetId = col.assets().doc().id;
    const storagePath = storagePaths.derived(input.uid, assetId, 'booth-narration.wav');
    await withTmpDir(async (dir) => {
      const local = path.join(dir, 'booth-narration.wav');
      await writeFile(local, encodePcm16Wav(input.samples, RATE));
      await bucket.upload(local, { destination: storagePath, resumable: false, metadata: { contentType: 'audio/wav', cacheControl: 'private, max-age=31536000' } });
      await createAsset({ uid: input.uid, assetId, projectId: input.projectId, kind: 'audio', source: 'derived', title: input.title, fileName: 'booth-narration.wav', mimeType: 'audio/wav', storagePath, localFile: local, dir, collections: ['lite:booth', 'lite:narration', `lite:booth:scene:${input.sceneId}`], derivedFrom: { assetId: input.firstTakeAssetId } });
    });
    return assetId;
  },
};

const boothRef = (projectId: string, sceneId: string) => col.sub(projectId, 'boothScenes').doc(sceneId);

async function loadScene(uid: string, projectId: string, sceneId: string): Promise<{ spec: LiteSpec; scene: LiteScene; title: string }> {
  const snap = await col.projects().doc(projectId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) throw new HttpsError('not-found', 'Film not found.');
  if (snap.get('type') !== 'film_lite') throw new HttpsError('failed-precondition', 'The recording booth is part of Film Studio Lite.');
  const spec = normalizeLiteSpec(snap.get('lite'));
  const scene = spec.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new HttpsError('not-found', 'Scene not found (save the film and try again).');
  return { spec, scene, title: String(snap.get('title') ?? 'Film') };
}

const emptyDoc = (uid: string, sceneId: string): BoothSceneDoc => ({ ownerUid: uid, sceneId, language: BOOTH_LANGUAGE, narrationHash: '', lines: [], takes: [], picks: {}, joined: null, updatedAt: Date.now() });

/** The stored booth state with its lines brought up to date with the scene's current narration. */
async function current(uid: string, projectId: string, sceneId: string): Promise<{ doc: BoothSceneDoc; spec: LiteSpec; scene: LiteScene; title: string }> {
  const { spec, scene, title } = await loadScene(uid, projectId, sceneId);
  const snap = await boothRef(projectId, sceneId).get();
  const stored = snap.exists ? ({ ...emptyDoc(uid, sceneId), ...(snap.data() as Partial<BoothSceneDoc>) } as BoothSceneDoc) : emptyDoc(uid, sceneId);
  const doc = stored.narrationHash === boothNarrationHash(scene.narration) && stored.lines.length ? stored : refreshBoothLines(stored, sceneBoothLines(spec, scene), scene.narration);
  return { doc, spec, scene, title };
}

async function open(owner: Owner, p: Req<'open'>) {
  const { doc, scene } = await current(owner.uid, p.projectId, p.sceneId);
  if (!scene.narration.trim()) throw new HttpsError('failed-precondition', 'This scene has no narration to record yet.');
  const next = { ...doc, updatedAt: Date.now() };
  await boothRef(p.projectId, p.sceneId).set(next);
  return next;
}

async function takeAdd(owner: Owner, p: Req<'takeAdd'>) {
  await assertRateLimit(owner.uid, 1, 120);
  const { doc } = await current(owner.uid, p.projectId, p.sceneId);
  const line = doc.lines.find((l) => l.id === p.lineId);
  if (!line) throw new HttpsError('failed-precondition', 'That line is no longer in the narration. Reopen the booth.');
  if (doc.takes.some((t) => t.assetId === p.assetId)) return { take: doc.takes.find((t) => t.assetId === p.assetId)!, duplicate: true };
  if (doc.takes.filter((t) => t.lineId === line.id).length >= BOOTH_LIMITS.takesPerLine) throw new HttpsError('resource-exhausted', `A line keeps at most ${BOOTH_LIMITS.takesPerLine} takes. Delete one first.`);
  const aSnap = await col.assets().doc(p.assetId).get();
  const asset = aSnap.data() as AssetDoc | undefined;
  if (!asset || asset.ownerUid !== owner.uid || asset.projectId !== p.projectId) throw new HttpsError('not-found', 'Recording not found.');
  if (asset.kind !== 'audio' || asset.status !== 'ready') throw new HttpsError('failed-precondition', asset.status === 'rejected' ? asset.rejection?.reason ?? 'The recording was rejected.' : 'The recording is still being checked. Try again in a moment.');
  if (asset.sizeBytes > BOOTH_LIMITS.takeMaxBytes || (asset.durationSec ?? 0) > BOOTH_LIMITS.takeMaxSec) throw new HttpsError('invalid-argument', `A take is at most ${BOOTH_LIMITS.takeMaxSec} s. Record one line at a time.`);
  const samples = await boothIo.decode(asset.storagePath);
  const analysis = analyzeRecording(samples, RATE, 'pronunciation');
  const take: BoothTake = { id: `t${col.assets().doc().id.slice(0, 12)}`, assetId: p.assetId, lineId: line.id, lineText: line.text, durationSec: analysis.durationSec, analysis, check: checkBoothTake(analysis, line.expectedSec), createdAt: Date.now() };
  const ref = boothRef(p.projectId, p.sceneId);
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    const base = cur.exists ? ({ ...doc, ...(cur.data() as BoothSceneDoc), lines: doc.lines, narrationHash: doc.narrationHash } as BoothSceneDoc) : doc;
    const picks = { ...base.picks };
    // The first usable take of a line is picked for the director; a later pick is always theirs.
    if (!picks[line.id] && take.check.verdict !== 'redo') picks[line.id] = take.id;
    tx.set(ref, { ...base, takes: [...base.takes.filter((t) => t.assetId !== take.assetId), take], picks, updatedAt: Date.now() });
  });
  return { take, duplicate: false };
}

async function takeDelete(owner: Owner, p: Req<'takeDelete'>) {
  const { doc } = await current(owner.uid, p.projectId, p.sceneId);
  const picks = Object.fromEntries(Object.entries(doc.picks).filter(([, v]) => v !== p.takeId));
  // The take's audio stays in the studio's assets (delete it there to free the storage).
  await boothRef(p.projectId, p.sceneId).set({ ...doc, takes: doc.takes.filter((t) => t.id !== p.takeId), picks, updatedAt: Date.now() });
  return { ok: true };
}

async function pick(owner: Owner, p: Req<'pick'>) {
  const { doc } = await current(owner.uid, p.projectId, p.sceneId);
  if (!doc.lines.some((l) => l.id === p.lineId)) throw new HttpsError('failed-precondition', 'That line is no longer in the narration.');
  const picks = { ...doc.picks };
  if (p.takeId === null) delete picks[p.lineId];
  else {
    const t = doc.takes.find((x) => x.id === p.takeId);
    if (!t || t.lineId !== p.lineId) throw new HttpsError('invalid-argument', 'That take belongs to another line.');
    picks[p.lineId] = t.id;
  }
  await boothRef(p.projectId, p.sceneId).set({ ...doc, picks, updatedAt: Date.now() });
  return { picks };
}

/**
 * Joins the picked takes of a scene in line order: each decoded, optionally cleaned (the Narrator's noise reduction),
 * trimmed to its speech with a little air and short fades, then joined with the chosen pause. No model is called. The
 * result is a new audio asset; the browser sets it as the scene's recording and the ordinary `liteGenerate`
 * narration step times it (Kasem, the shared protected words) after showing its estimate.
 */
async function useForScene(owner: Owner, p: Req<'useForScene'>) {
  await assertRateLimit(owner.uid, 1, 30);
  const { doc, scene, title } = await current(owner.uid, p.projectId, p.sceneId);
  const plan = boothJoinPlan(doc, { noiseReduction: p.noiseReduction, pauseSec: p.pauseSec });
  if (!plan.ready) {
    const parts = [plan.missing.length ? `${plan.missing.length} line(s) have no picked take` : '', plan.outdated.length ? `${plan.outdated.length} line(s) changed after their take was recorded` : ''].filter(Boolean);
    throw new HttpsError('failed-precondition', `${parts.join(' and ') || 'Nothing to join'}.`, { missing: plan.missing.map((l) => l.id), outdated: plan.outdated.map((l) => l.id) });
  }
  if (doc.joined && doc.joined.picksHash === plan.picksHash) {
    const a = await col.assets().doc(doc.joined.assetId).get();
    if (a.exists && a.get('status') === 'ready') return { ...doc.joined, reused: true };
  }
  const parts: { samples: Float32Array; pauseAfterSec: number }[] = [];
  for (const t of plan.takes) {
    const asset = (await col.assets().doc(t.assetId).get()).data() as AssetDoc | undefined;
    if (!asset || asset.ownerUid !== owner.uid) throw new HttpsError('not-found', 'A picked take is no longer in the studio’s assets. Record that line again.');
    let samples = await boothIo.decode(asset.storagePath);
    if (p.noiseReduction !== 'off') samples = await boothIo.reduceNoise(samples, p.noiseReduction);
    const trimmed = trimClip(samples, RATE, BOOTH_TRIM);
    if (!trimmed.length) throw new HttpsError('failed-precondition', `No speech was found in the take for “${t.lineText.slice(0, 60)}”. Pick another take.`);
    parts.push({ samples: trimmed, pauseAfterSec: p.pauseSec });
  }
  const joined = joinWithPauses(parts, RATE);
  const assetId = await boothIo.store({ uid: owner.uid, projectId: p.projectId, sceneId: p.sceneId, title: `${title} · ${scene.title || 'Scene'} · booth recording`, samples: joined.samples, firstTakeAssetId: plan.takes[0]!.assetId });
  const result = { assetId, picksHash: plan.picksHash, durationSec: Math.round((joined.samples.length / RATE) * 1000) / 1000, noiseReduction: p.noiseReduction, pauseSec: p.pauseSec, lines: plan.takes.length, at: Date.now() };
  await boothRef(p.projectId, p.sceneId).set({ ...doc, joined: result, updatedAt: Date.now() });
  return { ...result, spans: joined.spans, reused: false };
}

/** Booth recordings by scene (used by `liteGenerate` to time them as Kasem with the shared vocabulary). */
export async function boothRecordings(projectId: string): Promise<Record<string, { assetId: string; language: string }>> {
  const snap = await col.sub(projectId, 'boothScenes').get();
  const out: Record<string, { assetId: string; language: string }> = {};
  for (const d of snap.docs) {
    const b = d.data() as Partial<BoothSceneDoc>;
    if (b.joined?.assetId) out[d.id] = { assetId: b.joined.assetId, language: b.language || BOOTH_LANGUAGE };
  }
  return out;
}

export async function liteBooth(owner: Owner, p: LiteBoothRequest): Promise<unknown> {
  switch (p.op) {
    case 'open':
      return open(owner, p);
    case 'takeAdd':
      return takeAdd(owner, p);
    case 'takeDelete':
      return takeDelete(owner, p);
    case 'pick':
      return pick(owner, p);
    case 'useForScene':
      return useForScene(owner, p);
    default: {
      const unhandled: never = p;
      throw new HttpsError('invalid-argument', `Unknown booth operation ${(unhandled as { op?: string }).op ?? ''}.`);
    }
  }
}
