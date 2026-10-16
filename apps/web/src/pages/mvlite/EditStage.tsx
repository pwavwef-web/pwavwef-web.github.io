import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Combine, Copy, Scissors, SplitSquareHorizontal, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import {
  EXPORT_PRESETS,
  LYRIC_PRESET_LABELS,
  LYRIC_PRESETS,
  duplicateMvShot,
  findMvShot,
  mapMvSection,
  mapMvShot,
  mergeMvSections,
  moveMvBoundary,
  moveMvShot,
  mvShotImageId,
  removeMvShot,
  snapToBeat,
  splitMvSection,
  splitMvShot,
  type Clip,
  type ClipLook,
  type LiteAspect,
  type LyricPreset,
  type LyricsTrackDoc,
  type MvSection,
  type MvSectionTransition,
  type MvShot,
  type MvTransition,
} from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { useProjectDoc } from '../../lib/continuity';
import { applyLyricPreset, ASPECT_PRESET, saveMvComposition } from '../../lib/mvlite';
import { useMediaUrls } from '../../lib/media';
import { useUid } from '../../lib/session';
import { useAsset } from '../../components/media';
import { FramingEditor, MotionExample, MotionPresetPicker } from '../../components/lite/FramingEditor';
import { LitePlayer, type PlayerHandle } from '../../components/lite/LitePlayer';
import { LyricStyleStudio } from '../../components/lyric-style-studio';
import { Badge, Button, cx, Field, IconButton, Input, Notice, Segmented, Select, Toggle } from '../../components/ui';
import { fmtSec, LabeledSlider, Section, SECTION_LANE, type MvStageProps } from './common';

function ShotThumb({ assetId, className }: { assetId: string | null; className?: string }) {
  const urls = useMediaUrls(assetId);
  const url = urls?.thumb ?? urls?.file ?? null;
  return url ? <img src={url} alt="" className={cx('object-cover', className)} draggable={false} /> : <div className={cx('bg-panel-2', className)} />;
}

