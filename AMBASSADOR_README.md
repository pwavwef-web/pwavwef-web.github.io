# AZ Ambassador Program — Developer & Program Guide

> A reference for building, expanding, and improving the AZ Learner Ambassador Program pages, training courses, and platform engagement.

---

## Table of Contents

1. [Overview](#overview)
2. [Ambassador Program Pages](#ambassador-program-pages)
3. [Course Development](#course-development)
4. [Improving Platform Engagement](#improving-platform-engagement)
5. [Firestore Data Structure](#firestore-data-structure)
6. [Roadmap](#roadmap)

---

## Overview

The AZ Ambassador Program empowers students to represent AZ Learner on their campuses. Ambassadors promote the platform, organize events, collect peer feedback, and mentor fellow students. In return they receive leadership experience, early access to new features, and exclusive training resources.

This document guides developers and program managers on:

- How the ambassador-facing pages are built and how to extend them.
- How to create and publish training courses inside the portal.
- Strategies to increase ambassador and student engagement on the platform.

---

## Ambassador Program Pages

### Current Pages

| File | Purpose |
|------|---------|
| `ambassador.html` | Protected portal — profile, programs, courses, and leaderboard tabs |
| `ambassadorsignup.html` | Public sign-up form for prospective ambassadors |
| `courses.html` | Public standalone courses page — all 4 training courses with hardcoded modules |
| `leaderboard.html` | Public ambassador leaderboard — queries Firestore `ambassadors` ordered by `achievementPoints` |

### Portal Architecture (`ambassador.html`)

The portal is a single-page application built with **Tailwind CSS** and **Firebase**. It uses a tab-switching pattern with four views:

| Tab ID | View ID | Content |
|--------|---------|---------|
| `tab-profile` | `view-profile` | Ambassador profile card + stats |
| `tab-programs` | `view-programs` | Upcoming / past ambassador programs |
| `tab-courses` | `view-courses` | Training courses with hardcoded modules (Firestore override supported) |
| `tab-leaderboard` | `view-leaderboard` | Top ambassadors ranked by `achievementPoints` + monthly challenge |

#### Adding a New Tab

1. Add a button inside the tab-navigation `<div>` following the existing pattern:

   ```html
   <button onclick="portal.switchTab('resources')" id="tab-resources"
       class="portal-tab px-4 py-2 rounded text-xs font-bold transition text-gray-400 hover:text-white whitespace-nowrap">
       <i class="fa-solid fa-folder"></i> Resources
   </button>
   ```

2. Add the corresponding view `<div>` inside the tab-content wrapper:

   ```html
   <div id="view-resources" class="portal-view hidden">
       <!-- content here -->
   </div>
   ```

3. The existing `portal.switchTab()` function handles show/hide and active-button styling automatically — no JavaScript changes are needed.

#### Authentication & Access Control

The portal enforces two levels of access via Firebase Auth + Firestore:

- **Admin** — matched against `users/{uid}` where `role === 'admin'`. Automatically granted ambassador status.
- **Ambassador** — matched against the `ambassadors` collection by email. Must be manually approved.

Any other authenticated user is signed out and directed to the sign-up page.

### Sign-Up Flow (`ambassadorsignup.html`)

Submitted applications are written to the `ambassadors` Firestore collection with a status of `pending`. An admin must set `status: 'approved'` (via `admin.html`) before the applicant can log in to the portal.

---

## Course Development

The **Training & Resources** tab (`view-courses`) displays four course cards loaded from the `HARDCODED_COURSES` array in `ambassador.html`. When Firestore has published courses they take precedence; when it returns empty the hardcoded data is used automatically as a reliable fallback.

### Hardcoded Courses (`HARDCODED_COURSES` in `ambassador.html`)

| ID | Title | Color | Icon | Modules |
|----|-------|-------|------|---------|
| `marketing-outreach` | Marketing & Outreach | blue | bullhorn | 3 |
| `leadership-development` | Leadership Development | orange | users | 3 |
| `communication-skills` | Communication Skills | green | comments | 3 |
| `event-planning` | Event Planning | purple | calendar-check | 3 |

Each module has `order`, `title`, `type`, and `content` fields. Clicking a course card opens a **course detail modal** (`#course-modal`) that renders the modules as expandable `<details>` accordions.

### Standalone Courses Page (`courses.html`)

A public-facing page at `/courses.html` lists all four courses with fully expanded module content in styled accordions. It links to the Ambassador Portal for sign-in and to `ambassadorsignup.html` for new applications.

### Course Card Structure

Each course card in the grid follows this HTML template:

```html
<div class="bg-{color}-900/20 border border-{color}-500/30 rounded-xl p-6 hover:border-{color}-500/50 transition cursor-pointer"
     onclick="portal.openCourse('{courseId}')">
    <div class="flex items-start gap-4">
        <div class="bg-{color}-500/20 p-3 rounded-lg">
            <i class="fas fa-{icon} text-{color}-400 text-2xl"></i>
        </div>
        <div>
            <h3 class="text-lg font-bold text-white mb-1">{Course Title}</h3>
            <p class="text-sm text-gray-400 mb-3">{Short description}</p>
            <div class="flex items-center gap-3">
                <span class="text-xs text-{color}-400 font-bold">{Duration}</span>
                <span class="text-xs text-gray-500">{Module count} modules</span>
            </div>
        </div>
    </div>
</div>
```

Replace `{color}` with a Tailwind color name (`blue`, `orange`, `green`, `purple`, etc.) and update the other placeholders.

### Storing Course Content in Firestore

Create a `courses` collection with documents structured as follows:

```json
{
  "id": "marketing-outreach",
  "title": "Marketing & Outreach",
  "description": "Learn how to effectively promote AZ Learner on campus",
  "color": "blue",
  "icon": "bullhorn",
  "duration": "2 hrs",
  "modules": [
    {
      "order": 1,
      "title": "Understanding Your Audience",
      "type": "text",
      "content": "..."
    },
    {
      "order": 2,
      "title": "Social Media Basics",
      "type": "video",
      "url": "https://..."
    }
  ],
  "publishedAt": "<Firestore Timestamp>",
  "isPublished": true
}
```

When `isPublished` is `true`, the portal will load these Firestore documents instead of the hardcoded fallback.

### Loading Courses Dynamically

The `loadCourses()` function in `ambassador.html` already supports dynamic loading. It queries Firestore first; if the result is empty it falls back to `HARDCODED_COURSES`. No additional code changes are needed to publish a course — simply add it to Firestore with `isPublished: true`.

> **Note — Tailwind CSS:** Tailwind's JIT compiler only includes classes it can detect as complete strings at build time. Because the portal loads Tailwind from a CDN at runtime (not a build step), dynamic class names via template literals work fine in this project. If you ever switch to a build-time Tailwind setup, use the pre-defined `COLOR_CLASSES` mapping object in `loadCourses()` instead of string interpolation.

### Tracking Course Progress

Add a `courseProgress` sub-collection under each ambassador document:

```
ambassadors/{ambassadorId}/courseProgress/{courseId}
  completedModules: [1, 2]
  startedAt: <Timestamp>
  completedAt: <Timestamp> | null
```

Display a progress bar on each course card and update `stat-courses` to show completed vs available counts.

---

## Improving Platform Engagement

### Ambassador Engagement

| Strategy | Status | Implementation |
|----------|--------|---------------|
| **Points & Badges** | 🟡 Partial | `achievementPoints` field exists in Firestore schema. Profile stat card displays the value. Award logic (program attendance, course completion, referrals) to be wired up server-side or via Cloud Functions. |
| **Leaderboard tab** | ✅ Done | `tab-leaderboard` / `view-leaderboard` added to the portal. Queries ambassadors ordered by `achievementPoints` descending. Public page at `leaderboard.html`. |
| **Monthly challenges** | ✅ Done (UI) | Monthly challenge banner implemented in `view-leaderboard` and `leaderboard.html`. Dynamic challenge data from a `challenges` Firestore collection to be wired up next. |
| **Progress notifications** | 🔴 Pending | Use Firebase Cloud Messaging (FCM) or email to notify ambassadors of upcoming programs, new courses, and leaderboard changes. |
| **Peer recognition** | 🔴 Pending | Allow ambassadors to nominate peers for a "Spotlight" badge via a lightweight nomination form inside the portal. |

### Student Engagement

| Strategy | Status | Implementation |
|----------|--------|---------------|
| **Referral tracking** | 🔴 Pending | Give each ambassador a unique referral code. Track sign-ups attributed to each code in Firestore and reward top referrers. |
| **Course Circles** | 🔴 Pending | Ambassadors host virtual or in-person study circles around specific courses. They mark attendance; attendance data feeds their achievement points. |
| **Campus events feed** | 🔴 Pending | Ambassadors post mini campus events from the portal. Events appear in the student-facing `home.html` events section automatically via a shared `events` collection. |
| **Feedback loops** | 🔴 Pending | Add a short in-portal survey (1–3 questions) after each program to collect NPS scores. Surface aggregate results to admins in `admin.html`. |
| **Social sharing** | 🔴 Pending | Generate shareable ambassador profile cards (Canvas API or a styled static page) so ambassadors can post on Instagram / TikTok and drive sign-ups. |

### Content & Communication

- Publish a fortnightly **Ambassador Digest** (email or WhatsApp broadcast) summarising new courses, upcoming programs, top performers, and platform updates.
- Maintain a **changelog** inside the portal (a `changelog` Firestore collection) so ambassadors always know what's new.
- Create short video walkthroughs (≤ 90 seconds) for each new feature and embed them in the relevant course module or program description.

---

## Firestore Data Structure

```
users/
  {uid}/
    role: 'admin' | 'user'
    name: string
    email: string

ambassadors/
  {docId}/
    email: string
    name: string
    university: string
    major: string
    year: string
    gpa: string
    phone: string
    dob: string
    socialMedia: string
    status: 'pending' | 'approved' | 'rejected'
    approvedAt: Timestamp
    approvedBy: string
    achievementPoints: number
    courseProgress/          ← sub-collection
      {courseId}/
        completedModules: number[]
        startedAt: Timestamp
        completedAt: Timestamp | null

ambassador_programs/
  {docId}/
    title: string
    description: string
    date: string (ISO-8601)
    link: string
    createdAt: Timestamp

courses/
  {courseId}/
    title: string
    description: string
    color: string
    icon: string
    duration: string
    isPublished: boolean
    publishedAt: Timestamp
    modules: Module[]

challenges/
  {challengeId}/
    title: string
    month: string (YYYY-MM)
    tasks: Task[]
    bonusBadge: string
```

---

## Roadmap

- [x] Publish first four training courses with three modules each (hardcoded in `ambassador.html` + standalone `courses.html`)
- [x] Implement dynamic course loading from Firestore (with hardcoded fallback)
- [x] Add course detail modal with expandable module accordions
- [x] Build leaderboard tab in portal (`view-leaderboard`) and public page (`leaderboard.html`)
- [x] Add monthly challenge UI to leaderboard views
- [ ] Wire up `achievementPoints` awards (program attendance, course completion, referrals)
- [ ] Add course-progress tracking per ambassador
- [ ] Launch referral-code tracking for student sign-ups
- [ ] Add in-portal program feedback surveys
- [ ] Enable ambassador-posted campus events visible on `home.html`
- [ ] Set up monthly challenge missions (dynamic from `challenges` Firestore collection)
- [ ] Generate shareable ambassador profile cards
- [ ] Send fortnightly Ambassador Digest via email / WhatsApp broadcast

