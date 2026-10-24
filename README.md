# AZ Studio

Private AI filmmaking portal for Indigen World music videos, promotional films, short films, episodic content and — shot by shot — feature-length productions.

**Public website.** https://az-studio.web.app/ is the public information site (Home, Explore, Showcase, About, Early access, FAQ, Privacy, Terms) with a working early-access list; the private studio is at **[/studio](https://az-studio.web.app/studio)** and every other studio URL is unchanged. Pages are generated from `apps/web/site/`. See [`docs/PUBLIC_SITE.md`](docs/PUBLIC_SITE.md) (operations, early-access administration, rollback) and [`docs/PUBLIC_PRODUCT_PREP.md`](docs/PUBLIC_PRODUCT_PREP.md) (the next phase — not built).

| Role | Model (Vertex AI, `global`) |
| --- | --- |
| Video generation & conversational editing (incl. quality repairs) | `gemini-omni-1.1-flash-preview` (Gemini Omni 1.1 Flash — Vertex AI ID of `gemini-omni-1.1-flash`) |
| Images & image editing | `gemini-3-pro-image` (Nano Banana Pro) |
| Screenplay, planning, song analysis, scene inspection, lyrics, cue sheets | `gemini-4-argon` (Gemini 4 Argon, no silent fallback) |
| Word-timed transcription (dialogue validation, lyric sync) | `gemini-3.5-transcribe-preview` |
| Dialogue guide audio (measured before a scene is generated) | `gemini-2.5-pro-tts` |
| Songs and film score | `lyria-3.5` — Vertex AI is checked first, then the Gemini Developer API with a server-side key; without either, music jobs report the exact limitation |

All model IDs live in one server-side registry: [`functions/src/config/models.ts`](functions/src/config/models.ts). A unit test fails if a model ID appears anywhere else. Settings → Models checks live availability of every role.

**Film Studio Lite** (sidebar → Film Lite, `/lite`) makes narrated films of several minutes from still images with slow, sub-pixel camera movement, voice with word-timed subtitles, a coherent score and ambience — no video generation or lip sync: Story → Scenes → Voice & Sound → Edit → Export. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#film-studio-lite).

**Music Video Lite** (sidebar → MV Lite, `/mvlite`) makes music videos from still images and your song: cuts land on the beat grid, sections follow the song’s structure and energy, and the lyrics — synchronised to the vocals — become captions; no video generation or lip sync: Song & lyrics → Concept → Shots → Edit → Export. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#music-video-lite).

**Pwavwe Narrator** (sidebar → Narrator, `/narrator`) — *The Pwavwe Papers, in your voice*: create a consented replica of Francis Pwavwe's voice (Gemini Developer API voice replication, `gemini-3.8-flash-tts`), audition and approve it, turn an article into an audio edition, regenerate single passages, export WAV/MP3 and prepare the SoundCloud / Blogger embed. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#pwavwe-narrator).

**Short Ads** (sidebar → Short Ads, `/ads`) produces 40–60 s promotional videos in 9:16, 16:9 or 1:1, built either around an approved narration or soundtrack (audio-first) or from a brief (brief-first): Brief → Audio & assets → Storyboard → Generate → Review → Export. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#short-ads).

Every shot can be produced under **quality control**: plan (duration from measured dialogue) → generate → inspect (FFmpeg measurements + word-timed transcript + Gemini review of the actual video) → score → repair (least destructive first, at most 3 automatic attempts within a cost ceiling) → reinspect → approve. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#quality-controlled-production).

The Bible automatically queues a 16:9 project cover once every character has a usable likeness reference. The cover uses those exact reference images and the project's treatment; it can also be regenerated from the Character or Visual Bible. Image jobs follow the studio's spending limits. The newest cover request wins if generations finish out of order; older covers remain in the media library.

## Workspaces

| Path | What |
| --- | --- |
| `apps/web` | React 19 + TypeScript + Vite + Tailwind SPA (`studio.html`, Firebase Hosting site `az-studio`), the public website generated from `site/`, and the Narrator player (`embed.html`) |
| `functions` | Firebase Functions v2, codebase `az-studio`, `us-central1`: owner-only API, Cloud Tasks job worker, upload validation, maintenance |
| `services/renderer` | Cloud Run job `az-studio-renderer`: FFmpeg timeline rendering |
| `packages/shared` | Domain model, job state machine, timeline ops, prompt compiler, cost maths, audio DSP, Fountain parser |
| `firebase/` | Security-rule templates (owner UID rendered from Secret Manager) and Firestore indexes |

## Commands

```bash
npm install
npm run check              # lint + typecheck + unit tests + production builds
npm run test:integration   # Firebase emulators: rules + API integration tests
AZS_ACCEPTANCE=1 npm run test:acceptance   # LIVE, billable: real generations against the deployed studio (tests/acceptance)
npm run deploy             # scoped deploy (see docs/OPERATIONS.md)
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
