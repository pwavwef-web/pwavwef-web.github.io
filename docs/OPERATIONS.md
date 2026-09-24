# AZ Studio operations

## Deploy

```bash
npm install
npm run deploy                 # lint, typecheck, tests, then renderer + rules + functions + hosting
node scripts/deploy.mjs --skip-checks --only=hosting   # partial deploys
```

`scripts/deploy.mjs` renders the security rules from Secret Manager (`scripts/render-rules.mjs`), writes the web env (`scripts/write-web-env.mjs`), deploys the Cloud Run renderer from source, and runs a **scoped** `firebase deploy --only firestore,storage,functions:az-studio,hosting:studio`.

### One-time IAM the Firebase CLI does not set up

These are already in place for `az-learner`; recreate them if the functions are ever deployed to a new project:

```bash
# Eventarc invokes the upload validator as the runtime service account.
gcloud run services add-iam-policy-binding azsonupload --region=us-central1 --project az-learner \
  --member=serviceAccount:az-studio-api@az-learner.iam.gserviceaccount.com --role=roles/run.invoker
# Firebase CLI 15.30 crashes ("reading 'filter'") when a new task queue has an empty IAM policy;
# seeding the enqueuer binding lets the deploy finish.
gcloud tasks queues add-iam-policy-binding azsJobWorker --location=us-central1 --project az-learner \
  --member=serviceAccount:az-studio-api@az-learner.iam.gserviceaccount.com --role=roles/cloudtasks.enqueuer
```

### Hosting and client updates

SPA routes are served `no-cache` and hashed `/assets/**` are immutable, so every deploy reaches new page loads immediately. A tab left open on an older build reloads itself once when it requests a chunk that no longer exists (`apps/web/src/lib/build-refresh.ts`).

## Owner identity

The owner is configured in Secret Manager — never in source:

```bash
printf '%s' 'NEW_UID'   | gcloud secrets versions add AZ_STUDIO_OWNER_UID   --data-file=- --project az-learner
printf '%s' 'new@mail'  | gcloud secrets versions add AZ_STUDIO_OWNER_EMAIL --data-file=- --project az-learner
node scripts/deploy.mjs --skip-checks --only=rules,functions   # re-render rules and pick up the new secret
```

The API requires the UID **and** the verified email to match. Rules require the UID and a verified email.

## Upgrading a model

Edit `functions/src/config/models.ts` (ID + capabilities) and `functions/src/config/pricing.ts` (published prices, source, date), run `npm run check`, deploy functions. No client change is needed: capabilities reach the UI through `bootstrap`.

Settings → Models probes every role live (`modelStatus`, cached 6 h in `runtime/modelStatus`). Status on 2026-09-24 for project `az-learner`:

- `lyria-3.5`: Vertex AI answers `400 Unsupported model interaction: lyria-3.5` (the publisher model is not found for the project in `global` or `us-central1`). Song and score generation fail fast with this limitation; nothing is billed and no older Lyria model is used. When Google enables it for the project, the existing jobs work unchanged.
- `gemini-omni-1.1-flash` is served as `gemini-omni-1.1-flash-preview`; `gemini-3.5-transcribe` (GA ID) and `gemini-3.5-flash-tts` return 404 for the project, so `gemini-3.5-transcribe-preview` and `gemini-2.5-pro-tts` are used.

## Cost controls

Settings → daily/monthly limits, confirmation threshold, concurrent generations, batch size. Limits are enforced server-side on submission (projected spend = recorded usage + running estimates + new estimate). Estimates use Google’s published list prices; invoices come from Cloud Billing.

Quality control (per project, Quality tab): at most 3 automatic repairs per production, a repair cost ceiling (default $6 per production, counting everything the production has spent), and director approval for any single retry above $1.50. When a limit is reached the production stops in “Awaiting repair approval” or “Failed quality review” with the reason, the report and the best version so far.

## Emulators & tests

```bash
npm test                   # unit tests (shared, functions, renderer with a real FFmpeg render, web)
npm run test:integration   # auth/firestore/storage/functions/tasks emulators; rules + API tests
AZS_ACCEPTANCE=1 npm run test:acceptance   # live acceptance suite (billable, ≈ $3 per full run at 360p)
```

The acceptance suite (`tests/acceptance`) runs the same server code as the API with your Application Default Credentials; Cloud Tasks deliver the work to the deployed worker. Each run creates `QA · …` projects in the studio (delete them from the Projects page when done) and writes logs and production records to `tests/acceptance/.results/`. On a busy workstation, set `FUNCTIONS_DISCOVERY_TIMEOUT=90` for `test:integration` (the deploy script sets 120 s itself).

## Security notes

- App Check is enforced on the callable API (reCAPTCHA Enterprise). Project-wide App Check enforcement for Firestore/Storage is intentionally **not** enabled because it would affect the other apps in this project; owner-only rules protect the data.
- No Identity Platform blocking function is used: it would apply to every app sharing the project’s Auth. Non-owners can authenticate but are denied by the API and rules.
- The media bucket enforces public access prevention; the browser receives only 2-hour V4 signed URLs.

## Known log noise

- `MaxListenersExceededWarning … PassThrough` in function logs comes from `@google-cloud/storage` 8.2.0 streaming reads on Node 24 (each read stream carries 11 listeners). It is per stream, not a leak.
- The first render after a renderer deploy spends ~2–3 minutes starting the container (image pull) before FFmpeg runs; the render itself takes seconds for short timelines.
