import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Check, Copy, ImagePlus, Images, Layers, LoaderCircle, Lock, LockOpen, Plus, RefreshCw, Scissors, Sparkles, Trash2, TriangleAlert, Upload, Wand2 } from 'lucide-react';
import {
  AMBIENCE_KINDS,
  AMBIENCE_LABELS,
  LITE_DIRECTION_PRESETS,
  MOTION_PRESETS,
  allShots,
  directionOf,
  duplicateScene,
  duplicateShot,
  estimateNarrationSec,
  findShot,
  insertScene,
  liteId,
  mapScene,
  mapShot,
  moveScene,
  newScene,
  newShot,
  removeScene,
  removeShot,
  scenesFromScript,
  scriptParagraphs,
  shotImageId,
  shotsNeedingImages,
  splitScene,
  splitShot,
  type LiteScene,
  type LiteShot,
  type LiteSpec,
  type MotionPreset,
  type ShotScale,
} from '@az-studio/shared';
import { useAiRun } from '../../lib/ai';
import { jobIndex, type ShotCandidate } from '../../lib/lite';
import { uploadFile } from '../../lib/media';
import { AssetPicker, AssetThumb, useAsset, type Asset } from '../../components/media';
import { Badge, Button, ConfirmDialog, cx, IconButton, Input, Modal, Notice, Select, Textarea, Tip } from '../../components/ui';
import { MotionExample } from '../../components/lite/FramingEditor';
import { fmtSec, Section, type StageProps } from './common';

interface ScenesOut {
  scenes?: {
    paragraph?: number;
    title?: string;
    purpose?: string;
    mood?: string;
    pauseBeforeSec?: number;
    pauseBlack?: boolean;
    transitionIn?: 'cut' | 'dissolve' | 'fade_black';
    musicIntensity?: number;
    musicSilence?: boolean;
    musicDirection?: string;
    ambience?: string;
    soundCue?: string;
    shots?: { brief?: string; composition?: string; scale?: string; characters?: string[]; location?: string; motion?: string; focusX?: number; focusY?: number; durationSec?: number; reuseOfPrevious?: boolean }[];
  }[];
  notes?: string;
}

const SCALES: ShotScale[] = ['establishing', 'wide', 'medium', 'close', 'detail'];
const clamp01 = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);

