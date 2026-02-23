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
| `ambassador.html` | Protected portal — profile, programs, courses, leaderboard, and challenges tabs |
| `ambassadorsignup.html` | Public sign-up form for prospective ambassadors |
| `courses.html` | Standalone courses overview — all 4 courses with hardcoded modules (no login required) |
| `leaderboard.html` | Standalone leaderboard page with peer-recognition nomination form and social sharing |
| `challenges.html` | Standalone monthly challenges page with task tracking, badges, and progress bar |

### Portal Architecture (`ambassador.html`)

The portal is a single-page application built with **Tailwind CSS** and **Firebase**. It uses a tab-switching pattern with five views:

| Tab ID | View ID | Content |
|--------|---------|---------|
| `tab-profile` | `view-profile` | Ambassador profile card + stats |
| `tab-programs` | `view-programs` | Upcoming / past ambassador programs |
| `tab-courses` | `view-courses` | Training courses with hardcoded module fallback |
| `tab-leaderboard` | `view-leaderboard` | Live leaderboard ranked by `achievementPoints` |
| `tab-challenges` | `view-challenges` | Monthly challenge tasks with progress tracking |

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

The **Training & Resources** tab (`view-courses`) loads courses from the Firestore `courses` collection. When Firestore returns no published courses, it automatically falls back to four **hardcoded courses** with complete module content. The same four courses (with all modules) are available on the standalone `courses.html` page without authentication.

### Hardcoded Courses

| Course | Modules | Color | Icon |
|--------|---------|-------|------|
| Marketing & Outreach | Understanding Your Audience · Social Media Strategy · Campus Tabling & Flyers · Measuring Your Impact | blue | bullhorn |
| Leadership Development | Leadership Styles & Principles · Running Effective Study Groups · Peer Mentoring Techniques · Conflict Resolution | orange | users |
| Communication Skills | Foundations of Effective Communication · Public Speaking Fundamentals · Digital & Written Communication · Active Listening | green | comments |
| Event Planning | Event Planning Basics · Promoting Your Event · Running Virtual Study Sessions · Post-Event Follow-Up | purple | chart-line |

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

### Opening a Course

`portal.openCourse(courseId)` looks up the course from `window._portalCourses` (populated by `loadCourses()`) and renders an accordion modal with all modules. Each module header expands to reveal the full module text when clicked.

### Storing Course Content in Firestore

Create a `courses` collection with documents structured as follows:

```json
{
  "id": "marketing-outreach",
  "title": "Marketing & Outreach",
  "description": "Learn how to effectively promote AZ Learner on campus",
  "color": "blue",
  "icon": "bullhorn",
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

When at least one published course exists in Firestore, `loadCourses()` uses Firestore data and ignores the hardcoded fallback. This allows the content team to update courses without a code deployment.

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

### Ambassador Engagement — Implemented ✅

| Strategy | Status | Implementation |
|----------|--------|---------------|
| **Points & Badges** | ✅ | `achievementPoints` field on ambassador document. Points awarded for programs, courses, referrals, and challenges. Badge system shown on `challenges.html`. |
| **Leaderboard tab** | ✅ | `tab-leaderboard` / `view-leaderboard` in portal + standalone `leaderboard.html`. Queries ambassadors ordered by `achievementPoints` descending. |
| **Monthly challenges** | ✅ | `tab-challenges` / `view-challenges` in portal + standalone `challenges.html`. February 2026 challenge with 5 tasks, progress bar, and bonus banner. |
| **Peer recognition** | ✅ | Nomination form on `leaderboard.html` — ambassadors nominate peers for a Spotlight badge. |
| **Social sharing** | ✅ | Share rank via WhatsApp, Twitter/X, or copy link on `leaderboard.html`. |

### Ambassador Engagement — To Do

| Strategy | Implementation |
|----------|---------------|
| **Progress notifications** | Use Firebase Cloud Messaging (FCM) or email to notify ambassadors of upcoming programs, new courses, and leaderboard changes. |
| **Persist challenge progress** | Write task completion state to `ambassadors/{id}/challengeProgress/{challengeId}` in Firestore so progress survives page refresh. |

### Student Engagement

| Strategy | Implementation |
|----------|---------------|
| **Referral tracking** | Give each ambassador a unique referral code. Track sign-ups attributed to each code in Firestore and reward top referrers. |
| **Course Circles** | Ambassadors host virtual or in-person study circles around specific courses. They mark attendance; attendance data feeds their achievement points. |
| **Campus events feed** | Ambassadors post mini campus events from the portal. Events appear in the student-facing `home.html` events section automatically via a shared `events` collection. |
| **Feedback loops** | Add a short in-portal survey (1–3 questions) after each program to collect NPS scores. Surface aggregate results to admins in `admin.html`. |

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
    challengeProgress/       ← sub-collection
      {challengeId}/
        completedTasks: string[]
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

- [x] Publish first four training courses with at least four modules each (hardcoded fallback in portal + `courses.html`)
- [x] Implement dynamic course loading from Firestore with hardcoded fallback
- [x] Build achievement-points system and leaderboard tab (`leaderboard.html` + portal tab)
- [x] Launch monthly challenge missions (`challenges.html` + portal tab)
- [x] Add peer recognition nomination form (`leaderboard.html`)
- [x] Social sharing for ambassador rank (`leaderboard.html`)
- [ ] Add course-progress tracking per ambassador (Firestore `courseProgress` sub-collection)
- [ ] Persist challenge task state to Firestore
- [ ] Launch referral-code tracking for student sign-ups
- [ ] Add in-portal program feedback surveys
- [ ] Enable ambassador-posted campus events visible on `home.html`
- [ ] Set up Firebase Cloud Messaging for progress notifications
- [ ] Generate shareable ambassador profile cards
- [ ] Send fortnightly Ambassador Digest via email / WhatsApp broadcast
