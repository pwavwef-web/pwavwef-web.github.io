# AZ Learner — Contributor Advice & Developer Guide

> Practical guidance for anyone building on, contributing to, or maintaining this repository.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Code Style & Conventions](#code-style--conventions)
3. [Working with Firebase](#working-with-firebase)
4. [Adding New Pages](#adding-new-pages)
5. [Styling with Tailwind CSS](#styling-with-tailwind-css)
6. [Payments with Paystack](#payments-with-paystack)
7. [SEO Best Practices](#seo-best-practices)
8. [Deployment on GitHub Pages](#deployment-on-github-pages)
9. [Security Advice](#security-advice)
10. [Common Pitfalls](#common-pitfalls)
11. [Ambassador & Admin Features](#ambassador--admin-features)
12. [Accessibility Tips](#accessibility-tips)

---

## Getting Started

This is a **static HTML/CSS/JavaScript** site hosted on **GitHub Pages**. There is no build step or bundler — every file you edit is served directly to the browser.

1. **Clone the repository** and open any `.html` file in your browser or a local server.
2. Use a local dev server (e.g. VS Code Live Server extension or `npx serve .`) to avoid CORS issues when testing Firebase calls locally.
3. Read [`README.md`](README.md) for a feature overview, [`AMBASSADOR_README.md`](AMBASSADOR_README.md) for ambassador portal details, and [`FRANCIS_PRODUCTION_README.md`](FRANCIS_PRODUCTION_README.md) for the productions site brief.
4. Do **not** commit sensitive credentials (Firebase API keys intended to be private, admin passwords, etc.) directly into source files. Use Firestore Security Rules and Firebase Auth to enforce access control instead.

---

## Code Style & Conventions

### HTML

- Use semantic elements: `<main>`, `<section>`, `<article>`, `<nav>`, `<header>`, `<footer>`.
- Always set `lang="en"` on `<html>` and include a meaningful `<title>` and `<meta name="description">`.
- Follow the existing file-naming pattern: lowercase, hyphenated filenames (e.g. `privacy-policy.html`).
- Pages that belong to the AZ Learner ecosystem should load the same set of fonts (Inter, Poppins, etc.) already declared in `index.html` / `home.html`.

### JavaScript

- All JavaScript in this project is **vanilla ES5/ES6** — do not introduce a framework unless the scope of the change genuinely requires it.
- Prefer `const` and `let` over `var`.
- Namespace related logic in plain objects (e.g. `const portal = { ... }`) rather than polluting the global scope with many top-level functions.
- Async operations that touch Firebase should use `async/await` with a `try/catch` block so errors surface clearly in the console.
- Log meaningful error messages: `console.error('loadCourses:', err)` rather than swallowing errors silently.

### CSS / Tailwind

- Use Tailwind utility classes for all layout and styling — avoid writing standalone CSS files unless absolutely necessary.
- Responsive variants (`sm:`, `md:`, `lg:`) should be mobile-first: design the base state for mobile, then layer breakpoints for larger screens.
- Dark backgrounds are standard across the site (`bg-gray-900`, `bg-gray-950`, `bg-black`). Maintain this dark-mode aesthetic when adding new sections.

---

## Working with Firebase

The site uses **Firebase Firestore** for all dynamic data and **Firebase Auth** for user authentication. The Firebase config object is embedded inline in the HTML files. While the client-side Firebase config (API key, authDomain, projectId, etc.) is safe to expose publicly, **you must ensure Firestore Security Rules are correctly configured before deployment** — the config alone does not protect your data; the rules do.

### Firestore tips

- **Read the security rules before writing.** Public collections (e.g. `thoughts`, `courses`) allow unauthenticated reads; write access is restricted to the admin account. Mirror this pattern when you create new collections.
- **Batch related writes** using `writeBatch()` to keep Firestore data consistent — for example, when approving an ambassador, update both the `ambassadors` document and any related `users` document in a single batch.
- **Paginate large reads.** Use `startAfter()` / `limit()` when listing ambassadors or thoughts; avoid pulling entire collections in one query.
- **Use sub-collections** for per-document data that could grow unboundedly (e.g. `ambassadors/{id}/courseProgress` and `ambassadors/{id}/challengeProgress`) — this is already the pattern in the ambassador portal.
- **Cache common reads** in a module-level variable (e.g. `window._portalCourses`) to avoid redundant Firestore fetches on the same page load.

### Firebase Auth tips

- The admin guard pattern used across the site checks `currentUser.email === ADMIN_EMAIL`. Keep `ADMIN_EMAIL` in a single constant at the top of the file so it is easy to update.
- Always call `firebase.auth().onAuthStateChanged()` as the entry point for page initialisation — never assume the user is signed in on page load.
- Sign out the user and redirect to the sign-up page if they lack the required role. Never simply hide UI elements as the sole access control mechanism.

---

## Adding New Pages

1. Create the `.html` file in the repository root following the existing naming convention.
2. Copy the `<head>` block from a similar page (e.g. `home.html`) to inherit the correct fonts, favicon, Tailwind CDN link, and meta tags. Update `<title>`, `<meta name="description">`, and the canonical `<link>` for the new page.
3. Add the page to the **Pages** table in [`README.md`](README.md).
4. If the page is publicly accessible, add a link to it from an appropriate navigation location (e.g. the footer or the home page nav).
5. If the page is admin-only or ambassador-only, add the same Firebase Auth + role guard used by `ambassador.html` or `admin.html`.

---

## Styling with Tailwind CSS

Tailwind is loaded from the CDN — there is no Tailwind config file or purge step. This means:

- **Every utility class is available**, but the bundle is larger than a compiled project. Keep the CDN version in sync across all pages (check the `src` URL in any `<script>` tag that loads Tailwind).
- Avoid inventing custom colour names that differ from those already established:
  - `blue-500` / `blue-900` — primary accent (AZ Learner)
  - `amber-400` / `yellow-400` — highlights and CTAs
  - `gray-900` / `gray-950` / `black` — backgrounds
- Use `transition` and `duration-200` for hover/focus animations to keep interactions consistent with the rest of the site.
- Test on **mobile first** — the core audience accesses the platform on Android devices.

---

## Payments with Paystack

The site integrates **Paystack** for printing and other paid services.

- Always verify payment on the **server side** (or via a Cloud Function / webhook) before fulfilling an order. Never trust a client-side `success` callback alone.
- Use Paystack's test keys during development and swap to live keys only in production. Never commit live secret keys to the repository.
- Display clear payment summaries to the user before they are redirected to the Paystack checkout (amount, description, and breakdown).
- Handle payment failures gracefully: show a user-friendly error message and offer a retry option rather than leaving the user on a broken state.

---

## SEO Best Practices

Pages in this repo already follow good SEO practices. Maintain them when adding new pages:

- Include `<meta name="description">`, Open Graph tags (`og:title`, `og:description`, `og:image`, `og:url`), and Twitter Card tags.
- Add a `<link rel="canonical">` pointing to the production URL of the page.
- Use JSON-LD structured data (`<script type="application/ld+json">`) for pages that represent a software application, article, event, or person.
- Ensure `<meta name="robots" content="index, follow">` is set on all public pages. Add `noindex` to admin-only or draft pages.
- Use descriptive `alt` attributes on all `<img>` tags.
- Keep `<title>` tags unique per page and under 60 characters where possible.

---

## Deployment on GitHub Pages

The site is deployed automatically from the `main` branch via GitHub Pages.

- **Merging to `main` triggers a deployment** — test your changes locally before merging.
- The custom domain (`azlearner.me`) is configured in the `CNAME` file. Do not delete or modify `CNAME` unless you are intentionally changing the domain.
- All assets (images, `.apk` files, PDFs) are served from the repository root. Keep binary assets reasonably sized — large files slow down page loads and inflate repository size.
- If you add a page that should **not** be publicly indexed (e.g. an admin utility), add it to a `robots.txt` disallow rule or ensure it requires authentication before any content is rendered.

---

## Security Advice

- **Firestore Security Rules are your last line of defence.** Client-side role checks prevent accidental access; Firestore rules prevent malicious access. Always write rules that enforce the same access policy as your UI.
- Never expose Firebase **service-account** credentials or secret keys in any file in this repository. The Firebase client-side config (API key, authDomain, etc.) is safe to include — it is designed to be public and is protected by Firestore rules.
- Validate all user-supplied input before writing it to Firestore. At minimum, trim strings and check that required fields are non-empty.
- For the ambassador sign-up form, prevent duplicate submissions by checking whether a document with the applicant's email already exists before writing a new one.
- Keep dependencies (Tailwind CDN, Firebase SDK, Font Awesome, Paystack JS) up to date. Pin CDN URLs to an exact version (e.g. `firebase@10.7.1`) rather than `latest` or a range to avoid unexpected breaking changes.

---

## Common Pitfalls

| Pitfall | How to Avoid |
|---------|-------------|
| Firebase not initialised before a Firestore call | Always call `firebase.initializeApp(config)` before any `firebase.firestore()` reference. Wrap page logic in `onAuthStateChanged`. |
| Hardcoded course/challenge content going stale | Use Firestore as the source of truth where possible; the hardcoded fallback is for offline/first-load resilience only. |
| Tailwind classes not applying | The CDN version of Tailwind supports all classes out of the box — double-check for typos in class names. |
| GitHub Pages caching old versions | GitHub Pages CDN caches aggressively. Append a query string (e.g. `?v=2`) to asset URLs when you need cache-busting during a release. |
| Broken links after renaming a file | Search the whole repository for the old filename before renaming (`grep -r "old-name.html" .`). |
| `.apk` files making the repo too large | Store large binaries in a release artifact or a CDN and link to them rather than committing them directly. |

---

## Ambassador & Admin Features

- The **Ambassador Portal** (`ambassador.html`) is a protected single-page app. Follow the tab/view pattern documented in [`AMBASSADOR_README.md`](AMBASSADOR_README.md) when adding new sections.
- The **Admin Panel** (`admin.html`) is the only place where ambassador applications should be approved or rejected. Protect all admin writes with the `role === 'admin'` check.
- When adding a new ambassador feature, update both the **portal tab** (for ambassadors) and the **admin view** (so admins can manage the data) together.
- Always test the ambassador sign-up → approval → portal-login flow end-to-end when touching authentication or Firestore rules.

---

## Accessibility Tips

- Ensure sufficient color contrast between text and backgrounds (aim for WCAG AA — 4.5:1 for normal text).
- All interactive elements (`<button>`, `<a>`) should be reachable and operable via keyboard. Add `tabindex="0"` and `onkeydown` handlers to any `<div>` or `<span>` that behaves like a button.
- Use `aria-label` on icon-only buttons (e.g. close modals, share buttons) so screen readers convey their purpose.
- Modals and off-canvas panels should trap focus while open and restore focus to the trigger element when closed.
- Run a **Lighthouse audit** (Chrome DevTools → Lighthouse tab) on any new page before merging. Aim for Accessibility and SEO scores above 90.

---

*This document is intended to grow alongside the project. If you discover a pattern, pitfall, or best practice not covered here, add it in a PR so future contributors benefit from your experience.*
