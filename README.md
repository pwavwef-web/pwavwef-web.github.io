# AZ Studio

Private AI filmmaking portal for Indigen World music videos, promotional films, short films, episodic content and — shot by shot — feature-length productions.

| Role | Model (Vertex AI, `global`) |
| --- | --- |
| Video generation & conversational editing | `gemini-omni-1.1-flash-preview` (Gemini Omni 1.1 Flash) |
| Images & image editing | `gemini-3-pro-image` (Nano Banana Pro) |
| Screenplay, planning, song analysis | `gemini-3.1-pro-preview` (fallback `gemini-2.5-pro`) |

All model IDs live in one server-side registry: [`functions/src/config/models.ts`](functions/src/config/models.ts). A unit test fails if a model ID appears anywhere else.

## Workspaces

| Path | What |
| --- | --- |
| `apps/web` | React 19 + TypeScript + Vite + Tailwind SPA (Firebase Hosting site `az-studio`) |
| `functions` | Firebase Functions v2, codebase `az-studio`, `us-central1`: owner-only API, Cloud Tasks job worker, upload validation, maintenance |
| `services/renderer` | Cloud Run job `az-studio-renderer`: FFmpeg timeline rendering |
| `packages/shared` | Domain model, job state machine, timeline ops, prompt compiler, cost maths, audio DSP, Fountain parser |
| `firebase/` | Security-rule templates (owner UID rendered from Secret Manager) and Firestore indexes |

## Commands

```bash
npm install
npm run check              # lint + typecheck + unit tests + production builds
npm run test:integration   # Firebase emulators: rules + API integration tests
npm run deploy             # scoped deploy (see docs/OPERATIONS.md)
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
