# AZ Studio operations

## Deploy

```bash
npm install
node scripts/release.mjs --deploy                      # tag the clean HEAD as studio-vYYYY.MM.DD.N, then deploy it
node scripts/release.mjs --deploy --only=hosting       # partial deploys (any subset of renderer,stems,rules,functions,hosting)
npm run deploy                                         # deploy HEAD when it is already tagged
```

**Release train.** `scripts/deploy.mjs` deploys only a clean, tagged commit (`studio-v…`, annotated, made by `scripts/release.mjs`); untracked client production folders and `exports/` are ignored. The tag and short commit are stamped into the web build (`VITE_AZS_RELEASE`), the functions (`functions/.env.<project>`, `AZS_RELEASE`, gitignored) and the renderer and stems jobs' environment; Settings → Release shows the page's and the server's release, and a tab running an older release gets a reload banner.

**Checks on every push.** `.github/workflows/check.yml` runs `npm run check` (lint, types, unit tests, builds; FFmpeg and fonts installed for the renderer tests) on every push and pull request. The deploy reads that run for the commit with `gh`: a red or unfinished run refuses the deploy; when no run is known (commit not pushed, or `gh` not signed in) the deploy runs lint, typecheck and tests itself (`--skip-checks` skips only this local fallback).

**Safe by construction.** The rules are re-rendered from Secret Manager and verified on every deploy (`render-rules.mjs --verify`: no test owner, no placeholder, the production owner present), and `firebase.json` runs the same verification before *any* Firestore or Storage rules deploy, so a direct `firebase deploy` after an emulator run (which leaves `owner-test-uid` rules behind) is refused. The idempotent network steps — the Cloud Run job deploys, their IAM bindings and `firebase deploy` — are retried up to three times with a growing pause, because this network often drops them half way.

`scripts/deploy.mjs` renders the security rules from Secret Manager (`scripts/render-rules.mjs`), writes the web env (`scripts/write-web-env.mjs`), deploys the Cloud Run jobs from source (`az-studio-renderer`, and `az-studio-stems` for stem separation), and runs a **scoped** `firebase deploy --only firestore,storage,functions:az-studio,hosting:studio`. Targets: `--only=renderer,stems,rules,functions,hosting` (any subset).

### One-time IAM the Firebase CLI does not set up

These are already in place for `az-learner`; recreate them if the functions are ever deployed to a new project:

```bash
# Eventarc invokes the upload validator and automatic Bible covers as the runtime service account.
gcloud run services add-iam-policy-binding azsonupload --region=us-central1 --project az-learner \
  --member=serviceAccount:az-studio-api@az-learner.iam.gserviceaccount.com --role=roles/run.invoker
gcloud run services add-iam-policy-binding azsonbiblecharacter --region=us-central1 --project az-learner \
  --member=serviceAccount:az-studio-api@az-learner.iam.gserviceaccount.com --role=roles/run.invoker
# Firebase CLI 15.30 crashes ("reading 'filter'") when a new task queue has an empty IAM policy;
# seeding the enqueuer binding lets the deploy finish.
gcloud tasks queues add-iam-policy-binding azsJobWorker --location=us-central1 --project az-learner \
  --member=serviceAccount:az-studio-api@az-learner.iam.gserviceaccount.com --role=roles/cloudtasks.enqueuer
```

### Hosting and client updates

SPA routes are served `no-cache` and hashed `/assets/**` are immutable, so every deploy reaches new page loads immediately. A tab left open on an older build reloads itself once when it requests a chunk that no longer exists (`apps/web/src/lib/build-refresh.ts`).

## Public website

The public pages, the early-access list (Settings → Early access to view, export, delete or pause) and the rollback steps are in [`PUBLIC_SITE.md`](PUBLIC_SITE.md). The studio dashboard is at `/studio`.

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

## Model health (daily canary)

