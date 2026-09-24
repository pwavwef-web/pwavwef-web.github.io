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
      `Create a music video treatment.\nSong: ${i.songTitle ?? 'Untitled'} by ${i.artist ?? 'the artist'}\nArtist brief: ${i.brief ?? '—'}\nTempo: ${i.bpm ?? '?'} BPM\nSections: ${j(i.sections)}\n${i.instrumental ? 'This song is INSTRUMENTAL: it has no lyrics. Do not invent, quote or imply any lyrics.' : `Lyrics:\n${String(i.lyrics ?? '(not provided — do not invent lyrics)').slice(0, 12000)}`}`,
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
      `Write exactly one shot for every slot below (use its slotIndex).\nTreatment: ${j(i.treatment)}\nSlots (seconds within the song): ${j(i.slots)}\nSections: ${j(i.sections)}\n${i.instrumental ? 'The song is instrumental: lyricCue must be empty and no shot may invent lyrics.' : `Lyrics with timing: ${j(i.lyrics)}`}\nCharacters: ${j(i.characters)}\nLocations: ${j(i.locations)}\nStyle bible: ${j(i.styleBible)}`,
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
  'music.lyrics': {
    label: 'Song lyrics',
    system:
      `${WRITER} You are also a professional songwriter. Write original lyrics only — never quote or imitate existing songs or a real artist's lyrics. ` +
      'Write every line in the requested language and keep to it; never switch into a more widely spoken language. For languages with little written material ' +
      '(for example Kasem, Dagbani, Gurenɛ), use simple, common words and standard orthography with its special letters (ɛ, ɔ, ɩ, ʋ, ŋ), and say plainly in `notes` which words or spellings a fluent speaker should check.',
    expectedOutputTokens: 3500,
    thinking: 'HIGH',
    validate: need(['subject', 'language']),
    schema: obj({
      title: str(),
      languageCode: str('BCP-47 code of the language actually written, e.g. en, tw, xsm'),
      sections: arr(obj({ label: { type: 'string', enum: ['intro', 'verse', 'pre-chorus', 'chorus', 'post-chorus', 'bridge', 'breakdown', 'drop', 'instrumental', 'hook', 'outro', 'other'] }, name: str('e.g. Verse 1'), lines: arr(str('One sung line')) })),
      notes: str('Choices made, and anything a fluent speaker should verify'),
    }),
    prompt: (i) =>
      `Write song lyrics.\nLanguage: ${i.languageName ?? i.language} (${i.language})\nSubject: ${i.subject}\nStructure: ${i.structure || 'intro, verse, pre-chorus, chorus, verse, pre-chorus, chorus, bridge, chorus, outro'}\nTone: ${i.tone ?? 'open'}\nGenre: ${i.genre ?? 'open'}\nTitle idea: ${i.title ?? '—'}\nArtist / brand notes: ${i.notes ?? '—'}\n` +
      'Return the sections in singing order; repeat chorus text in full wherever the chorus is sung. Instrumental sections have no lines.',
  },
  'film.score_bible': {
    label: 'Musical bible',
    system: `${WRITER} You are also a film composer and music supervisor. Design one coherent musical identity for the whole film that a music model can follow in every cue.`,
    expectedOutputTokens: 3000,
    thinking: 'HIGH',
    validate: need(['title']),
    schema: obj({
      mainTheme: str('Main theme: melodic shape, instrument, character — concrete enough to recreate in every cue'),
      emotionalMotif: str('Recurring emotional motif'),
      instrumentation: arr(str('An instrument or ensemble in the palette')),
      key: str('Home key, e.g. D minor'),
      tempoMin: num('Slowest tempo (BPM)'),
      tempoMax: num('Fastest tempo (BPM)'),
      culturalDirection: str('Cultural and stylistic direction'),
      characterThemes: arr(obj({ character: str(), theme: str() })),
      locationThemes: arr(obj({ location: str(), theme: str() })),
      tensionLanguage: str('How the score expresses tension'),
      resolutionLanguage: str('How the score expresses release and resolution'),
      avoid: arr(str('Instrument, style or cliché to avoid')),
      notes: str(),
    }),
    prompt: (i) =>
      `Create the musical bible for the film "${i.title}".\nGenre: ${i.genre ?? 'unspecified'}\nLogline: ${i.logline ?? '—'}\nCreator's music direction: ${i.direction ?? '—'}\nTreatment:\n${String(i.treatment ?? '').slice(0, 8000)}\n\nCharacters: ${j(i.characters)}\nLocations: ${j(i.locations)}\n\nScreenplay (excerpt):\n${String(i.fountain ?? '').slice(0, 40000)}`,
  },
  'film.cue_sheet': {
    label: 'Score cue sheet',
    system:
      `${WRITER} You are also a music editor spotting a film. Music is a deliberate choice: use silence where it serves the story, keep the score under dialogue, ` +
      'let it rise in scenes without dialogue, and make transitions intentional. Times are film seconds and must cover the film in order without overlaps.',
    expectedOutputTokens: 6000,
    thinking: 'HIGH',
    validate: need(['scenes']),
    schema: obj({
      cues: arr(
        obj({
          sceneId: str('Scene id as given, or empty'),
          scene: str('Scene heading'),
          start: num('Start (film seconds)'),
          end: num('End (film seconds)'),
          purpose: str('Emotional purpose of the music here'),
          intensity: num('0 (barely there) to 10 (full)'),
          theme: str('Theme or motif used'),
          transitionIn: { type: 'string', enum: ['cut_in', 'crossfade', 'swell', 'sting', 'fade_in', 'continue'] },
          transitionOut: { type: 'string', enum: ['crossfade', 'fade_out', 'hard_out', 'continue'] },
          silence: { type: 'boolean', description: 'True for deliberate silence (no score at all)' },
          duckForDialogue: { type: 'boolean', description: 'True when dialogue plays over this cue' },
          notes: str(),
        }),
      ),
    }),
    prompt: (i) =>
      `Spot the score for "${i.title}" (${i.mode === 'minimal' ? 'minimal, sparse score' : 'cinematic score'}), total length ${Math.round(Number(i.durationSec) || 0)} s.\nMusical bible: ${j(i.bible)}\nCreator's direction: ${i.direction ?? '—'}\nScenes in order with film timing and dialogue share (0 = no dialogue, 1 = wall-to-wall talk): ${j(i.scenes)}`,
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

const SEVERITY: Schema = { type: 'string', enum: ['minor', 'major', 'critical'] };
const SECONDS = (d: string) => num(`${d} (seconds from the start of the clip; -1 when not applicable)`);

/** Structured scene review returned by the reasoning model during quality inspection. */
export const INSPECTION_SCHEMA: Schema = obj({
  summary: str('Two or three sentences a director can act on'),
  speakerAttribution: arr(obj({ lineIndex: { type: 'integer' }, expectedCharacter: str(), deliveredBy: str('Who actually speaks the line on screen (character name, "off-screen", or "nobody")'), correct: { type: 'boolean' }, note: str() })),
  lipSync: obj({ applicable: { type: 'boolean' }, drift: { type: 'string', enum: ['none', 'minor', 'severe'] }, note: str() }),
  performanceFinished: { type: 'boolean', description: 'Every speaker finishes their physical performance (gesture, turn, reaction) before the end' },
  dialogueOverMusic: { type: 'string', enum: ['clear', 'music_loud', 'music_overpowering', 'not_applicable'] },
  abruptCutDuringSpeech: { type: 'boolean' },
  actions: arr(obj({ beat: str('One required action beat from the direction'), completed: { type: 'boolean' }, startSec: SECONDS('When it starts'), endSec: SECONDS('When it completes'), note: str() })),
  actionComplete: { type: 'boolean' },
  unfinishedMovementAtEnd: { type: 'boolean' },
  continuity: arr(obj({ aspect: { type: 'string', enum: ['character_identity', 'costume', 'hairstyle', 'location', 'time_of_day', 'props', 'storyboard_mismatch', 'previous_shot_mismatch', 'story_continuity', 'screen_direction'] }, ok: { type: 'boolean' }, severity: { type: 'string', enum: ['none', 'minor', 'major', 'critical'] }, note: str() })),
  cameraMatchesDirection: { type: 'boolean' },
  screenDirectionConsistent: { type: 'boolean' },
  emotionalPerformanceMatches: { type: 'boolean' },
  renderedText: obj({ present: { type: 'boolean' }, acceptable: { type: 'boolean' }, note: str() }),
  artefacts: arr(obj({ description: str(), severity: SEVERITY, startSec: SECONDS('Start'), endSec: SECONDS('End') })),
  suddenDisappearance: { type: 'boolean' },
  accidentalSceneChange: { type: 'boolean', description: 'An unplanned cut or scene change (planned cuts listed in the brief do not count)' },
  firstFrame: obj({ quality: { type: 'string', enum: ['good', 'acceptable', 'poor'] }, note: str() }),
  lastFrame: obj({ quality: { type: 'string', enum: ['good', 'acceptable', 'poor'] }, note: str() }),
  scores: obj({
    actionCompleteness: num('0–100'),
    visualAccuracy: num('0–100'),
    characterContinuity: num('0–100, or -1 when no recurring character appears'),
    audioQuality: num('0–100'),
    storyContinuity: num('0–100'),
    overallUsability: num('0–100: could this take go into the film as it is?'),
  }),
  problems: arr(obj({ category: str('One of the problem categories listed in the brief'), severity: SEVERITY, startSec: SECONDS('Start'), endSec: SECONDS('End'), description: str() })),
  recommendedRepair: obj({
    type: { type: 'string', enum: ['none', 'conversational_edit', 'extend_scene', 'regenerate_longer', 'split_into_shots', 'replace_visuals_keep_audio', 'cutaway', 'regenerate_section', 'trim_ending', 'regenerate'] },
    instruction: str('Exact instruction for the video model to fix the problems'),
    sectionStartSec: SECONDS('Start of the faulty section'),
    sectionEndSec: SECONDS('End of the faulty section'),
    rationale: str(),
  }),
});

/** Vocal detection and an independent line-level transcription (cross-checks the word-timed transcript). */
export const VOCALS_SCHEMA: Schema = obj({
  vocalsPresent: { type: 'boolean' },
  confidence: num('0–1'),
  languageCode: str('BCP-47 code of the sung language, or "und" when unsure'),
  note: str(),
  lines: arr(obj({ start: num('seconds'), end: num('seconds'), text: str('The sung line as heard'), uncertainWords: arr(str('A word in this line you are unsure about')) })),
});

/** Line anchors for exact, authoritative lyrics (the model returns indices and times only — never text). */
export const LYRIC_ANCHORS_SCHEMA: Schema = obj({
  lines: arr(obj({ lineIndex: { type: 'integer' }, start: num('When the line starts being sung (seconds)'), end: num('When it ends (seconds)'), confidence: num('0–1'), sung: { type: 'boolean', description: 'False if this line is not sung at all' } })),
});
