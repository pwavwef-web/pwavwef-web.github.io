# Link to Ad

Paste a website link. Get an editable first ad. (`/linkad`, project type `link_ad`, owner-only.)

AZ Studio reads one public product or service page (plus at most four related pages of the same site), keeps what it finds as **sourced facts**, proposes one focused 15–30 second vertical advert, plans **three directions** cheaply (text, pictures and rough storyboard — no generated video), records the chosen script with a speech model, times the captions from the real audio, composes a timeline and renders a **real 1080 × 1920 MP4** with the studio's own FFmpeg renderer.

## Flow and stages

`Website → Proposed ad → Directions → Edit → Export` (the page's stepper). Stored on the ad (`project.linkad.stage`):

| Stage | Meaning | Left by |
| --- | --- | --- |
| `draft` | nothing run yet | `analyse` |
| `analysing` | the job `linkad.run{analyse}` is reading the site, keeping pictures and proposing the brief | job finishes → `reviewing` (or `failed` when nothing at all could be read) |
| `reviewing` | the brief is being reviewed; facts are editable | `approveBrief` + `plan` → `planning` |
| `planning` | job `{directions}` | → `awaiting_selection` (or back to `reviewing` with the error) |
| `awaiting_selection` | three directions are ready | `selectDirection` → `generating` |
| `generating` | the editing stage (voice, words, pictures, captions); a voice job may be running | `export` → `composing` |
| `composing` | a `render.timeline` job is running | all exports finished → `ready` (a final export whose file passed the checks) or back to `generating` |
| `ready`, `failed`, `cancelled` | terminal until the owner acts | any explicit step |

Legal moves are `LINKAD_TRANSITIONS` (`packages/shared/src/linkad.ts`, tested). Failures keep the work: a failed voice scene leaves the other scenes recorded; a failed export returns to editing; a failed brief leaves the facts and pictures.

## Where it plugs in

| Concern | Reuse / new |
| --- | --- |
| Owner access | the callable `azsApi` owner check, then `linkAdEntitlement` (feature flag + quotas) — `functions/src/lib/linkad-store.ts` |
| API | one action `linkAd` with an `op` per operation — `packages/shared/src/linkad-schemas.ts`, `functions/src/api/linkad.ts` |
| Data | `projects/{id}` (type `link_ad`, field `linkad`, **written by the API only**; the rules refuse client writes to it and client creation of the type) |
| Jobs | the studio job queue: new type `linkad.run` (steps `analyse`, `directions`, `revise`, `voice`) — `functions/src/workers/linkad.ts`; exports are ordinary `render.timeline` jobs |
| Reading sites | `functions/src/lib/linkad-net.ts` (safe fetch), `linkad-extract.ts` (parse5), `linkad-site.ts` (orchestration, Firecrawl adapter) |
| Planning | `packages/shared/src/linkad-plan.ts` (prompts, parsing, checks), `functions/src/lib/linkad-model.ts` (Vertex `gemini-4-argon` via `callReasoning`) |
| Voice, captions | `speakLine` (`gemini-2.5-pro-tts`) → saved asset → `transcribe` + `reconcileTranscript` (word timing) → `cuesFromWords`; `functions/src/lib/linkad-voice.ts` |
| Composition | `packages/shared/src/linkad-assemble.ts` builds an ordinary timeline; the browser preview (`LitePlayer`) and the renderer read the same document |
| Rendering | `services/renderer` unchanged (colour cards, framed pictures with `layout`, boxed captions, ducked music) |
| Spend | `recordUsage`, `assertWithinLimits`, the owner's confirmation threshold; plus a per-ad cap and ledger |
| UI | `apps/web/src/pages/linkad/*`, `lib/linkad.ts`; Create → Link to Ad; the project opens at `/linkad/:id` |

Existing studios are untouched: `PROJECT_TYPES`, `JOB_TYPES` and the API union gained one member each, the rules gained one denied field (`linkad`), and `LitePlayer` learned to draw pictures placed in a box and text anchored to the top.

## Facts, claims and approval

* `source.facts` — what a page said: `kind`, wording, **source URL, supporting excerpt, retrieval time**, qualifiers (currency, “from”, “per night”). A retrieval time never makes a price, date or offer *current*; prices, dates, offers and ratings always need the director's confirmation.
* `userFacts` — the director's own notes, shown and stored as theirs.
* `brief.*` with `origin: 'ai'` — recommendations (the audience is labelled “AI recommendation”).
* `confirmations` — `{factId: hash of the wording}`; editing a fact un-confirms it. `briefApprovedHash` records the facts the brief rested on; a later change marks the scenes that rely on them for review (`reviewScenes`).
* `checkClaims` (`linkad-checks.ts`) refuses wording the facts do not support: figures (prices, percentages, dates) must appear in a fact — and be confirmed if they need it — and rankings, awards, guarantees, ratings, customer counts, scarcity and urgency are accepted only when the website itself says them. The planner is told once what to fix; anything left is flagged on the scene and blocks export.
* Conflicts (different phone numbers or prices for the same thing on different pages) and gaps (no price, no contact, no pictures) are listed, not resolved silently.

## Fetching safely

`linkad-net.ts` is the only code that reads an address someone typed. HTTP(S) only; no embedded credentials; only standard ports; hostnames such as `localhost`, `*.local`, `*.internal`, `metadata.google.internal`; every literal IPv4/IPv6 form (decimal, hex, octal, short, mapped, NAT64, 6to4) checked against private, loopback, link-local (cloud metadata), carrier-grade NAT, multicast and reserved ranges. The **connection itself** is made through a custom DNS `lookup` that resolves, rejects reserved addresses and hands back only checked ones — so a name that points inward, or changes its answer between check and connect, cannot reach the internal network. Redirects are followed by hand (limit 4), each re-validated; https never redirects to http; pages never leave their own site. Limits: 12 s, 2.5 MB (decompressed size too), HTML only for pages; pictures 8 MB, JPEG/PNG/WebP/GIF only, magic bytes sniffed, decoded dimensions ≤ 40 megapixels. 401/402/403, login-looking pages and `robots.txt` disallows are reported as “not read” — never worked around. At most **five** pages per ad (hard cap in code; the page's setting can only lower it); the default is the submitted page plus related offer/about/contact pages of the same site. Script-built pages need Firecrawl (below); otherwise they are reported empty.

Website text is **data**: lines addressed to an AI (“ignore all previous instructions…”) are removed before planning and shown to the director; the planner's system message says so; its answer is parsed and checked against known fact ids, picture ids and the claim rules, so a page that talked the model into something still cannot put it in the ad (tested). No tools are available to the model.

Pictures need a rights confirmation (“I own these pictures or have permission…”); until given, nothing from the site or an upload is rendered. AI-made pictures (optional paid “extend to vertical”) are marked, need a look (“reviewed”) and show an estimate first.

## Jobs, resume, cost

* One step at a time per ad; every paid or long step takes a client **request id**: the job id is derived from (ad, step, request id), so a repeated click, a refresh or a second tab returns the same job and never a second paid call. A project lock serialises starts.
* Progress is the backend's own stage text (`job.stage`) shown on the page; there is no percentage counter. Reload shows the same state (the document and the job are live).
* Voice: one request per scene; each scene is **saved before it is timed**, and the take records the hash of (words, voice, direction). A sent-but-unsaved request is marked in `voiceInFlight`; if a worker dies, nothing is resent automatically — the owner must acknowledge that the earlier request may already have been charged. Cancel stops between scenes; finished scenes are kept. Transient provider failures use the studio's retry policy.
* Changing narration invalidates that scene's take only. Changing the voice or its direction invalidates every take. Caption colour/size, brand colours, music level, overlay text and the closing change only the composition hash (new export, no re-recording). Exports store the hash they were made from and show “out of date” when it changes.
* Spend: every step shows an estimate (`estimateText`, `estimateSpeech`, `estimateTranscription`, `estimateRender` at published list prices) and is checked against the ad's **spending cap**, the owner's daily/monthly limits and the confirmation threshold. The ledger keeps **estimate** and **reported actual** separately (actual = the provider's own token counts at list prices); fixture steps are labelled. Render compute is estimated but billed by Google Cloud separately. No checkout or billing was added.

## Export and checks

`export` re-runs the readiness checks, assembles the timeline on the frame grid (scenes are whole frames, so a cut never leaves a one-frame black gap), saves it as the project's timeline, and creates an ordinary `render.timeline` job (draft 720 × 1280, final 1080 × 1920, loudness-normalised mix; the render carries `skipInspection`, so the studio's Gemini final-film inspection and its export gate do not apply — this feature checks its own files). When the render finishes the server **probes the file** (duration within 0.6 s of the plan, picture and sound streams present, exact dimensions, h264/aac) and only then marks the final export good and the ad `ready`. A landscape photo that cannot fill the tall frame without going soft (> 1.5× enlargement at 1080 px) is shown whole, rounded and shadowed, on the brand colour; text always lives in zones that cannot collide (`VERTICAL_ZONES`, tested), contrast of captions and brand text is checked, and the closing scene is text-led so the call to action stays readable.

## Configuration

| Item | Where | Effect when missing |
| --- | --- | --- |
| Owner identity | Secret Manager `AZ_STUDIO_OWNER_UID`, `AZ_STUDIO_OWNER_EMAIL` (existing) | no access |
| Feature flag | Firestore `runtime/features` field `linkAd: { enabled: false }` switches the feature off for everyone; env `AZS_FEATURE_LINK_AD=off` too. Default: on, owner-only. Quotas: `linkAd.quotas` (`analysesPerDay` 60, `voiceRunsPerDay` 120, `exportsPerDay` 60, `maxSpendCapUsd` 25) | — |
| Firecrawl (optional, script-built pages) | Secret Manager `AZ_STUDIO_FIRECRAWL_API_KEY` (`POST https://api.firecrawl.dev/v2/scrape`, bearer auth, `formats:["markdown"]`) | script-built pages are reported “almost empty” and the director is told to paste the details |
| Google models | the studio's existing Vertex access (`gemini-4-argon`, `gemini-2.5-pro-tts`, `gemini-3.5-transcribe-preview`) | provider errors are classified by the studio's existing recovery system |
| Fixtures | `AZS_LINKAD_FIXTURES=1` or the emulator only | a “Fixture run” (demo site, planner, tone voice) is refused in production |

The config screen (`linkAd {op:'config'}`) shows the feature state, provider names and any actionable setup notes — never keys or balances. Gemini “URL context” is deliberately **not** used: the studio fetches pages itself (with the protections above) and supplies the retrieved text explicitly, so fetch status and safety stay under its control.

## Future public access (not enabled)

`linkAdEntitlement(owner)` returns `{enabled, plan, audience, quotas}`; today the only plan is the owner's. Public access would change that function (and the quotas), add accounts, and nothing else: every read and write is already scoped to `ownerUid`, the document is server-written, quotas and spend are counted server-side, and no public page exposes workspaces, media, keys or balances. Other aspect ratios (`LINKAD_FORMATS`, `FRAMING_WIDTH`, `FRAME_BOX`, `VERTICAL_ZONES` are 9:16-specific) and languages (`LINKAD_LANGUAGES`, one entry) are listed as extension points and shown disabled — they do not work yet.

## Run, test, render

```bash
npm run dev                                   # the studio at /linkad (needs the emulators or the live backend)
npx vitest run --project shared --project functions --project renderer --pool=threads --maxWorkers=2
npx vitest run --project functions functions/test/linkad-extract.test.ts functions/test/linkad.test.ts
npx vitest run --project renderer services/renderer/test/link-ad-render.test.ts   # real FFmpeg render + pixel/audio checks
npm run test:e2e                              # browser run against the emulators (includes tests/e2e/linkad.e2e.test.ts, fixture mode)
AZS_ACCEPTANCE=1 node --dns-result-order=ipv6first scripts/production/run.mjs scripts/production/link-ad/live-check.ts [url]
```

`live-check.ts` reads a real page and asks the real planner for the brief and directions (two text calls, no writes to the studio, no audio/image/video).

## Known limits

* English only, 9:16 only, one voice take per scene (no per-word re-timing UI), no music generation (bring your own licensed track), no avatar, lip-sync, ad buying, social publishing or performance prediction.
* Script-built pages need Firecrawl; PDFs, SVG logos and video are not read.
* The word timing of a live recording comes from transcription; low-confidence or estimated timing is flagged on the scene and in the export checks.
* Estimates are published list prices and token estimates; the “reported” figure is the provider's own token count at those prices, not your invoice.
