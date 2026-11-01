/**
 * Public website content. Edit copy here; pages are generated from it at build time (`npm run build -w apps/web`).
 *
 * Rules for this file (see docs/PUBLIC_SITE.md):
 *  - Describe only what the private studio really does today, and label its status honestly.
 *  - The showcase lists only work that has been explicitly published for the public. Never add a project
 *    found in private storage, and never link to private media URLs.
 *  - No invented customers, testimonials, statistics, partners, prices or dates.
 */

export type Status = 'working' | 'preparing' | 'idea';

export const STATUS_LABEL: Record<Status, string> = {
  working: 'Working in the private studio',
  preparing: 'Being prepared for public access',
  idea: 'Future idea',
};

/** Four verified capabilities for the home page (all in use in the private studio). */
export const HIGHLIGHTS = [
  {
    icon: 'film',
    title: 'Narrated films from still images',
    body: 'Start from a story. AZ Studio plans the scenes, creates still images with slow camera movement, records the narration with word-timed subtitles and adds a score and ambience.',
  },
  {
    icon: 'music',
    title: 'Music videos that follow the song',
    body: 'Cuts land on the beat, sections follow the structure and energy of the track, and the lyrics — synchronised to the vocals — become on-screen captions.',
  },
  {
    icon: 'voice',
    title: 'Audio editions of written work',
    body: 'Turn an article into a narrated audio edition, redo a single passage without re-recording the rest, and publish it with a listening player.',
  },
  {
    icon: 'spark',
    title: 'Short promotional videos',
    body: 'Adverts of 40 to 60 seconds in portrait, landscape or square, built around an approved voice-over or soundtrack, or worked up from a brief.',
  },
] as const;

export interface Feature {
  title: string;
  body: string;
  status: Status;
}

export interface Workflow {
  id: string;
  icon: 'film' | 'image' | 'music' | 'voice';
  title: string;
  intro: string;
  features: Feature[];
}

/** Explore page. Every "working" item exists in the private studio today (see README.md and docs/ARCHITECTURE.md). */
export const WORKFLOWS: Workflow[] = [
  {
    id: 'video',
    icon: 'film',
    title: 'Video and storytelling',
    intro: 'From a written idea to a finished, exported film — with the script, shots, sound and edit kept together in one project.',
    features: [
      { status: 'working', title: 'Film projects', body: 'Develop a screenplay, break it into scenes and shots, and generate each shot as video. Dialogue, timing and continuity are checked after generation, and weak takes can be repaired automatically within a cost limit you set.' },
      { status: 'working', title: 'Narrated films from stills', body: 'A lighter way to tell a story: still images with gentle camera movement, narration with subtitles, a score and ambience. Several minutes long, without generated video.' },
      { status: 'working', title: 'Short promotional videos', body: 'Storyboard a 40–60 second advert scene by scene around an approved voice-over, then review each scene before it goes into the edit.' },
      { status: 'working', title: 'Timeline editing and export', body: 'Arrange clips, captions and audio on a timeline, render the final film, and have the export checked for problems such as black frames, frozen pictures or sudden loud peaks before download.' },
    ],
  },
  {
    id: 'image',
    icon: 'image',
    title: 'Image creation',
    intro: 'Pictures for stories and projects, with references that help characters and places stay recognisable from one image to the next.',
    features: [
      { status: 'working', title: 'Generate and edit images', body: 'Create images from a description, or edit an existing one with written instructions.' },
      { status: 'working', title: 'Character and visual references', body: 'Keep reference pictures for characters, sets and props so later images and shots stay consistent.' },
      { status: 'working', title: 'Project covers', body: 'A cover image for a film project, made from its own characters and treatment.' },
    ],
  },
  {
    id: 'music',
    icon: 'music',
    title: 'Music',
    intro: 'Songs and score alongside the pictures, so the music and the edit can be shaped together.',
    features: [
      { status: 'working', title: 'Songs and film score', body: 'Generate songs with lyrics, or score cues for a film, from a written direction.' },
      { status: 'working', title: 'Work with your own tracks', body: 'Upload or record audio, see its beats and sections, separate vocals from instruments, and balance a mix.' },
      { status: 'working', title: 'Music videos from stills', body: 'Build a music video from still images and your song, with cuts on the beat and synchronised lyric captions.' },
    ],
  },
  {
    id: 'narration',
    icon: 'voice',
    title: 'Narration',
    intro: 'Spoken versions of written work, made carefully enough to publish.',
    features: [
      { status: 'working', title: 'Audio editions', body: 'Turn an article into a narrated audio edition with chapters, regenerate single passages, and export WAV or MP3.' },
      { status: 'working', title: 'A hosted listening player', body: 'Publish an edition with a player that can be embedded in a blog post — like the editions in the showcase.' },
      { status: 'working', title: 'Voice choice', body: 'Use one of the available synthetic voices. A replica of a person’s own voice is only made from their own recordings, with their recorded consent — today that means Francis’s voice only.' },
    ],
  },
];

/** What is being prepared — none of it is open yet. */
export const PREPARING: Feature[] = [
  { status: 'preparing', title: 'The early-access list', body: 'Open now. It records who would like to try AZ Studio so invitations can go out in small groups.' },
  { status: 'preparing', title: 'Personal accounts', body: 'Separate accounts and workspaces for invited people, kept apart from the private studio and from each other.' },
  { status: 'preparing', title: 'Fair-use limits', body: 'Clear limits on how much each person can generate, enforced on the server, so the costs of generation stay predictable.' },
];

