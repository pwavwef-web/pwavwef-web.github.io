import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { toast } from 'sonner';
import { ref, uploadBytesResumable } from 'firebase/storage';
import { extensionOf, kindForMime, UPLOAD_POLICY, validateDeclaredUpload, type AssetDoc, type AssetKind } from '@az-studio/shared';
import { api } from './api';
import { db, storage } from './firebase';

export interface MediaUrls {
  file?: string;
  thumb?: string;
  poster?: string;
  waveform?: string;
  expiresAt: number;
  /** Why the file may not be downloaded yet (export gate of inspected renders). */
  blocked?: string;
}

const cache = new Map<string, MediaUrls>();
const listeners = new Map<string, Set<(u: MediaUrls) => void>>();
let queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const REFRESH_MARGIN = 5 * 60_000;

async function flush() {
  timer = null;
  const ids = [...queue];
  queue = new Set();
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    try {
      const res = await api<{ urls: Record<string, MediaUrls> }, 'mediaUrls'>('mediaUrls', { assetIds: chunk, variants: ['file', 'thumb', 'poster', 'waveform'], download: false });
      for (const id of chunk) {
        const u = res.urls[id] ?? { expiresAt: Date.now() + 60_000 };
        cache.set(id, u);
        listeners.get(id)?.forEach((fn) => fn(u));
      }
    } catch {
      for (const id of chunk) cache.delete(id);
    }
  }
}

function request(id: string) {
  queue.add(id);
  if (!timer) timer = setTimeout(() => void flush(), 30);
}

/** Signed, short-lived URLs for an asset's file, thumbnail, poster and waveform (batched & cached). */
export function useMediaUrls(assetId: string | null | undefined, version?: string | number): MediaUrls | null {
  const [urls, setUrls] = useState<MediaUrls | null>(() => (assetId ? cache.get(assetId) ?? null : null));
  useEffect(() => {
    if (!assetId) {
      setUrls(null);
      return;
    }
    const set = listeners.get(assetId) ?? new Set();
    set.add(setUrls);
    listeners.set(assetId, set);
    const cached = cache.get(assetId);
    if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN && version === undefined) setUrls(cached);
    else request(assetId);
    const refreshIn = cached ? Math.max(30_000, cached.expiresAt - Date.now() - REFRESH_MARGIN) : 60 * 60_000;
    const t = setTimeout(() => request(assetId), refreshIn);
    return () => {
      clearTimeout(t);
      set.delete(setUrls);
    };
  }, [assetId, version]);
  return urls;
}

export async function getMediaUrls(assetId: string): Promise<MediaUrls> {
  const cached = cache.get(assetId);
  if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN) return cached;
  return new Promise((resolve) => {
    const set = listeners.get(assetId) ?? new Set();
    const fn = (u: MediaUrls) => {
      set.delete(fn);
      resolve(u);
    };
    set.add(fn);
    listeners.set(assetId, set);
    request(assetId);
  });
}

export async function downloadUrl(assetId: string): Promise<string | null> {
  const res = await api<{ urls: Record<string, MediaUrls> }, 'mediaUrls'>('mediaUrls', { assetIds: [assetId], variants: ['file'], download: true });
  const u = res.urls[assetId];
  if (u?.blocked) throw new Error(u.blocked);
  return u?.file ?? null;
}

/** Opens an asset's download, explaining (instead of failing silently) when export is blocked. */
export async function openDownload(assetId: string): Promise<void> {
  try {
    const url = await downloadUrl(assetId);
    if (url) window.open(url, '_blank', 'noopener');
    else toast.error('The file is not available yet.');
  } catch (e) {
    toast.error('Download not available', { description: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export function guessKind(file: File): AssetKind | null {
  const byMime = file.type ? kindForMime(file.type) : null;
  if (byMime) return byMime;
  const ext = extensionOf(file.name);
  for (const [kind, p] of Object.entries(UPLOAD_POLICY) as [AssetKind, (typeof UPLOAD_POLICY)[AssetKind]][]) if (p.extensions.includes(ext)) return kind;
  return null;
}

export interface UploadOptions {
  kind?: AssetKind;
  projectId?: string | null;
  title?: string;
  collections?: string[];
  onProgress?: (fraction: number) => void;
}

/** Reserves an asset, uploads it resumably, and resolves once the server has validated it. */
export async function uploadFile(file: File, opts: UploadOptions = {}): Promise<string> {
  const kind = opts.kind ?? guessKind(file);
  if (!kind) throw new Error(`“${file.name}” is not a supported file type.`);
  const mimeType = file.type || (kind === 'document' ? 'text/plain' : 'application/octet-stream');
  const problem = validateDeclaredUpload({ fileName: file.name, mimeType, sizeBytes: file.size, kind });
  if (problem) throw new Error(problem);
  const { assetId, storagePath } = await api<{ assetId: string; storagePath: string }, 'createUpload'>('createUpload', {
    kind,
    fileName: file.name,
    mimeType,
    sizeBytes: file.size,
    projectId: opts.projectId ?? null,
    ...(opts.title ? { title: opts.title } : {}),
    collections: opts.collections ?? [],
  });
  const task = uploadBytesResumable(ref(storage, storagePath), file, { contentType: mimeType });
  await new Promise<void>((resolve, reject) => {
    task.on('state_changed', (s) => opts.onProgress?.(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0), reject, () => resolve());
  });
  opts.onProgress?.(1);
  await waitForAsset(assetId);
  return assetId;
}

/** Resolves when the server marks the asset ready; rejects with the server's reason if rejected. */
export function waitForAsset(assetId: string, timeoutMs = 10 * 60_000): Promise<AssetDoc> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      unsub();
      reject(new Error('Processing is taking longer than expected. It will continue in the background.'));
    }, timeoutMs);
    const unsub = onSnapshot(
      doc(db, 'assets', assetId),
      (snap) => {
        const a = snap.data() as AssetDoc | undefined;
        if (!a) return;
        if (a.status === 'ready') {
          clearTimeout(t);
          unsub();
          resolve({ ...a, id: snap.id });
        } else if (a.status === 'rejected') {
          clearTimeout(t);
          unsub();
          reject(new Error(a.rejection?.reason ?? 'The file was rejected.'));
        }
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}