`azsCanary` runs every day at 06:30 (Africa/Accra): a JSON answer from the reasoning model, one spoken sentence and its transcript (≈ $0.002 in total, recorded in the ledger as studio checks), the Lyria route (Vertex AI's refusal must still be *recognised* so music jobs take the Developer API — the 13 Oct failure — and the Developer API must list the model), the Narrator model, and availability listings for video and image (a real probe would cost cents). Each probe keeps a signature (response shape, or error class plus normalised wording); any difference from the previous day's run is stored in `runtime/canary` (copies per day under `runtime/canary/runs`) and shown as a studio-wide banner until acknowledged in Settings → Model health, where the check can also be run on demand.

## Cost controls

Settings → daily/monthly limits, confirmation threshold, concurrent generations, batch size. Limits are enforced server-side on submission (projected spend = recorded usage + running estimates + new estimate). Estimates use Google’s published list prices; invoices come from Cloud Billing.

**Model budgets** (Settings): a monthly budget per model role (reasoning, video, image, speech, transcription, music, narration; 0 = none). The worker checks it before a job starts (`JOB_ROLES` in `packages/shared/src/role-budgets.ts` lists the roles each job type spends on) and fails the job with the reason, before any request is sent; other roles keep working. **Spend by task** (Settings) groups this month's usage by model and job type and prices the reasoning calls at Gemini 4 Argon's standard rate, which applies from 1 December 2026 (input $4 and output $20 per 1M tokens, double the introductory rate); `PRICING.text` is evaluated per call, so a function instance started in November prices December calls correctly.

Per project (header → settings): **Draft / Final** generation quality (Draft generates new shots at the lowest resolution), a **project budget** with a warning threshold (enforced server-side before submission, shown in every cost confirmation with what remains), the advanced continuity workspaces toggle and **Cancel queued** (queued jobs and unstarted productions stop with no charge). Every cost confirmation lists the video generations, images, music requests, renders, inspections, processing jobs and reference images of the batch.

Quality control (per project, Quality tab): at most 3 automatic repairs per production, a repair cost ceiling (default $6 per production, counting everything the production has spent), and director approval for any single retry above $1.50. When a limit is reached the production stops in “Awaiting repair approval” or “Failed quality review” with the reason, the report and the best version so far.

Generation retries (Settings): attempts for temporary failures, the first and longest wait between attempts, the longest Retry-After to honour, failed status checks before an accepted job pauses as resumable, how long to keep checking an accepted job, one automatic rewrite of a blocked prompt and one repaired resubmission of an invalid configuration (each can be switched off). A banner there lists active provider pauses (access, billing or exhausted quota) with their reason and when they lift; resolve the cause, then resume.

## Emulators & tests

```bash
npm test                   # unit tests (shared, functions, renderer with a real FFmpeg render, web)
npm run test:integration   # auth/firestore/storage/functions/tasks emulators; rules + API tests
AZS_ACCEPTANCE=1 npm run test:acceptance   # live acceptance suite (billable, ≈ $3 per full run at 360p)
```

The acceptance suite (`tests/acceptance`) runs the same server code as the API with your Application Default Credentials; Cloud Tasks deliver the work to the deployed worker. Each run creates `QA · …` projects in the studio (delete them from the Projects page when done) and writes logs and production records to `tests/acceptance/.results/`. On a busy workstation the Functions emulator can exceed the CLI's 10 s discovery timeout (every API test then fails with `Cannot determine backend specification`): run `test:integration` and `test:e2e` with `FUNCTIONS_DISCOVERY_TIMEOUT=120` (the deploy script sets it itself).

## Film Studio Lite

- The renderer must be redeployed (`node scripts/deploy.mjs --only=renderer`) before Lite exports run on Cloud Run: earlier renderer images ignore camera moves and treatments. Functions (new `lite.narration` and `audio.ambience` jobs, the `liteGenerate` / `liteCancel` API) and rules (`film_lite` projects) deploy with the usual scoped deploy.
- In the emulators, renders run the same renderer program locally (`services/renderer/dist/main.js`, built by `test:e2e`); paid providers are not reachable there, so `tests/e2e/lite.e2e.test.ts` writes the narration timing a transcription would return as a stand-in.
- Recording booth: no new job type or index; deploy functions (the `liteBooth` action) and hosting. Takes need a microphone over https (or localhost); the Hosting Permissions-Policy already allows `microphone=(self)`. Joining runs in `azsApi` (1 GiB) and decodes each picked take whole, which is fine for sentence-length takes (≤ 90 s each, ≤ 120 lines).
- `AZS_ACCEPTANCE=1 npm run test:acceptance -- 12-film-lite` runs Film Studio Lite against the live providers in-process (one image, three narrated scenes, one score movement, ambience; capped at $1.50, about $0.25), renders locally against the live project and runs the final inspection. Rerunning with the same `AZS_ACCEPTANCE_RUN` resumes the film without repeating paid requests. Outputs land in `exports/film-studio-lite-verification/`.

## Music Video Lite

- Deploy functions (the `mvliteGenerate` / `mvliteCancel` API, the `mvlite.concept` / `mvlite.shots` tasks), rules (`mv_lite` projects) and hosting. The renderer needs no change beyond the one Film Studio Lite already requires.
- `tests/e2e/mvlite.e2e.test.ts` drives the workspace in a real browser against the emulators with a synthetic song (beats detected in the browser), writes the lyric timing a synchronisation would return as a stand-in, and renders a draft locally.
- `AZS_ACCEPTANCE=1 npm run test:acceptance -- 14-mv-lite` runs it against the live providers in-process on a QA copy of a real song (beat analysis, lyric synchronisation compared with a corrected sheet, concept, shot plan, up to five images, styled lyrics; capped at $1.50), renders locally and runs the final inspection. Outputs land in `exports/music-video-lite-verification/`.

## Link to Ad

Owner-only; see [`LINK_TO_AD.md`](LINK_TO_AD.md). Operating notes:

* **Switch off / on.** Firestore `runtime/features` → `{ linkAd: { enabled: false } }` hides it from every call at once (existing ads stay stored); or deploy with env `AZS_FEATURE_LINK_AD=off`. Quotas live in the same field (`linkAd.quotas`).
* **Firecrawl (optional).** `printf '%s' "$KEY" | gcloud secrets create AZ_STUDIO_FIRECRAWL_API_KEY --data-file=- --project az-learner` and grant `roles/secretmanager.secretAccessor` on it to `az-studio-api@az-learner.iam.gserviceaccount.com`. It is used only for pages the built-in reader finds empty. Without it those pages are reported as unreadable.
* **Spend.** Each ad has its own cap (default $1, hard maximum from the entitlement); the voice (`gemini-2.5-pro-tts`) and word timing (`gemini-3.5-transcribe-preview`) are the only paid steps besides two text calls; render compute is billed by Cloud Run. The renderer image is unchanged by this feature.
* **Live check without writes.** `AZS_ACCEPTANCE=1 node --dns-result-order=ipv6first scripts/production/run.mjs scripts/production/link-ad/live-check.ts https://example.com/` reads a real page and asks the real planner for a brief and directions (two text calls; nothing is written, no audio/image/video).
* **Custom domain.** `azlearner.me` is attached to the Hosting site `az-studio` (certificate active, DNS matched). For the *studio* to sign in and call the API from it, five allow-lists include it (all done 2026-10-25): Firebase Auth authorized domains, the callable CORS list (`ALLOWED_ORIGINS`, in code), the web API key's referrers (`AZ Studio Web (restricted)`), the App Check reCAPTCHA key's allowed domains, and the media bucket's CORS origins. Canonical links on the public pages still use `az-studio.web.app` (`SITE_ORIGIN`); switching them is a separate decision. `www.azlearner.me` is not attached.

## Pwavwe Narrator

- Deploy functions (the `narrator` API action and the `narrator.voice` / `narrator.speak` / `narrator.export` jobs), rules (owner-read narrator collections) and hosting. No renderer or index change is needed (lists are sorted in the browser).
- Provider access uses the existing `AZ_STUDIO_GEMINI_API_KEY`. Checked 2026-10-17 from `az-learner`: both 3.8 TTS models answer `models.get`, `voices.list?type=replicated` answers (no voices), a create without audio is refused with "Missing source_audio.", and two synthesis probes with a prebuilt voice (≈ $0.001) returned 24 kHz mono 16-bit WAV. **No replicated voice has been created yet** — that needs Francis's own reference and consent recordings. Narrator → Settings → Provider re-checks access live.
- Pricing (paid tier): Flash TTS $0.50 / 1M text tokens in and $9.00 / 1M audio tokens out through 31 Dec 2026, doubling on 1 Jan 2027 (Flash-Lite $6 out); 25 audio tokens per second. Voice creation has no listed price, so it is shown as unavailable.
- Hosted player: deploy functions (new public `azsPublic`, invoked unauthenticated through the Hosting rewrite `/api/public/**`), rules and hosting. Withdrawal window: unpublish stops the public audio immediately (objects deleted) and the metadata within about a minute (browser 30 s, CDN 60 s); a replaced revision is served for 15 minutes to listeners already playing it. Downloaded copies cannot be revoked. Allowed embedding origins live in `PUBLICATION_ORIGINS` and firebase.json (`/embed/**` CSP `frame-ancestors`); change both together. The Hosting emulator applies only the first matching header block, unlike production, so verify header changes on the deployed site.
- Blogger: AZ Studio has no Blogger access, so post markup is always pasted by hand in the HTML view; check that it survives saving and plays in the published post. The player's look is served from Hosting and changes for every post on deploy, but the box height, the `?theme=` choice and the fallback link under the player belong to the pasted markup — posts embedded before a markup change keep the old surround until the block is replaced. `docs/narrator-player-embed.md` holds the current block for the live posts and the optional theme-sync snippet for Theme → Edit HTML.
- Publications (Narrator → Publications) fetches each published paper's live post on blogs.pwavwe.com (read-only, at most 6 checks a minute) and compares its player block with today's markup. It never changes a post: "Copy current markup" puts the block on the clipboard to paste by hand.
- Auto-direct: a `narrator.direct` job uses the reasoning model only (≈ $0.01–0.02 for an 18-paragraph paper, measured 2026-10-18); it never synthesises audio.
- Tests: `functions/test/narrator.test.ts` and `narrator-provider.test.ts` use a **mocked** provider (no Google calls) and the real FFmpeg export; `packages/shared/test/narrator.test.ts` covers text, chunking, invalidation, audio checks, SoundCloud/Blogger and extraction. Set `AZS_NARRATOR_LIVE=1` in the functions emulator environment only when you intend live, billable provider calls.

## Public beta (switched off)

Built and deployable in this project with nothing exposed: `runtime/features` has no `beta` field, so `azsMember` refuses every call and `/app` says the beta is not open. Creating invitations, choosing invitees, switching it on and creating a separate project are the owner's decisions.

* **Switch on / off.** Firestore `runtime/features` → `{ beta: { enabled: true, limits: { … } } }` (limits optional, clamped to hard maxima: `dailyChars`, `dailyMinutes`, `maxEditionChars`, `maxEditions`, `jobCeilingUsd`, `globalDailyUsd`, `inviteCredits`, `inviteDays`). `enabled: false` (or deploying with env `AZS_FEATURE_BETA=off`) refuses every member call at once; a running job stops before its next voice request and its unspent credits are released.
* **Invite.** Studio → Beta (`/studio/beta`): tick early-access entries, choose the wave, create. Copy each code to its person yourself (AZ Studio sends no email). Revoke invitations or members there; +100 credits per click.
* **Deploy in this project.** Functions (`azsMember`, `azsMemberWorker` — a new task queue: seed its enqueuer binding like `azsJobWorker`'s, see above —, the `beta` action), rules (explicit denies for `members`, `invites`, `betaFeedback` and `members/**` in the bucket) and hosting (`/app`, `/app/**` → `app.html`). No index is needed.
* **Separate project (preferred by the plan).** Create the project with its own Auth (Google sign-in), Firestore database, bucket, App Check key, `AZ_STUDIO_GEMINI_API_KEY`, `AZ_STUDIO_OWNER_UID/EMAIL` secrets and billing budget; deploy only `functions:az-studio:azsMember,functions:az-studio:azsMemberWorker` there; build the web app with `VITE_MEMBER_FIREBASE_API_KEY/AUTH_DOMAIN/PROJECT_ID/APP_ID/MESSAGING_SENDER_ID` and `VITE_MEMBER_RECAPTCHA_ENTERPRISE_SITE_KEY`; give the studio's functions `AZS_BETA_PROJECT`, `AZS_BETA_DATABASE`, `AZS_BETA_BUCKET` and grant `az-studio-api@az-learner` `roles/datastore.user` on the new project so the Beta page writes invitations there. Add the new project's auth domain to the studio CSP `frame-src` (sign-in popup) and its functions origin is already covered by `*.cloudfunctions.net`.
* **Tests.** `functions/test/beta-booth.test.ts` (gate, invitations, allowances, worker with a mocked provider, booth, publication health) and `tests/beta-rules.int.test.ts` (emulators; deny-by-default).

## Export gate

Final renders (and any render requested with inspection) are inspected automatically when the render finishes (`final.inspect`: FFmpeg measurements, transcription, OCR, the reviewer, and the fact check against the project's approved facts — add prices, phone numbers, dates and links under Short Ads → Brief → Approved facts; a Link to Ad uses its confirmed facts). The reviewer's logo, private-information and cropped-text findings only block when OCR confirms them. A download of such a render is refused by the API (`mediaUrls` with `download`) until its inspection is **ready** or **overridden** with a recorded note; playback for review is always allowed. Automatic fixes change the timeline (or, for styled lyrics, the song's lyric style for that aspect ratio) and mark the inspection `needsRerender` — the next render is inspected again to verify them. `azsMaintenance` starts inspections that were missed (e.g. a deploy during a render).

What counts as a fault: black stretches (reported once — the frozen-picture check skips spans that are black), frozen pictures, sample peaks at the limiter, and sudden loud peaks — momentary loudness of at least −12 LUFS that is 10 LU above what played in the five seconds before (an error at −5 LUFS or +18 LU). A line spoken louder than the rest of a quiet mix is dynamics, not a fault. Black after the last picture offers holding the last shot when its source runs longer.

## Security notes

- App Check is enforced on the callable API (reCAPTCHA Enterprise). Project-wide App Check enforcement for Firestore/Storage is intentionally **not** enabled because it would affect the other apps in this project; owner-only rules protect the data.
- No Identity Platform blocking function is used: it would apply to every app sharing the project’s Auth. Non-owners can authenticate but are denied by the API and rules.
- The media bucket enforces public access prevention; the browser receives only 2-hour V4 signed URLs.

## Known log noise

- `MaxListenersExceededWarning … PassThrough` in function logs comes from `@google-cloud/storage` 8.2.0 streaming reads on Node 24 (each read stream carries 11 listeners). It is per stream, not a leak.
- The first render after a renderer deploy spends ~2–3 minutes starting the container (image pull) before FFmpeg runs; the render itself takes seconds for short timelines.
