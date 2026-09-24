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
- **Omni chains.** Every video result is stored with `store: true`; follow-up edits and extensions reference the parent turn server-side (`previous_interaction_id`) and carry no `generation_config.video_config.task` — Vertex AI rejects a task alongside a previous interaction, so the prompt states the change. An extension returns the whole video (e.g. 4 s + 4 s → 8 s) but is billed for the new seconds, with the earlier video as input (verified 2026-09-24). After the retention window the server re-sends the prior clip (≤10 s) with the `edit`/`extend` task instead; Omni refuses to change or continue speech in a re-sent clip, so dialogue repairs only continue live interactions and otherwise regenerate.
- **No fabricated parameters.** Requests are validated against `VIDEO_CAPABILITIES` / `IMAGE_CAPABILITIES`; unset options are omitted. Camera, lighting, mood, dialogue and sound are compiled into prompt text, not sent as API fields.
- **Audio.** Omni does not accept audio input. Songs are analysed in the browser (beats, tempo, sections; `packages/shared/src/audio.ts`) and by Gemini Pro (section labels, lyric transcription); timing becomes prompt directions and the real track is mixed by the renderer.
- **Upload validation.** `azsOnUpload` sniffs magic bytes, then probes audio/video with ffprobe and derives posters and waveforms with ffmpeg. The bundled static binaries crash when they resolve a hostname in the Cloud Functions runtime, so they read Storage objects through a loopback range proxy (`functions/src/lib/media-proxy.ts`) instead of signed URLs; large files are streamed by range, never downloaded whole.
- **Rendering.** The renderer splits the timeline into segments that never cut through transitions, renders each (overlays, transitions, Ken Burns, libass captions), concatenates losslessly, mixes audio once (loudness-normalised for final), muxes with `+faststart`, and writes a `provenance.json` sidecar.
- **Provenance.** Generated originals are stored byte-for-byte (C2PA manifests preserved and detected); SynthID is inherent to the pixels/audio. Re-encoded renders cannot keep source C2PA manifests — the sidecar lists each source’s status.

## Quality-controlled production

A production (`productions/{id}`) is a durable state machine driven by Cloud Tasks `advance` payloads (`functions/src/lib/production.ts`); child jobs carry `productionId`, and every terminal job transition re-enqueues the production. Statuses: Planning → Generating → Inspecting → Repairing → Awaiting review → Approved, or Failed quality review (plus Awaiting repair approval when a retry would pass the cost ceiling or is expensive). Stages: `plan`, `audio_prepare`, `duration_calculate`, `generate`, `inspect`, `repair`, `reinspect`, `approve`, `render`. Every version, report, repair and event is stored under the production.

- **Duration is a preference.** `packages/shared/src/duration.ts` computes the required length from the dialogue (guide audio spoken by `gemini-2.5-pro-tts` and measured with FFmpeg, uploaded recordings, or lines identified in an inspected take), speaker pauses, action beats, an opening (0.4–1 s) and closing hold (0.8–1.5 s). A scene that does not fit is lengthened, or produced as connected Omni extensions that break only at sentence boundaries (≤ 40 s), or split into separate shots. Omni cannot take audio input, so the guide audio is used for measurement and timing directions; the delivered dialogue is verified after generation.
- **Inspection** (`functions/src/workers/inspect.ts`) measures the real file (speech bounds, trailing room, clipping, loudness, scene cuts, black frames, end motion), transcribes it with word timestamps (`gemini-3.5-transcribe-preview`), aligns the transcript to the screenplay (`packages/shared/src/text-align.ts`: missing, altered, repeated, truncated words, early/late start, cutoff time), and has `gemini-3.1-pro-preview` watch the video with the reference images for speaker attribution, lip-sync, action beats, continuity, artefacts, first/last frames and seven scores. The verdict (`evaluateQuality`) is deterministic: incomplete dialogue caps the score at 55, incomplete action at 60, critical faults at 40; a failing version can only be approved through the API with the waived issues recorded. Picture cuts are checked against the plan: joins between connected shots and the reaction-shot / reverse-angle cuts a continuation part was directed to make (up to two per part) are intended; any other cut is reported, and fails the scene when the reviewer also sees it.
- **Repair** (`chooseRepair`) escalates from the least destructive fix: trim a spoiled ending → extend the scene (Omni extension) → Omni conversational edit → cutaway → regenerate a failed section → regenerate longer / split into connected shots. Defaults: 3 automatic attempts, $6 cost ceiling per production, approval required for retries above $1.50.

## Lyrics and film score

- **Lyric sheets** (`packages/shared/src/lyrics.ts`) keep the user’s text as the source of truth: uploaded or approved text is never rewritten to match a transcription. Plain text, `.txt`, `.lrc` (incl. enhanced word tags), `.srt`, `.vtt` and Lyria’s timed output are parsed; untimed text is aligned to word timestamps (Needleman–Wunsch with accent/West-African-letter folding), low-confidence and unaligned lines are flagged, and a Gemini anchor pass places lines the transcriber missed. Kasem (`xsm`) and other low-resource languages keep spelling and diacritics exactly; AI-written lyrics in them are marked for language verification. Instrumental songs never get lyrics.
- **Lyric captions** (line, karaoke, phrase, subtitle, vertical) live on a dedicated “Lyrics” track and are re-timed from the sheet whenever the song clip is moved, trimmed or split; the render dialog runs a final sync check (`checkLyricSync`) and the server refuses a render with out-of-sync captions unless the director accepts it. Exports: `.lrc`, `.srt`, `.vtt`.
- **Film score** (`packages/shared/src/score.ts`): musical bible and cue sheet from Gemini, movements of ≤150 s that break at deliberate silence, generated with `lyria-3.5` as strictly instrumental cues, laid on alternating score tracks with crossfades, ducking under dialogue (FFmpeg `sidechaincompress`) and volume automation. Music videos keep the song as the master audio; no score is added unless requested.

## Data model (database `az-studio`)

`users/{uid}` (settings, stats) · `projects/{id}` with subcollections `scripts` (+`versions`), `sequences`, `scenes`, `shots` (+`takes`), `characters`, `locations`, `elements`, `songs` (+ lyric sheet, vocals analysis, transcript), `timelines` (+`versions`), `scores`, `notes`, `aiRuns` · `productions` (+`versions`, `reports`, `events`; server-written) · `assets` · `chains` (+`turns`) · `jobs` · `batches` · `renders` · `usage`, `usageDaily`, `usageMonthly` · `interactions` (model call log) · `aiRuns` (project-less) · `runtime` (rate limits, concurrency slots, model availability cache; never client-readable).
