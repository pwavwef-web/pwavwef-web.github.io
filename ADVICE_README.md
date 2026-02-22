# AZ Learner — Advice & Best Practices

> Practical guidance for developers, contributors, and platform managers working on AZ Learner.

---

## Table of Contents

1. [Contributing to the Codebase](#contributing-to-the-codebase)
2. [HTML & Tailwind CSS Best Practices](#html--tailwind-css-best-practices)
3. [JavaScript Guidelines](#javascript-guidelines)
4. [Firebase & Firestore Tips](#firebase--firestore-tips)
5. [Performance Optimisation](#performance-optimisation)
6. [Security Checklist](#security-checklist)
7. [Accessibility & Mobile UX](#accessibility--mobile-ux)
8. [GitHub Pages Deployment](#github-pages-deployment)
9. [Feature Development Advice](#feature-development-advice)
10. [Platform Growth Tips](#platform-growth-tips)

---

## Contributing to the Codebase

### Before You Start

- Read `README.md`, `AMBASSADOR_README.md`, and `FRANCIS_PRODUCTION_README.md` first.
- Familiarise yourself with the existing page structure — all pages live in the repository root and share the same Tailwind CDN setup.
- Clone the repo and open pages in a local browser before making changes. There is no build step — just open the `.html` file directly or use a simple local server (`python3 -m http.server 8080`).

### Branching & Pull Requests

- Work on a feature branch, not directly on `main`.
- Name branches clearly: `feature/course-progress`, `fix/leaderboard-sort`, `content/new-faq-entries`.
- Write a short description in your PR explaining *what* changed and *why*.
- Test your changes on both desktop and a real (or simulated) mobile device before opening a PR.

### File Naming

- New pages follow lowercase, hyphen-separated naming: `my-new-page.html`.
- New README / documentation files follow `SCREAMING_SNAKE_CASE.md` to stay consistent with `AMBASSADOR_README.md`.
- Keep all assets (images, APKs, PDFs) in the repository root unless there is a clear reason to create a subfolder.

### After Adding a Page

- Add the new page to the **Pages** table in `README.md`.
- Ensure the page has a `<meta name="description">` tag for SEO.
- Add a `<link rel="icon" type="image/png" href="favicon1.png">` line to keep the favicon consistent.

---

## HTML & Tailwind CSS Best Practices

### Consistency

- Use Tailwind via the CDN (`https://cdn.tailwindcss.com`) on every page — do **not** mix in a separately compiled stylesheet.
- Define the Tailwind config block (`tailwind.config = { ... }`) at the top of each page's `<script>` section when you need custom colours or dark-mode settings.
- Stick to the existing colour tokens (`blueAccent`, `orangeAccent`, `darkBg`, `darkCard`) rather than introducing arbitrary hex values in Tailwind classes.

### Semantic Markup

- Use the correct HTML element for its purpose: `<nav>`, `<main>`, `<section>`, `<article>`, `<aside>`, `<header>`, `<footer>`.
- Wrap interactive controls in `<button>` (not `<div onclick="...">`) so they are keyboard-focusable by default.
- Always include `alt` text on `<img>` tags — even `alt=""` for decorative images.

### Dark Mode

- The platform defaults to dark backgrounds. When adding a new page, use `bg-slate-900` or `bg-[#0f172a]` as the base page colour.
- Test every new element in both light and dark contexts if dark-mode toggling is present on that page.

### Forms

- Every `<input>` must have a matching `<label>` (even if visually hidden) for screen-reader support.
- Use `type="email"`, `type="tel"`, `type="number"` etc. to trigger the correct keyboard on mobile.
- Disable the submit button while a form is being processed to prevent double submissions.

---

## JavaScript Guidelines

### General

- All JavaScript is vanilla ES-module style — avoid importing large libraries unless absolutely necessary.
- Keep business logic out of inline `onclick="..."` attributes. Register event listeners in a `<script>` block or an external `.js` file instead.
- Use `const` by default; only use `let` when reassignment is required. Avoid `var`.

### Firebase SDK

- Load the Firebase SDK from the official CDN (`https://www.gstatic.com/firebasejs/`) and pin to an exact version number (e.g., `9.15.0`) to prevent unexpected breaking changes from minor or patch updates.
- Initialise Firebase once at the top of the page and reuse the `db` / `auth` references throughout — do not call `initializeApp()` more than once per page.
- Wrap all Firestore reads and writes in `try / catch` blocks and surface meaningful error messages to the user.

### Async / Await

- Prefer `async / await` over long `.then()` chains — it is easier to read and debug.
- Always `await` Firestore writes before updating the UI to confirm that the data was saved successfully.

### Error Handling

```js
// ✅ Good
try {
    await addDoc(collection(db, 'ambassadors'), formData);
    showSuccess('Application submitted!');
} catch (err) {
    console.error('Firestore write failed:', err);
    showError('Something went wrong. Please try again.');
}

// ❌ Avoid — silent failure
addDoc(collection(db, 'ambassadors'), formData);
showSuccess('Application submitted!');
```

---

## Firebase & Firestore Tips

### Data Modelling

- Keep top-level collections flat where possible. Avoid deep nesting beyond one sub-collection level (e.g., `ambassadors/{id}/courseProgress/{courseId}` is fine; going deeper adds query complexity).
- Store timestamps as Firestore `Timestamp` objects, not as plain strings. Use `serverTimestamp()` for write events so timestamps are consistent across time zones.
- Use `isPublished: boolean` fields to draft content without exposing it to users — this is already the pattern for courses and podcast episodes.

### Security Rules

- **Never** ship with open read/write rules (`allow read, write: if true`). The existing project uses Firebase Auth to guard writes — preserve this pattern on all new collections.
- Rule of thumb: public content (`courses`, `thoughts`, `ambassador_programs`) can be read by anyone but written only by authenticated admins. User-specific data (`ambassadors/{id}/challengeProgress`) should be readable/writable only by the owning user or an admin.
- Review and test your Firestore security rules in the Firebase Console > Rules Playground before deploying.

### Pagination

- Firestore queries are fast for small datasets, but as the platform grows, add `.limit(20)` to list queries and implement cursor-based pagination with `startAfter()` to avoid loading entire collections at once.

### Offline Support

- Consider enabling Firestore offline persistence (`enableIndexedDbPersistence(db)`) for the ambassador portal — ambassadors in areas with poor connectivity will still be able to view their profile and course content.

---

## Performance Optimisation

### Page Load

- Avoid loading scripts that are not needed on a given page. For example, do not include `paystack.js` on pages that have no payment functionality.
- Defer non-critical scripts with `defer` or `async` attributes on the `<script>` tag.
- Compress images before committing them. Use WebP format where possible — it is supported by all modern browsers and is significantly smaller than JPEG or PNG.
- The APK files (`app.apk`, `appv2.0.apk`) are large binary files. Consider hosting them on a dedicated file host and linking to them instead of storing them in the Git repository to keep clone sizes small.

### Tailwind CDN

- The CDN version of Tailwind includes every utility class, which is large. For production, consider switching to the Tailwind CLI build that tree-shakes unused classes — this can reduce CSS payload by over 90%.

### Fonts

- Google Fonts are loaded on most pages. Reduce the number of font weights you request:
  ```html
  <!-- Instead of loading 5 weights... -->
  <link href="...?family=Roboto:wght@300;400;500;700;900" rel="stylesheet">
  <!-- ...only load what you use -->
  <link href="...?family=Roboto:wght@400;700" rel="stylesheet">
  ```
- Add `&display=swap` to all Google Fonts URLs so text is shown immediately in a system font while the custom font loads.

### Caching

- GitHub Pages sets `Cache-Control` headers automatically. Ensure asset filenames include a version number when you release updated versions (e.g., rename `app.apk` to `appv2.1.apk` when releasing a patch update) so users always get the latest file.

---

## Security Checklist

### Credentials & API Keys

- **Do not commit Firebase config objects with unrestricted API keys.** The Firebase web config (`apiKey`, `projectId`, etc.) visible in client-side code is acceptable *only* when Firebase Security Rules are properly set up. Never expose service account credentials (JSON key files) in the repository.
- Audit `.gitignore` to ensure no `.env` files, service account keys, or secrets are tracked.

### User Input

- Sanitise all user-supplied content before rendering it in the DOM. Use `element.textContent = value` instead of `element.innerHTML = value` when inserting untrusted text to prevent XSS attacks.
- On forms submitted to Firestore, validate inputs on the client *and* enforce constraints in Firestore Security Rules.

### Admin Pages

- `admin.html` and `cvadmin.html` should remain authentication-gated. Double-check that the Firebase Auth guard runs *before* any sensitive UI or data is displayed.
- Consider adding an explicit sign-out button and session timeout on admin pages.

### Dependency Hygiene

- CDN-loaded libraries (Tailwind, Firebase, Paystack, Font Awesome) are loaded over HTTPS — always verify the URL is from the official CDN and includes an exact version number (e.g., `6.4.0`) rather than a floating `@latest` tag.

---

## Accessibility & Mobile UX

### Accessibility

- Aim for a minimum contrast ratio of 4.5:1 between text and background colours. Check with the [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/).
- All interactive elements should be reachable via keyboard (`Tab`) and activatable via `Enter` / `Space`.
- Use ARIA roles sparingly — they are only needed when HTML semantics are insufficient (e.g., `role="dialog"` on a custom modal).

### Mobile

- The platform is primarily used on mobile. Always test new pages on a 375 px viewport (iPhone SE) and a 390 px viewport (iPhone 14).
- Avoid fixed-height containers that can cause content to overflow on small screens.
- Use safe-area insets (`env(safe-area-inset-bottom)`) in `padding-bottom` for sticky footer bars, as already done in `home.html`.
- Touch targets (buttons, links) should be at least 44 × 44 px.

### PWA Potential

- The site is close to being a Progressive Web App (PWA). Adding a `manifest.json` and a minimal service worker would enable "Add to Home Screen" on Android and iOS — a significant improvement for regular users who currently use the `.apk` sideload.

---

## GitHub Pages Deployment

- The site is deployed automatically from the `main` branch via GitHub Pages. Every push to `main` is live within 1–2 minutes.
- The custom domain is configured in `CNAME`. Do not delete or rename this file.
- To test deployment, wait for the GitHub Pages build action to complete in the **Actions** tab before verifying changes on the live URL.
- If a page appears broken after a push, hard-refresh the browser (`Ctrl + Shift + R` / `Cmd + Shift + R`) to bypass the browser cache.

---

## Feature Development Advice

### Start Simple

- Build the simplest version of a feature first, ship it, and then iterate based on real user feedback. The hardcoded course fallback pattern in `ambassador.html` is a great example — it shipped a working feature without waiting for a Firestore content pipeline.

### Reuse Existing Patterns

- The tab-switching pattern used in `ambassador.html` (one content `<div>` per tab, show/hide via JavaScript) is already well-understood by the codebase — reuse it for any new multi-view page.
- The admin-email guard pattern (`if (user.email !== ADMIN_EMAIL) signOut(auth)`) is consistent across admin pages — maintain this consistency.

### Versioning the APK

- When releasing a new version of the Android app, update the filename (e.g., `appv2.0.apk` → `appv3.0.apk`) and update all references in `app.html`. Do not overwrite an existing APK file in-place.

### Testing Changes

- Open the modified `.html` file directly in Chrome DevTools with the **Network** tab open to confirm that all CDN resources load correctly and no 404 errors appear.
- Use the **Application** tab in Chrome DevTools to inspect Firestore reads/writes via the Firebase debug view if you enable `firebase.firestore.setLogLevel('debug')` during local development (remove before committing).

---

## Platform Growth Tips

### For Students

- Make the printing and delivery feature the primary CTA on the landing page — it solves an immediate, concrete problem and drives initial sign-ups.
- Add social proof (number of print jobs completed, number of students served) to `index.html` to build trust with first-time visitors.
- A simple onboarding checklist on `home.html` (e.g., "Set up your profile → Join a Course Circle → Try printing") reduces drop-off for new users.

### For Ambassadors

- Ambassadors are most engaged when they see their actions lead to visible, shareable results. Keep the leaderboard visible and add a personal "monthly impact" summary card that ambassadors can screenshot and share.
- Recognise ambassadors publicly — a "Top Ambassador of the Month" section on `ambassador.html` or a dedicated social post builds motivation.
- Reduce friction in the sign-up flow (`ambassadorsignup.html`) — every extra field costs applicants. Consider a two-step form: collect name, email, and university first; gather detailed info after provisional acceptance.

### For the Team

- Maintain a short internal changelog (Firestore `changelog` collection or a `CHANGELOG.md` in this repository) so team members always know what shipped and what is in progress.
- Use GitHub Issues to track bugs and feature requests — a labelled issue board is easier to manage than a chat thread.
- Schedule a short monthly review: check Firestore usage, review ambassador activity, and pick the top two–three platform improvements to ship that month.
