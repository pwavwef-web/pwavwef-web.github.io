import { bucket } from './firebase';
import { IS_EMULATOR, SIGNED_URL_TTL_SECONDS } from '../config/runtime';

/**
 * Short-lived V4 signed read URL. Signing uses the runtime service account through IAM signBlob
 * (it holds roles/iam.serviceAccountTokenCreator on itself); the bucket itself stays private.
 */
export async function signedReadUrl(path: string, opts: { downloadName?: string; ttlSeconds?: number } = {}): Promise<{ url: string; expiresAt: number }> {
  const ttl = opts.ttlSeconds ?? SIGNED_URL_TTL_SECONDS;
  const expiresAt = Date.now() + ttl * 1000;
  if (IS_EMULATOR) {
    const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:9199';
    return { url: `http://${host}/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`, expiresAt };
  }
  const [url] = await bucket.file(path).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: expiresAt,
    ...(opts.downloadName ? { responseDisposition: `attachment; filename="${opts.downloadName.replace(/"/g, '')}"` } : {}),
  });
  return { url, expiresAt };
}

export async function readHead(path: string, bytes = 65536): Promise<Buffer> {
  const [buf] = await bucket.file(path).download({ start: 0, end: bytes - 1 });
  return buf;
}

export async function objectSize(path: string): Promise<number> {
  const [meta] = await bucket.file(path).getMetadata();
  return Number(meta.size ?? 0);
}

export async function deletePrefix(prefix: string): Promise<void> {
  await bucket.deleteFiles({ prefix, force: true });
}
