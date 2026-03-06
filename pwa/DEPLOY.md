# AZ Learner PWA — Deployment Guide

This guide explains every step needed to deploy the Progressive Web App (PWA) version of **AZ Learner** (`pwa/index.html`). The PWA is installable on Android, iOS, and desktop browsers and works offline after the first load.

---

## Table of Contents

1. [What's inside the `pwa/` folder](#whats-inside-the-pwa-folder)
2. [How the PWA works](#how-the-pwa-works)
3. [Option A – Deploy on GitHub Pages (recommended)](#option-a--deploy-on-github-pages-recommended)
4. [Option B – Deploy on Firebase Hosting](#option-b--deploy-on-firebase-hosting)
5. [Option C – Deploy on any static host (Netlify, Vercel, Render …)](#option-c--deploy-on-any-static-host)
6. [Updating the app after deployment](#updating-the-app-after-deployment)
7. [Testing the PWA locally](#testing-the-pwa-locally)
8. [Checklist before going live](#checklist-before-going-live)
9. [Troubleshooting](#troubleshooting)

---

## What's inside the `pwa/` folder

```
pwa/
├── index.html        ← The app shell (home.html + PWA additions)
├── manifest.json     ← Web App Manifest (name, icons, colors, shortcuts)
├── sw.js             ← Service Worker (offline caching strategy)
├── icons/
│   ├── icon-192.png  ← Home-screen icon (Android / Chrome)
│   └── icon-512.png  ← Splash-screen / maskable icon
└── DEPLOY.md         ← This file
```

The `pwa/index.html` is identical to the root `home.html` except for these additions:

| Addition | Purpose |
|---|---|
| `<base href="../">` | Keeps all relative asset paths working from the `/pwa/` sub-directory |
| `<link rel="manifest" href="/pwa/manifest.json">` | Tells the browser this is a PWA |
| Apple / Microsoft meta tags | "Add to Home Screen" support on iOS / Windows |
| Service worker registration script | Enables offline caching |

---

## How the PWA works

### Web App Manifest (`manifest.json`)

Describes the app to the browser:
- **`display: standalone`** — runs full-screen (no browser chrome) when installed
- **`start_url: ./`** — opens `pwa/index.html` on launch
- **`theme_color`** / **`background_color`** — used for the status bar and splash screen
- **`shortcuts`** — quick-launch actions visible in Android's long-press menu

### Service Worker (`sw.js`)

Implements a layered caching strategy:

| Request type | Strategy | Rationale |
|---|---|---|
| Firebase, Paystack APIs | **Network-only** | Always fetch live data; never cache auth tokens |
| Navigation (HTML pages) | **Network-first → cache fallback** | Fresh content when online; offline shell if not |
| Same-origin static files | **Cache-first** | Instant repeat loads |
| CDN (Tailwind, Font Awesome) | **Network-first → cache fallback** | Fresh on updates; readable offline after first visit |

#### Scope note

By default the service worker's scope is `/pwa/` (the directory where `sw.js` lives).
Only URLs under `/pwa/` are intercepted by the SW.
Assets resolved by `<base href="../">` (favicon, CDN fonts, Firebase SDK …) continue to
be served from the browser's standard HTTP cache when offline.

To expand the scope to `/` (cache root assets too), configure the hosting server to send
the header **`Service-Worker-Allowed: /`** for the `sw.js` response — see the
hosting-specific sections below for how to add this header.

---

## Option A – Deploy on GitHub Pages (recommended)

This project is already hosted on GitHub Pages at **azlearner.me**. No new infrastructure is needed.

### Steps

1. **Commit the `pwa/` folder** to the `main` (or `master`) branch:

   ```bash
   git add pwa/
   git commit -m "feat: add PWA folder (manifest, service worker, app shell)"
   git push origin main
   ```

2. **GitHub Pages deploys automatically.** After a minute or two the PWA will be live at:

   ```
   https://azlearner.me/pwa/
   ```

3. **Verify HTTPS** – GitHub Pages provides HTTPS by default. HTTPS is *required* for service workers and the install prompt to work.

4. **Set a custom domain (already done)** – The `CNAME` file at the root already maps the repo to `azlearner.me`.

5. **Test the install prompt** by opening `https://azlearner.me/pwa/` in Chrome on Android and looking for the "Add to Home Screen" banner.

### Enabling PWA for the root domain (optional)

If you want `https://azlearner.me/` itself to be installable as a PWA:

1. Copy `manifest.json` to the repo root (update `start_url` to `./`).
2. Copy `sw.js` to the repo root (update the `PRECACHE_URLS` to include root assets).
3. Add the PWA meta tags and SW registration to `home.html` or `index.html`.

---

## Option B – Deploy on Firebase Hosting

Firebase Hosting serves files over HTTPS with a global CDN and is ideal if you want the PWA and Firebase backend to live under the same project.

### Prerequisites

```bash
npm install -g firebase-tools
firebase login
```

### Steps

1. **Initialize Firebase Hosting** from the repo root:

   ```bash
   firebase init hosting
   ```

   When prompted:
   - *Public directory* → `.` (the whole repo)
   - *Configure as a single-page app?* → **No** (the app is a multi-page site)
   - *Set up automatic builds with GitHub Actions?* → optional

   This creates `firebase.json` and `.firebaserc`.

2. **Edit `firebase.json`** to add a rewrite rule so `/pwa/` resolves correctly and to set HTTPS headers:

   ```json
   {
     "hosting": {
       "public": ".",
       "ignore": ["firebase.json", ".git/**", "node_modules/**"],
       "headers": [
         {
           "source": "/pwa/sw.js",
           "headers": [
             { "key": "Service-Worker-Allowed", "value": "/" },
             { "key": "Cache-Control", "value": "no-cache" }
           ]
         },
         {
           "source": "/pwa/manifest.json",
           "headers": [
             { "key": "Content-Type", "value": "application/manifest+json" }
           ]
         }
       ],
       "rewrites": [
         {
           "source": "/pwa",
           "destination": "/pwa/index.html"
         }
       ]
     }
   }
   ```

3. **Deploy:**

   ```bash
   firebase deploy --only hosting
   ```

4. The PWA will be live at:

   ```
   https://<your-project-id>.web.app/pwa/
   ```

   Or at your custom domain if configured in the Firebase Console under **Hosting → Add custom domain**.

---

## Option C – Deploy on any static host

Netlify, Vercel, Render, Cloudflare Pages, and similar platforms all work. The steps below use **Netlify** as an example.

### Netlify

1. Push the repo to GitHub (already done).

2. Log in to [netlify.com](https://netlify.com) → **Add new site → Import an existing project**.

3. Select the GitHub repo and configure:
   - *Branch to deploy* → `main`
   - *Base directory* → *(leave empty – deploy from root)*
   - *Build command* → *(leave empty – static site)*
   - *Publish directory* → `.`

4. Click **Deploy site**.

5. **Set a custom domain** under **Domain settings** and enable **HTTPS** (Netlify provides Let's Encrypt automatically).

6. Add a `netlify.toml` to the repo root for the correct MIME type and cache headers:

   ```toml
   [[headers]]
     for = "/pwa/sw.js"
     [headers.values]
       Content-Type = "application/javascript"
       Cache-Control = "no-cache"
       Service-Worker-Allowed = "/"

   [[headers]]
     for = "/pwa/manifest.json"
     [headers.values]
       Content-Type = "application/manifest+json"
   ```

### Vercel

1. Install the Vercel CLI: `npm i -g vercel`
2. Run `vercel` from the repo root and follow the prompts.
3. Add a `vercel.json` for headers:

   ```json
   {
     "headers": [
       {
         "source": "/pwa/sw.js",
         "headers": [
           { "key": "Cache-Control", "value": "no-cache" },
           { "key": "Service-Worker-Allowed", "value": "/" }
         ]
       },
       {
         "source": "/pwa/manifest.json",
         "headers": [
           { "key": "Content-Type", "value": "application/manifest+json" }
         ]
       }
     ]
   }
   ```

---

## Updating the app after deployment

### App content changes

Edit `pwa/index.html` (or `home.html` and re-copy it), then push to the repo. GitHub Pages / your host will pick up the change automatically.

### Forcing the service worker to update the cache

Bump the `CACHE_NAME` constant in `sw.js` (e.g. `az-learner-v1` → `az-learner-v2`). The old cache will be deleted automatically when the new service worker activates.

```js
// sw.js
const CACHE_NAME = 'az-learner-v2'; // ← increment this
```

### Updating manifest icons or shortcuts

Edit `pwa/manifest.json`. Users who have already installed the app will see the new manifest the next time they trigger a browser update check (usually within 24 hours).

---

## Testing the PWA locally

### Using a local server

Service workers require `localhost` or HTTPS. The fastest way is Python's built-in server:

```bash
# From the repo root
python3 -m http.server 8080
```

Then open: `http://localhost:8080/pwa/`

### Using VS Code Live Server

Install the **Live Server** extension, right-click `pwa/index.html` → *Open with Live Server*.

### Testing on a real device (not just desktop)

Service workers only run on `localhost` or HTTPS. To test the install prompt on a physical Android/iOS device during local development:

1. **Use ngrok** to expose your local server over HTTPS:

   ```bash
   # Install: https://ngrok.com/download
   python3 -m http.server 8080 &   # start local server
   ngrok http 8080                  # expose via HTTPS tunnel
   ```

   Then open the `https://xxxxx.ngrok-free.app/pwa/` URL on your device.

2. **Or use Chrome DevTools remote debugging** – connect your phone via USB, enable **Remote Devices** in `chrome://inspect`, and navigate to the `localhost` URL. Chrome on desktop proxies the request to the phone.



1. Open Chrome DevTools → **Lighthouse** tab.
2. Select **Progressive Web App** and click **Analyze page load**.
3. Aim for a score of 90+ in all categories.

### Simulating offline mode

1. Open DevTools → **Application** → **Service Workers**.
2. Check **Offline**.
3. Reload the page – the cached shell should load without a network connection.

---

## Checklist before going live

- [ ] **HTTPS is enabled** on the hosting domain (required for SW + install prompt)
- [ ] `pwa/manifest.json` validates without errors ([https://manifest-validator.appspot.com](https://manifest-validator.appspot.com))
- [ ] `pwa/sw.js` registers successfully (check DevTools → Application → Service Workers)
- [ ] Both icons (`icon-192.png`, `icon-512.png`) load correctly
- [ ] "Add to Home Screen" banner appears in Chrome on Android
- [ ] App loads correctly in standalone mode after installation
- [ ] Offline mode shows the cached shell instead of a browser error
- [ ] Lighthouse PWA score ≥ 90

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| Install banner doesn't appear | Not HTTPS / manifest not found / SW not registered | Check DevTools console for errors; ensure HTTPS |
| Service worker not registering | Wrong `scope` or MIME type | Verify `sw.js` is served as `application/javascript`; check `Service-Worker-Allowed` header |
| App shows blank page offline | Cache wasn't populated | Visit the page online at least once; clear site data and re-test |
| Old content served after update | Service worker still active | Bump `CACHE_NAME` in `sw.js` and redeploy |
| Icons not showing on iOS | Missing `apple-touch-icon` | Already added in `pwa/index.html`; ensure path `/pwa/icons/icon-192.png` is accessible |
| `base href` breaks a link | Absolute path needed | Prefix the specific link with the full URL or a `/`-rooted path |

---

*Generated for [azlearner.me](https://azlearner.me) — AZ Learner PWA*
