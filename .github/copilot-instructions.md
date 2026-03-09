# Copilot Instructions for AZ Learner

## Project Overview
AZ Learner is a student utility PWA for Ghanaian university students. It supports document printing, course chat groups, GPA calculation, events, an ambassador program, CV building, podcasts, and a leaderboard. The backend is exclusively Firebase (Firestore, Auth, Storage); the frontend is vanilla HTML/CSS/JS with no build step.

## Architecture

- **Hosting**: GitHub Pages (auto-deploys on push to `main`). Firebase Hosting is also configured (`firebase.json`).
- **No build step**: All dependencies are loaded from CDNs. There is no `package.json`, bundler, or transpiler.
- **Monolithic HTML files**: Each page is a single large HTML file (often 2,000–5,000+ lines) with all JavaScript inline in a `<script type="module">` block.
- **External JS**: Only `pwa/sw.js` (service worker), `team/js/team.js`, and `team/js/profile-form.js` are external files.
- **Firebase SDK**: Version `11.0.2` (CDN). Use this version for all new code. One file (`emmanuel.html`) uses `11.6.1`; do not change it.
- **CSS**: Tailwind CSS via CDN (`https://cdn.tailwindcss.com`) plus inline `<style>` blocks. Only the team sub-section uses an external stylesheet (`team/css/team.css`).

## Key Libraries (all CDN)
- Firebase `11.0.2` — Auth, Firestore, Storage, Vertex AI
- Tailwind CSS — utility-first styling; custom theme defined in inline `tailwind.config`
- Font Awesome `6.4.0` — icons
- Paystack Inline — payment processing; amount in **pesewas** (GHS × 100)
- `html2canvas` `1.4.1` — certificate/screenshot rendering

## Code Conventions

### File & Symbol Naming
- HTML files: `kebab-case.html`
- Functions and variables: `camelCase`
- CSS classes: Tailwind utilities; custom semantic classes in `kebab-case`
- Firestore collections: `snake_case` (e.g., `print_messages`, `user_notifications`, `direct_chats`)
- Firestore document fields: `camelCase` for most fields (e.g., `weeklyXp`, `lastLogin`), `snake_case` for some legacy fields

### Global State Pattern
All logic is attached to `window` objects:
```js
window.app = { init(), switchView(), addXp(), ... }
window.authManager = { login(), logout(), ... }
```
Use `window.addEventListener('DOMContentLoaded', () => app.init())` as the entry point.

### Inline Event Handlers
Interactive elements use `onclick="app.someMethod('...')"` referencing window globals. Do not introduce framework-style event delegation without matching the existing style in the file being edited.

### XSS / HTML Safety
- Always call `escapeHtml()` (or equivalent) before injecting user-supplied data into `innerHTML`.
- `formatBlogText()` HTML-escapes before applying markdown-like regex transforms.
- `sendSystemNotification()` currently injects `title` and `body` into `innerHTML` without escaping. If you touch this function, refactor it to use `textContent` (or call `escapeHtml()`) before setting innerHTML to prevent XSS.

### Authentication
- `onAuthStateChanged(auth, async (user) => { ... })` drives all auth-gated UI.
- User role is stored in Firestore at `users/{uid}.role`, not in Firebase Auth custom claims.
- CEO-only pages compare `user.email` to the hardcoded constant `CEO_EMAIL` defined near the top of each file.

### Firestore Timestamps
- `print_messages` and print order timestamps use `Date.now()` numbers, **not** `serverTimestamp()`.
- Use `serverTimestamp()` for new collections unless matching an existing pattern.

### Navigation / History
- CV builder step navigation uses `history.pushState` / `history.back` / `popstate`.
- In `pwa/index.html`, every modal opened via a dedicated open method must call `history.pushState()` and be listed in the `views` array in the `popstate` handler so the back button dismisses it.

### Payments (Paystack)
- Amount is always in **pesewas**: `Math.round(priceGHS * 100)`.
- Use `callback` for success and `onClose` for cancel/close.

## Firebase / Firestore

### Security Rules
- `firestore.rules` and `storage.rules` are manually deployed via `firebase deploy --only firestore:rules,storage`.
- Auth checks use `request.auth.token.email` and `request.auth.uid`.
- Do not weaken existing rules.

### Indexes
- Composite indexes are declared in `firestore.indexes.json`.
- If a new query requires a composite index, add it to `firestore.indexes.json`.

## PWA
- Service worker lives at `pwa/sw.js`; it caches the app shell but excludes Firebase and Paystack (network-only).
- `pwa/index.html` uses `<base href="../">` to resolve assets from the `/pwa/` subdirectory.
- `pwa/manifest.json` defines app identity, icons, and shortcuts.

## Validation & Testing
- There is **no automated test suite** and **no CI pipeline**.
- Validate changes manually in a browser.
- For Firestore rules changes, use the Firebase Emulator Suite locally.
- Linting: none configured — follow existing code style in the file being edited.

## Deployment
- Push to `main` → GitHub Pages auto-deploys (custom domain `azlearner.me` via `CNAME`).
- Firestore/Storage rules changes require: `firebase deploy --only firestore:rules,storage`
- Hosting changes (rewrites, headers) require: `firebase deploy --only hosting`

## Common Pitfalls
- Do not add `package.json`, bundlers, or node_modules — the project intentionally has no build step.
- Do not upgrade Firebase SDK version globally; match the existing `11.0.2` import URLs.
- Do not remove or restructure `<script type="module">` blocks — they are the entry points.
- All imports must use full CDN URLs (e.g., `https://www.gstatic.com/firebasejs/11.0.2/...`).
- When editing a monolithic HTML file, keep changes minimal and surgical; do not reformat the entire file.
