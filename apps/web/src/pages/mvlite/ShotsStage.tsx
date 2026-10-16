import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Check, Copy, ImagePlus, Images, Layers, LoaderCircle, Plus, RefreshCw, Scissors, Sparkles, Trash2, TriangleAlert, Upload, Wand2 } from 'lucide-react';
import {
  allMvShots,
  duplicateMvShot,
  energyBand,
  findMvShot,
  lyricsDuring,
  mapMvSection,
  mapMvShot,
  moveMvShot,
  mvPlanFromModel,
  mvShotsInput,
  mvSectionsFromSong,
  mvShotImageId,
  mvShotsNeedingImages,
  newMvShot,
  removeMvShot,
  spanEnergy,
  splitMvShot,
  type MvSection,
  type MvPlanOut,
  type MvSectionTransition,
  type MvShot,
  type MvTransition,
  type ShotScale,
} from '@az-studio/shared';
import { useAiRun } from '../../lib/ai';
import { jobIndex, type ShotCandidate } from '../../lib/mvlite';
import { uploadFile } from '../../lib/media';
import { AssetPicker, AssetThumb, useAsset, type Asset } from '../../components/media';
import { MotionExample } from '../../components/lite/FramingEditor';
import { Badge, Button, ConfirmDialog, cx, IconButton, Input, Modal, Notice, Select, Textarea, Tip } from '../../components/ui';
import { fmtSec, Section, SECTION_COLORS, type MvStageProps } from './common';

const SCALES: ShotScale[] = ['establishing', 'wide', 'medium', 'close', 'detail'];

