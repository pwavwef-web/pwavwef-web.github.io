# AZ Studio operations

## Deploy

```bash
npm install
npm run deploy                 # lint, typecheck, tests, then renderer + rules + functions + hosting
node scripts/deploy.mjs --skip-checks --only=hosting   # partial deploys
```

`scripts/deploy.mjs` renders the security rules from Secret Manager (`scripts/render-rules.mjs`), writes the web env (`scripts/write-web-env.mjs`), deploys the Cloud Run jobs from source (`az-studio-renderer`, and `az-studio-stems` for stem separation), and runs a **scoped** `firebase deploy --only firestore,storage,functions:az-studio,hosting:studio`. Targets: `--only=renderer,stems,rules,functions,hosting` (any subset).

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

## Lyria 3.5 (music) — server-side key

**Status (2026-09-26): configured.** `AZ_STUDIO_GEMINI_API_KEY` exists (created 2026-09-25, readable only by `az-studio-api`); live jobs generated complete songs and film-score movements. The steps below are for rotating or re-creating it.

Vertex AI does not serve `lyria-3.5` to `az-learner` (it answers `400 Unsupported model interaction`). The Gemini Developer API does, so music generation uses it **server-side** with a key kept in Secret Manager. Without the key, song, cue and section generation fail fast with the exact limitation (nothing is billed, no older model is used); uploads, recording, analysis, arrangement, stems and mixing keep working.

```bash
# 1. Create an API key in the az-learner project (APIs & Services → Credentials), restricted to the
#    "Generative Language API", with no application restriction (it is used only by Cloud Functions).
# 2. Store it and let the functions' runtime service account read it:
printf '%s' 'THE_KEY' | gcloud secrets create AZ_STUDIO_GEMINI_API_KEY --data-file=- --project az-learner
gcloud secrets add-iam-policy-binding AZ_STUDIO_GEMINI_API_KEY --project az-learner \
  --member=serviceAccount:az-studio-api@az-learner.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
```

The key is read at run time (no redeploy needed) and never reaches the browser. Settings → Models shows which surface serves Lyria 3.5; Vertex AI is re-checked every 6 hours and used as soon as Google enables it for the project.

## Stem separation job

`az-studio-stems` (Cloud Run job, `services/stems`, Demucs `htdemucs` on CPU, model weights baked into the image) separates vocals, drums, bass and other. The worker starts an execution per request, polls it, stores each stem as an audio asset and adds it to the music project's mixer. Deployed with `node scripts/deploy.mjs --only=stems`; the first execution after a deploy pulls a ~2 GB image. It runs on 4 vCPU / 16 GiB; the estimate assumes ≈ 1.6 s of compute per second of audio plus 2 minutes of start-up at Cloud Run list prices (≈ $0.04 for a 3-minute song), shown before confirmation; the real execution time is recorded after.

## Upgrading a model

Edit `functions/src/config/models.ts` (ID + capabilities) and `functions/src/config/pricing.ts` (published prices, source, date), run `npm run check`, deploy functions. No client change is needed: capabilities reach the UI through `bootstrap`.

Settings → Models probes every role live (`modelStatus`, cached 6 h in `runtime/modelStatus`). Status on 2026-09-24 for project `az-learner`:

- `lyria-3.5`: Vertex AI answers `400 Unsupported model interaction: lyria-3.5` (the publisher model is not found for the project in `global` or `us-central1`). Music is generated with the same model on the Gemini Developer API with `AZ_STUDIO_GEMINI_API_KEY` (configured since 2026-09-25, above); without the key, song, cue and section generation fail fast with this limitation — nothing is billed and no older Lyria model is used. When Google enables it on Vertex AI for the project, the existing jobs switch to it unchanged.
- `gemini-omni-1.1-flash` is served as `gemini-omni-1.1-flash-preview`; `gemini-3.5-transcribe` (GA ID) and `gemini-3.5-flash-tts` return 404 for the project, so `gemini-3.5-transcribe-preview` and `gemini-2.5-pro-tts` are used.

## Cost controls

Settings → daily/monthly limits, confirmation threshold, concurrent generations, batch size. Limits are enforced server-side on submission (projected spend = recorded usage + running estimates + new estimate). Estimates use Google’s published list prices; invoices come from Cloud Billing.

Per project (header → settings): **Draft / Final** generation quality (Draft generates new shots at the lowest resolution), a **project budget** with a warning threshold (enforced server-side before submission, shown in every cost confirmation with what remains), the advanced continuity workspaces toggle and **Cancel queued** (queued jobs and unstarted productions stop with no charge). Every cost confirmation lists the video generations, images, music requests, renders, inspections, processing jobs and reference images of the batch.

Quality control (per project, Quality tab): at most 3 automatic repairs per production, a repair cost ceiling (default $6 per production, counting everything the production has spent), and director approval for any single retry above $1.50. When a limit is reached the production stops in “Awaiting repair approval” or “Failed quality review” with the reason, the report and the best version so far.

## Emulators & tests

```bash
npm test                   # unit tests (shared, functions, renderer with a real FFmpeg render, web)
npm run test:integration   # auth/firestore/storage/functions/tasks emulators; rules + API tests
AZS_ACCEPTANCE=1 npm run test:acceptance   # live acceptance suite (billable, ≈ $3 per full run at 360p)
```

The acceptance suite (`tests/acceptance`) runs the same server code as the API with your Application Default Credentials; Cloud Tasks deliver the work to the deployed worker. Each run creates `QA · …` projects in the studio (delete them from the Projects page when done) and writes logs and production records to `tests/acceptance/.results/`. On a busy workstation the Functions emulator can exceed the CLI's 10 s discovery timeout (every API test then fails with `Cannot determine backend specification`): run `test:integration` and `test:e2e` with `FUNCTIONS_DISCOVERY_TIMEOUT=120` (the deploy script sets it itself).

## Export gate

Final renders (and any render requested with inspection) are inspected automatically when the render finishes (`final.inspect`: FFmpeg measurements, transcription, OCR, the reviewer). A download of such a render is refused by the API (`mediaUrls` with `download`) until its inspection is **ready** or **overridden** with a recorded note; playback for review is always allowed. Automatic fixes change the timeline (or, for styled lyrics, the song's lyric style for that aspect ratio) and mark the inspection `needsRerender` — the next render is inspected again to verify them. `azsMaintenance` starts inspections that were missed (e.g. a deploy during a render).

What counts as a fault: black stretches (reported once — the frozen-picture check skips spans that are black), frozen pictures, sample peaks at the limiter, and sudden loud peaks — momentary loudness of at least −12 LUFS that is 10 LU above what played in the five seconds before (an error at −5 LUFS or +18 LU). A line spoken louder than the rest of a quiet mix is dynamics, not a fault. Black after the last picture offers holding the last shot when its source runs longer.

## Security notes

- App Check is enforced on the callable API (reCAPTCHA Enterprise). Project-wide App Check enforcement for Firestore/Storage is intentionally **not** enabled because it would affect the other apps in this project; owner-only rules protect the data.
- No Identity Platform blocking function is used: it would apply to every app sharing the project’s Auth. Non-owners can authenticate but are denied by the API and rules.
- The media bucket enforces public access prevention; the browser receives only 2-hour V4 signed URLs.

## Known log noise

- `MaxListenersExceededWarning … PassThrough` in function logs comes from `@google-cloud/storage` 8.2.0 streaming reads on Node 24 (each read stream carries 11 listeners). It is per stream, not a leak.
- The first render after a renderer deploy spends ~2–3 minutes starting the container (image pull) before FFmpeg runs; the render itself takes seconds for short timelines.