export const IDEAS: Feature[] = [
  { status: 'idea', title: 'Sharing finished work', body: 'Publishing a film, song or audio edition from your own account with a link you control.' },
  { status: 'idea', title: 'Working with collaborators', body: 'Inviting someone else into a project to review or contribute.' },
  { status: 'idea', title: 'Paid plans or credits', body: 'Possibly, because every generation has a real cost. Nothing about pricing has been decided.' },
];

export interface FaqItem {
  q: string;
  /** Trusted inline markup allowed (links). */
  a: string;
}

export const FAQ: FaqItem[] = [
  {
    q: 'Can I use AZ Studio now?',
    a: 'Not yet. AZ Studio is currently a private studio that Francis Pwavwe uses for his own projects. If you’d like to try it when access opens, <a href="/early-access">join the early-access list</a>.',
  },
  {
    q: 'What kinds of projects is it being built for?',
    a: 'Creative projects that mix pictures, sound and words: short films and narrated stories, music videos, songs and score, images, short promotional videos, and audio editions of written work. <a href="/explore">Explore the workflows</a> to see what each one does.',
  },
  {
    q: 'What does joining early access mean?',
    a: 'You’ll be on a list of people who want to try AZ Studio, and you may receive emails about early access — such as an invitation when one is available. Access will be introduced gradually, in small groups. Joining doesn’t create an account, doesn’t cost anything, and doesn’t guarantee an invitation or a date.',
  },
  {
    q: 'Will there be paid features?',
    a: 'Probably, in some form. Generating video, images, music and voice has a real cost each time, so a public version will need limits and may need paid plans or credits. Nothing has been decided, and no payments are taken today.',
  },
  {
    q: 'Are prices or a launch date confirmed?',
    a: 'No. There are no confirmed prices and no confirmed launch date. Updates will go to people on the early-access list first.',
  },
  {
    q: 'How can I send feedback?',
    a: `Through the <a href="https://blogs.pwavwe.com/p/contact.html">contact page on The Pwavwe Papers</a>, Francis’s website. Feedback about this site, the showcase or the idea of AZ Studio is welcome.`,
  },
  {
    q: 'How is AZ Studio’s work made?',
    a: 'With generative AI. AZ Studio uses Google’s Gemini and Lyria models through Google Cloud for video, images, text, voice and music, and adds its own planning, checking and editing around them. Media generated by Google’s models carries Google’s invisible SynthID watermark.',
  },
  {
    q: 'How do I leave the list or have my details deleted?',
    a: 'Ask through the <a href="https://blogs.pwavwe.com/p/contact.html">contact page</a> from the address you registered with, and your registration will be deleted. The <a href="/privacy">privacy notice</a> has the details.',
  },
];

/** Showcase entries. Only explicitly published work belongs here (see the rules at the top of this file). */
export interface ShowcaseEntry {
  id: string;
  title: string;
  description: string;
  kind: 'audio' | 'video' | 'image';
  /** Short label such as "Audio edition · 8 min". */
  meta: string;
  /** ISO date the work was published. */
  published: string;
  credit: string;
  /** Where the work was originally published. */
  link?: { href: string; label: string };
  /** Audio: a published Narrator edition, played through the public player on demand. */
  audioEditionId?: string;
  /** Video: a public, web-optimised file under /showcase-media/ with a poster and captions. */
  video?: { src: string; poster: string; width: number; height: number; captions?: string };
  /** Image: a public file under /showcase-media/ with dimensions and a description for screen readers. */
  image?: { src: string; width: number; height: number; alt: string };
  /** How the entry was approved for public showing. */
  approval: string;
}

export const SHOWCASE: ShowcaseEntry[] = [
  {
    id: 'useful-app',
    title: 'Not Every Useful App Needs to Become a Startup',
    description: 'An essay arguing that a personal app can be a complete success with one user — and that useful software deserves a measure of value beyond customers and scale. Narrated in AZ Studio, with a chapter for each section.',
    kind: 'audio',
    meta: 'Audio edition · 8 min 26 s',
    published: '2026-10-18',
    credit: 'Written by Francis Pwavwe · The Pwavwe Papers',
    link: { href: 'https://blogs.pwavwe.com/2026/10/useful-app-does-not-need-startup.html', label: 'Read the essay' },
    audioEditionId: 'kOZQ0h9lETB6',
    approval: 'Published by Francis through the AZ Studio hosted player for The Pwavwe Papers (public id kOZQ0h9lETB6).',
  },
  {
    id: 'if-they-had-the-power',
    title: 'If They Had the Power',
    description: 'A response to a racist post: what happens when contempt gains power, and why anyone’s safety should never depend on someone else’s goodwill. Narrated in AZ Studio, with a chapter for each section.',
    kind: 'audio',
    meta: 'Audio edition · 10 min 7 s',
    published: '2026-10-13',
    credit: 'Written by Francis Pwavwe · The Pwavwe Papers',
    link: { href: 'https://blogs.pwavwe.com/2026/10/if-they-had-the-power.html', label: 'Read the essay' },
    audioEditionId: 'ajLMkL8uwtfL',
    approval: 'Published by Francis through the AZ Studio hosted player for The Pwavwe Papers (public id ajLMkL8uwtfL).',
  },
];