function ImageStatus({ assetId, active, failed }: { assetId: string | null; active: boolean; failed: string | null }) {
  const a = useAsset(assetId);
  return (
    <div className="relative overflow-hidden rounded-lg bg-black/40">
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

function CandidateThumb({ assetId }: { assetId: string }) {
  const a = useAsset(assetId);
  return a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} aspect="aspect-video" hoverPlay={false} /> : <div className="aspect-video animate-pulse rounded-lg bg-panel-2" />;
}

function CandidatesDialog({ open, onOpenChange, shot, candidates, onApprove }: { open: boolean; onOpenChange: (o: boolean) => void; shot: MvShot; candidates: ShotCandidate[]; onApprove: (assetId: string) => void }) {
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

function ShotCard({ section, shot, index, props, focused }: { section: MvSection; shot: MvShot; index: number; props: MvStageProps; focused: boolean }) {
  const { spec, update, project, work, jobs, comp } = props;
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
  const candidates: ShotCandidate[] = [...idx.imageCandidates(shot.id), ...shot.image.uploads];
  const imageId = mvShotImageId(spec, shot);
  const reuse = shot.image.reuseOfShotId ? findMvShot(spec, shot.image.reuseOfShotId) : null;
  const set = (fn: (s: MvShot) => MvShot, label = 'shot') => update((s) => mapMvShot(s, shot.id, fn), label);
  const earlier = allMvShots(spec).filter((x) => x.shot.id !== shot.id && !x.shot.image.reuseOfShotId);
  const t = comp.timing.sections.find((s) => s.sectionId === section.id)?.shots.find((x) => x.shotId === shot.id);
  const sung = comp.lyrics[shot.id] ?? [];

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const assetId = await uploadFile(file, { kind: 'image', projectId: project.id, collections: ['mvlite:image', `mvlite:shot:${shot.id}`] });
      set((s) => ({ ...s, image: { ...s.image, approvedAssetId: assetId, reuseOfShotId: null, uploads: [...s.image.uploads, { assetId, source: 'upload', jobId: null, prompt: null, at: Date.now() }] } }), 'image');
      toast.success('Image uploaded and approved for this shot');
    } catch (e) {
      toast.error('Upload failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div ref={ref} data-shot={shot.id} className={cx('rounded-xl border bg-panel/60 p-3 transition-colors', focused ? 'border-accent/60 shadow-[var(--shadow-glow)]' : 'border-line')}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          <button type="button" className="block w-full cursor-pointer text-left" onClick={() => setCompare(true)} aria-label="Compare images for this shot">
            <ImageStatus assetId={imageId} active={Boolean(active)} failed={failed?.error?.message ?? null} />
          </button>
          <div className="flex flex-wrap gap-1">
            {!reuse && (
              <Button size="sm" variant={imageId ? 'ghost' : 'secondary'} icon={imageId ? <RefreshCw className="size-3.5" /> : <Wand2 className="size-3.5" />} disabled={Boolean(active) || work.busy} onClick={() => void work.run({ targetIds: [shot.id], force: Boolean(imageId) })}>
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
                Reframe image of {x.section.name || x.section.label} · shot {x.shotIndex + 1}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="timecode text-xs text-faint">Shot {index + 1}</span>
            {t && <span className="timecode text-xs text-dim">{fmtSec(t.start)} · {t.duration.toFixed(2)} s · {t.bars.toFixed(1)} bars</span>}
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
            <label className="inline-flex items-center gap-1 text-xs text-dim">
              Bars
              <Input type="number" aria-label="Planned length in bars" min={0.25} max={32} step={0.5} value={shot.bars} onChange={(e) => set((s) => ({ ...s, bars: Math.max(0.25, Number(e.target.value) || 1) }), 'bars')} className="!w-16 !py-1 !text-xs" />
            </label>
            {index > 0 && (
              <Select aria-label="Into this shot" value={shot.transitionIn} onChange={(e) => set((s) => ({ ...s, transitionIn: e.target.value as MvTransition }))} className="!w-auto !py-1 !text-xs">
                <option value="cut">Cut</option>
                <option value="dissolve">Dissolve</option>
                <option value="flash">Flash</option>
              </Select>
            )}
          </div>
          {sung.length > 0 && <p className="truncate text-xs text-accent-2 italic" title={sung.join(' / ')}>♪ {sung.join(' / ')}</p>}
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
            <IconButton size="sm" label="Earlier" disabled={index === 0} onClick={() => update((s) => moveMvShot(s, shot.id, -1), 'reorder')}>
              <ArrowUp className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label="Later" disabled={index === section.shots.length - 1} onClick={() => update((s) => moveMvShot(s, shot.id, 1), 'reorder')}>
              <ArrowDown className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label="Split shot (second half reframes the same image)" onClick={() => update((s) => splitMvShot(s, shot.id), 'split')}>
              <Scissors className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label="Duplicate shot" onClick={() => update((s) => duplicateMvShot(s, shot.id), 'duplicate')}>
              <Copy className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label="Remove shot" disabled={section.shots.length <= 1} onClick={() => update((s) => removeMvShot(s, shot.id), 'remove')}>
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

function SectionCard({ section, index, props }: { section: MvSection; index: number; props: MvStageProps }) {
  const { update, focus, comp, song } = props;
  const set = (fn: (s: MvSection) => MvSection, label = 'section') => update((sp) => mapMvSection(sp, section.id, fn), label);
  const st = comp.timing.sections.find((s) => s.sectionId === section.id);
  const lines = st ? lyricsDuring(song?.sheet, st.songStart, st.songEnd) : [];
  const band = song ? energyBand(spanEnergy(song.analysis, section.start, section.end)) : 'mid';
  return (
    <section id={`section-${section.id}`} className={cx('card p-4', focus.sectionId === section.id && !focus.shotId && 'ring-1 ring-accent/50')}>
      <div className="flex flex-wrap items-start gap-3">
        <span className="display mt-0.5 rounded-lg px-2 text-3xl text-faint" style={{ background: SECTION_COLORS[section.label] }}>
          {String(index + 1).padStart(2, '0')}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Section name" value={section.name} onChange={(e) => set((s) => ({ ...s, name: e.target.value }), 'name')} className="!w-auto min-w-[180px] !py-1 font-medium" />
            <Badge>{section.label}</Badge>
            {st && <Badge>{fmtSec(st.start)} · {st.duration.toFixed(1)} s · {st.bars.toFixed(1)} bars</Badge>}
            <Badge tone={band === 'high' ? 'warning' : band === 'low' ? 'neutral' : 'accent'}>{band} energy</Badge>
            <span className="flex-1" />
            <Select aria-label="Into the section" value={section.transitionIn} disabled={index === 0} onChange={(e) => set((s) => ({ ...s, transitionIn: e.target.value as MvSectionTransition }))} className="!w-auto !py-0.5 !text-xs">
              <option value="cut">Cut in</option>
              <option value="dissolve">Dissolve in</option>
              <option value="flash">Flash in</option>
              <option value="fade_black">Through black</option>
            </Select>
            <label className="inline-flex items-center gap-1 text-xs text-dim">
              <input type="checkbox" checked={section.lyrics} onChange={(e) => set((s) => ({ ...s, lyrics: e.target.checked }))} /> lyrics on screen
            </label>
          </div>
          <Input aria-label="Visual idea" value={section.idea} placeholder="Visual idea — what this section shows and why" onChange={(e) => set((s) => ({ ...s, idea: e.target.value }), 'idea')} />
          <Input aria-label="Mood" value={section.mood} placeholder="Mood" onChange={(e) => set((s) => ({ ...s, mood: e.target.value }), 'mood')} />
          {lines.length > 0 && <p className="text-xs text-dim italic">♪ {lines.map((l) => l.text).join(' / ')}</p>}
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {section.shots.map((shot, i) => (
          <ShotCard key={shot.id} section={section} shot={shot} index={i} props={props} focused={focus.shotId === shot.id} />
        ))}
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set((s) => ({ ...s, shots: [...s.shots, newMvShot({ bars: s.shots[s.shots.length - 1]?.bars ?? 2, motion: { ...s.shots[s.shots.length - 1]!.motion, preset: 'still', manual: null } })] }), 'add')}>
          Add shot
        </Button>
      </div>
    </section>
  );
}

export function ShotsStage(props: MvStageProps) {
  const { project, spec, update, work, jobs, song, go } = props;
  const ai = useAiRun(project.id);
  const [replace, setReplace] = useState<null | 'ai' | 'song'>(null);
  const [bulk, setBulk] = useState(false);
  const shots = allMvShots(spec);
  const need = mvShotsNeedingImages(spec);
  const approved = shots.filter((x) => x.shot.image.approvedAssetId).length;
  const reused = shots.filter((x) => x.shot.image.reuseOfShotId).length;
  const idx = useMemo(() => jobIndex(jobs), [jobs]);
  const running = shots.filter((x) => idx.active('lite_shot', x.shot.id)).length;
  const ready = Boolean(song?.analysis);

  const planSong = () => song && update((s) => ({ ...s, sections: mvSectionsFromSong(s, song) }), 'plan');
  const planAi = async () => {
    if (!song) return;
    const out = await ai.run<MvPlanOut>('mvlite.shots', mvShotsInput(spec, song), 'Music video shot plan');
    if (!out) return;
    update((s) => ({ ...s, sections: mvPlanFromModel(s, mvSectionsFromSong(s, song), out) }), 'plan');
    if (out.notes) toast.message('Notes from the planner', { description: out.notes.slice(0, 400) });
  };
  const start = (how: 'ai' | 'song') => (spec.sections.length ? setReplace(how) : how === 'ai' ? void planAi() : planSong());

  /** Existing images fill shots without one, in order. */
  const placeMyImages = async (files: FileList) => {
    setBulk(true);
    try {
      const targets = shots.filter((x) => !mvShotImageId(spec, x.shot)).map((x) => x.shot.id);
      const ids: string[] = [];
      for (const f of [...files].slice(0, Math.max(1, targets.length))) ids.push(await uploadFile(f, { kind: 'image', projectId: project.id, collections: ['mvlite:image'] }));
      update((s) => ids.reduce((acc, assetId, i) => (targets[i] ? mapMvShot(acc, targets[i]!, (x) => ({ ...x, image: { ...x.image, approvedAssetId: assetId, uploads: [...x.image.uploads, { assetId, source: 'upload', jobId: null, prompt: null, at: Date.now() }] } })) : acc), s), 'images');
      toast.success(`${ids.length} image${ids.length === 1 ? '' : 's'} placed`, { description: 'In order, on shots that had no image.' });
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
        title="Shot plan"
        sub="One section per part of the song; shots share each section’s bars and cut on the beat. Plan before any image is generated."
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" disabled={!ready} onClick={() => start('song')}>
              From the song (no AI)
            </Button>
            <Button variant="primary" icon={<Sparkles className="size-4" />} loading={ai.busy} disabled={!ready} onClick={() => start('ai')}>
              Plan shots
            </Button>
          </div>
        }
      >
        {!song ? (
          <Notice>Choose the song first.</Notice>
        ) : !ready ? (
          <Notice>
            Detect the song’s beats and sections first.{' '}
            <Button size="sm" variant="ghost" onClick={() => go('song')}>
              Song stage
            </Button>
          </Notice>
        ) : null}
        {spec.sections.length > 0 && (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ['Shots', shots.length],
              ['Approved', approved],
              ['To generate', need.length],
              ['Reframed reuse', reused],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-xl border border-line px-3 py-2">
                <p className="text-[11px] text-faint">{k}</p>
                <p className="display text-2xl text-fg">{v}</p>
              </div>
            ))}
          </div>
        )}
        {spec.sections.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Wand2 className="size-4" />} disabled={!need.length || work.busy} loading={work.busy} onClick={() => void work.run()}>
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
      {spec.sections.map((s, i) => (
        <SectionCard key={s.id} section={s} index={i} props={props} />
      ))}
      <ConfirmDialog
        open={replace !== null}
        onOpenChange={(o) => !o && setReplace(null)}
        title="Replace the shot plan?"
        confirmLabel="Replace plan"
        onConfirm={() => {
          const how = replace;
          setReplace(null);
          if (how === 'ai') void planAi();
          else planSong();
        }}
        body={<>The current sections and shots are replaced (Undo brings them back). Images you already made stay in your library and can be chosen again.</>}
      />
      {ai.dialog}
    </>
  );
}
