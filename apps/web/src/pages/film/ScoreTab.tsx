import { useEffect, useMemo, useState } from 'react';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { AlertTriangle, Lock, LockOpen, Music, Play, RefreshCw, Sparkles, Upload, Wand2 } from 'lucide-react';
import {
  applyScoreToTimeline,
  DEFAULT_SCORE_MIX,
  EMPTY_BIBLE,
  estimateSpeechSeconds,
  formatTimecode,
  formatUsd,
  normalizeCueSheet,
  planMovements,
  SCORE_MODE_LABELS,
  timelineDuration,
  type AssetDoc,
  type ModelAvailability,
  type MusicalBible,
  type ProjectDoc,
  type SceneDoc,
  type ScoreCue,
  type ScoreDoc,
  type ScoreMode,
  type ScriptDoc,
  type ShotDoc,
  type TimelineDoc,
} from '@az-studio/shared';
import { db } from '../../lib/firebase';
import { errorMessage } from '../../lib/api';
import { useAiRun } from '../../lib/ai';
import type { WithId } from '../../lib/data';
import { modelStatus } from '../../lib/production';
import { useBoot } from '../../lib/session';
import { saveTimeline, updateProject, useSub } from '../../lib/studio';
import { useJobSubmitter } from '../../components/jobs';
import { AssetPicker } from '../../components/media';
import { useMediaUrls } from '../../lib/media';
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Segmented, Select, Slider, Textarea, Toggle } from '../../components/ui';

const list = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Scene timing for spotting: from the latest assembled timeline, else from the breakdown estimates. */
function sceneTiming(scenes: WithId<SceneDoc>[], shots: WithId<ShotDoc>[], timeline: WithId<TimelineDoc> | undefined) {
  const ordered = [...scenes].sort((a, b) => a.order - b.order);
  const dialogueSec = (sceneId: string) => shots.filter((s) => s.sceneId === sceneId).reduce((sum, s) => sum + s.directions.dialogue.reduce((x, l) => x + (l.line.trim() ? estimateSpeechSeconds(l.line) : 0), 0), 0);
  if (timeline?.clips.some((c) => c.shotId)) {
    const byScene = new Map<string, { start: number; end: number }>();
    for (const c of timeline.clips) {
      const sceneId = c.shotId ? shots.find((s) => s.id === c.shotId)?.sceneId : null;
      if (!sceneId) continue;
      const cur = byScene.get(sceneId);
      byScene.set(sceneId, { start: Math.min(cur?.start ?? Infinity, c.start), end: Math.max(cur?.end ?? 0, c.start + c.duration) });
    }
    const rows = ordered.filter((s) => byScene.has(s.id)).map((s) => ({ id: s.id, heading: s.heading, summary: s.summary, mood: s.mood, ...byScene.get(s.id)! }));
    if (rows.length) return { source: `timeline “${timeline.name}”`, rows: rows.map((r) => ({ ...r, dialogueShare: Math.min(1, dialogueSec(r.id) / Math.max(1, r.end - r.start)) })), durationSec: timelineDuration(timeline.clips) };
  }
  let t = 0;
  const rows = ordered.map((s) => {
    const r = { id: s.id, heading: s.heading, summary: s.summary, mood: s.mood, start: t, end: t + Math.max(5, s.estimatedDurationSec || 60) };
    t = r.end;
    return { ...r, dialogueShare: Math.min(1, dialogueSec(s.id) / Math.max(1, r.end - r.start)) };
  });
  return { source: 'breakdown estimates', rows, durationSec: t };
}

function MovementPlayer({ assetId }: { assetId: string }) {
  const urls = useMediaUrls(assetId);
  return urls?.file ? <audio src={urls.file} controls preload="none" className="mt-2 w-full" /> : null;
}

