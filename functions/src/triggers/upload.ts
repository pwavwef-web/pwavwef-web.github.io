import path from 'node:path';
import { logger } from 'firebase-functions';
import { fileTypeFromBuffer } from 'file-type';
import { parseUploadPath, UPLOAD_POLICY, type AssetDoc, type AssetKind } from '@az-studio/shared';
import { deriveFiles, withTmpDir } from '../lib/assets';
import { bucket, col, db, FieldValue } from '../lib/firebase';
import { readHead } from '../lib/storage';
import { mediaInputUrl } from '../lib/media-proxy';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  webm: 'video/webm',
  mpg: 'video/mpeg',
  '3gp': 'video/3gpp',
  flv: 'video/x-flv',
  asf: 'video/x-ms-wmv',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  aif: 'audio/aiff',
  pdf: 'application/pdf',
};

/** Which sniffed containers are acceptable for each asset kind. */
const ALLOWED_EXT: Record<AssetKind, string[]> = {
  image: ['png', 'jpg', 'webp', 'heic', 'heif'],
  video: ['mp4', 'm4v', 'mov', 'qt', 'webm', 'mpg', '3gp', 'flv', 'asf'],
  audio: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aif', 'webm', 'mp4'],
  document: ['pdf'],
};

/** Server-side verdict on an uploaded file's real type. Exported for unit tests. */
export async function sniffUpload(kind: AssetKind, head: Buffer): Promise<{ ok: true; mimeType: string } | { ok: false; reason: string }> {
  const detected = await fileTypeFromBuffer(head);
  if (kind === 'document') {
    if (detected?.ext === 'pdf') return { ok: true, mimeType: 'application/pdf' };
    // Fonts for lyric and credit styles (TrueType / OpenType outlines).
    if (detected?.ext === 'ttf' || detected?.ext === 'otf') return { ok: true, mimeType: detected.ext === 'ttf' ? 'font/ttf' : 'font/otf' };
    if (detected) return { ok: false, reason: `Expected a text, PDF or font file but found ${detected.mime}.` };
    // Plain text (lyrics, .lrc, .fountain): must be valid UTF-8 without NUL bytes.
    if (head.includes(0)) return { ok: false, reason: 'This file is not a text document.' };
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 4)));
    } catch {
      return { ok: false, reason: 'Text files must be UTF-8 encoded.' };
    }
    return { ok: true, mimeType: 'text/plain' };
  }
  if (!detected) return { ok: false, reason: `The file does not look like a valid ${kind}.` };
  const ext = detected.ext as string;
  if (!ALLOWED_EXT[kind].includes(ext)) return { ok: false, reason: `Expected ${kind === 'image' ? 'an' : 'a'} ${kind} file but found ${detected.mime}.` };
  let mimeType = MIME_BY_EXT[ext] ?? detected.mime;
  if (kind === 'audio' && (ext === 'mp4' || ext === 'm4a')) mimeType = 'audio/mp4';
  if (kind === 'audio' && ext === 'webm') mimeType = 'audio/webm';
  return { ok: true, mimeType };
}

export interface FinalizedObject {
  name: string;
  size: number;
}

/** Validates an owner upload, extracts metadata/derivatives and marks the asset ready (or rejects it). */
export async function handleUpload(obj: FinalizedObject): Promise<void> {
  const parsed = parseUploadPath(obj.name);
  if (!parsed) return;
  const assetRef = col.assets().doc(parsed.assetId);
  const snap = await assetRef.get();
  const file = bucket.file(obj.name);
  const reject = async (reason: string) => {
    logger.warn('upload rejected', { path: obj.name, reason });
    await file.delete({ ignoreNotFound: true });
    if (snap.exists) await assetRef.set({ status: 'rejected', rejection: { reason }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  };
  if (!snap.exists) {
    // Uploads must be reserved through the API first.
    await file.delete({ ignoreNotFound: true });
    return;
  }
  const asset = { id: snap.id, ...snap.data() } as AssetDoc;
  if (asset.status !== 'uploading') return;
  if (asset.ownerUid !== parsed.uid || asset.storagePath !== obj.name) return reject('Upload location does not match its reservation.');
  const policy = UPLOAD_POLICY[asset.kind];
  if (obj.size > policy.maxBytes) return reject(`File is larger than the ${Math.round(policy.maxBytes / 1048576)} MB limit for ${asset.kind} files.`);
  if (obj.size <= 0) return reject('The file is empty.');

  await assetRef.update({ status: 'processing', updatedAt: FieldValue.serverTimestamp() });
  const head = await readHead(obj.name, 64 * 1024);
  const verdict = await sniffUpload(asset.kind, head);
  if (!verdict.ok) return reject(verdict.reason);

  try {
    await withTmpDir(async (dir) => {
      let input: string;
      if (asset.kind === 'image' || asset.kind === 'document') {
        input = path.join(dir, 'source');
        await file.download({ destination: input });
      } else {
        // Large audio/video is read with range requests through the loopback media proxy (never downloaded whole).
        input = await mediaInputUrl(obj.name);
      }
      const derived = await deriveFiles(asset.ownerUid, asset.id, asset.kind, input, dir, head);
      const batch = db.batch();
      batch.update(assetRef, {
        status: 'ready',
        mimeType: verdict.mimeType,
        sizeBytes: obj.size,
        width: derived.width,
        height: derived.height,
        durationSec: derived.durationSec,
        fps: derived.fps,
        hasAudio: derived.hasAudio,
        thumbPath: derived.thumbPath,
        posterPath: derived.posterPath,
        waveformPath: derived.waveformPath,
        c2pa: derived.c2pa,
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.set(col.users().doc(asset.ownerUid), { stats: { storageBytes: FieldValue.increment(obj.size), assetCount: FieldValue.increment(1) } }, { merge: true });
      await batch.commit();
    });
  } catch (e) {
    await reject(`The file could not be read as a valid ${asset.kind}: ${String((e as Error).message).slice(0, 160)}`);
  }
}
