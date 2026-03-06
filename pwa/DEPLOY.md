# AZ Learner – Progressive Web App (PWA) Deployment Guide

This folder (`pwa/`) contains a fully installable Progressive Web App built on top of `home.html`.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell – copy of `home.html` with PWA meta tags and SW registration |
| `manifest.json` | Web App Manifest – controls install prompt, icons, theme colour, splash screen |
| `sw.js` | Service Worker – pre-caches the app shell; network-first fetch with offline fallback |
| `DEPLOY.md` | This guide |

---

## Prerequisites

- A **GitHub account** and a repository named `<username>.github.io` (or any repo with GitHub Pages enabled).
- The live site is already served over **HTTPS** – this is required for Service Workers to register.

---

## Deployment Steps

### 1 – Push to GitHub

If you haven't already, commit and push the entire repository (including the `pwa/` folder) to GitHub:

```bash
git add pwa/
git commit -m "feat: add PWA folder"
git push origin main
```

### 2 – Enable GitHub Pages

1. Go to your repository on GitHub.
2. Click **Settings → Pages**.
3. Under **Source**, choose **Deploy from a branch** and select `main` (or `master`) / `/ (root)`.
4. Click **Save**.

GitHub will build and publish your site at:
```
https://<username>.github.io/
```

The PWA will be available at:
```
https://<username>.github.io/pwa/
```

> **Custom domain?**  If you have a `CNAME` file in the repo (like this one), the site is served at the custom domain instead.  The PWA will then be at:
> `https://<your-domain>/pwa/`

### 3 – Verify HTTPS

Open the URL in your browser. Check the address bar – it **must** show a padlock 🔒. GitHub Pages enables HTTPS automatically. If you use a custom domain, enable **Enforce HTTPS** in Settings → Pages.

### 4 – Test the Manifest

1. Open Chrome DevTools (`F12`).
2. Go to **Application → Manifest**.
3. Confirm all fields are populated (name, icons, theme colour, start URL).

### 5 – Test the Service Worker

1. In DevTools go to **Application → Service Workers**.
2. After the first page load, the SW `sw.js` should show **Status: activated and running**.
3. Tick **Offline** in the Network tab, then reload – the app shell should still load.

### 6 – Install the PWA

**Desktop (Chrome / Edge)**
- An **Install** icon appears in the address bar. Click it and choose **Install**.

**Android (Chrome)**
- Chrome shows an **"Add to Home screen"** banner or you can use the browser menu → **Add to Home screen**.

**iOS (Safari)**
- Tap the **Share** button → **Add to Home Screen**.

---

## Customisation Checklist

- [ ] Verify `../app-icon.png` (already referenced in `manifest.json`) is properly masked – use the [Maskable.app Editor](https://maskable.app/editor) to preview it. Replace with a masked version if needed.
- [ ] Add a 192 × 192 icon variant to `manifest.json` for older Android Chrome versions.
- [ ] Update `"start_url"` in `manifest.json` if you deploy to a non-root path.
- [ ] Update the `PRECACHE_URLS` list in `sw.js` to include any extra offline-critical assets.
- [ ] Consider adding a **push notification** flow using the [Web Push API](https://web.dev/push-notifications-overview/) for re-engagement.

---

## Updating the App

When you push new code, the browser will detect that `sw.js` has changed (because the `CACHE_NAME` constant should be bumped) and will install the new Service Worker on the next page load.

**To force an update:**
1. Increment the cache version in `sw.js`:
   ```js
   const CACHE_NAME = 'az-learner-v2'; // bump this
   ```
2. Commit and push.
3. Users will receive the update the next time they open the app (after the new SW activates).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Install button doesn't appear | Confirm HTTPS, manifest is linked correctly, and all required manifest fields are present |
| Service Worker not registering | Check the browser console for errors; ensure the SW file is at `/pwa/sw.js` and the scope matches |
| Cached old version showing | Bump `CACHE_NAME` in `sw.js` and redeploy |
| iOS Safari "Add to Home Screen" shows blank icon | Provide an explicit `apple-touch-icon` link in `<head>` (already included) |

---

## Further Reading

- [web.dev – Progressive Web Apps](https://web.dev/progressive-web-apps/)
- [MDN – Web App Manifest](https://developer.mozilla.org/en-US/docs/Web/Manifest)
- [MDN – Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [GitHub Pages Documentation](https://docs.github.com/en/pages)
