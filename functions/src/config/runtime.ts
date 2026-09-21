import { defineSecret } from 'firebase-functions/params';

/** Runtime configuration. Resource names are fixed for this deployment and overridable for emulators. */
export const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true';
export const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'az-learner';

/** All AZ Studio compute runs in us-central1 (Omni cannot edit uploaded video for EEA/UK/CH traffic). */
export const REGION = 'us-central1';
export const FIRESTORE_DATABASE = process.env.AZS_FIRESTORE_DATABASE || 'az-studio';
export const MEDIA_BUCKET = process.env.AZS_MEDIA_BUCKET || 'az-studio-media-az-learner';
/** Expanded by Firebase to az-studio-api@<project>.iam.gserviceaccount.com. */
export const RUNTIME_SERVICE_ACCOUNT = 'az-studio-api@';
export const RUNTIME_SERVICE_ACCOUNT_EMAIL = `az-studio-api@${PROJECT_ID}.iam.gserviceaccount.com`;
export const RENDER_JOB_NAME = process.env.AZS_RENDER_JOB || 'az-studio-renderer';
export const WORKER_FUNCTION = 'azsJobWorker';

export const ALLOWED_ORIGINS: (string | RegExp)[] = [
  'https://az-studio.web.app',
  'https://az-studio.firebaseapp.com',
  /^http:\/\/(localhost|127\.0\.0\.1):\d+$/,
];

/** Owner identity lives in Secret Manager (see docs/OPERATIONS.md). */
export const OWNER_UID = defineSecret('AZ_STUDIO_OWNER_UID');
export const OWNER_EMAIL = defineSecret('AZ_STUDIO_OWNER_EMAIL');

/** Signed media URLs expire after this many seconds. */
export const SIGNED_URL_TTL_SECONDS = 2 * 60 * 60;

/** Omni polling cadence. */
export const OMNI_POLL = { firstDelaySec: 20, intervalSec: 15, slowIntervalSec: 30, slowAfterPolls: 12, maxWaitMinutes: 45 };
