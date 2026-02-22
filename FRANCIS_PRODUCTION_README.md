# Francis Pwavwe Productions — Website Development Prompt

> **"Clarity. Purpose. Production."**  
> A creative hub for content, ideas, and impact — built by Francis Pwavwe.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Site Goals](#site-goals)
3. [Planned Pages & Sections](#planned-pages--sections)
4. [Branding Guidelines](#branding-guidelines)
5. [Tech Stack](#tech-stack)
6. [Content Strategy](#content-strategy)
7. [Firestore / Backend Notes](#firestore--backend-notes)
8. [Integration Checklist](#integration-checklist)
9. [Roadmap](#roadmap)

---

## Project Overview

**Francis Pwavwe Productions** is the creative umbrella brand for all content, projects, and productions led by Francis Pwavwe — Tourism Management student, Cadet Leader, Podcaster, and builder of [AZ Learner](https://azlearner.me).

The production site is a **dedicated, standalone creative platform** that lives alongside the existing personal portfolio (`francis.html`) and the AZ Learner ecosystem. Its purpose is to centralise and professionally showcase:

- **Blue Mind Radio** — the podcast series exploring Gen Z culture, philosophy, and personal growth.
- **Blog / Thought pieces** — long-form written content on tourism, leadership, and life.
- **Video & Media Productions** — documentary, vlog, and short-form content.
- **Collaborations & Services** — a channel for brands and individuals to work with Francis.

> **Status:** Site not yet created. This document serves as the full development brief. When the site is ready, follow the [Integration Checklist](#integration-checklist) to link it into this repository.

---

## Site Goals

| Goal | Description |
|------|-------------|
| **Brand Authority** | Establish Francis Pwavwe Productions as a distinct, credible creative brand. |
| **Content Hub** | Centralise podcast episodes, blog posts, and video productions in one place. |
| **Audience Growth** | Drive listeners, readers, and viewers from the site to streaming and social platforms. |
| **Collaboration Pipeline** | Provide a clear, professional pathway for brands and collaborators to reach Francis. |
| **Showcase Work** | Display past productions, press features, and testimonials. |

---

## Planned Pages & Sections

### Core Pages

| File | Route | Purpose |
|------|-------|---------|
| `fp-index.html` | `/fp-index.html` or its own domain | Landing / hero page |
| `fp-about.html` | `/fp-about.html` | The story of Francis Pwavwe Productions |
| `fp-podcast.html` | `/fp-podcast.html` | Blue Mind Radio — full episode archive |
| `fp-blog.html` | `/fp-blog.html` | Written pieces — "Thoughts" long-form |
| `fp-productions.html` | `/fp-productions.html` | Video and media production portfolio |
| `fp-collaborate.html` | `/fp-collaborate.html` | Collaboration / booking enquiry page |
| `fp-contact.html` | `/fp-contact.html` | Contact form and social links |

### Sections within the Landing Page (`fp-index.html`)

1. **Hero** — Full-screen, cinematic intro. Tagline, name, and two CTAs: *Listen Now* and *Work With Me*.
2. **About Snippet** — Two-paragraph teaser with a link to the full About page.
3. **Latest Episode** — Auto-pulled latest Blue Mind Radio episode card (from Firestore or RSS).
4. **Featured Thought** — Most recent blog/thought-piece card.
5. **Productions Reel** — Auto-playing muted loop or thumbnail grid of video productions.
6. **Collaborators & Press** — Logo bar of past partners or press mentions.
7. **Newsletter / Subscribe** — Email capture (name + email) fed to a Firestore `subscribers` collection.
8. **Footer** — Social links, copyright, and links to AZ Learner and the personal portfolio.

---

## Branding Guidelines

The production site should feel **cinematic, premium, and intentional** — distinct from the academic tone of AZ Learner yet consistent with the personal portfolio's colour palette.

### Colour Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `fp-dark` | `#0a0a0f` | Page background (near-black) |
| `fp-primary` | `#1e40af` | Primary accents (inherited from portfolio) |
| `fp-gold` | `#fbbf24` | Highlight / "Productions" wordmark accent |
| `fp-accent` | `#6366f1` | Interactive elements, hover states |
| `fp-light` | `#f8fafc` | Body text on dark backgrounds |
| `fp-muted` | `#94a3b8` | Subtext and captions |

### Typography

| Role | Font | Weight |
|------|------|--------|
| Display / Hero | Poppins | 700, 800 |
| Body | Inter | 300, 400 |
| Pull-quotes | Playfair Display (italic) | 400 |

> All three fonts are already loaded in `francis.html` via Google Fonts — reuse the same `<link>` tags.

### Logo & Wordmark

- **Primary mark:** "FRANCIS PWAVWE" in Poppins 800, followed by `PRODUCTIONS` in Poppins 500, letter-spaced, with `PRODUCTIONS` rendered in `fp-gold`.
- **Icon mark:** A stylised microphone silhouette or film-frame — to be designed and saved as `fp-logo.svg`.
- **Favicon:** Reuse or adapt `brand.png` / `favicon.png` until a production-specific favicon is ready.

### Tone & Voice

- **Confident, thoughtful, and warm.** Not hype-driven.
- Copy should feel like it comes from someone who has *thought deeply* about their work.
- Avoid corporate jargon; write the way Francis speaks on Blue Mind Radio.

---

## Tech Stack

Maintain consistency with the existing site stack to simplify maintenance:

| Layer | Choice | Notes |
|-------|--------|-------|
| Markup | HTML5 | Semantic, accessible markup |
| Styling | Tailwind CSS (CDN) | Same config as `francis.html` — dark mode via `class` strategy |
| Icons | Lucide (unpkg CDN) | Already used across the portfolio |
| Scripting | Vanilla JavaScript (ES modules) | No framework needed |
| Backend / DB | Firebase Firestore | Same project: `francis-pwavwe` |
| Auth | Firebase Auth | Admin-only episode/post publishing (reuse pattern from `francis.html`) |
| Hosting | GitHub Pages | Deployed from this repository via the existing CNAME / Pages config |
| Payments *(future)* | Paystack | For paid content or exclusive episodes |

### Firebase Collections to Reuse / Extend

| Collection | Use |
|-----------|-----|
| `thoughts` | Blog posts (already used in `francis.html`) |
| `podcast_episodes` | Blue Mind Radio episodes — add if not already present |
| `subscribers` | Newsletter email captures |
| `collaborations` | Collaboration enquiry submissions |
| `productions` | Video/media project entries |

---

## Content Strategy

### Blue Mind Radio (Podcast)

- Each episode stored as a Firestore document in `podcast_episodes`:
  ```json
  {
    "title": "Episode Title",
    "episode": 12,
    "season": 1,
    "description": "A brief summary...",
    "coverImage": "https://...",
    "audioUrl": "https://...",
    "spotifyUrl": "https://open.spotify.com/...",
    "applePodcastsUrl": "https://podcasts.apple.com/...",
    "youtubeUrl": "https://youtube.com/...",
    "publishedAt": "<Firestore Timestamp>",
    "tags": ["Gen Z", "Philosophy", "Growth"],
    "isPublished": true
  }
  ```
- The landing page pulls the single latest `isPublished: true` episode.
- `fp-podcast.html` renders all episodes in reverse-chronological order with a search/filter by tag.

### Blog / Thoughts

- Reuse the existing `thoughts` Firestore collection (already powering `francis.html`).
- `fp-blog.html` renders all published thoughts, filtered to `category !== 'Podcast'` to separate written posts from episode notes.

### Productions

- Each production stored in a `productions` collection:
  ```json
  {
    "title": "Project Title",
    "type": "Documentary | Short Film | Vlog | Ad | Photo Series",
    "description": "What it is and why it was made...",
    "thumbnailUrl": "https://...",
    "videoUrl": "https://youtube.com/...",
    "client": "Self / Brand Name",
    "year": 2025,
    "isPublished": true
  }
  ```

---

## Firestore / Backend Notes

- **Firebase Project:** `francis-pwavwe` (projectId already in `francis.html`) — no new project needed.
- **Admin Auth:** Protect publish/delete actions behind `ADMIN_EMAIL = 'pwavwef@gmail.com'` (same guard used in `francis.html`).
- **Security Rules:** Ensure Firestore rules allow public `read` on `podcast_episodes`, `thoughts`, and `productions` (already the case for `thoughts`); restrict `write` to authenticated admin.
- **CORS / Storage:** If self-hosting audio files, configure Firebase Storage CORS rules to allow playback from `azlearner.me` and any production domain.

---

## Integration Checklist

Follow these steps once the Francis Pwavwe Productions site is built and ready to integrate:

- [ ] Add all new `.html` files to the repository root (e.g., `fp-index.html`, `fp-podcast.html`, etc.)
- [ ] Add any new image/media assets (logos, thumbnails) to the repository root or a `/fp-assets/` subfolder
- [ ] Add the new page(s) to the **Pages** table in `README.md`
- [ ] Add a navigation link from `francis.html` hero / footer pointing to `fp-index.html` (or the production domain)
- [ ] Add a reciprocal link from the productions site back to `francis.html` and `azlearner.me`
- [ ] Update `CNAME` if the productions site uses a custom subdomain (e.g., `productions.francispwavwe.com`)
- [ ] Verify all Firestore collection names match those documented above
- [ ] Test dark-mode compatibility and mobile responsiveness across all new pages
- [ ] Run a Lighthouse audit (Performance, Accessibility, SEO) and resolve any critical issues
- [ ] Confirm Firebase Auth admin guard works correctly on any admin-only write operations
- [ ] Push to the `main` branch and confirm GitHub Pages deployment is successful

---

## Roadmap

- [ ] Design and finalise the `fp-logo.svg` wordmark / icon mark
- [ ] Build `fp-index.html` — hero, about snippet, latest episode, featured thought, and footer
- [ ] Build `fp-podcast.html` — full Blue Mind Radio episode archive with Firestore integration
- [ ] Build `fp-blog.html` — written thought-pieces feed (reusing `thoughts` collection)
- [ ] Build `fp-productions.html` — video and media portfolio grid
- [ ] Build `fp-collaborate.html` — collaboration enquiry form (writes to `collaborations` collection)
- [ ] Build `fp-about.html` — extended brand story and mission statement
- [ ] Add newsletter subscribe widget (writes to `subscribers` collection)
- [ ] Integrate full site into this repository (see [Integration Checklist](#integration-checklist))
- [ ] Set up custom subdomain or dedicated domain for the productions site
- [ ] Add productions site link to `francis.html` portfolio
- [ ] Launch announcement — publish a Blue Mind Radio episode and blog post about the new site
