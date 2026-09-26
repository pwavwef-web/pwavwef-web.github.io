import { getApps, initializeApp } from 'firebase-admin/app';

// The acceptance suite drives the same server code the callable API runs (after its owner check),
// against the live project, with the developer's Application Default Credentials. Nothing here
// mints or stores tokens; Cloud Tasks deliver the work to the deployed worker.
if (process.env.AZS_ACCEPTANCE !== '1') throw new Error('Acceptance tests create real, billable generations. Run them with AZS_ACCEPTANCE=1.');

const PROJECT = process.env.AZS_PROJECT ?? 'az-learner';
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
// Bill the developer credentials' API calls (e.g. Cloud Vision in the checks) to the studio project, whatever
// quota project the local ADC file names.
process.env.GOOGLE_CLOUD_QUOTA_PROJECT = PROJECT;
if (!getApps().length) {
  // Tasks are enqueued with an OIDC token for the runtime service account, exactly as the API does.
  initializeApp({ projectId: PROJECT, serviceAccountId: `az-studio-api@${PROJECT}.iam.gserviceaccount.com` });
}