export function planFromModel(spec: LiteSpec, out: ScenesOut): LiteScene[] {
  const paragraphs = scriptParagraphs(spec.story.script);
  const d = directionOf(spec.setup.direction);
  const byName = (name: string | undefined) => spec.bible.characters.find((c) => c.name.toLowerCase() === (name ?? '').trim().toLowerCase())?.id;
  const locByName = (name: string | undefined) => spec.bible.locations.find((l) => l.name.toLowerCase() === (name ?? '').trim().toLowerCase())?.id ?? null;
  const used = new Set<number>();
  const scenes: LiteScene[] = [];
  for (const s of out.scenes ?? []) {
    const i = Number(s.paragraph);
    if (!Number.isInteger(i) || i < 0 || i >= paragraphs.length || used.has(i)) continue;
    used.add(i);
    let prev: LiteShot | null = null;
    const shots = (s.shots ?? []).map((x) => {
      const shot = newShot({
        brief: String(x.brief ?? '').slice(0, 1200),
        composition: String(x.composition ?? '').slice(0, 600),
        scale: (SCALES as string[]).includes(String(x.scale)) ? (x.scale as ShotScale) : 'wide',
        characterIds: (x.characters ?? []).map(byName).filter((v): v is string => Boolean(v)),
        locationId: locByName(x.location),
        durationSec: Math.max(3, Math.min(40, Number(x.durationSec) || 10)),
        motion: { preset: (MOTION_PRESETS as readonly string[]).includes(String(x.motion)) ? (x.motion as MotionPreset) : 'push_in', intensity: d.motion.intensity, focal: { x: clamp01(x.focusX, 0.5), y: clamp01(x.focusY, 0.45) }, focalSize: null, ease: 'gentle', manual: null },
      });
      if (x.reuseOfPrevious && prev && !prev.image.reuseOfShotId) shot.image.reuseOfShotId = prev.id;
      prev = shot;
      return shot;
    });
    scenes.push(
      newScene(
        {
          title: String(s.title ?? `Scene ${scenes.length + 1}`).slice(0, 120),
          purpose: String(s.purpose ?? '').slice(0, 600),
          mood: String(s.mood ?? '').slice(0, 200),
          narration: paragraphs[i]!,
          pauseBeforeSec: Math.max(0, Math.min(6, Number(s.pauseBeforeSec) || 0)),
          pauseBlack: Boolean(s.pauseBlack),
          transitionIn: scenes.length === 0 ? 'fade_black' : s.transitionIn === 'dissolve' || s.transitionIn === 'fade_black' ? s.transitionIn : 'cut',
          music: { mode: s.musicSilence ? 'silence' : 'score', intensity: Math.max(0, Math.min(10, Math.round(Number(s.musicIntensity) || 4))), direction: String(s.musicDirection ?? '').slice(0, 300) },
          ambience: { kind: (AMBIENCE_KINDS as readonly string[]).includes(String(s.ambience)) ? (s.ambience as LiteScene['ambience']['kind']) : 'none', assetId: null, levelDb: 0 },
          soundCue: s.soundCue?.trim() ? { label: s.soundCue.trim().slice(0, 120), assetId: null, atSec: 1, levelDb: 0 } : null,
          shots: shots.length ? shots : [newShot()],
        },
        d,
      ),
    );
  }
  // Paragraphs the plan skipped still become scenes (the narration is never dropped).
  paragraphs.forEach((p, i) => {
    if (!used.has(i)) scenes.splice(Math.min(i, scenes.length), 0, newScene({ title: `Scene ${i + 1}`, narration: p }, d));
  });
  return scenes;
}

function ImageStatus({ assetId, active, failed, className }: { assetId: string | null; active: boolean; failed: string | null; className?: string }) {
  const a = useAsset(assetId);
  return (
    <div className={cx('relative overflow-hidden rounded-lg bg-black/40', className)}>
      {a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} aspect="aspect-video" hoverPlay={false} /> : <div className="grid aspect-video place-items-center text-faint">{active ? null : <ImagePlus className="size-5" />}</div>}
      {active && (
        <div className="absolute inset-0 grid place-items-center bg-black/55 text-xs text-dim backdrop-blur-[1px]">
          <span className="inline-flex items-center gap-1.5">
            <LoaderCircle className="size-3.5 animate-spin" /> Generating…
          </span>
        </div>
      )}
      {failed && !active && (
        <Tip label={failed}>
          <span className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-danger/85 px-1.5 py-0.5 text-[10px] text-white">
            <TriangleAlert className="size-3" /> Failed
          </span>
        </Tip>
      )}
    </div>
  );
}

