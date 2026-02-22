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
| `ambassador.html` | Protected portal — profile, programs, and courses tabs |
| `ambassadorsignup.html` | Public sign-up form for prospective ambassadors |

### Portal Architecture (`ambassador.html`)

The portal is a single-page application built with **Tailwind CSS** and **Firebase**. It uses a tab-switching pattern with three views:

| Tab ID | View ID | Content |
|--------|---------|---------|
| `tab-profile` | `view-profile` | Ambassador profile card + stats |
| `tab-programs` | `view-programs` | Upcoming / past ambassador programs |
| `tab-courses` | `view-courses` | Training courses and resource library |

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

The **Training & Resources** tab (`view-courses`) currently lists four course cards as *Coming Soon*. Use the steps below to develop and publish courses.

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

### Planned Core Courses

| Course | Description | Icon | Color |
|--------|-------------|------|-------|
| Marketing & Outreach | Promote AZ Learner on campus effectively | `bullhorn` | blue |
| Leadership Development | Manage study groups and mentor peers | `users` | orange |
| Communication Skills | Engage students and the core team clearly | `comments` | green |
| Event Planning | Organise study sessions and campus events | `chart-line` | purple |

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

### Loading Courses Dynamically

Replace the static course cards with a dynamic loader by adding the following function to `window.portal` in `ambassador.html`.

> **Note — imports:** `getDocs`, `query`, `collection`, and `where` must be imported from `firebase/firestore` at the top of the module script (they are already imported in the existing script block; verify before adding this function).

> **Note — Tailwind CSS:** Tailwind's JIT compiler only includes classes it can detect as complete strings at build time. Because the portal loads Tailwind from a CDN at runtime (not a build step), dynamic class names via template literals work fine in this project. If you ever switch to a build-time Tailwind setup, use a pre-defined color-class mapping object instead of string interpolation.

```javascript
// Pre-defined safe color-class map (required if using build-time Tailwind)
const COLOR_CLASSES = {
    blue:   { bg: 'bg-blue-900/20',   border: 'border-blue-500/30',   icon: 'text-blue-400',   badge: 'text-blue-400'   },
    orange: { bg: 'bg-orange-900/20', border: 'border-orange-500/30', icon: 'text-orange-400', badge: 'text-orange-400' },
    green:  { bg: 'bg-green-900/20',  border: 'border-green-500/30',  icon: 'text-green-400',  badge: 'text-green-400'  },
    purple: { bg: 'bg-purple-900/20', border: 'border-purple-500/30', icon: 'text-purple-400', badge: 'text-purple-400' },
};

async loadCourses() {
    const coursesGrid = document.getElementById('courses-grid');
    const snap = await getDocs(
        query(collection(db, 'courses'), where('isPublished', '==', true))
    );
    document.getElementById('stat-courses').innerText = snap.size;
    coursesGrid.innerHTML = '';

    snap.forEach(docSnap => {
        const c = docSnap.data();
        const cls = COLOR_CLASSES[c.color] ?? COLOR_CLASSES.blue;

        // Build the card element safely (textContent for user data prevents XSS)
        const card = document.createElement('div');
        card.className = `${cls.bg} border ${cls.border} rounded-xl p-6 hover:opacity-90 transition cursor-pointer`;
        card.addEventListener('click', () => portal.openCourse(docSnap.id));

        const inner = document.createElement('div');
        inner.className = 'flex items-start gap-4';

        const iconWrap = document.createElement('div');
        iconWrap.className = 'bg-opacity-20 p-3 rounded-lg';
        const icon = document.createElement('i');
        icon.className = `fas fa-${c.icon} ${cls.icon} text-2xl`;
        iconWrap.appendChild(icon);

        const textWrap = document.createElement('div');

        const title = document.createElement('h3');
        title.className = 'text-lg font-bold text-white mb-1';
        title.textContent = c.title;           // textContent — safe from XSS

        const desc = document.createElement('p');
        desc.className = 'text-sm text-gray-400 mb-3';
        desc.textContent = c.description;      // textContent — safe from XSS

        const badge = document.createElement('span');
        badge.className = `text-xs ${cls.badge} font-bold`;
        badge.textContent = `${c.modules?.length ?? 0} modules`;

        textWrap.append(title, desc, badge);
        inner.append(iconWrap, textWrap);
        card.appendChild(inner);
        coursesGrid.appendChild(card);
    });
},
```

Add a `<div id="courses-grid" class="grid md:grid-cols-2 gap-6"></div>` in `view-courses` and call `this.loadCourses()` inside `showPortal()`.

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

| Strategy | Implementation |
|----------|---------------|
| **Points & Badges** | Track `achievementPoints` in the ambassador Firestore document. Award points for attending programs, completing courses, and recruiting new users. Display them on the profile stats card. |
| **Leaderboard tab** | Add a `tab-leaderboard` / `view-leaderboard` that queries ambassadors ordered by `achievementPoints` descending. |
| **Monthly challenges** | Store monthly missions in a `challenges` Firestore collection. Ambassadors mark tasks complete; completing all tasks in a month earns a bonus badge. |
| **Progress notifications** | Use Firebase Cloud Messaging (FCM) or email to notify ambassadors of upcoming programs, new courses, and leaderboard changes. |
| **Peer recognition** | Allow ambassadors to nominate peers for a "Spotlight" badge via a lightweight nomination form inside the portal. |

### Student Engagement

| Strategy | Implementation |
|----------|---------------|
| **Referral tracking** | Give each ambassador a unique referral code. Track sign-ups attributed to each code in Firestore and reward top referrers. |
| **Course Circles** | Ambassadors host virtual or in-person study circles around specific courses. They mark attendance; attendance data feeds their achievement points. |
| **Campus events feed** | Ambassadors post mini campus events from the portal. Events appear in the student-facing `home.html` events section automatically via a shared `events` collection. |
| **Feedback loops** | Add a short in-portal survey (1–3 questions) after each program to collect NPS scores. Surface aggregate results to admins in `admin.html`. |
| **Social sharing** | Generate shareable ambassador profile cards (Canvas API or a styled static page) so ambassadors can post on Instagram / TikTok and drive sign-ups. |

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

- [ ] Publish first four training courses with at least two modules each
- [ ] Implement dynamic course loading from Firestore
- [ ] Add course-progress tracking per ambassador
- [ ] Build achievement-points system and leaderboard tab
- [ ] Launch referral-code tracking for student sign-ups
- [ ] Add in-portal program feedback surveys
- [ ] Enable ambassador-posted campus events visible on `home.html`
- [ ] Set up monthly challenge missions
- [ ] Generate shareable ambassador profile cards
- [ ] Send fortnightly Ambassador Digest via email / WhatsApp broadcast
