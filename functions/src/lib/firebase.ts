import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { FIRESTORE_DATABASE, MEDIA_BUCKET } from '../config/runtime';

const app = getApps()[0] ?? initializeApp();

/** The dedicated `az-studio` Firestore database (the project's default database is not used). */
export const db = getFirestore(app, FIRESTORE_DATABASE);
db.settings({ ignoreUndefinedProperties: true });

/** Private media bucket (uniform access, public access prevention enforced). */
export const bucket = getStorage(app).bucket(MEDIA_BUCKET);

export { FieldValue, Timestamp };

export const col = {
  users: () => db.collection('users'),
  projects: () => db.collection('projects'),
  jobs: () => db.collection('jobs'),
  batches: () => db.collection('batches'),
  assets: () => db.collection('assets'),
  chains: () => db.collection('chains'),
  renders: () => db.collection('renders'),
  timelines: (projectId: string) => db.collection('projects').doc(projectId).collection('timelines'),
  usage: () => db.collection('usage'),
  usageDaily: () => db.collection('usageDaily'),
  usageMonthly: () => db.collection('usageMonthly'),
  interactions: () => db.collection('interactions'),
  aiRuns: () => db.collection('aiRuns'),
  runtime: () => db.collection('runtime'),
  productions: () => db.collection('productions'),
  songs: (projectId: string) => db.collection('projects').doc(projectId).collection('songs'),
  scores: (projectId: string) => db.collection('projects').doc(projectId).collection('scores'),
};

export const gsUri = (path: string) => `gs://${bucket.name}/${path}`;

/** Converts a `gs://bucket/path` URI into an object path within the media bucket. */
export function pathFromGsUri(uri: string): string | null {
  const prefix = `gs://${bucket.name}/`;
  return uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
}
