import type { TextTask } from '@az-studio/shared';

/**
 * JSON Schema subset accepted by Gemini structured output. Do not put `maxItems` on arrays of
 * objects: Vertex AI rejects such schemas with a bare 400 INVALID_ARGUMENT. Limit counts in the
 * prompt and trim the result instead.
 */
type Schema = Record<string, unknown>;

const str = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) });
const num = (description?: string): Schema => ({ type: 'number', ...(description ? { description } : {}) });
const arr = (items: Schema, extra: Schema = {}): Schema => ({ type: 'array', items, ...extra });
const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required });

const SHOT_FIELDS = {
  title: str('Short shot name'),
  description: str('What happens in the shot, one or two sentences'),
  framing: str('Shot size / angle, e.g. "Medium close-up, low angle"'),
  cameraMovement: str('Camera movement, e.g. "Slow push-in"'),
  lens: str('Lens choice, e.g. "50mm lens"'),
  lighting: str('Lighting design'),
  mood: str('Emotional tone'),
  performance: str('Direction for the performers'),
  action: str('Precise visible action for the video model, present tense'),
  ambientSound: str('Sound design and ambience'),
};

export interface TextTaskSpec {
  label: string;
  system: string;
  schema: Schema;
  expectedOutputTokens: number;
  thinking: 'LOW' | 'MEDIUM' | 'HIGH';
  prompt: (input: Record<string, unknown>) => string;
  validate?: (input: Record<string, unknown>) => string | null;
}

const WRITER =
  'You are a senior screenwriter, director and producer working inside AZ Studio, a private filmmaking portal. ' +
  'Write with specificity, visual clarity and emotional truth. Respect the creator’s voice and cultural context — many projects are West African (Ghanaian) and Afro-diasporic; ' +
  'portray people, places and languages authentically and without stereotypes. Never depict real, identifiable people unless the creator explicitly provides consent context. ' +
  'Return only JSON that matches the response schema.';

const FOUNTAIN_RULES =
  'Screenplays use Fountain markup: scene headings like "INT. KUMASI MARKET - DAY" on their own line preceded by a blank line; action in plain paragraphs; ' +
  'character cues in UPPERCASE on their own line, followed by dialogue; parentheticals in (parentheses) under the cue; transitions such as "CUT TO:" in uppercase. ' +
  'Do not use markdown, bold markers or code fences.';

const need = (keys: string[]) => (input: Record<string, unknown>) => {
  for (const k of keys) {
    const v = input[k];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return `Missing “${k}”.`;
  }
  return null;
};

const j = (v: unknown) => JSON.stringify(v ?? null, null, 1);

