import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { storagePaths, type AssetDoc, type AssetGeneration, type AssetKind, type AssetSource, type JobTarget } from '@az-studio/shared';
import { bucket, col, db, FieldValue } from './firebase';
import { audioPeaks, detectC2pa, imageThumb, probe, videoFrame } from './media';

export async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'azs-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readHeadLocal(file: string, bytes = 262_144): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export interface DerivedFiles {
  thumbPath: string | null;
  posterPath: string | null;
  waveformPath: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  fps: number | null;
  hasAudio: boolean | null;
  c2pa: 'present' | 'absent' | 'unknown';
}

/**
 * Probes media and uploads thumbnail / poster / waveform derivatives. `input` is a local path or a
 * loopback media-proxy URL (large uploads are read with HTTP range requests instead of downloaded).
 */
export async function deriveFiles(uid: string, assetId: string, kind: AssetKind, input: string, dir: string, head?: Buffer): Promise<DerivedFiles> {
  const localFile = input;
  const out: DerivedFiles = { thumbPath: null, posterPath: null, waveformPath: null, width: null, height: null, durationSec: null, fps: null, hasAudio: null, c2pa: 'unknown' };
  try {
    out.c2pa = detectC2pa(head ?? (await readHeadLocal(localFile)));
  } catch {
    out.c2pa = 'unknown';
  }
  if (kind === 'document') return out;
  const info = await probe(localFile);
  if (kind === 'video' && !info.hasVideo) throw new Error('No video stream found.');
  if (kind === 'audio' && !info.hasAudio) throw new Error('No audio stream found.');
  if (kind === 'image' && !(info.width && info.height)) throw new Error('Image dimensions could not be read.');
  out.width = info.width;
  out.height = info.height;
  out.durationSec = kind === 'image' ? null : info.durationSec;
  out.fps = kind === 'video' ? info.fps : null;
  out.hasAudio = kind === 'image' ? false : info.hasAudio;

  const upload = async (local: string, name: string, contentType: string) => {
    const dest = storagePaths.derived(uid, assetId, name);
    await bucket.upload(local, { destination: dest, resumable: false, metadata: { contentType, cacheControl: 'private, max-age=31536000' } });
    return dest;
  };
  try {
    if (kind === 'image') {
      const thumb = path.join(dir, 'thumb.jpg');
      await imageThumb(localFile, thumb, 640);
      out.thumbPath = await upload(thumb, 'thumb.jpg', 'image/jpeg');
    } else if (kind === 'video') {
      const at = Math.min(1, Math.max(0, (info.durationSec ?? 2) * 0.1));
      const poster = path.join(dir, 'poster.jpg');
      const thumb = path.join(dir, 'thumb.jpg');
      await videoFrame(localFile, poster, at, 1280);
      await videoFrame(localFile, thumb, at, 480);
      out.posterPath = await upload(poster, 'poster.jpg', 'image/jpeg');
      out.thumbPath = await upload(thumb, 'thumb.jpg', 'image/jpeg');
    }
  } catch {
    // Thumbnails are best-effort (e.g. HEIC stills); the asset stays usable.
  }
  if ((kind === 'audio' || (kind === 'video' && info.hasAudio)) && info.durationSec) {
    try {
      const peaks = await audioPeaks(localFile, kind === 'audio' ? 2400 : 800);
      const wf = path.join(dir, 'waveform.json');
      await writeFile(wf, JSON.stringify({ durationSec: info.durationSec, ...peaks }));
      out.waveformPath = await upload(wf, 'waveform.json', 'application/json');
    } catch {
      out.waveformPath = null;
    }
  }
  return out;
}

export interface NewAssetInput {
  uid: string;
  assetId?: string;
  projectId: string | null;
  kind: AssetKind;
  source: AssetSource;
  title: string;
  fileName: string;
  mimeType: string;
  storagePath: string;
  localFile: string;
  dir: string;
  collections?: string[];
  generation?: Omit<AssetGeneration, 'provenance'> & { provenance?: Partial<AssetGeneration['provenance']> };
  derivedFrom?: AssetDoc['derivedFrom'];
}

/** Creates a ready asset document for a stored object. Returns the asset id. */
export async function createAsset(input: NewAssetInput): Promise<string> {
  const assetId = input.assetId ?? col.assets().doc().id;
  const derived = await deriveFiles(input.uid, assetId, input.kind, input.localFile, input.dir);
  const size = (await stat(input.localFile)).size;
  const doc: Omit<AssetDoc, 'id'> = {
    ownerUid: input.uid,
    projectId: input.projectId,
    kind: input.kind,
    source: input.source,
    status: 'ready',
    title: input.title.slice(0, 160),
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: size,
    storagePath: input.storagePath,
    thumbPath: derived.thumbPath,
    posterPath: derived.posterPath,
    waveformPath: derived.waveformPath,
    width: derived.width,
    height: derived.height,
    durationSec: derived.durationSec,
    fps: derived.fps,
    hasAudio: derived.hasAudio,
    favorite: false,
    tags: [],
    collections: input.collections ?? [],
    generation: input.generation
      ? {
          ...input.generation,
          provenance: { synthId: true, c2pa: derived.c2pa, generator: input.generation.modelId, ...(input.generation.provenance ?? {}) },
        }
      : null,
    derivedFrom: input.derivedFrom ?? null,
    c2pa: derived.c2pa,
    rejection: null,
  };
  const batch = db.batch();
  batch.set(col.assets().doc(assetId), { ...doc, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  batch.set(col.users().doc(input.uid), { stats: { storageBytes: FieldValue.increment(size), assetCount: FieldValue.increment(1) } }, { merge: true });
  await batch.commit();
  return assetId;
}

/** Links a finished asset to the creative document the job was made for. */
export async function applyTarget(projectId: string | null, target: JobTarget | null, assetId: string, purpose?: string): Promise<void> {
  if (!target || !projectId) return;
  const p = col.projects().doc(projectId);
  const addRef = async (collection: 'characters' | 'locations' | 'elements', id: string, extra: Record<string, unknown> = {}) => {
    const ref = p.collection(collection).doc(id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const patch: Record<string, unknown> = { referenceAssetIds: FieldValue.arrayUnion(assetId), ...extra };
      if (collection !== 'elements' && !snap.get('primaryRefAssetId')) patch.primaryRefAssetId = assetId;
      tx.update(ref, patch);
    });
  };
  switch (target.kind) {
    case 'character':
      await addRef('characters', target.id, purpose === 'turnaround' ? { turnaroundAssetId: assetId } : {});
      break;
    case 'location':
      await addRef('locations', target.id);
      break;
    case 'element':
      await addRef('elements', target.id);
      break;
    case 'storyboard':
      await p.collection('shots').doc(target.id).set({ refs: { storyboardAssetId: assetId }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      break;
    case 'project':
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(p);
        if (snap.exists && !snap.get('coverAssetId')) tx.update(p, { coverAssetId: assetId });
      });
      break;
    default:
      break;
  }
}

export async function saveBufferToFile(dir: string, name: string, data: Buffer): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, data);
  return file;
}
