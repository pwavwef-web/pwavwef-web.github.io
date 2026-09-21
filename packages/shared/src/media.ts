import type { AssetKind } from './types';

const MB = 1024 * 1024;

/** Upload policy. The server re-validates every upload by sniffing file signatures. */
export const UPLOAD_POLICY: Record<AssetKind, { maxBytes: number; mimeTypes: string[]; extensions: string[] }> = {
  image: {
    maxBytes: 30 * MB,
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'],
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif'],
  },
  video: {
    maxBytes: 2048 * MB,
    mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/mpeg', 'video/3gpp', 'video/x-flv', 'video/x-ms-wmv'],
    extensions: ['mp4', 'mov', 'webm', 'mpeg', 'mpg', '3gp', 'flv', 'wmv', 'm4v'],
  },
  audio: {
    maxBytes: 300 * MB,
    mimeTypes: [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/x-wav',
      'audio/wave',
      'audio/flac',
      'audio/x-flac',
      'audio/aac',
      'audio/mp4',
      'audio/x-m4a',
      'audio/m4a',
      'audio/ogg',
      'audio/webm',
      'audio/aiff',
      'audio/x-aiff',
    ],
    extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'webm', 'aif', 'aiff'],
  },
  document: {
    maxBytes: 20 * MB,
    mimeTypes: ['text/plain', 'application/pdf'],
    extensions: ['txt', 'lrc', 'fountain', 'pdf'],
  },
};

export function kindForMime(mime: string): AssetKind | null {
  const m = mime.toLowerCase();
  for (const [kind, policy] of Object.entries(UPLOAD_POLICY) as [AssetKind, (typeof UPLOAD_POLICY)[AssetKind]][]) {
    if (policy.mimeTypes.includes(m)) return kind;
  }
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return null;
}

export function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i >= 0 ? fileName.slice(i + 1).toLowerCase() : '';
}

/** Returns an error message, or null when the declared file is acceptable. */
export function validateDeclaredUpload(input: { fileName: string; mimeType: string; sizeBytes: number; kind: AssetKind }): string | null {
  const policy = UPLOAD_POLICY[input.kind];
  if (!policy) return 'Unsupported file kind.';
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) return 'The file is empty.';
  if (input.sizeBytes > policy.maxBytes) {
    return `${input.kind} files must be ${Math.round(policy.maxBytes / MB)} MB or smaller.`;
  }
  const ext = extensionOf(input.fileName);
  const mimeOk = policy.mimeTypes.includes(input.mimeType.toLowerCase());
  const extOk = policy.extensions.includes(ext);
  if (!mimeOk && !extOk) return `This ${input.kind} format is not supported.`;
  return null;
}

/** Storage-safe file name: keeps letters, digits, dot, dash and underscore. */
export function safeFileName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '');
  const trimmed = base.slice(-120);
  return trimmed.length > 0 ? trimmed : 'file';
}

export const storagePaths = {
  upload: (uid: string, assetId: string, fileName: string) => `users/${uid}/uploads/${assetId}/${safeFileName(fileName)}`,
  generatedDir: (uid: string, jobId: string) => `users/${uid}/generated/${jobId}/`,
  derived: (uid: string, assetId: string, name: string) => `users/${uid}/derived/${assetId}/${name}`,
  render: (uid: string, renderId: string, name: string) => `users/${uid}/renders/${renderId}/${name}`,
};

/** Parses `users/{uid}/uploads/{assetId}/{file}` paths. */
export function parseUploadPath(path: string): { uid: string; assetId: string; fileName: string } | null {
  const m = /^users\/([^/]+)\/uploads\/([^/]+)\/([^/]+)$/.exec(path);
  if (!m) return null;
  return { uid: m[1]!, assetId: m[2]!, fileName: m[3]! };
}
