import { bucket, db } from './firebase';

/**
 * Pwavwe Narrator documents and private media. Every document carries `ownerUid`; the API checks it on
 * every read and write, and the security rules let only the owner read (clients never write directly).
 * Media lives under users/{uid}/narrator/ in the private bucket and is served only through short-lived
 * signed URLs issued after the same ownership check.
 */
export const ncol = {
  voices: () => db.collection('narratorVoices'),
  /** Provider identifiers — server-only (no client rule matches this subcollection). */
  voicePrivate: (voiceId: string) => db.collection('narratorVoices').doc(voiceId).collection('private').doc('provider'),
  tests: (voiceId: string) => db.collection('narratorVoices').doc(voiceId).collection('tests'),
  recordings: () => db.collection('narratorRecordings'),
  editions: () => db.collection('narratorEditions'),
  clips: (editionId: string) => db.collection('narratorEditions').doc(editionId).collection('clips'),
  exports: (editionId: string) => db.collection('narratorEditions').doc(editionId).collection('exports'),
  profiles: () => db.collection('narratorProfiles'),
  /** Hosted-player publications, keyed by the stable public id (owner-readable; served publicly only through publicView). */
  publications: () => db.collection('narratorPublications'),
  /** Status cache and locks (never client-readable). */
  runtime: (key: string) => db.collection('runtime').doc(`narrator-${key}`),
};

export const npath = {
  root: (uid: string) => `users/${uid}/narrator/`,
  recording: (uid: string, recordingId: string) => `users/${uid}/narrator/recordings/${recordingId}.wav`,
  test: (uid: string, voiceId: string, testId: string) => `users/${uid}/narrator/voices/${voiceId}/tests/${testId}.wav`,
  chunkDir: (uid: string, jobId: string) => `users/${uid}/narrator/chunks/${jobId}/`,
  chunk: (uid: string, jobId: string, key: string, i: number) => `users/${uid}/narrator/chunks/${jobId}/${key}-${i}.wav`,
  editionDir: (uid: string, editionId: string) => `users/${uid}/narrator/editions/${editionId}/`,
  clip: (uid: string, editionId: string, clipId: string) => `users/${uid}/narrator/editions/${editionId}/clips/${clipId}.wav`,
  exportFile: (uid: string, editionId: string, exportId: string, name: string) => `users/${uid}/narrator/editions/${editionId}/exports/${exportId}/${name}`,
  /** Published listening copies (MP3 only), one object per revision; outside users/ and never client-readable. */
  publicAudio: (publicId: string, revision: number) => `narrator-public/${publicId}/r${revision}.mp3`,
};

/** Media I/O (kept behind this module so worker tests can use an in-memory store). */
export const media = {
  async save(path: string, data: Buffer | Uint8Array, contentType: string): Promise<void> {
    await bucket.file(path).save(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { resumable: false, contentType, metadata: { cacheControl: 'private, max-age=0, no-store' } } as never);
  },
  async read(path: string): Promise<Buffer> {
    const [buf] = await bucket.file(path).download();
    return buf;
  },
  async remove(path: string): Promise<void> {
    try {
      await bucket.file(path).delete();
    } catch (e) {
      if ((e as { code?: number }).code !== 404) throw e;
    }
  },
  async copy(from: string, to: string, meta: { contentType: string; cacheControl: string }): Promise<number> {
    await bucket.file(from).copy(bucket.file(to));
    await bucket.file(to).setMetadata({ contentType: meta.contentType, cacheControl: meta.cacheControl, contentDisposition: 'inline' });
    const [m] = await bucket.file(to).getMetadata();
    return Number(m.size ?? 0);
  },
  async size(path: string): Promise<number | null> {
    try {
      const [m] = await bucket.file(path).getMetadata();
      return Number(m.size ?? 0);
    } catch (e) {
      if ((e as { code?: number }).code === 404) return null;
      throw e;
    }
  },
  stream(path: string, range?: { start: number; end: number }): NodeJS.ReadableStream {
    return bucket.file(path).createReadStream(range ? { start: range.start, end: range.end } : {});
  },
  /** Inbox uploads older than `olderThanMs` (left behind when a browser never finished the request). */
  async staleInbox(olderThanMs: number): Promise<string[]> {
    const [files] = await (bucket as unknown as { getFiles: (o: { matchGlob: string }) => Promise<[{ name: string; metadata: { timeCreated?: string } }[]]> }).getFiles({ matchGlob: 'users/*/narrator-inbox/*' });
    return files.filter((f) => Date.now() - Date.parse(f.metadata.timeCreated ?? '') > olderThanMs).map((f) => f.name);
  },
  async removePrefix(prefix: string): Promise<void> {
    await (bucket as unknown as { deleteFiles: (o: { prefix: string; force: boolean }) => Promise<void> }).deleteFiles({ prefix, force: true });
  },
};
