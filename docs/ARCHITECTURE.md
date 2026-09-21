# AZ Studio architecture

## Isolation inside the shared `az-learner` project

The Firebase project also hosts other apps (Hosting sites `az-learner`/“Last Hour”, `absag-ucc1`, `cv-build`, `hallkey`, `orglet`, `tmg-22`; several Firestore databases; the `absag*` functions). AZ Studio therefore uses only its own resources:

| Resource | Name |
| --- | --- |
| Hosting site | `az-studio` → https://az-studio.web.app |
| Web app | `AZ Studio` (`1:12958795950:web:06bec3bbdd07bc1c40453f`) |
| Firestore database | `az-studio` (us-central1, delete protection on) |
| Storage bucket | `az-studio-media-az-learner` (us-central1, uniform access, public access prevention) |
| Functions codebase | `az-studio` (`azsApi`, `azsJobWorker`, `azsOnUpload`, `azsMaintenance`) |
| Cloud Run job | `az-studio-renderer` |
| Service accounts | `az-studio-api@` (functions), `az-studio-renderer@` (render job) |
| Secrets | `AZ_STUDIO_OWNER_UID`, `AZ_STUDIO_OWNER_EMAIL` |
| API key | `AZ Studio Web (restricted)` — referrer-restricted to AZ Studio domains |
| App Check | reCAPTCHA Enterprise key `AZ Studio App Check` |

The default Firestore database, the default bucket and their rules are **not** touched by AZ Studio deploys.

## Request flow

```
Browser (Auth + App Check) ──callable──▶ azsApi (owner check, zod + capability validation, cost/limits)
                                            │ writes jobs/{id}, enqueues Cloud Task
                                            ▼
                                   azsJobWorker (Cloud Tasks, idempotent, leases)
          ┌──────────────┬────────────────────┼────────────────────┬─────────────────────┐
   Nano Banana Pro   Gemini Omni (Interactions   Gemini Pro (JSON)   Cloud Run job (FFmpeg)
   generateContent   API, background + poll)     writing / song AI    renders timelines
          └──────────────┴──── media → private bucket, assets/{id}, usage records ─────────┘
Browser ◀── Firestore listeners (jobs, assets, renders) ── signed URLs (2 h) for playback
```

- **Durable jobs.** Status `queued → validating → generating → downloading → rendering → completed | failed | cancelled` (see `packages/shared/src/jobs.ts`). Every Cloud Tasks delivery is idempotent: jobs are claimed with a lease, Omni interactions are polled by re-enqueued tasks, and `azsMaintenance` re-attaches lost pollers or fails jobs whose worker died *without* resending paid requests.
- **Omni chains.** Every video result is stored with `store: true`; follow-up edits reference the parent turn server-side (`previous_interaction_id`). After the retention window the server re-sends the prior clip (≤10 s) instead.
- **No fabricated parameters.** Requests are validated against `VIDEO_CAPABILITIES` / `IMAGE_CAPABILITIES`; unset options are omitted. Camera, lighting, mood, dialogue and sound are compiled into prompt text, not sent as API fields.
- **Audio.** Omni does not accept audio input. Songs are analysed in the browser (beats, tempo, sections; `packages/shared/src/audio.ts`) and by Gemini Pro (section labels, lyric transcription); timing becomes prompt directions and the real track is mixed by the renderer.
- **Upload validation.** `azsOnUpload` sniffs magic bytes, then probes audio/video with ffprobe and derives posters and waveforms with ffmpeg. The bundled static binaries crash when they resolve a hostname in the Cloud Functions runtime, so they read Storage objects through a loopback range proxy (`functions/src/lib/media-proxy.ts`) instead of signed URLs; large files are streamed by range, never downloaded whole.
- **Rendering.** The renderer splits the timeline into segments that never cut through transitions, renders each (overlays, transitions, Ken Burns, libass captions), concatenates losslessly, mixes audio once (loudness-normalised for final), muxes with `+faststart`, and writes a `provenance.json` sidecar.
- **Provenance.** Generated originals are stored byte-for-byte (C2PA manifests preserved and detected); SynthID is inherent to the pixels/audio. Re-encoded renders cannot keep source C2PA manifests — the sidecar lists each source’s status.

## Data model (database `az-studio`)

`users/{uid}` (settings, stats) · `projects/{id}` with subcollections `scripts` (+`versions`), `sequences`, `scenes`, `shots` (+`takes`), `characters`, `locations`, `elements`, `songs`, `timelines` (+`versions`), `notes`, `aiRuns` · `assets` · `chains` (+`turns`) · `jobs` · `batches` · `renders` · `usage`, `usageDaily`, `usageMonthly` · `interactions` (model call log) · `aiRuns` (project-less) · `runtime` (rate limits, concurrency slots; never client-readable).
