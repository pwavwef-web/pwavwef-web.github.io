/**
 * Narration for the four Indigen World contributor videos. Every claim is traceable to the Indigen World
 * repository (see exports/indigen-contributor-series/FACT-CHECK.md). No Kasem is spoken: pronunciation cannot be verified.
 */
export interface VideoDef {
  key: 'v1' | 'v2' | 'v3' | 'v4';
  slug: string;
  title: string;
  lines: string[];
  musicPrompt: string;
  whatsapp: string;
}

export const VOICE = 'Sulafat';
export const DIRECTION =
  'Speak as a warm, friendly Ghanaian woman talking to fellow contributors: clear everyday English, natural conversational pace (not slow, not ceremonial), smiling tone, light Ghanaian English rhythm without exaggeration, brief natural pauses at full stops';

const MUSIC_BASE =
  'Warm contemporary Afropop-inspired instrumental for a vertical social video: light percussion (shakers, soft congas, rim clicks), rounded bass, marimba-like plucks and clean guitar, optimistic forward movement. Instrumental only, no vocals. A sparse, uncluttered middle that leaves space for a spoken voice, and a clean resolved final chord that rings out and ends on its own. Avoid gloomy piano, funeral pacing, overpowering drums, and imitation of any named artist.';

export const VIDEOS: VideoDef[] = [
  {
    key: 'v1',
    slug: '01-what-makes-a-contribution-useful',
    title: 'What Makes a Contribution Useful?',
    lines: [
      "A submission can look complete and still leave the reviewer guessing. Here's how to make yours useful.",
      "Start with meaning. You've translated a greeting. But who says it? To an elder? A child? A guest at the door?",
      "That's what the usage note is for. Write who says it, to whom, and when. Two short lines can save a reviewer a long guess.",
      "Accuracy comes first. Write it the way you really say it, check the spelling, and if you're unsure, say so instead of guessing.",
      "Sharing a recording? Then the sound is the whole contribution. A quiet room beats a noisy market. Close the door, hold the phone a hand's width away, and listen back before you send.",
      "Share what you know yourself. If it's already there, a new way of saying it is welcome. An exact copy isn't needed.",
      'And if a reviewer sends it back, take it as help, not a verdict. Fix what they point to, and send it again. Your first version stays on record.',
      'Today, open the contributor portal and make one careful contribution. Use what you just saw.',
    ],
    musicPrompt: `${MUSIC_BASE} About 104 BPM, approximately 95 seconds in total, with a gentle lift in energy after the first third.`,
    whatsapp:
      'New from Indigen World: what makes a contribution useful, in about a minute and a half. Watch, then open the contributor portal and make one careful contribution today: tribestudio.indigenworld.com/contributor',
  },
  {
    key: 'v2',
    slug: '02-someone-knows-this-because-you-shared-it',
    title: 'Someone Knows This Because You Shared It',
    lines: [
      'That expression you use every day? Someone else may have never had the chance to learn it.',
      'Think of what you say when a guest walks into your home. You heard it from your family. You say it without thinking.',
      'But a young person who grew up far from home may never have heard it said your way.',
      "So you record it. You add what it means, and when it's said.",
      "A reviewer who speaks Kasem checks it. If it's approved, it can be published whole, with its meaning and context, so learners can find it, and Kawuri can answer from reviewed records.",
      'One expression will not do everything. But it is one more thing that does not live only in memory.',
      'Share one expression, or one recording, that you know well.',
    ],
    musicPrompt: `${MUSIC_BASE} About 96 BPM, a warmer and more intimate feel with softer percussion, approximately 65 seconds in total, with a gentle emotional lift in the final third.`,
    whatsapp:
      'Someone knows this because you shared it. A one-minute reminder from Indigen World of why your everyday expressions matter. Share one you know well: tribestudio.indigenworld.com/contributor',
  },
  {
    key: 'v3',
    slug: '03-help-fill-the-jars',
    title: 'Help Fill the Jars',
    lines: [
      'These jars fill when useful contributions are added. Yours can move one forward.',
      "You add an expression. A reviewer checks it. Once it's approved and published, it counts, and the jar rises.",
      "Drafts, and work still waiting for review, don't fill a jar. Approved work does.",
      'Each jar is a different kind of knowledge.',
      'Everyday expressions. Words and meanings. Proverbs. Pronunciation recordings.',
      'Pick the one you know best.',
      'This is an illustration, not live numbers. The real jars are on the progress page.',
      "A full jar isn't a launch, or a finished model. It's reviewed material we can build on.",
      'Choose a jar. Add something you know.',
    ],
    musicPrompt: `${MUSIC_BASE} About 112 BPM, brighter and more playful with a rising, filling feel, approximately 62 seconds in total, with a lift at the three-quarter point.`,
    whatsapp:
      'Help fill the jars. Choose a category, add something you know, and watch approved work move the jars on the progress page. Open the contributor portal: tribestudio.indigenworld.com/contributor',
  },
  {
    key: 'v4',
    slug: '04-what-happens-after-you-submit',
    title: 'What Happens After You Submit?',
    lines: [
      'You tap Submit. What happens next?',
      'First, your work locks and shows as Awaiting review, so the reviewer sees exactly what you sent.',
      'A reviewer who speaks Kasem reads your usage note first, then checks the meaning and the context.',
      'Sometimes they approve it. Sometimes they send it back with a note on what to fix. Then you revise and resubmit, and your first version stays on record.',
      "Why so careful? Because collecting material isn't the same as having material people can rely on. A recording that can't be heard, or an expression with no context, is hard to use.",
      'Once approved, an expression can be published whole, with its meaning, and it adds to its jar on the progress page.',
      "Kawuri answers only from reviewed records. And approval doesn't instantly train a model, or put your work in every resource. Review and quality checks decide what is used.",
      'So after you submit, check your Activity for decisions, read any feedback, and send it again if asked.',
    ],
    musicPrompt: `${MUSIC_BASE} About 100 BPM, steady and reassuring with a clear sense of forward progress, approximately 85 seconds in total, with a lift in energy in the final quarter.`,
    whatsapp:
      'You tap Submit. What happens next? A short look at review, feedback and approval. After you submit, check your Activity and use any reviewer feedback: tribestudio.indigenworld.com/contributor',
  },
];