export function ScoreTab({ project }: { project: WithId<ProjectDoc> }) {
  const boot = useBoot();
  const scores = useSub<ScoreDoc>(project.id, 'scores', 'createdAt', 'asc');
  const scenes = useSub<SceneDoc>(project.id, 'scenes', 'order');
  const shots = useSub<ShotDoc>(project.id, 'shots', 'order');
  const scripts = useSub<ScriptDoc>(project.id, 'scripts', 'updatedAt', 'desc');
  const timelines = useSub<TimelineDoc>(project.id, 'timelines', 'updatedAt', 'desc');
  const characters = useSub<{ name: string; appearance: string }>(project.id, 'characters', 'name');
  const locations = useSub<{ name: string; description: string }>(project.id, 'locations', 'name');
  const ai = useAiRun(project.id);
  const { submit, busy, dialog } = useJobSubmitter();
  const [music, setMusic] = useState<ModelAvailability | null>(null);
  const [checkingMusic, setCheckingMusic] = useState(false);
  const [picker, setPicker] = useState(false);
  const [direction, setDirection] = useState('');
  const score = scores.data[0] ?? null;
  const mode: ScoreMode = project.score?.mode ?? score?.mode ?? 'none';
  const timeline = timelines.data[0];
  const timing = useMemo(() => sceneTiming(scenes.data, shots.data, timeline), [scenes.data, shots.data, timeline]);

  useEffect(() => {
    modelStatus(false)
      .then((r) => setMusic(r.models.find((m) => m.role === 'music') ?? null))
      .catch(() => setMusic(null));
  }, []);

  const refreshMusic = async () => {
    setCheckingMusic(true);
    try {
      const result = await modelStatus(true);
      setMusic(result.models.find((m) => m.role === 'music') ?? null);
    } catch (e) {
      toast.error('Could not check Lyria availability', { description: errorMessage(e) });
    } finally {
      setCheckingMusic(false);
    }
  };

  const save = async (patch: Partial<ScoreDoc>) => {
    const id = score?.id ?? doc(db, 'projects', project.id, 'scores', 'main').id;
    const ref = doc(db, 'projects', project.id, 'scores', id);
    const base: Omit<ScoreDoc, 'id'> = score ?? { title: project.title, mode, bible: EMPTY_BIBLE, mainThemeLockedAt: null, bibleApprovedAt: null, cueSheet: [], movements: [], mix: DEFAULT_SCORE_MIX, importedAssetId: null, durationSec: timing.durationSec, createdAt: serverTimestamp() };
    await setDoc(ref, { ...(score ? {} : base), ...patch, updatedAt: serverTimestamp() }, { merge: true });
    if (!project.score?.scoreId) await updateProject(project.id, { score: { mode: patch.mode ?? mode, scoreId: id } });
  };
  const setMode = async (m: ScoreMode) => {
    await updateProject(project.id, { score: { mode: m, scoreId: score?.id ?? 'main' } });
    await save({ mode: m });
  };

  const writeBible = async () => {
    const out = await ai.run<{ mainTheme: string; emotionalMotif: string; instrumentation: string[]; key: string; tempoMin: number; tempoMax: number; culturalDirection: string; characterThemes: { character: string; theme: string }[]; locationThemes: { location: string; theme: string }[]; tensionLanguage: string; resolutionLanguage: string; avoid: string[]; notes: string }>(
      'film.score_bible',
      { title: project.title, genre: project.genre, logline: project.logline, direction, treatment: project.treatment?.body ?? '', characters: characters.data.map((c) => ({ name: c.name, description: c.appearance })), locations: locations.data.map((l) => ({ name: l.name, description: l.description })), fountain: scripts.data[0]?.content ?? '' },
      'Musical bible',
    );
    if (!out) return;
    const bible: MusicalBible = {
      mainTheme: score?.mainThemeLockedAt ? score.bible.mainTheme : out.mainTheme,
      emotionalMotif: out.emotionalMotif,
      instrumentation: out.instrumentation ?? [],
      key: out.key,
      tempoRange: { min: Math.round(out.tempoMin || 70), max: Math.round(out.tempoMax || 100) },
      culturalDirection: out.culturalDirection,
      characterThemes: out.characterThemes ?? [],
      locationThemes: out.locationThemes ?? [],
      tensionLanguage: out.tensionLanguage,
      resolutionLanguage: out.resolutionLanguage,
      avoid: out.avoid ?? [],
      notes: out.notes ?? '',
    };
    await save({ bible, mode: mode === 'none' ? 'cinematic' : mode });
    toast.success('Musical bible ready');
  };

  const spot = async () => {
    if (!score) return;
    const out = await ai.run<{ cues: Partial<ScoreCue>[] }>('film.cue_sheet', { title: project.title, bible: score.bible, mode, direction, durationSec: timing.durationSec, scenes: timing.rows.map((r) => ({ sceneId: r.id, heading: r.heading, summary: r.summary, mood: r.mood, start: Math.round(r.start * 10) / 10, end: Math.round(r.end * 10) / 10, dialogueShare: Math.round(r.dialogueShare * 100) / 100 })) }, 'Score cue sheet');
    if (!out?.cues?.length) return;
    const cueSheet = normalizeCueSheet(out.cues, timing.durationSec);
    await save({ cueSheet, durationSec: timing.durationSec, movements: planMovements(cueSheet, { crossfadeSec: score.mix.crossfadeSec }) });
    toast.success(`${cueSheet.length} cues spotted`, { description: 'Movements are planned from the cue sheet.' });
  };

  const generate = async (movementIds: string[]) => {
    if (!score) return;
    const jobs = movementIds.map((movementId) => ({ type: 'music.generate' as const, projectId: project.id, purpose: 'score_movement' as const, prompt: direction.trim() || 'score', lyrics: null, instrumental: true, languageCode: null, imageAssetIds: [], alternate: false, songId: null, scoreId: score.id, movementId, label: `Score movement ${movementId}` }));
    await submit(jobs, { label: `${jobs.length} score movement${jobs.length === 1 ? '' : 's'}`, alwaysConfirm: jobs.length > 1 });
  };

  const apply = async () => {
    if (!score || !timeline) return;
    try {
      let importedDurationSec: number | null = null;
      if (score.importedAssetId) importedDurationSec = Number(((await getDoc(doc(db, 'assets', score.importedAssetId))).data() as AssetDoc | undefined)?.durationSec ?? 0) || null;
      const state = { tracks: timeline.tracks, clips: timeline.clips, markers: timeline.markers ?? [], fps: timeline.fps, aspectRatio: timeline.aspectRatio, beatGrid: timeline.beatGrid ?? null };
      const next = applyScoreToTimeline(state, { ...score, mode }, { importedDurationSec, filmDurationSec: timelineDuration(timeline.clips.filter((c) => c.kind !== 'audio' || !c.label.startsWith('Score'))) });
      await saveTimeline(project.id, timeline.id, next, (timeline.version ?? 0) + 1);
      toast.success('Score laid on the timeline', { description: `Ducking ${score.mix.ducking ? `on (−${score.mix.duckDb} dB under dialogue)` : 'off'} · crossfades ${score.mix.crossfadeSec} s.` });
    } catch (e) {
      toast.error('Could not apply the score', { description: errorMessage(e) });
    }
  };

  const bible = score?.bible ?? EMPTY_BIBLE;
  const setBible = (patch: Partial<MusicalBible>) => void save({ bible: { ...bible, ...patch } });
  const ready = score?.movements.filter((m) => m.status === 'ready').length ?? 0;
  const unavailable = music?.status === 'unavailable';

  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="eyebrow flex items-center gap-1.5">
              <Music className="size-3.5" /> Film score
            </p>
            <p className="mt-1 text-sm text-dim">One musical identity for the whole film — never unrelated music per scene. Silence stays a deliberate choice.</p>
          </div>
          <Segmented label="Soundtrack" value={mode} onChange={(m) => void setMode(m)} options={(['none', 'minimal', 'cinematic'] as ScoreMode[]).map((m) => ({ value: m, label: SCORE_MODE_LABELS[m] }))} />
        </div>
        {mode === 'none' ? (
          <Notice>No score: shots are generated without background music and nothing is added in the edit. Dialogue, ambience and effects carry the film.</Notice>
        ) : (
          <Field label="Your direction for the music (optional)">
            <Textarea rows={2} value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="e.g. kora and strings, restrained, rooted in northern Ghana; avoid trap drums" />
          </Field>
        )}
        {unavailable && (
          <Notice tone="danger" icon={<AlertTriangle className="size-4" />}>
            {music!.detail} You can still write the bible and cue sheet, and import an existing soundtrack below.
            <div className="mt-2">
              <Button size="sm" variant="ghost" loading={checkingMusic} icon={<RefreshCw className="size-3.5" />} onClick={() => void refreshMusic()}>
                Check again
              </Button>
            </div>
          </Notice>
        )}
      </Card>

      {mode !== 'none' && (
        <>
          <Card className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="eyebrow">Musical bible</p>
              <div className="flex gap-2">
                <Button size="sm" variant={score?.mainThemeLockedAt ? 'subtle' : 'ghost'} icon={score?.mainThemeLockedAt ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />} onClick={() => void save({ mainThemeLockedAt: score?.mainThemeLockedAt ? null : Date.now() })}>
                  {score?.mainThemeLockedAt ? 'Main theme locked' : 'Lock main theme'}
                </Button>
                <Button size="sm" variant="primary" loading={ai.busy} icon={<Wand2 className="size-3.5" />} onClick={() => void writeBible()}>
                  {score?.bible.mainTheme ? 'Rewrite from the screenplay' : 'Write from the screenplay'}
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Main theme" hint={score?.mainThemeLockedAt ? 'Locked: reused verbatim in every movement and regeneration.' : undefined}>
                <Textarea rows={2} disabled={Boolean(score?.mainThemeLockedAt)} value={bible.mainTheme} onChange={(e) => setBible({ mainTheme: e.target.value })} />
              </Field>
              <Field label="Emotional motif">
                <Textarea rows={2} value={bible.emotionalMotif} onChange={(e) => setBible({ emotionalMotif: e.target.value })} />
              </Field>
              <Field label="Instrumentation (comma-separated)">
                <Input value={bible.instrumentation.join(', ')} onChange={(e) => setBible({ instrumentation: list(e.target.value) })} />
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Key">
                  <Input value={bible.key} onChange={(e) => setBible({ key: e.target.value })} />
                </Field>
                <Field label="Tempo min">
                  <Input type="number" value={bible.tempoRange.min} onChange={(e) => setBible({ tempoRange: { ...bible.tempoRange, min: Number(e.target.value) || 60 } })} />
                </Field>
                <Field label="Tempo max">
                  <Input type="number" value={bible.tempoRange.max} onChange={(e) => setBible({ tempoRange: { ...bible.tempoRange, max: Number(e.target.value) || 100 } })} />
                </Field>
              </div>
              <Field label="Cultural & stylistic direction">
                <Textarea rows={2} value={bible.culturalDirection} onChange={(e) => setBible({ culturalDirection: e.target.value })} />
              </Field>
              <Field label="Avoid (comma-separated)">
                <Input value={bible.avoid.join(', ')} onChange={(e) => setBible({ avoid: list(e.target.value) })} />
              </Field>
              <Field label="Tension language">
                <Input value={bible.tensionLanguage} onChange={(e) => setBible({ tensionLanguage: e.target.value })} />
              </Field>
              <Field label="Resolution language">
                <Input value={bible.resolutionLanguage} onChange={(e) => setBible({ resolutionLanguage: e.target.value })} />
              </Field>
            </div>
            {(bible.characterThemes.length > 0 || bible.locationThemes.length > 0) && (
              <div className="grid grid-cols-1 gap-2 text-xs text-dim md:grid-cols-2">
                <div>{bible.characterThemes.map((c) => <p key={c.character}><span className="text-fg">{c.character}</span> — {c.theme}</p>)}</div>
                <div>{bible.locationThemes.map((l) => <p key={l.location}><span className="text-fg">{l.location}</span> — {l.theme}</p>)}</div>
              </div>
            )}
          </Card>

          <Card className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="eyebrow">Cue sheet</p>
                <p className="mt-1 text-xs text-faint">Scene timing from {timing.source} · {formatTimecode(timing.durationSec, 0)}</p>
              </div>
              <Button size="sm" variant="primary" loading={ai.busy} disabled={!score?.bible.mainTheme || !timing.rows.length} icon={<Sparkles className="size-3.5" />} onClick={() => void spot()}>
                {score?.cueSheet.length ? 'Re-spot the film' : 'Spot the film'}
              </Button>
            </div>
            {!timing.rows.length && <EmptyState title="No scenes yet" body="Break down the screenplay first, or assemble a timeline, so the score can be spotted against real scene timing." />}
            {score?.cueSheet.length ? (
              <ul className="space-y-1.5">
                {score.cueSheet.map((c, i) => (
                  <li key={c.id} className="grid grid-cols-1 items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs md:grid-cols-[110px_minmax(0,1fr)_140px_auto]">
                    <span className="timecode text-faint">
                      {formatTimecode(c.start, 0)}–{formatTimecode(c.end, 0)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-fg">{c.scene}</p>
                      <p className="truncate text-dim">
                        {c.silence ? 'Deliberate silence' : c.purpose} {c.theme && !c.silence ? `· ${c.theme}` : ''}
                      </p>
                    </div>
                    <Slider label="Intensity" min={0} max={10} step={1} value={c.intensity} onChange={() => undefined} onCommit={(v) => void save({ cueSheet: score.cueSheet.map((x, k) => (k === i ? { ...x, intensity: v } : x)) })} />
                    <div className="flex flex-wrap gap-2">
                      <Toggle checked={c.silence} onChange={(v) => void save({ cueSheet: score.cueSheet.map((x, k) => (k === i ? { ...x, silence: v } : x)) })} label="Silence" />
                      <Toggle checked={c.duckForDialogue} onChange={(v) => void save({ cueSheet: score.cueSheet.map((x, k) => (k === i ? { ...x, duckForDialogue: v } : x)) })} label="Duck" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <Card className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="eyebrow">Master score</p>
                <p className="mt-1 text-xs text-faint">
                  {score?.movements.length ? `${score.movements.length} connected movement${score.movements.length === 1 ? '' : 's'} from one bible (${ready} ready)` : 'Spot the film to plan the score.'} · {boot?.capabilities.music.displayName} ≈ {formatUsd(boot?.pricing.music.perSongUsd ?? 0)} per movement
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon={<Upload className="size-3.5" />} onClick={() => setPicker(true)}>
                  Import soundtrack
                </Button>
                <Button size="sm" variant="primary" loading={busy} disabled={!score?.movements.length || unavailable} icon={<Sparkles className="size-3.5" />} onClick={() => void generate(score!.movements.filter((m) => !m.locked && m.status !== 'ready').map((m) => m.id))}>
                  Generate score
                </Button>
              </div>
            </div>
            {score?.importedAssetId && (
              <Notice>
                Imported soundtrack in use — it replaces the generated movements when applied.{' '}
                <button type="button" className="cursor-pointer text-accent-2 underline" onClick={() => void save({ importedAssetId: null })}>
                  Remove
                </button>
              </Notice>
            )}
            <ul className="space-y-2">
              {score?.movements.map((m) => (
                <li key={m.id} className="rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-fg">Movement {m.index + 1}</span>
                    <span className="timecode text-xs text-faint">
                      {formatTimecode(m.start, 0)}–{formatTimecode(m.end, 0)}
                    </span>
                    <Badge tone={m.status === 'ready' ? 'success' : m.status === 'failed' ? 'danger' : m.status === 'generating' ? 'accent' : 'neutral'}>{m.status}</Badge>
                    {m.locked && <Badge tone="violet">locked</Badge>}
                    <span className="ml-auto flex gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => void save({ movements: score.movements.map((x) => (x.id === m.id ? { ...x, locked: !x.locked } : x)) })}>
                        {m.locked ? 'Unlock' : 'Lock'}
                      </Button>
                      <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} disabled={m.locked || unavailable || m.status === 'generating'} loading={busy} onClick={() => void generate([m.id])}>
                        {m.status === 'ready' ? 'Regenerate movement' : 'Generate'}
                      </Button>
                    </span>
                  </div>
                  {m.error && <p className="mt-1 text-xs text-[#ff9b9b]">{m.error}</p>}
                  {m.assetId && m.status === 'ready' && <MovementPlayer assetId={m.assetId} />}
                </li>
              ))}
            </ul>
          </Card>

          <Card className="space-y-4 p-5">
            <p className="eyebrow">Mix</p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Toggle checked={score?.mix.ducking ?? true} onChange={(v) => void save({ mix: { ...(score?.mix ?? DEFAULT_SCORE_MIX), ducking: v } })} label="Dialogue ducking" description="The score drops automatically under dialogue and important effects, and rises in the gaps." />
              <Toggle checked={score?.mix.intensityAutomation ?? true} onChange={(v) => void save({ mix: { ...(score?.mix ?? DEFAULT_SCORE_MIX), intensityAutomation: v } })} label="Score volume automation" description="Follows each cue’s intensity and silences." />
              <Field label={`Duck depth ${score?.mix.duckDb ?? 12} dB`}>
                <Slider label="Duck depth" min={6} max={18} step={1} value={score?.mix.duckDb ?? 12} onChange={() => undefined} onCommit={(v) => void save({ mix: { ...(score?.mix ?? DEFAULT_SCORE_MIX), duckDb: v } })} />
              </Field>
              <Field label={`Crossfade ${score?.mix.crossfadeSec ?? 2.5} s`}>
                <Slider label="Crossfade" min={0.5} max={6} step={0.5} value={score?.mix.crossfadeSec ?? 2.5} onChange={() => undefined} onCommit={(v) => void save({ mix: { ...(score?.mix ?? DEFAULT_SCORE_MIX), crossfadeSec: v } })} />
              </Field>
              <Field label={`Score level ${score?.mix.volumeDb ?? -8} dB`}>
                <Slider label="Score level" min={-24} max={0} step={1} value={score?.mix.volumeDb ?? -8} onChange={() => undefined} onCommit={(v) => void save({ mix: { ...(score?.mix ?? DEFAULT_SCORE_MIX), volumeDb: v } })} />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Select value={timeline?.id ?? ''} disabled className="!w-64" aria-label="Timeline">
                <option value={timeline?.id ?? ''}>{timeline ? timeline.name : 'No timeline yet'}</option>
              </Select>
              <Button variant="primary" disabled={!timeline || (!ready && !score?.importedAssetId)} icon={<Play className="size-4" />} onClick={() => void apply()}>
                Apply score to the latest timeline
              </Button>
            </div>
            <p className="text-xs text-faint">The score sits on its own tracks (Score A / Score B) so movements crossfade with an equal-power curve and never restart at picture cuts; the final render normalises loudness.</p>
          </Card>
        </>
      )}
      <AssetPicker open={picker} onOpenChange={setPicker} kinds={['audio']} projectId={project.id} onPick={(a) => a[0] && void save({ importedAssetId: a[0].id, mode: mode === 'none' ? 'cinematic' : mode })} title="Import an existing soundtrack" />
      {ai.dialog}
      {dialog}
    </div>
  );
}
