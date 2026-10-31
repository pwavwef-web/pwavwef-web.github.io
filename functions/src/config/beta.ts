import { FIRESTORE_DATABASE, MEDIA_BUCKET, PROJECT_ID } from './runtime';

/**
 * Where the public beta's data lives. The plan (docs/PUBLIC_PRODUCT_PREP.md §1) prefers a separate Firebase project for
 * members; these settings let the same code run either way:
 *
 * - **Same project (default).** Nothing set: member data goes to this deployment's database and bucket under
 *   `members/…`, `invites/…`, `betaFeedback/…`, which no client rule exposes.
 * - **Separate project.** Deploy `azsMember` / `azsMemberWorker` into the members' project (its own Auth, quotas and
 *   billing), and give the studio's deployment `AZS_BETA_PROJECT` / `AZS_BETA_DATABASE` / `AZS_BETA_BUCKET` so the
 *   owner's Beta page creates invitations and reads usage there (the studio's service account needs
 *   `roles/datastore.user` on that project). docs/OPERATIONS.md → Public beta has the steps.
 */
export const BETA_PROJECT = process.env.AZS_BETA_PROJECT || PROJECT_ID;
export const BETA_DATABASE = process.env.AZS_BETA_DATABASE || FIRESTORE_DATABASE;
export const BETA_BUCKET = process.env.AZS_BETA_BUCKET || MEDIA_BUCKET;
export const BETA_IS_SEPARATE = BETA_PROJECT !== PROJECT_ID || BETA_DATABASE !== FIRESTORE_DATABASE || BETA_BUCKET !== MEDIA_BUCKET;

/** Deployment kill switch: `AZS_FEATURE_BETA=off` turns the beta off whatever the feature flag says. */
export const BETA_ENV_OFF = () => (process.env.AZS_FEATURE_BETA ?? '').toLowerCase() === 'off';

/** Cloud Tasks queue (function) that voices members' editions. */
export const MEMBER_WORKER_FUNCTION = 'azsMemberWorker';
