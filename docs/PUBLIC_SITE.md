# Public website and early-access list

https://az-studio.web.app is now two things on one Firebase Hosting site (`az-studio`):

| URL | What | Access |
| --- | --- | --- |
| `/`, `/explore`, `/showcase`, `/about`, `/early-access`, `/faq`, `/privacy`, `/terms` | Public website (static pages) | Anyone; indexed |
| `/studio` | **Private studio dashboard** (was `/`) | Sign-in + owner check |
| `/projects/…`, `/lite/…`, `/mvlite/…`, `/ads/…`, `/narrator/…`, `/create/…`, `/assets`, `/jobs`, `/settings`, `/print/…` | Private studio (unchanged URLs) | Sign-in + owner check |
| `/embed/audio/{id}`, `/api/public/audio/…` | Narrator public player (unchanged) | Anyone; published editions only |
| `/api/public/early-access` | Early-access form endpoint (POST) | Anyone; write-only |
| anything else | Public 404 page | — |

Plan and inspection notes: [`PUBLIC_SITE_PLAN.md`](PUBLIC_SITE_PLAN.md). Next phase: [`PUBLIC_PRODUCT_PREP.md`](PUBLIC_PRODUCT_PREP.md).

## How the owner reaches the studio

Open **https://az-studio.web.app/studio** (or the footer's "Studio sign in"). Bookmarks to any other studio page keep
working. `/home` also lands on `/studio`. Sign-in is unchanged (Google popup or email, MFA), and access is still decided
server-side by `AZ_STUDIO_OWNER_UID` + `AZ_STUDIO_OWNER_EMAIL`.

## How the separation works

- **Pages** are generated at build time from `apps/web/site/` by a Vite plugin (`site/plugin.ts`): `content.ts`
  (copy, workflows, FAQ, showcase), `pages.ts` (templates), `layout.ts` (head, header, footer), `config.ts`
  (origin, page list, studio prefixes). One script (`site/client/main.ts`, ~4 KB: menu + form) and one stylesheet.
  They load no Firebase SDK, no studio code, no third-party resources, and set no cookies or storage.
- **The studio** is `apps/web/studio.html` (renamed from `index.html`). `firebase.json` rewrites the studio prefixes
  to it; there is no catch-all, so unknown paths get `404.html`. `site/config.ts` holds the same prefix list and a test
  (`site/site.test.ts`) fails if the two drift. The dev server routes identically (`routeFor` in `site/plugin.ts`).
- **Headers**: the strict studio block (`**`: studio CSP, `X-Frame-Options: DENY`, `X-Robots-Tag: noindex, nofollow`)
  stays first; a later block for the public page paths sets a tighter CSP (`script-src 'self'`, nothing third-party)
  and `X-Robots-Tag: all`. Production merges matching blocks with later ones winning; the Hosting emulator applies
  only the first match, so check header changes against the deployed site (`curl -sI`).
- **Authorization does not depend on any of this.** The callable API requires App Check and the owner UID + verified
  email; Firestore/Storage rules allow only the owner; the media bucket has public access prevention. Hiding links or
  `noindex` is not what protects the studio.

## Editing content

- Copy: `apps/web/site/content.ts` (home highlights, Explore workflows with honest status, FAQ, showcase).
  Page titles and descriptions: `apps/web/site/config.ts`. Then `npm run build -w apps/web` and deploy hosting.