function CandidatesDialog({ open, onOpenChange, shot, candidates, onApprove }: { open: boolean; onOpenChange: (o: boolean) => void; shot: LiteShot; candidates: ShotCandidate[]; onApprove: (assetId: string) => void }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Compare images" description="Choosing one never deletes the others; every candidate stays in your library." size="lg">
      {candidates.length === 0 ? (
        <p className="text-sm text-faint">No candidates yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {candidates.map((c) => {
            const approved = shot.image.approvedAssetId === c.assetId;
            return (
              <div key={c.assetId} className={cx('rounded-xl border p-2', approved ? 'border-success/60' : 'border-line')}>
                <CandidateThumb assetId={c.assetId} />
                <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                  <span className="text-faint">{c.source === 'generated' ? 'Generated' : c.source === 'upload' ? 'Uploaded' : 'Imported'} · {new Date(c.at).toLocaleString()}</span>
                  {approved ? (
                    <Badge tone="success" icon={<Check className="size-3" />}>
                      Approved
                    </Badge>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => onApprove(c.assetId)}>
                      Approve
                    </Button>
                  )}
                </div>
                {c.prompt && (
                  <details className="mt-1 text-[11px] text-faint">
                    <summary className="cursor-pointer">Prompt used</summary>
                    <p className="mt-1 whitespace-pre-wrap">{c.prompt}</p>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function CandidateThumb({ assetId }: { assetId: string }) {
  const a = useAsset(assetId);
  return a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} aspect="aspect-video" hoverPlay={false} /> : <div className="aspect-video animate-pulse rounded-lg bg-panel-2" />;
}

function ShotCard({ spec, scene, shot, index, props, focused }: { spec: LiteSpec; scene: LiteScene; shot: LiteShot; index: number; props: StageProps; focused: boolean }) {
  const { update, project, work, jobs } = props;
  const idx = useMemo(() => jobIndex(jobs), [jobs]);
  const [pick, setPick] = useState(false);
  const [compare, setCompare] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focused]);
  const active = idx.active('lite_shot', shot.id);
  const failed = idx.failed('lite_shot', shot.id);
  const generated = idx.imageCandidates(shot.id);
  const candidates: ShotCandidate[] = [...generated, ...shot.image.uploads];
  const imageId = shotImageId(spec, shot);
  const reuse = shot.image.reuseOfShotId ? findShot(spec, shot.image.reuseOfShotId) : null;
  const set = (fn: (s: LiteShot) => LiteShot, label = 'shot') => update((s) => mapShot(s, shot.id, fn), label);
  const earlier = allShots(spec).filter((x) => x.shot.id !== shot.id && !x.shot.image.reuseOfShotId);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const assetId = await uploadFile(file, { kind: 'image', projectId: project.id, collections: ['lite:image', `lite:shot:${shot.id}`] });
      set((s) => ({ ...s, image: { ...s.image, approvedAssetId: assetId, reuseOfShotId: null, uploads: [...s.image.uploads, { assetId, source: 'upload', jobId: null, prompt: null, at: Date.now() }] } }), 'image');
      toast.success('Image uploaded and approved for this shot');
    } catch (e) {
      toast.error('Upload failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div ref={ref} className={cx('rounded-xl border bg-panel/60 p-3 transition-colors', focused ? 'border-accent/60 shadow-[var(--shadow-glow)]' : 'border-line')}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          <button type="button" className="block w-full cursor-pointer text-left" onClick={() => setCompare(true)} aria-label="Compare images for this shot">
            <ImageStatus assetId={imageId} active={Boolean(active)} failed={failed?.error?.message ?? null} />
          </button>
          <div className="flex flex-wrap gap-1">
            {!reuse && (
              <Button size="sm" variant={imageId ? 'ghost' : 'secondary'} icon={imageId ? <RefreshCw className="size-3.5" /> : <Wand2 className="size-3.5" />} disabled={Boolean(active) || Boolean(work.busy)} onClick={() => void work.run('images', { targetIds: [shot.id], force: Boolean(imageId) })}>
                {imageId ? 'Regenerate' : 'Generate'}
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} loading={uploading} onClick={() => fileRef.current?.click()}>
              Upload
            </Button>
            <Button size="sm" variant="ghost" icon={<Images className="size-3.5" />} onClick={() => setPick(true)}>
              Library
            </Button>
            {candidates.length > 1 && (
              <Button size="sm" variant="ghost" icon={<Layers className="size-3.5" />} onClick={() => setCompare(true)}>
                Compare {candidates.length}
              </Button>
            )}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          </div>
          <Select aria-label="Image source" value={shot.image.reuseOfShotId ?? ''} onChange={(e) => set((s) => ({ ...s, image: { ...s.image, reuseOfShotId: e.target.value || null } }), 'reuse')} className="!text-xs">
            <option value="">Its own image</option>
            {earlier.map((x) => (
              <option key={x.shot.id} value={x.shot.id}>
                Reframe image of {x.scene.title || `scene ${x.sceneIndex + 1}`} · shot {x.shotIndex + 1}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="timecode text-xs text-faint">Shot {index + 1}</span>
            <Select aria-label="Shot size" value={shot.scale} onChange={(e) => set((s) => ({ ...s, scale: e.target.value as ShotScale }))} className="!w-auto !py-1 !text-xs">
              {SCALES.map((v) => (
                <option key={v} value={v}>
                  {v[0]!.toUpperCase() + v.slice(1)}
                </option>
              ))}
            </Select>
            <span className="inline-flex items-center gap-1.5 text-xs text-dim">
              <MotionExample preset={shot.motion.preset} />
              {shot.motion.preset.replace('_', ' ')}
            </span>
            <span className="flex-1" />
            <Input type="number" aria-label="Planned length in seconds" min={1.5} max={120} step={0.5} value={shot.durationSec} onChange={(e) => set((s) => ({ ...s, durationSec: Math.max(1, Number(e.target.value) || 1) }), 'duration')} className="!w-20 !py-1 !text-xs" />
            <IconButton size="sm" label={shot.lockDuration ? 'Length locked (narration changes never resize this shot)' : 'Lock this length'} active={shot.lockDuration} onClick={() => set((s) => ({ ...s, lockDuration: !s.lockDuration }))}>
              {shot.lockDuration ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
            </IconButton>
          </div>
          <Textarea aria-label="Image brief" rows={2} value={shot.brief} placeholder="What the image shows — subject, action, setting, light" onChange={(e) => set((s) => ({ ...s, brief: e.target.value }), 'brief')} />
          <Input aria-label="Composition" value={shot.composition} placeholder="Composition: where the subject sits, space around it" onChange={(e) => set((s) => ({ ...s, composition: e.target.value }), 'composition')} />
          <div className="flex flex-wrap items-center gap-1.5">
            {spec.bible.characters.map((c) => {
              const on = shot.characterIds.includes(c.id);
              return (
                <button key={c.id} type="button" onClick={() => set((s) => ({ ...s, characterIds: on ? s.characterIds.filter((x) => x !== c.id) : [...s.characterIds, c.id] }))} className={cx('cursor-pointer rounded-full border px-2 py-0.5 text-[11px]', on ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-faint hover:text-dim')} aria-pressed={on}>
                  {c.name}
                  {on && !c.refAssetIds.length ? ' · no reference' : ''}
                </button>
              );
            })}
            {spec.bible.locations.length > 0 && (
              <Select aria-label="Location" value={shot.locationId ?? ''} onChange={(e) => set((s) => ({ ...s, locationId: e.target.value || null }))} className="!w-auto !py-0.5 !text-[11px]">
                <option value="">No location reference</option>
                {spec.bible.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
            <span className="flex-1" />
            <IconButton size="sm" label="Split shot (second half reframes the same image)" onClick={() => update((s) => splitShot(s, shot.id), 'split')}>
              <Scissors className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label="Duplicate shot" onClick={() => update((s) => duplicateShot(s, shot.id), 'duplicate')}>
              <Copy className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label="Remove shot" disabled={scene.shots.length <= 1} onClick={() => update((s) => removeShot(s, shot.id), 'remove')}>
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
          {failed && !active && <p className="text-xs text-danger">{failed.error?.message}</p>}
        </div>
      </div>
      <AssetPicker open={pick} onOpenChange={setPick} kinds={['image']} projectId={project.id} title="Choose an image for this shot" onPick={(as) => as[0] && set((s) => ({ ...s, image: { ...s.image, approvedAssetId: as[0]!.id, reuseOfShotId: null, uploads: s.image.uploads.some((u) => u.assetId === as[0]!.id) ? s.image.uploads : [...s.image.uploads, { assetId: as[0]!.id, source: 'import', jobId: null, prompt: null, at: Date.now() }] } }), 'image')} />
      <CandidatesDialog open={compare} onOpenChange={setCompare} shot={shot} candidates={candidates} onApprove={(assetId) => set((s) => ({ ...s, image: { ...s.image, approvedAssetId: assetId, reuseOfShotId: null } }), 'approve')} />
    </div>
  );
}

function SceneCard({ scene, index, props }: { scene: LiteScene; index: number; props: StageProps }) {
  const { spec, update, focus } = props;
  const set = (fn: (s: LiteScene) => LiteScene, label = 'scene') => update((sp) => mapScene(sp, scene.id, fn), label);
  const sentences = useMemo(() => {
    const out: { at: number; label: string }[] = [];
    const re = /[.!?…]["”’)]?\s+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scene.narration))) out.push({ at: m.index + m[0].length, label: scene.narration.slice(Math.max(0, m.index - 30), m.index + 1) });
    return out;
  }, [scene.narration]);
  const est = estimateNarrationSec(scene.narration, spec.setup.wordsPerMinute);
  const planned = scene.shots.reduce((a, x) => a + x.durationSec, 0);
  const voice = props.comp.voices[scene.id];
  return (
    <section id={`scene-${scene.id}`} className={cx('card p-4', focus.sceneId === scene.id && !focus.shotId && 'ring-1 ring-accent/50')}>
      <div className="flex flex-wrap items-start gap-3">
        <span className="display mt-0.5 text-3xl text-faint">{String(index + 1).padStart(2, '0')}</span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Scene title" value={scene.title} onChange={(e) => set((s) => ({ ...s, title: e.target.value }), 'title')} className="!w-auto min-w-[220px] !py-1 font-medium" />
            <Badge>{fmtSec(Math.max(planned, est + scene.leadInSec + scene.tailSec))} planned</Badge>
            {voice?.stale && <Badge tone="warning">Narration out of date</Badge>}
            <span className="flex-1" />
            <IconButton size="sm" label="Move up" disabled={index === 0} onClick={() => update((s) => moveScene(s, scene.id, index - 1), 'move')}>
              <ArrowUp className="size-4" />
            </IconButton>
            <IconButton size="sm" label="Move down" disabled={index === spec.scenes.length - 1} onClick={() => update((s) => moveScene(s, scene.id, index + 1), 'move')}>
              <ArrowDown className="size-4" />
            </IconButton>
            <IconButton size="sm" label="Duplicate scene (images reused)" onClick={() => update((s) => duplicateScene(s, scene.id), 'duplicate')}>
              <Copy className="size-4" />
            </IconButton>
            <IconButton size="sm" label="Remove scene" onClick={() => update((s) => removeScene(s, scene.id), 'remove')}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
          <Input aria-label="Narrative purpose" value={scene.purpose} placeholder="Narrative purpose — why this scene exists" onChange={(e) => set((s) => ({ ...s, purpose: e.target.value }), 'purpose')} />
          <Textarea aria-label="Narration" rows={3} value={scene.narration} onChange={(e) => set((s) => ({ ...s, narration: e.target.value }), 'narration')} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-dim">
            <span>≈ {fmtSec(est)} spoken</span>
            <span className="text-faint">·</span>
            <label className="inline-flex items-center gap-1">
              Pause before
              <Input type="number" min={0} max={30} step={0.5} value={scene.pauseBeforeSec} onChange={(e) => set((s) => ({ ...s, pauseBeforeSec: Math.max(0, Number(e.target.value) || 0) }), 'pause')} className="!w-16 !py-0.5 !text-xs" aria-label="Pause before (seconds)" />s
            </label>
            <label className="inline-flex items-center gap-1">
              <input type="checkbox" checked={scene.pauseBlack} onChange={(e) => set((s) => ({ ...s, pauseBlack: e.target.checked }), 'pause')} /> on black
            </label>
            <Select aria-label="Transition into the scene" value={scene.transitionIn} onChange={(e) => set((s) => ({ ...s, transitionIn: e.target.value as LiteScene['transitionIn'] }))} className="!w-auto !py-0.5 !text-xs">
              <option value="cut">Cut in</option>
              <option value="dissolve">Dissolve in</option>
              <option value="fade_black">Through black</option>
            </Select>
            <Select aria-label="Ambience" value={scene.ambience.kind} onChange={(e) => set((s) => ({ ...s, ambience: { ...s.ambience, kind: e.target.value as LiteScene['ambience']['kind'] } }))} className="!w-auto !py-0.5 !text-xs">
              <option value="none">No ambience</option>
              {AMBIENCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {AMBIENCE_LABELS[k]}
                </option>
              ))}
              <option value="upload">Uploaded ambience</option>
            </Select>
            {sentences.length > 0 && (
              <Select aria-label="Split the scene" value="" onChange={(e) => e.target.value && update((s) => splitScene(s, scene.id, Number(e.target.value)), 'split')} className="!w-auto !py-0.5 !text-xs">
                <option value="">Split after…</option>
                {sentences.slice(0, -1).map((x) => (
                  <option key={x.at} value={x.at}>
                    …{x.label}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {scene.shots.map((shot, i) => (
          <ShotCard key={shot.id} spec={spec} scene={scene} shot={shot} index={i} props={props} focused={focus.shotId === shot.id} />
        ))}
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set((s) => ({ ...s, shots: [...s.shots, newShot({ durationSec: 9, motion: { ...s.shots[s.shots.length - 1]!.motion, preset: 'still', manual: null } })] }), 'add')}>
          Add shot
        </Button>
      </div>
    </section>
  );
}

export function ScenesStage(props: StageProps) {
  const { project, spec, update, work, jobs } = props;
  const ai = useAiRun(project.id);
  const [replace, setReplace] = useState<null | 'ai' | 'script'>(null);
  const [bulk, setBulk] = useState(false);
  const d = LITE_DIRECTION_PRESETS[spec.setup.direction];
  const paragraphs = scriptParagraphs(spec.story.script);
  const shots = allShots(spec);
  const need = shotsNeedingImages(spec);
  const reused = shots.filter((x) => x.shot.image.reuseOfShotId).length;
  const approved = shots.filter((x) => x.shot.image.approvedAssetId).length;
  const uploaded = shots.filter((x) => x.shot.image.uploads.some((u) => u.assetId === x.shot.image.approvedAssetId)).length;
  const idx = useMemo(() => jobIndex(jobs), [jobs]);
  const running = shots.filter((x) => idx.active('lite_shot', x.shot.id)).length;

  const planAi = async () => {
    const out = await ai.run<ScenesOut>(
      'lite.scenes',
      {
        direction: { name: d.label, visual: d.visual, motion: d.motion, shotSec: d.shotSec, dissolveShare: d.dissolveShare, ambience: d.ambience },
        aspect: spec.setup.aspect,
        extraAspects: spec.setup.extraAspects,
        visualPlan: spec.setup.visualPlan,
        paragraphs: paragraphs.map((p, i) => ({ index: i, text: p, spokenSec: estimateNarrationSec(p, spec.setup.wordsPerMinute) })),
        characters: spec.bible.characters.map((c) => ({ name: c.name, description: c.description })),
        locations: spec.bible.locations.map((l) => ({ name: l.name, description: l.description })),
        treatment: spec.story.treatment,
      },
      'Scene plan',
    );
    if (!out) return;
    update((s) => ({ ...s, scenes: planFromModel(s, out), timing: { baseline: null, totalSec: null, acknowledgedAt: null } }), 'plan');
    if (out.notes) toast.message('Notes from the planner', { description: out.notes.slice(0, 400) });
  };
  const planScript = () => update((s) => ({ ...s, scenes: scenesFromScript(s), timing: { baseline: null, totalSec: null, acknowledgedAt: null } }), 'plan');
  const start = (how: 'ai' | 'script') => (spec.scenes.length ? setReplace(how) : how === 'ai' ? void planAi() : planScript());

  /** Existing images fill shots without one, in story order. */
  const placeMyImages = async (files: FileList) => {
    setBulk(true);
    try {
      const targets = shots.filter((x) => !shotImageId(spec, x.shot)).map((x) => x.shot.id);
      const ids: string[] = [];
      for (const f of [...files].slice(0, Math.max(1, targets.length))) ids.push(await uploadFile(f, { kind: 'image', projectId: project.id, collections: ['lite:image'] }));
      update((s) => ids.reduce((acc, assetId, i) => (targets[i] ? mapShot(acc, targets[i]!, (x) => ({ ...x, image: { ...x.image, approvedAssetId: assetId, uploads: [...x.image.uploads, { assetId, source: 'upload', jobId: null, prompt: null, at: Date.now() }] } })) : acc), s), 'images');
      toast.success(`${ids.length} image${ids.length === 1 ? '' : 's'} placed`, { description: 'In story order, on shots that had no image.' });
    } catch (e) {
      toast.error('Upload failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBulk(false);
    }
  };
  const bulkRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <Section
        title="Scene plan"
        sub="Plan before any image is generated. Every scene carries its narration, shots, pauses, transitions, music intensity and ambience."
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" disabled={!paragraphs.length} onClick={() => start('script')}>
              From script (no AI)
            </Button>
            <Button variant="primary" icon={<Sparkles className="size-4" />} loading={ai.busy} disabled={!paragraphs.length} onClick={() => start('ai')}>
              Plan scenes
            </Button>
          </div>
        }
      >
        {!paragraphs.length && <Notice>Write or generate the narration on the Story stage first — each paragraph becomes a scene.</Notice>}
        {spec.scenes.length > 0 && (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            {[
              ['Shots', shots.length],
              ['Approved', approved],
              ['To generate', need.length],
              ['Reframed reuse', reused],
              ['Your images', uploaded],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-xl border border-line px-3 py-2">
                <p className="text-[11px] text-faint">{k}</p>
                <p className="display text-2xl text-fg">{v}</p>
              </div>
            ))}
          </div>
        )}
        {spec.scenes.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Wand2 className="size-4" />} disabled={!need.length || Boolean(work.busy)} loading={work.busy === 'images'} onClick={() => void work.run('images')}>
              Review & generate {need.length} image{need.length === 1 ? '' : 's'}
            </Button>
            <Button variant="ghost" icon={<Upload className="size-4" />} loading={bulk} onClick={() => bulkRef.current?.click()}>
              Use my images
            </Button>
            <input ref={bulkRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(e) => e.target.files?.length && void placeMyImages(e.target.files)} />
            {running > 0 && (
              <Badge tone="accent" icon={<LoaderCircle className="size-3 animate-spin" />}>
                {running} generating
              </Badge>
            )}
            <span className="text-xs text-faint">Nothing is generated until you review the plan and its cost. Approved, reused and uploaded images are never requested again.</span>
          </div>
        )}
      </Section>
      {spec.scenes.map((s, i) => (
        <SceneCard key={s.id} scene={s} index={i} props={props} />
      ))}
      {spec.scenes.length > 0 && (
        <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => update((s) => insertScene(s, null, newScene({ title: `Scene ${s.scenes.length + 1}`, narration: '', shots: [newShot({ id: liteId('sh') })] }, directionOf(s.setup.direction))), 'add')}>
          Add scene
        </Button>
      )}
      <ConfirmDialog
        open={replace !== null}
        onOpenChange={(o) => !o && setReplace(null)}
        title="Replace the scene plan?"
        confirmLabel="Replace plan"
        onConfirm={() => {
          const how = replace;
          setReplace(null);
          if (how === 'ai') void planAi();
          else planScript();
        }}
        body={<>The current scenes and shots are replaced (Undo brings them back). Images and narration you already made stay in your library and can be chosen again.</>}
      />
      {ai.dialog}
    </>
  );
}