/** The composition is saved as the format's timeline document whenever it changes (debounced). */
function useSavedComposition(props: MvStageProps) {
  const uid = useUid();
  const { project, spec, update, comp, aspect } = props;
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const key = JSON.stringify({ t: comp.assembly.state.tracks, c: comp.assembly.state.clips, b: comp.assembly.state.beatGrid });
  const last = useRef<string>('');
  useEffect(() => {
    if (!spec.sections.length || key === last.current) return;
    const t = setTimeout(async () => {
      setSaved('saving');
      try {
        const r = await saveMvComposition(uid, project, spec, aspect, comp.assembly.state);
        last.current = key;
        if (r.created) update((s) => ({ ...s, timelines: { ...s.timelines, [aspect]: r.timelineId } }), 'composition');
        setSaved('saved');
      } catch {
        setSaved('error');
      }
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, aspect]);
  return saved;
}

function Lane({ label, clips, duration, pxPerSec, color, onSelect, selected, height = 34, text }: { label: string; clips: Clip[]; duration: number; pxPerSec: number; color: (c: Clip) => string; onSelect?: (c: Clip) => void; selected?: (c: Clip) => boolean; height?: number; text?: (c: Clip) => string }) {
  return (
    <div className="flex items-stretch">
      <div className="sticky left-0 z-10 flex w-24 shrink-0 items-center border-r border-line bg-panel px-2 text-[11px] text-faint">{label}</div>
      <div className="relative" style={{ width: duration * pxPerSec, height }}>
        {clips.map((c) => (
          <button key={c.id} type="button" onClick={() => onSelect?.(c)} title={c.label || c.text} className={cx('absolute top-1 bottom-1 cursor-pointer overflow-hidden rounded-[4px] border px-1 text-left text-[10px] leading-tight text-white/90', selected?.(c) ? 'border-white' : 'border-black/30')} style={{ left: c.start * pxPerSec, width: Math.max(2, c.duration * pxPerSec), background: color(c) }}>
            <span className="truncate">{text ? text(c) : c.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LookControls({ look, onChange, inherit }: { look: Partial<ClipLook>; onChange: (l: Partial<ClipLook>) => void; inherit?: ClipLook }) {
  const v = (k: keyof ClipLook) => (look[k] ?? inherit?.[k] ?? 0) as number;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <LabeledSlider label="Film grain" value={v('grain')} display={`${Math.round(v('grain') * 100)} %`} min={0} max={1} step={0.05} onChange={(x) => onChange({ ...look, grain: x })} />
      <LabeledSlider label="Vignette" value={v('vignette')} display={`${Math.round(v('vignette') * 100)} %`} min={0} max={1} step={0.05} onChange={(x) => onChange({ ...look, vignette: x })} />
      <LabeledSlider label="Haze / mist" value={v('haze')} display={`${Math.round(v('haze') * 100)} %`} min={0} max={1} step={0.05} onChange={(x) => onChange({ ...look, haze: x })} />
      <LabeledSlider label="Warmth" value={v('warmth')} display={v('warmth') > 0 ? `warm ${Math.round(v('warmth') * 100)}` : v('warmth') < 0 ? `cool ${Math.round(-v('warmth') * 100)}` : 'neutral'} min={-1} max={1} step={0.05} onChange={(x) => onChange({ ...look, warmth: x })} />
    </div>
  );
}

function ShotInspector({ shot, section, props }: { shot: MvShot; section: MvSection; props: MvStageProps }) {
  const { spec, update, comp, aspect, setFocus } = props;
  const imageId = mvShotImageId(spec, shot);
  const asset = useAsset(imageId);
  const t = comp.timing.sections.find((s) => s.sectionId === section.id)?.shots.find((s) => s.shotId === shot.id);
  const set = (fn: (s: MvShot) => MvShot, label = 'shot') => update((s) => mapMvShot(s, shot.id, fn), label);
  const outWidth = EXPORT_PRESETS[ASPECT_PRESET[aspect]].final.width;
  const index = section.shots.findIndex((x) => x.id === shot.id);
  const sung = comp.lyrics[shot.id] ?? [];
  return (
    <Section
      title={`${section.name || section.label} · shot ${index + 1}`}
      sub={t ? `${fmtSec(t.start)} – ${fmtSec(t.start + t.duration)} · ${t.duration.toFixed(2)} s · ${t.bars.toFixed(1)} bars (planned ${shot.bars})${t.onGrid ? ' · cut on the beat' : ' · cut off the grid'}` : undefined}
      action={
        <div className="flex gap-1">
          <IconButton size="sm" label="Earlier in the section" disabled={index === 0} onClick={() => update((s) => moveMvShot(s, shot.id, -1), 'reorder')}>
            <ChevronLeft className="size-4" />
          </IconButton>
          <IconButton size="sm" label="Later in the section" disabled={index === section.shots.length - 1} onClick={() => update((s) => moveMvShot(s, shot.id, 1), 'reorder')}>
            <ChevronRight className="size-4" />
          </IconButton>
          <IconButton size="sm" label="Split shot" onClick={() => update((s) => splitMvShot(s, shot.id), 'split')}>
            <Scissors className="size-4" />
          </IconButton>
          <IconButton size="sm" label="Duplicate shot" onClick={() => update((s) => duplicateMvShot(s, shot.id), 'duplicate')}>
            <Copy className="size-4" />
          </IconButton>
          <IconButton
            size="sm"
            label="Remove shot"
            disabled={section.shots.length <= 1}
            onClick={() => {
              update((s) => removeMvShot(s, shot.id), 'remove');
              setFocus({ shotId: null });
            }}
          >
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {imageId ? <FramingEditor assetId={imageId} dims={asset.data?.width && asset.data.height ? { w: asset.data.width, h: asset.data.height } : null} motion={shot.motion} aspect={aspect} durationSec={t?.duration ?? 4} outWidth={outWidth} onChange={(m) => set((s) => ({ ...s, motion: m }), 'motion')} /> : <Notice tone="warning">This shot has no image yet — generate, upload or choose one on the Shots stage.</Notice>}
          {sung.length > 0 && <p className="text-xs text-accent-2 italic">♪ {sung.join(' / ')}</p>}
        </div>
        <div className="space-y-4">
          <Field label="Camera movement">
            <MotionPresetPicker value={shot.motion.preset} onChange={(p) => set((s) => ({ ...s, motion: { ...s.motion, preset: p, manual: null } }), 'motion')} />
          </Field>
          <LabeledSlider label="Movement strength" value={shot.motion.intensity} display={`${Math.round(shot.motion.intensity * 100)} %`} min={0} max={0.2} step={0.005} onChange={(v) => set((s) => ({ ...s, motion: { ...s.motion, intensity: v, manual: null } }), 'motion')} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Planned bars">
              <Input type="number" min={0.25} max={32} step={0.5} value={shot.bars} onChange={(e) => set((s) => ({ ...s, bars: Math.max(0.25, Number(e.target.value) || 1) }), 'bars')} />
            </Field>
            <Field label="Into this shot">
              <Segmented size="sm" label="Transition" value={index === 0 ? 'section' : shot.transitionIn} onChange={(v) => v !== 'section' && set((s) => ({ ...s, transitionIn: v as MvTransition }))} options={index === 0 ? [{ value: 'section', label: 'Section transition' }] : [{ value: 'cut', label: 'Cut' }, { value: 'dissolve', label: 'Dissolve' }, { value: 'flash', label: 'Flash' }]} />
            </Field>
          </div>
          <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-sm text-dim">Image treatment for this shot {shot.look ? <Badge className="ml-1">custom</Badge> : null}</summary>
            <div className="mt-3 space-y-2">
              <LookControls look={shot.look ?? {}} inherit={spec.setup.look} onChange={(l) => set((s) => ({ ...s, look: l }), 'look')} />
              {shot.look && (
                <Button size="sm" variant="ghost" onClick={() => set((s) => ({ ...s, look: null }), 'look')}>
                  Use the video’s treatment
                </Button>
              )}
            </div>
          </details>
        </div>
      </div>
    </Section>
  );
}

function SectionInspector({ section, props, playhead }: { section: MvSection; props: MvStageProps; playhead: number }) {
  const { spec, update, comp, song } = props;
  const set = (fn: (s: MvSection) => MvSection, label = 'section') => update((sp) => mapMvSection(sp, section.id, fn), label);
  const i = spec.sections.findIndex((s) => s.id === section.id);
  const next = spec.sections[i + 1];
  const grid = song?.analysis?.downbeats.length ? song.analysis.downbeats : song?.analysis?.beats ?? [];
  const songAt = comp.timing.songStart + playhead;
  const snapped = grid.length ? snapToBeat(songAt, grid) : songAt;
  const bar = grid.length > 1 ? grid[1]! - grid[0]! : 2;
  const st = comp.timing.sections.find((s) => s.sectionId === section.id);
  const inside = st && snapped > st.songStart + 0.5 && snapped < st.songEnd - 0.5;
  return (
    <Section title={section.name || section.label} sub={st ? `${fmtSec(st.start)} – ${fmtSec(st.start + st.duration)} · ${st.bars.toFixed(1)} bars · ${section.shots.length} shot${section.shots.length === 1 ? '' : 's'}` : undefined}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Into the section">
          <Segmented size="sm" label="Section transition" value={i === 0 ? 'cut' : section.transitionIn} onChange={(v: MvSectionTransition) => i > 0 && set((s) => ({ ...s, transitionIn: v }))} options={[{ value: 'cut', label: 'Cut' }, { value: 'dissolve', label: 'Dissolve' }, { value: 'flash', label: 'Flash' }, { value: 'fade_black', label: 'Through black' }]} />
        </Field>
        <Toggle checked={section.lyrics} onChange={(v) => set((s) => ({ ...s, lyrics: v }))} label="Lyrics on screen" description="Off keeps this section’s picture clean." />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {next && (
          <>
            <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-3.5" />} onClick={() => update((s) => moveMvBoundary(s, section.id, section.end - bar), 'boundary')}>
              End a bar earlier
            </Button>
            <Button size="sm" variant="ghost" icon={<ChevronRight className="size-3.5" />} onClick={() => update((s) => moveMvBoundary(s, section.id, section.end + bar), 'boundary')}>
              End a bar later
            </Button>
            <Button size="sm" variant="ghost" icon={<Combine className="size-3.5" />} onClick={() => update((s) => mergeMvSections(s, section.id), 'merge')}>
              Join with “{next.name || next.label}”
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" icon={<SplitSquareHorizontal className="size-3.5" />} disabled={!inside} onClick={() => update((s) => splitMvSection(s, section.id, snapped), 'split')}>
          Split at the playhead ({fmtSec(snapped - comp.timing.songStart)})
        </Button>
      </div>
    </Section>
  );
}

function LyricLook({ props }: { props: MvStageProps }) {
  const { project, spec, update, songDoc } = props;
  const track = useProjectDoc<LyricsTrackDoc>(project.id, 'lyricsTracks', songDoc?.id ?? null);
  const [busy, setBusy] = useState(false);
  if (!songDoc || !spec.lyrics.enabled) return null;
  const apply = async (preset: LyricPreset) => {
    setBusy(true);
    try {
      await applyLyricPreset(project.id, songDoc.id, preset, track.data?.styleId ?? null);
      update((s) => ({ ...s, lyrics: { ...s.lyrics, preset } }), 'lyric-style');
      toast.success(`Lyrics: ${LYRIC_PRESET_LABELS[preset]}`, { description: 'The export lays the lyrics out with this style (the preview shows plain captions).' });
    } catch (e) {
      toast.error('Could not apply the style', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Lyric style" sub="How the lyrics look in the export. The preview above shows their timing; a draft render shows the exact typography.">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Preset">
          <Select value={spec.lyrics.preset} onChange={(e) => void apply(e.target.value as LyricPreset)} disabled={busy}>
            {LYRIC_PRESETS.filter((p) => p !== 'end_credit_scroll' && p !== 'dual_language' && p !== 'call_response').map((p) => (
              <option key={p} value={p}>
                {LYRIC_PRESET_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Badge tone={track.data?.styleId ? 'success' : 'warning'}>{track.data?.styleId ? 'Style applied' : 'No style yet — the export uses plain captions'}</Badge>
        {!track.data?.styleId && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void apply(spec.lyrics.preset)}>
            Apply {LYRIC_PRESET_LABELS[spec.lyrics.preset]}
          </Button>
        )}
      </div>
      <details className="mt-4 rounded-xl border border-line p-3">
        <summary className="cursor-pointer text-sm text-dim">Advanced lyric style studio (fonts, sections, placement, face avoidance)</summary>
        <div className="mt-3">
          <LyricStyleStudio project={project} song={songDoc} />
        </div>
      </details>
    </Section>
  );
}

export function EditStage(props: MvStageProps) {
  const { spec, update, comp, aspect, setAspect, focus, setFocus } = props;
  const player = useRef<PlayerHandle>(null);
  const [playhead, setPlayhead] = useState(0);
  const [zoom, setZoom] = useState(14);
  const [sectionOnly, setSectionOnly] = useState(false);
  const saved = useSavedComposition(props);
  const state = comp.assembly.state;
  const D = comp.assembly.durationSec;
  const hit = focus.shotId ? findMvShot(spec, focus.shotId) : null;
  const section = hit?.section ?? spec.sections.find((s) => s.id === focus.sectionId) ?? null;
  const st = section ? comp.timing.sections.find((s) => s.sectionId === section.id) : null;
  const range = sectionOnly && st ? { start: st.start, end: st.start + st.duration } : null;
  const labelOf = useMemo(() => new Map(spec.sections.flatMap((s) => s.shots.map((x) => [x.id, s.label] as const))), [spec.sections]);
  const sectionOfShot = useMemo(() => new Map(spec.sections.flatMap((s) => s.shots.map((x) => [x.id, s.id] as const))), [spec.sections]);
  const lanes = useMemo(() => ({ pic: state.clips.filter((c) => c.trackId === 'mv_pic'), lyrics: state.clips.filter((c) => c.lyric), song: state.clips.filter((c) => c.trackId === 'mv_song') }), [state.clips]);
  const formats: LiteAspect[] = [spec.setup.aspect, ...spec.setup.extraAspects];
  const seek = (t: number) => player.current?.seek(t);

  useEffect(() => {
    if (hit && !sectionOnly) {
      const t = comp.timing.sections.find((s) => s.sectionId === hit.section.id)?.shots.find((s) => s.shotId === hit.shot.id);
      if (t) seek(t.start + 0.01);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.shotId]);

  if (!spec.sections.length) return <Notice>Plan the shots first — the edit is built from them.</Notice>;
  return (
    <>
      <section className="card space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {formats.length > 1 && <Segmented size="sm" label="Format" value={aspect} onChange={setAspect} options={formats.map((f) => ({ value: f, label: f }))} />}
          <Badge tone="success">{fmtSec(D)}</Badge>
          {comp.timing.bpm && <Badge>{Math.round(comp.timing.bpm)} BPM · cuts on {spec.setup.cutOn === 'beat' ? 'beats' : 'bar lines'}</Badge>}
          {saved !== 'idle' && <Badge tone={saved === 'error' ? 'danger' : 'neutral'}>{saved === 'saving' ? 'Saving composition…' : saved === 'error' ? 'Composition not saved — retrying on the next change' : 'Composition saved'}</Badge>}
          <span className="flex-1" />
          {section && <Toggle checked={sectionOnly} onChange={setSectionOnly} label="Play this section only" />}
        </div>
        <div className={cx('mx-auto', aspect === '9:16' ? 'max-w-[380px]' : aspect === '1:1' ? 'max-w-[560px]' : 'max-w-[980px]')}>
          <LitePlayer ref={player} state={state} durationSec={D} range={range} onTime={setPlayhead} markers={comp.timing.sections.map((s) => ({ time: s.start, label: spec.sections.find((x) => x.id === s.sectionId)?.name ?? '' }))} showSafeArea={false} />
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Storyboard">
          {comp.timing.sections.flatMap((ts) => {
            const s = spec.sections.find((x) => x.id === ts.sectionId)!;
            return s.shots.map((sh, k) => {
              const t = ts.shots[k];
              const on = focus.shotId === sh.id;
              return (
                <button key={sh.id} type="button" onClick={() => setFocus({ sectionId: s.id, shotId: sh.id })} className={cx('w-28 shrink-0 cursor-pointer overflow-hidden rounded-lg border text-left', on ? 'border-accent ring-1 ring-accent/60' : 'border-line hover:border-line-strong')}>
                  <div className="relative aspect-video">
                    <ShotThumb assetId={mvShotImageId(spec, sh)} className="absolute inset-0 size-full" />
                    <span className="absolute bottom-1 left-1">
                      <MotionExample preset={sh.motion.preset} className="!h-[18px] !w-8" />
                    </span>
                    {k === 0 && (
                      <span className="absolute top-1 left-1 rounded px-1 text-[9px] text-white" style={{ background: SECTION_LANE[s.label] }}>
                        {s.name || s.label}
                      </span>
                    )}
                  </div>
                  <p className="truncate px-1.5 py-1 text-[10px] text-dim">{t ? `${t.duration.toFixed(1)} s · ${t.bars.toFixed(1)} bars` : ''}</p>
                </button>
              );
            });
          })}
        </div>

        <div className="rounded-xl border border-line">
          <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
            <span className="text-[11px] text-faint">Timeline · lines mark bars</span>
            <span className="flex-1" />
            <IconButton size="sm" label="Zoom out" onClick={() => setZoom((z) => Math.max(2, z / 1.5))}>
              <ZoomOut className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label="Zoom in" onClick={() => setZoom((z) => Math.min(80, z * 1.5))}>
              <ZoomIn className="size-3.5" />
            </IconButton>
          </div>
          <div className="relative overflow-x-auto">
            <div
              className="relative"
              style={{ width: 96 + D * zoom }}
              onPointerDown={(e) => {
                const target = e.target as HTMLElement;
                if (target.closest('button')) return;
                const r = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - r.left - 96;
                if (x >= 0) seek(x / zoom);
              }}
            >
              <div className="pointer-events-none absolute inset-y-0" style={{ left: 96 }} aria-hidden>
                {comp.timing.downbeats.map((b) => (
                  <span key={b} className="absolute inset-y-0 w-px bg-white/[0.06]" style={{ left: b * zoom }} />
                ))}
              </div>
              <Lane label="Picture" clips={lanes.pic} duration={D} pxPerSec={zoom} height={44} color={(c) => SECTION_LANE[labelOf.get(c.shotId ?? '') ?? 'other']! + 'cc'} selected={(c) => c.shotId === focus.shotId} onSelect={(c) => c.shotId && setFocus({ shotId: c.shotId, sectionId: sectionOfShot.get(c.shotId) ?? null })} text={(c) => `${c.transitionIn.type === 'dip_white' ? '✦ ' : c.transitionIn.type === 'dissolve' ? '◐ ' : ''}${c.label.split('·').pop()?.trim() ?? ''}`} />
              <Lane label="Lyrics" clips={lanes.lyrics} duration={D} pxPerSec={zoom} height={26} color={() => '#2a3b5acc'} text={(c) => c.text} />
              <Lane label="Song" clips={lanes.song} duration={D} pxPerSec={zoom} color={() => '#5b4aa8cc'} />
              <div className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]" style={{ left: 96 + playhead * zoom }} />
            </div>
          </div>
        </div>
      </section>

      {hit && <ShotInspector key={hit.shot.id} shot={hit.shot} section={hit.section} props={props} />}
      {section && <SectionInspector section={section} props={props} playhead={playhead} />}
      <LyricLook props={props} />

      <Section title="Picture treatment" sub="Optional, subtle and rendered locally (deterministic). It never covers the lyrics.">
        <LookControls look={spec.setup.look} onChange={(l) => update((s) => ({ ...s, setup: { ...s.setup, look: { ...s.setup.look, ...l } } }), 'look')} />
      </Section>
      <Section title="Song level and ending" sub="The song plays once, untouched. The picture fades in at the start and out after the last note.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <LabeledSlider label="Song level" value={spec.sound.gainDb} display={`${spec.sound.gainDb > 0 ? '+' : ''}${spec.sound.gainDb.toFixed(1)} dB`} min={-12} max={3} step={0.5} onChange={(v) => update((s) => ({ ...s, sound: { ...s.sound, gainDb: v } }), 'gain')} />
          <LabeledSlider label="Fade in" value={spec.sound.fadeInSec} display={`${spec.sound.fadeInSec.toFixed(1)} s`} min={0} max={4} step={0.1} onChange={(v) => update((s) => ({ ...s, sound: { ...s.sound, fadeInSec: v } }), 'fade')} />
          <LabeledSlider label="Fade out" value={spec.sound.fadeOutSec} display={`${spec.sound.fadeOutSec.toFixed(1)} s`} min={0} max={8} step={0.1} onChange={(v) => update((s) => ({ ...s, sound: { ...s.sound, fadeOutSec: v } }), 'fade')} />
          <LabeledSlider label="Picture after the song" value={spec.sound.tailSec} display={`${spec.sound.tailSec.toFixed(1)} s`} min={0} max={6} step={0.1} onChange={(v) => update((s) => ({ ...s, sound: { ...s.sound, tailSec: v } }), 'tail')} />
        </div>
      </Section>
    </>
  );
}
