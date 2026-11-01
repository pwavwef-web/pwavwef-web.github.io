# Public website — implementation plan (phase 1)

Written 2026-10-24 before the work started. The finished state is documented in
[`PUBLIC_SITE.md`](PUBLIC_SITE.md); the next phase is in [`PUBLIC_PRODUCT_PREP.md`](PUBLIC_PRODUCT_PREP.md).

## What exists today (inspected)

| Area | Finding |
| --- | --- |
| Hosting | One site, `az-studio` → https://az-studio.web.app (no custom domain). Every path falls back to the studio SPA (`index.html`). `/embed/audio/**` is the public Narrator player; `/api/public/**` rewrites to the public `azsPublic` function. All responses carry `X-Robots-Tag: noindex`. |
| Private studio | React 19 + Vite + Tailwind SPA. `AuthGate` wraps every route: Firebase Auth (Google or email, MFA), then the `bootstrap` call decides. The owner reaches it at `/` today. |
| Authorization | Enforced server-side, independent of the UI: `azsApi` requires App Check, then `assertOwner` (UID **and** verified email from Secret Manager). Firestore and Storage rules allow only the owner UID with a verified email; everything else is denied by a catch-all. The media bucket has public access prevention; media reaches the browser only as 2-hour signed URLs. A non-owner can sign in but gets "permission-denied" everywhere. |
| Paid services | Every generation (Gemini Omni video, Nano Banana Pro images, Gemini 4 Argon text, transcription, TTS, Lyria music, Cloud Run renders and stems) is started only through `azsApi` (owner-only) and the Cloud Tasks worker (invoker = runtime service account). `azsPublic` serves published Narrator audio and never imports generation code. |
| Caching | No service worker. SPA HTML is `no-cache`, hashed assets immutable. Private data never passes through Hosting (Firestore/Storage SDK + POST callables). |
| Explicitly public assets | Two published Narrator audio editions (`kOZQ0h9lETB6`, `ajLMkL8uwtfL`) that Francis published through the hosted player for The Pwavwe Papers. Nothing else (exports, projects, media) is approved for public viewing. |
| Contact | The Pwavwe Papers contact page, https://blogs.pwavwe.com/p/contact.html (Francis's own public site). No contact address exists in the repository. |
| Deploy | `scripts/deploy.mjs` (scoped to AZ Studio resources in the shared `az-learner` project); Hosting preview channels are available. |

## Architecture choice

Least disruptive option on the existing site and stack:

- **Public pages own `/`** plus `/explore`, `/showcase`, `/about`, `/early-access`, `/faq`, `/privacy`, `/terms`
  and a real `404.html`. They are **static HTML generated at build time** by a small Vite plugin from TypeScript
  content files (`apps/web/site/`), with one tiny vanilla script and stylesheet. They load no Firebase SDK, no
  studio code, no third-party scripts and set no cookies.
- **The studio keeps every existing URL** (`/projects/…`, `/lite/…`, `/narrator/…`, `/create`, `/assets`,
  `/jobs`, `/settings`, `/print/…`). Only the dashboard moves from `/` to **`/studio`**. Its HTML entry is
  renamed `index.html` → `studio.html`; Hosting rewrites the studio prefixes to it. Auth uses a popup on
  `az-learner.firebaseapp.com`, so no callback path changes. Asset paths stay `/assets/…`.
- Unknown paths get the public 404 page instead of the studio shell.
- Security headers: the strict studio block stays first; a later block gives public pages a tighter CSP
  (`script-src 'self'`, no third parties) and allows indexing. Studio routes keep `noindex`.

## Early-access registration

- `POST /api/public/early-access` handled inside the existing public function `azsPublic` (same-origin via the
  existing Hosting rewrite; no new paid infrastructure).
- Validation with zod in `packages/shared` (shared by browser and server). Fields: email (required), name,
  interest, explicit consent to early-access updates. Notice version stored with a server timestamp.
- Abuse controls: origin check, JSON-only, body size limit, honeypot, per-IP (HMAC-hashed, kept ≤ 48 h) hourly
  and daily limits, a global daily cap, and an owner "pause" switch.
- Duplicates: document ID = SHA-256 of the normalised email; a repeat submission changes nothing visible and
  gets the identical response, so the endpoint never reveals whether an address is registered.
- Storage: Firestore `earlyAccess/{hash}` in the `az-studio` database; rules deny every client read/write.
- Owner tools: an owner-only `earlyAccess` API action (list, delete, pause) and a Settings card with CSV export.
- Emails are never logged. No email is sent (no provider configured), and the UI does not promise one.

## Pages

Home, Explore, Showcase, About, Early access, FAQ + contact, Privacy, Terms, 404 — unique titles and
descriptions, canonical URLs on https://az-studio.web.app, Open Graph/Twitter metadata, favicon, sharing image,
`sitemap.xml` (public pages only), `robots.txt`.

## Verification

Unit tests (shared schema, function handler, site build/route parity with firebase.json), emulator integration
tests (rules, owner/non-owner/anonymous API, endpoint persistence and privacy), e2e studio tests on `/studio`,
browser checks on mobile and desktop, a public-build secret scan, then a Hosting preview channel before the live
deploy. Functions and rules deploy first because Hosting preview channels share the live backend.

## Out of scope (phase 1)

Public generation, accounts or sign-up, payments or credits, emails or campaigns, analytics or ad cookies.