- Preview locally: `npm run dev -w apps/web` (pages at http://localhost:5173/). The `player-preview` launch
  configuration (`--mode playerqa`) proxies `/api/public` to production so the showcase players play real editions —
  **don't submit the form there**, it would reach the production list.
- Sharing image / touch icon: `node scripts/site-images.mjs` regenerates `apps/web/public/og.png` and
  `apple-touch-icon.png`.

### Showcase rules

Only work that has been deliberately published may be listed, each entry with an `approval` note. Never list a
project found in private storage and never link to bucket or signed URLs. Audio entries use the public Narrator
player (`/embed/audio/{publicId}`; audio downloads only on play). Video/image entries expect web-optimised public
files under `apps/web/public/showcase-media/` with a poster, dimensions, captions or alt text. Unpublishing a
Narrator edition makes its showcase player show "no longer available" — remove the entry too.

## Early-access list

### What is stored

`earlyAccess/{sha256(normalised email)}` in the `az-studio` Firestore database:
`email`, `name` (or null), `interest` (or null), `consent { updates: true, noticeVersion, at }`, `createdAt`,
`lastSubmittedAt`, `submissions`, `source: "website"`. Per-network counters live in `earlyAccessRate/{hmac(ip)}`
(the HMAC key is in `runtime/earlyAccessKey`) and are deleted after 48 h by `azsMaintenance`; the pause switch and the
daily total are in `runtime/earlyAccess`. Rules deny every client read and write on all of these.

Abuse controls: same-site `Origin` only, JSON only, 2 KB body limit, honeypot field, 5 per network per hour and
20 per day, 1,000 per day overall, and an owner pause switch. A repeat of an address already on the list changes only
`lastSubmittedAt`/`submissions` and gets the same `200 {"ok":true}` as a new one, so the form never reveals who is
registered. Email and network addresses are never written to logs.

No email is sent: nothing is connected for sending, and the form says so. Don't start outreach without updating the
privacy notice first (see below).

### View, export, delete

- **Studio → Settings → Early access (public website)**: count, table, **Export CSV** (spreadsheet-safe), delete
  one registration (with confirmation), and **Pause new registrations**.
- Deletion requests arrive through the contact page. Match the sender to the registered address, delete the entry in
  Settings, and reply. Deleting removes the registration and its consent record; CSV copies you exported earlier are
  not affected — delete those too.
- Without the UI (owner credentials on this machine):

  ```bash
  # list (Firestore REST, read with your gcloud account)
  curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: az-learner" \
    "https://firestore.googleapis.com/v1/projects/az-learner/databases/az-studio/documents/earlyAccess?pageSize=300"
  # delete one: the id is sha256 of the lower-cased, trimmed address
  ID=$(printf '%s' 'someone@example.com' | sha256sum | cut -d' ' -f1)
  curl -s -X DELETE -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: az-learner" \
    "https://firestore.googleapis.com/v1/projects/az-learner/databases/az-studio/documents/earlyAccess/$ID"
  ```

### Changing the notice or consent wording

`EARLY_ACCESS_NOTICE_VERSION` and `EARLY_ACCESS_CONSENT_TEXT` in `packages/shared/src/early-access.ts`. Bump the
version (a date) whenever the privacy notice or the consent sentence changes; each registration keeps the version it
was given. Deploy functions **and** hosting together after a change — the endpoint rejects nothing on version, but the
pages show the version and it should match what the server stores.

## Deploy

```bash
node scripts/deploy.mjs --only=rules,functions,hosting      # checks first; or add --skip-checks
```

`hosting` builds the public pages with the studio. To check a build before it goes live, use a preview channel
(functions and rules are shared with live, so deploy those first):

```bash
node scripts/write-web-env.mjs && npm run build -w apps/web
firebase hosting:channel:deploy public-preview --only studio --expires 7d --project az-learner
```

Studio sign-in does not work on preview channel domains (the restricted API key and the callable CORS list only
allow the live domains); the public pages and the form do.

## Rollback

- **Hosting** (pages + studio shell): Firebase console → Hosting → `az-studio` → release history → *Rollback* on the
  previous release, or `firebase hosting:clone az-studio:@<previous-version-id> az-studio:live --project az-learner`.
  Rolling back to a release from before 2026-10-24 restores the studio at `/` and removes the public site.
- **Functions**: redeploy the previous commit (`git checkout <sha> -- functions packages/shared` then
  `node scripts/deploy.mjs --skip-checks --only=functions`). An older `azsPublic` answers the form with 405, which the
  form reports as "couldn't be saved" — nothing false is shown.
- **Close the form without a deploy**: Settings → Early access → *Pause new registrations*.
- Registrations already stored are unaffected by any rollback.

## Owner input still needed

These were left out rather than guessed:

1. A **dedicated contact address** for AZ Studio, if you want one; the site uses the Pwavwe Papers contact page.
2. A **retention period** for the list (the notice says "while the list is in use, or until you ask").
3. **Jurisdiction / governing law** for the terms, and whether you want a formal legal name or postal address.
4. Whether the list should state a **minimum age**.
5. **Email provider** for invitations (and the privacy notice update that must go out first).
6. Confirmation that the two Narrator editions may stay in the showcase.
7. A **custom domain**, if any — then update `SITE_ORIGIN`, the endpoint's `SITE_ORIGINS`, the studio's
   `ALLOWED_ORIGINS`, the API-key referrers and Auth authorised domains together.