export const TEXT_TASK_SPECS: Record<TextTask, TextTaskSpec> = {
  'film.treatment': {
    label: 'Treatment',
    system: WRITER,
    expectedOutputTokens: 4000,
    thinking: 'HIGH',
    validate: need(['idea']),
    schema: obj({
      title: str(),
      logline: str('One-sentence logline'),
      synopsis: str('One-paragraph synopsis'),
      body: str('Full treatment prose in present tense, 4–10 paragraphs separated by blank lines'),
      themes: arr(str()),
      tone: str(),
      visualStyle: str('Cinematic look: format, lensing, camera language, texture'),
      palette: arr(str('Colour descriptor'), { maxItems: 8 }),
      characters: arr(obj({ name: str(), role: str(), description: str() })),
      settings: arr(obj({ name: str(), description: str() })),
    }),
    prompt: (i) =>
      `Develop a film treatment.\nIdea: ${i.idea}\nGenre: ${i.genre ?? 'open'}\nTone: ${i.tone ?? 'open'}\nTarget runtime (minutes): ${i.runtimeMinutes ?? 'unspecified'}\nExisting logline: ${i.logline ?? '—'}\nCreator notes: ${i.notes ?? '—'}`,
  },
  'film.screenplay_draft': {
    label: 'Screenplay draft',
    system: `${WRITER} ${FOUNTAIN_RULES}`,
    expectedOutputTokens: 18000,
    thinking: 'HIGH',
    validate: need(['treatment']),
    schema: obj({ fountain: str('Complete screenplay text in Fountain markup'), notes: str('Brief notes on choices made') }),
    prompt: (i) =>
      `Write ${i.scope === 'sequence' ? 'the next sequence of' : 'a full draft of'} the screenplay "${i.title ?? 'Untitled'}" (target ≈ ${i.targetPages ?? 10} pages).\n` +
      `Treatment:\n${i.treatment}\n\nCharacters:\n${j(i.characters)}\n` +
      (i.sequenceSummary ? `\nThis sequence should cover:\n${i.sequenceSummary}\n` : '') +
      (i.existingContent ? `\nScreenplay so far (continue after it, do not repeat it):\n${String(i.existingContent).slice(-12000)}\n` : ''),
  },
  'film.screenplay_rewrite': {
    label: 'Rewrite selection',
    system: `${WRITER} ${FOUNTAIN_RULES}`,
    expectedOutputTokens: 3000,
    thinking: 'MEDIUM',
    validate: need(['selection', 'instruction']),
    schema: obj({ fountain: str('Replacement text in Fountain markup'), rationale: str() }),
    prompt: (i) => `Rewrite the selected passage.\nInstruction: ${i.instruction}\n\nSelected passage:\n${i.selection}\n\nSurrounding context (do not rewrite):\n${String(i.context ?? '').slice(0, 8000)}`,
  },
  'film.screenplay_continue': {
    label: 'Continue scene',
    system: `${WRITER} ${FOUNTAIN_RULES}`,
    expectedOutputTokens: 3000,
    thinking: 'MEDIUM',
    validate: need(['contentBefore']),
    schema: obj({ fountain: str('New Fountain text that continues seamlessly') }),
    prompt: (i) => `Continue the screenplay from where it stops. ${i.instruction ? `Direction: ${i.instruction}` : 'Write the next beat of the scene.'}\n\nScreenplay so far:\n${String(i.contentBefore).slice(-12000)}\n\nTreatment for reference:\n${String(i.treatment ?? '').slice(0, 4000)}`,
  },
  'film.structure': {
    label: 'Structure & pacing analysis',
    system: `${WRITER} You are also a story analyst who gives precise, actionable notes.`,
    expectedOutputTokens: 5000,
    thinking: 'HIGH',
    validate: need(['fountain']),
    schema: obj({
      summary: str(),
      estimatedRuntimeMinutes: num(),
      acts: arr(obj({ name: str(), startScene: num('1-based scene number'), endScene: num(), summary: str() })),
      beats: arr(obj({ name: str('e.g. Inciting incident, Midpoint'), scene: num(), description: str() })),
      pacing: arr(obj({ sceneIndex: num('1-based scene number'), heading: str(), assessment: { type: 'string', enum: ['slow', 'balanced', 'fast'] }, note: str() })),
      strengths: arr(str()),
      issues: arr(str()),
      suggestions: arr(str()),
    }),
    prompt: (i) => `Analyse the structure and pacing of this screenplay. Genre: ${i.genre ?? 'unspecified'}. Target runtime: ${i.targetRuntime ?? 'unspecified'} minutes.\n\n${i.fountain}`,
  },
  'film.breakdown': {
    label: 'Scene breakdown',
    system: `${WRITER} You are also a first assistant director preparing a production breakdown.`,
    expectedOutputTokens: 8000,
    thinking: 'MEDIUM',
    validate: need(['fountain']),
    schema: obj({
      sequences: arr(obj({ title: str(), summary: str(), sceneIndexes: arr(num('1-based scene number')) })),
      scenes: arr(
        obj({
          index: num('1-based scene number in script order'),
          heading: str(),
          summary: str(),
          characters: arr(str('Character name in UPPERCASE')),
          props: arr(str()),
          costumes: arr(str()),
          mood: str(),
          dialoguePlan: str('How dialogue is delivered/recorded'),
          audioPlan: str('Music, ambience and effects'),
          estimatedDurationSec: num(),
        }),
      ),
    }),
    prompt: (i) => `Break down every scene of this screenplay in order. Known characters: ${j(i.knownCharacters)}. Known locations: ${j(i.knownLocations)}.\n\n${i.fountain}`,
  },
  'film.characters': {
    label: 'Character bible',
    system: WRITER,
    expectedOutputTokens: 4000,
    thinking: 'MEDIUM',
    schema: obj({
      characters: arr(obj({ name: str(), role: str(), description: str(), appearance: str('Consistent visual description for image/video models'), wardrobe: str(), personality: str(), voice: str('Voice and speech pattern') })),
    }),
    prompt: (i) => `Create character bible entries${i.names ? ` for: ${j(i.names)}` : ''}. Appearance descriptions must be specific and reusable across shots (age range, build, skin tone, hair, distinguishing features).\n\nTreatment:\n${String(i.treatment ?? '').slice(0, 8000)}\n\nScreenplay excerpt:\n${String(i.fountain ?? '').slice(0, 30000)}`,
  },
  'film.locations': {
    label: 'Location bible',
    system: WRITER,
    expectedOutputTokens: 3000,
    thinking: 'MEDIUM',
    schema: obj({ locations: arr(obj({ name: str(), description: str('Production-design description reusable in prompts'), timeOfDay: str(), palette: str(), atmosphere: str() })) }),
    prompt: (i) => `Create location bible entries for every distinct location.\n\nTreatment:\n${String(i.treatment ?? '').slice(0, 8000)}\n\nScreenplay:\n${String(i.fountain ?? '').slice(0, 30000)}`,
  },
  'film.shotlist': {
    label: 'Shot list',
    system: `${WRITER} You are also a cinematographer. Each shot becomes one 3–10 second Gemini Omni video generation, so describe exactly one continuous camera setup per shot.`,
    expectedOutputTokens: 6000,
    thinking: 'HIGH',
    validate: need(['scene']),
    schema: obj({
      shots: arr(
        obj({
          ...SHOT_FIELDS,
          dialogue: arr(obj({ character: str(), line: str() })),
          durationSec: { type: 'integer', minimum: 3, maximum: 10 },
          characterNames: arr(str()),
          transition: str('Transition into the next shot, e.g. cut, dissolve'),
        }),
      ),
    }),
    prompt: (i) =>
      `Design a shot list for this scene (aspect ratio ${i.aspectRatio ?? '16:9'}, at most ${i.maxShots ?? 12} shots).\nScene: ${j(i.scene)}\nCharacters: ${j(i.characters)}\nLocation: ${j(i.location)}\nStyle bible: ${j(i.styleBible)}`,
  },
  'music.treatment': {
    label: 'Music video treatment',
    system: `${WRITER} You direct music videos with a strong visual concept that serves the song’s structure and emotion.`,
    expectedOutputTokens: 4000,
    thinking: 'HIGH',
    schema: obj({
      title: str(),
      logline: str(),
      concept: str('Concept prose, 3–6 paragraphs'),
      visualStyle: str(),
      palette: arr(str(), { maxItems: 8 }),
      motifs: arr(str()),
      wardrobe: str(),
      performanceVsNarrative: str('Balance of performance and story footage'),
      characters: arr(obj({ name: str(), description: str('Reusable visual description') })),
      locations: arr(obj({ name: str(), description: str() })),
      sectionIdeas: arr(obj({ sectionLabel: str('Section name as given'), idea: str() })),
    }),
    prompt: (i) =>
      `Create a music video treatment.\nSong: ${i.songTitle ?? 'Untitled'} by ${i.artist ?? 'the artist'}\nArtist brief: ${i.brief ?? '—'}\nTempo: ${i.bpm ?? '?'} BPM\nSections: ${j(i.sections)}\nLyrics:\n${String(i.lyrics ?? '(instrumental or not provided)').slice(0, 12000)}`,
  },
  'music.shotlist': {
    label: 'Music video shot list',
    system: `${WRITER} You are a music video director and cinematographer. Each slot becomes one Gemini Omni clip (3–10 s); cut on the beat and keep characters, wardrobe and palette consistent.`,
    expectedOutputTokens: 9000,
    thinking: 'HIGH',
    validate: need(['slots']),
    schema: obj({
      shots: arr(obj({ slotIndex: { type: 'integer', minimum: 0 }, ...SHOT_FIELDS, characterNames: arr(str()), locationName: str(), lyricCue: str('Lyric sung during the shot, if any') })),
    }),
    prompt: (i) =>
      `Write exactly one shot for every slot below (use its slotIndex).\nTreatment: ${j(i.treatment)}\nSlots (seconds within the song): ${j(i.slots)}\nSections: ${j(i.sections)}\nLyrics with timing: ${j(i.lyrics)}\nCharacters: ${j(i.characters)}\nLocations: ${j(i.locations)}\nStyle bible: ${j(i.styleBible)}`,
  },
  'prompt.polish': {
    label: 'Prompt polish',
    system:
      'You are an expert prompt writer for Google Gemini Omni (video) and Nano Banana Pro (images). Rewrite prompts to be concrete and visual: shot size, camera movement, subject, action, setting, lighting, style, and — for video — sound design and dialogue (or "No dialogue"). ' +
      'Keep any tags like <FIRST_FRAME>, <IMAGE_REF_0> or <VIDEO_REF_0> exactly as written. Put restrictions as "Do not …" sentences. Return JSON only.',
    expectedOutputTokens: 1200,
    thinking: 'LOW',
    validate: need(['prompt']),
    schema: obj({ prompt: str(), notes: str() }),
    prompt: (i) => `Polish this ${i.kind === 'image' ? 'image' : 'video'} prompt:\n${i.prompt}`,
  },
  'storyboard.prompts': {
    label: 'Storyboard prompts',
    system: `${WRITER} You write Nano Banana Pro prompts for storyboard frames that match each shot’s exact composition.`,
    expectedOutputTokens: 4000,
    thinking: 'MEDIUM',
    validate: need(['shots']),
    schema: obj({ frames: arr(obj({ shotId: str(), prompt: str() })) }),
    prompt: (i) => `Write one storyboard frame prompt per shot.\nStyle: ${j(i.styleBible)}\nCharacters: ${j(i.characters)}\nShots: ${j(i.shots)}`,
  },
};

export const SONG_ANALYSIS_SCHEMA: Schema = obj({
  summary: str(),
  genre: str(),
  mood: str(),
  instrumentation: str(),
  tempoFeel: str(),
  sections: arr(
    obj({
      label: { type: 'string', enum: ['intro', 'verse', 'pre-chorus', 'chorus', 'post-chorus', 'bridge', 'breakdown', 'drop', 'instrumental', 'hook', 'outro', 'other'] },
      name: str('e.g. Verse 1'),
      start: num('Start time in seconds'),
      end: num('End time in seconds'),
    }),
  ),
  lyrics: arr(obj({ start: num('seconds'), end: num('seconds'), text: str('One sung line') })),
});
