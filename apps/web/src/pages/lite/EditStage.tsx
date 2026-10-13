import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Copy, Scissors, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import {
  EXPORT_PRESETS,
  duplicateShot,
  findShot,
  mapScene,
  mapShot,
  removeShot,
  shotImageId,
  splitShot,
  timingBaseline,
  type Clip,
  type ClipLook,
  type LiteAspect,
  type LiteScene,
  type LiteShot,
} from '@az-studio/shared';
import { ASPECT_PRESET, saveComposition } from '../../lib/lite';
import { useMediaUrls } from '../../lib/media';
import { useUid } from '../../lib/session';
import { useAsset, AssetPicker } from '../../components/media';
import { FramingEditor, MotionExample, MotionPresetPicker } from '../../components/lite/FramingEditor';
import { LitePlayer, type PlayerHandle } from '../../components/lite/LitePlayer';
import { Badge, Button, cx, Field, IconButton, Input, Notice, Segmented, Toggle } from '../../components/ui';
import { fmtSec, LabeledSlider, Section, type StageProps } from './common';

const LANE_COLORS = ['#4c8dff', '#9b8cff', '#3ed690', '#f4b84a', '#ff8fa3', '#5fd3e6'];

function ShotThumb({ assetId, className }: { assetId: string | null; className?: string }) {
  const urls = useMediaUrls(assetId);
  const url = urls?.thumb ?? urls?.file ?? null;
  return url ? <img src={url} alt="" className={cx('object-cover', className)} draggable={false} /> : <div className={cx('bg-panel-2', className)} />;
}

/** Composition is saved as the format's timeline document whenever it changes (debounced) — preview and export read the same thing. */
function useSavedComposition(props: StageProps) {
  const uid = useUid();
  const { project, spec, update, comp, aspect } = props;
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const key = JSON.stringify({ t: comp.assembly.state.tracks, c: comp.assembly.state.clips });
  const last = useRef<string>('');
  useEffect(() => {
    if (!spec.scenes.length || key === last.current) return;
    const t = setTimeout(async () => {
      setSaved('saving');
      try {
        const r = await saveComposition(uid, project, spec, aspect, comp.assembly.state);
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

function Lane({ label, clips, duration, pxPerSec, color, onSelect, selected, height = 34, text }: { label: string; clips: Clip[]; duration: number; pxPerSec: number; color: (c: Clip, i: number) => string; onSelect?: (c: Clip) => void; selected?: (c: Clip) => boolean; height?: number; text?: (c: Clip) => string }) {
  return (
    <div className="flex items-stretch">
      <div className="sticky left-0 z-10 flex w-24 shrink-0 items-center border-r border-line bg-panel px-2 text-[11px] text-faint">{label}</div>
      <div className="relative" style={{ width: duration * pxPerSec, height }}>
        {clips.map((c, i) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect?.(c)}
            title={c.label}
            className={cx('absolute top-1 bottom-1 cursor-pointer overflow-hidden rounded-[4px] border px-1 text-left text-[10px] leading-tight text-white/90', selected?.(c) ? 'border-white' : 'border-black/30')}
            style={{ left: c.start * pxPerSec, width: Math.max(2, c.duration * pxPerSec), background: color(c, i) }}
          >
            <span className="truncate">{text ? text(c) : c.label}</span>
            {c.volumeAutomation && c.volumeAutomation.length > 2 && (
              <svg className="pointer-events-none absolute inset-0 size-full" preserveAspectRatio="none" viewBox={`0 0 ${c.duration} 1`} aria-hidden>
                <polyline fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={0.04} vectorEffect="non-scaling-stroke" points={c.volumeAutomation.map((p) => `${p.t},${1 - Math.min(1, p.gain)}`).join(' ')} />
              </svg>
            )}
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

function ShotInspector({ shot, scene, props }: { shot: LiteShot; scene: LiteScene; props: StageProps }) {
  const { spec, update, comp, aspect, setFocus } = props;
  const imageId = shot.parallax?.backgroundAssetId ?? shotImageId(spec, shot);
  const asset = useAsset(imageId);
  const [pick, setPick] = useState<'bg' | 'fg' | null>(null);
  const t = comp.timing.scenes.find((s) => s.sceneId === scene.id)?.shots.find((s) => s.shotId === shot.id);
  const set = (fn: (s: LiteShot) => LiteShot, label = 'shot') => update((s) => mapShot(s, shot.id, fn), label);
  const outWidth = EXPORT_PRESETS[ASPECT_PRESET[aspect]].final.width;
  const index = scene.shots.findIndex((x) => x.id === shot.id);
  const move = (dir: -1 | 1) => update((s) => mapScene(s, scene.id, (sc) => {
    const shots = [...sc.shots];
    const i = shots.findIndex((x) => x.id === shot.id);
    const j = i + dir;
    if (j < 0 || j >= shots.length) return sc;
    [shots[i], shots[j]] = [shots[j]!, shots[i]!];
    return { ...sc, shots };
  }), 'reorder');
  return (
    <Section
      title={`${scene.title || 'Scene'} · shot ${index + 1}`}
      sub={t ? `${fmtSec(t.start)} – ${fmtSec(t.start + t.duration)} · ${t.duration.toFixed(1)} s on screen (planned ${shot.durationSec.toFixed(1)} s${shot.lockDuration ? ', locked' : ''})` : undefined}
      action={
        <div className="flex gap-1">
          <IconButton size="sm" label="Earlier in the scene" disabled={index === 0} onClick={() => move(-1)}>
            <ChevronLeft className="size-4" />
          </IconButton>
          <IconButton size="sm" label="Later in the scene" disabled={index === scene.shots.length - 1} onClick={() => move(1)}>
            <ChevronRight className="size-4" />
          </IconButton>
          <IconButton size="sm" label="Split shot" onClick={() => update((s) => splitShot(s, shot.id), 'split')}>
            <Scissors className="size-4" />
          </IconButton>
          <IconButton size="sm" label="Duplicate shot" onClick={() => update((s) => duplicateShot(s, shot.id), 'duplicate')}>
            <Copy className="size-4" />
          </IconButton>
          <IconButton size="sm" label="Remove shot" disabled={scene.shots.length <= 1} onClick={() => { update((s) => removeShot(s, shot.id), 'remove'); setFocus({ shotId: null }); }}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {imageId ? (
            <FramingEditor assetId={imageId} dims={asset.data?.width && asset.data.height ? { w: asset.data.width, h: asset.data.height } : null} motion={shot.motion} aspect={aspect} durationSec={t?.duration ?? shot.durationSec} outWidth={outWidth} onChange={(m) => set((s) => ({ ...s, motion: m }), 'motion')} />
          ) : (
            <Notice tone="warning">This shot has no image yet — generate, upload or choose one on the Scenes stage.</Notice>
          )}
        </div>
        <div className="space-y-4">
          <Field label="Camera movement">
            <MotionPresetPicker value={shot.motion.preset} onChange={(p) => set((s) => ({ ...s, motion: { ...s.motion, preset: p, manual: null } }), 'motion')} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Planned length (s)">
              <Input type="number" min={1.5} max={120} step={0.5} value={shot.durationSec} onChange={(e) => set((s) => ({ ...s, durationSec: Math.max(1, Number(e.target.value) || 1) }), 'duration')} />
            </Field>
            <Field label="Into this shot">
              <Segmented size="sm" label="Transition" value={index === 0 ? 'scene' : shot.transitionIn} onChange={(v) => v !== 'scene' && set((s) => ({ ...s, transitionIn: v as LiteShot['transitionIn'] }))} options={index === 0 ? [{ value: 'scene', label: 'Scene transition' }] : [{ value: 'cut', label: 'Cut' }, { value: 'dissolve', label: 'Dissolve' }]} />
            </Field>
          </div>
          <Toggle checked={shot.lockDuration} onChange={(v) => set((s) => ({ ...s, lockDuration: v }))} label="Lock length" description="Narration changes never resize a locked shot; the scene's other shots absorb the difference." />
          <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-sm text-dim">Image treatment for this shot {shot.look ? <Badge className="ml-1">custom</Badge> : null}</summary>
            <div className="mt-3 space-y-2">
              <LookControls look={shot.look ?? {}} inherit={spec.setup.look} onChange={(l) => set((s) => ({ ...s, look: l }), 'look')} />
              {shot.look && (
                <Button size="sm" variant="ghost" onClick={() => set((s) => ({ ...s, look: null }), 'look')}>
                  Use the film’s treatment
                </Button>
              )}
            </div>
          </details>
          <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-sm text-dim">Parallax (optional) {shot.parallax ? <Badge className="ml-1">on</Badge> : null}</summary>
            <p className="mt-2 text-xs text-faint">Needs two layers you already have: a clean background plate (the subject removed) and a transparent PNG of the foreground. AZ Studio does not cut layers out automatically — without a clean plate the subject would ghost. Without parallax the shot uses a clean pan/zoom.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPick('bg')}>
                {shot.parallax?.backgroundAssetId ? 'Change background plate' : 'Choose background plate'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPick('fg')}>
                {shot.parallax?.foregroundAssetId ? 'Change foreground layer' : 'Choose foreground layer'}
              </Button>
              {shot.parallax && (
                <Button size="sm" variant="ghost" onClick={() => set((s) => ({ ...s, parallax: null }), 'parallax')}>
                  Remove parallax
                </Button>
              )}
            </div>
            {shot.parallax && <LabeledSlider className="mt-3" label="Depth" value={shot.parallax.strength} display={`${Math.round(shot.parallax.strength * 100)} %`} min={0} max={1} step={0.05} onChange={(v) => set((s) => ({ ...s, parallax: s.parallax && { ...s.parallax, strength: v } }), 'parallax')} />}
            <AssetPicker
              open={pick !== null}
              onOpenChange={(o) => !o && setPick(null)}
              kinds={['image']}
              projectId={props.project.id}
              title={pick === 'fg' ? 'Transparent foreground layer (PNG)' : 'Clean background plate'}
              onPick={(as) => {
                const id = as[0]?.id;
                if (!id) return;
                set((s) => {
                  const cur = s.parallax ?? { backgroundAssetId: shotImageId(spec, s) ?? id, foregroundAssetId: id, strength: 0.4 };
                  return { ...s, parallax: pick === 'fg' ? { ...cur, foregroundAssetId: id } : { ...cur, backgroundAssetId: id } };
                }, 'parallax');
                setPick(null);
              }}
            />
          </details>
        </div>
      </div>
    </Section>
  );
}

function SceneInspector({ scene, props }: { scene: LiteScene; props: StageProps }) {
  const { update } = props;
  const set = (fn: (s: LiteScene) => LiteScene, label = 'scene') => update((sp) => mapScene(sp, scene.id, fn), label);
  return (
    <Section title={scene.title || 'Scene'} sub="Pauses and breathing room around the narration.">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <LabeledSlider label="Pause before" value={scene.pauseBeforeSec} display={`${scene.pauseBeforeSec.toFixed(1)} s`} min={0} max={8} step={0.25} onChange={(v) => set((s) => ({ ...s, pauseBeforeSec: v }), 'pause')} />
        <LabeledSlider label="Picture before the first word" value={scene.leadInSec} display={`${scene.leadInSec.toFixed(1)} s`} min={0} max={6} step={0.1} onChange={(v) => set((s) => ({ ...s, leadInSec: v }), 'lead')} />
        <LabeledSlider label="Room after the last word" value={scene.tailSec} display={`${scene.tailSec.toFixed(1)} s`} min={0} max={10} step={0.1} onChange={(v) => set((s) => ({ ...s, tailSec: v }), 'tail')} />
        <Toggle checked={scene.pauseBlack} onChange={(v) => set((s) => ({ ...s, pauseBlack: v }), 'pause')} label="Pause on black" description="A deliberate chapter break (allowed by the export checks)." />
        <Field label="Into the scene">
          <Segmented size="sm" label="Scene transition" value={scene.transitionIn} onChange={(v: LiteScene['transitionIn']) => set((s) => ({ ...s, transitionIn: v }))} options={[{ value: 'cut', label: 'Cut' }, { value: 'dissolve', label: 'Dissolve' }, { value: 'fade_black', label: 'Through black' }]} />
        </Field>
        <Toggle checked={scene.subtitles} onChange={(v) => set((s) => ({ ...s, subtitles: v }))} label="Subtitles in this scene" />
        <Field label="Music">
          <Segmented size="sm" label="Music" value={scene.music.mode} onChange={(v: LiteScene['music']['mode']) => set((s) => ({ ...s, music: { ...s.music, mode: v } }))} options={[{ value: 'score', label: 'Score' }, { value: 'silence', label: 'Deliberate silence' }]} />
        </Field>
        <LabeledSlider label="Music intensity" value={scene.music.intensity} display={`${scene.music.intensity}/10`} min={0} max={10} step={1} onChange={(v) => set((s) => ({ ...s, music: { ...s.music, intensity: v } }), 'intensity')} />
      </div>
      <p className="mt-3 text-xs text-faint">Music intensity shapes how the score is composed; re-compose the affected movement on the Voice & Sound stage after large changes.</p>
    </Section>
  );
}

export function EditStage(props: StageProps) {
  const { spec, update, comp, aspect, setAspect, focus, setFocus } = props;
  const player = useRef<PlayerHandle>(null);
  const [playhead, setPlayhead] = useState(0);
  const [zoom, setZoom] = useState(8);
  const [sceneOnly, setSceneOnly] = useState(false);
  const saved = useSavedComposition(props);
  const state = comp.assembly.state;
  const D = comp.assembly.durationSec;
  const hit = focus.shotId ? findShot(spec, focus.shotId) : null;
  const scene = hit?.scene ?? spec.scenes.find((s) => s.id === focus.sceneId) ?? null;
  const st = scene ? comp.timing.scenes.find((s) => s.sceneId === scene.id) : null;
  const range = sceneOnly && st ? { start: st.blackStart, end: st.start + st.duration } : null;
  const sceneOf = useMemo(() => new Map(spec.scenes.flatMap((s, i) => s.shots.map((x) => [x.id, i] as const))), [spec.scenes]);
  const lanes = useMemo(() => {
    const by = (prefix: string) => state.clips.filter((c) => c.trackId.startsWith(prefix));
    return { pic: state.clips.filter((c) => c.trackId === 'lt_pic'), voice: by('lt_voice'), music: by('lt_mus'), amb: by('lt_amb'), fx: by('lt_fx'), subs: by('lt_sub') };
  }, [state.clips]);
  const formats: LiteAspect[] = [spec.setup.aspect, ...spec.setup.extraAspects];
  const rec = comp.reconciliation;
  const seek = (t: number) => player.current?.seek(t);

  useEffect(() => {
    if (hit && !sceneOnly) {
      const t = comp.timing.scenes.find((s) => s.sceneId === hit.scene.id)?.shots.find((s) => s.shotId === hit.shot.id);
      if (t) seek(t.start + 0.01);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.shotId]);

  if (!spec.scenes.length) return <Notice>Plan the scenes first — the edit is built from them.</Notice>;
  return (
    <>
      {(rec.changes.length > 0 || !spec.timing.baseline) && (
        <Notice tone={spec.timing.baseline ? 'warning' : 'accent'} icon={<CheckCircle2 className="size-4" />}>
          <div className="space-y-2">
            {spec.timing.baseline ? (
              <>
                <p className="font-medium text-fg">
                  Timing changed: {rec.totalBefore !== null ? `${fmtSec(rec.totalBefore)} → ` : ''}
                  {fmtSec(rec.totalAfter)}. Voice is never cut; the picture follows the narration.
                </p>
                <ul className="space-y-0.5 text-xs">
                  {rec.changes.slice(0, 8).map((c) => (
                    <li key={c.sceneId}>
                      <button type="button" className="cursor-pointer hover:underline" onClick={() => setFocus({ sceneId: c.sceneId, shotId: null })}>
                        {c.title}
                      </button>
                      : {c.before ? `${fmtSec(c.before.start)} (${c.before.duration.toFixed(1)} s)` : 'new'} → {fmtSec(c.after.start)} ({c.after.duration.toFixed(1)} s) — {c.reason}
                    </li>
                  ))}
                  {rec.changes.length > 8 && <li>+{rec.changes.length - 8} more</li>}
                </ul>
              </>
            ) : (
              <p>{comp.timing.estimated ? 'Scene lengths are estimates until every scene has narration.' : 'Review the timing in the preview, then accept it as the approved edit.'}</p>
            )}
            <Button size="sm" variant="secondary" onClick={() => update((s) => ({ ...s, timing: { ...timingBaseline(comp.timing), acknowledgedAt: Date.now() } }), 'timing')}>
              Accept this timing
            </Button>
          </div>
        </Notice>
      )}

      <section className="card space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {formats.length > 1 && <Segmented size="sm" label="Format" value={aspect} onChange={setAspect} options={formats.map((f) => ({ value: f, label: f }))} />}
          <Badge tone={comp.timing.estimated ? 'warning' : 'success'}>{fmtSec(D)} {comp.timing.estimated ? 'estimated' : 'measured'}</Badge>
          {saved !== 'idle' && <Badge tone={saved === 'error' ? 'danger' : 'neutral'}>{saved === 'saving' ? 'Saving composition…' : saved === 'error' ? 'Composition not saved — retrying on the next change' : 'Composition saved'}</Badge>}
          <span className="flex-1" />
          {scene && <Toggle checked={sceneOnly} onChange={setSceneOnly} label="Play this scene only" />}
        </div>
        <div className={cx('mx-auto', aspect === '9:16' ? 'max-w-[380px]' : aspect === '1:1' ? 'max-w-[560px]' : 'max-w-[980px]')}>
          <LitePlayer ref={player} state={state} durationSec={D} range={range} onTime={setPlayhead} markers={comp.timing.scenes.map((s) => ({ time: s.blackStart, label: spec.scenes[s.index]!.title }))} showSafeArea={false} />
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Storyboard">
          {spec.scenes.flatMap((s, si) =>
            s.shots.map((sh, k) => {
              const t = comp.timing.scenes[si]?.shots[k];
              const on = focus.shotId === sh.id;
              return (
                <button key={sh.id} type="button" onClick={() => setFocus({ sceneId: s.id, shotId: sh.id })} className={cx('w-32 shrink-0 cursor-pointer overflow-hidden rounded-lg border text-left', on ? 'border-accent ring-1 ring-accent/60' : 'border-line hover:border-line-strong')}>
                  <div className="relative aspect-video">
                    <ShotThumb assetId={shotImageId(spec, sh)} className="absolute inset-0 size-full" />
                    <span className="absolute bottom-1 left-1">
                      <MotionExample preset={sh.motion.preset} className="!h-[18px] !w-8" />
                    </span>
                    {k === 0 && <span className="absolute top-1 left-1 rounded bg-black/60 px-1 text-[9px] text-white">{String(si + 1).padStart(2, '0')}</span>}
                  </div>
                  <p className="truncate px-1.5 py-1 text-[10px] text-dim">{t ? `${t.duration.toFixed(1)} s` : ''} · {sh.motion.preset.replace('_', ' ')}</p>
                </button>
              );
            }),
          )}
        </div>

        <div className="rounded-xl border border-line">
          <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
            <span className="text-[11px] text-faint">Timeline</span>
            <span className="flex-1" />
            <IconButton size="sm" label="Zoom out" onClick={() => setZoom((z) => Math.max(1.5, z / 1.5))}>
              <ZoomOut className="size-3.5" />
            </IconButton>
            <IconButton size="sm" label="Zoom in" onClick={() => setZoom((z) => Math.min(60, z * 1.5))}>
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
              <Lane label="Picture" clips={lanes.pic} duration={D} pxPerSec={zoom} height={44} color={(c) => (c.intentional === 'black' ? '#000' : LANE_COLORS[(sceneOf.get(c.shotId ?? '') ?? 0) % LANE_COLORS.length]! + 'cc')} selected={(c) => c.shotId === focus.shotId} onSelect={(c) => c.shotId && setFocus({ shotId: c.shotId, sceneId: spec.scenes[sceneOf.get(c.shotId) ?? 0]?.id ?? null })} text={(c) => (c.intentional === 'black' ? 'black' : c.label.split('·').pop()?.trim() ?? '')} />
              <Lane label="Narration" clips={lanes.voice} duration={D} pxPerSec={zoom} color={() => '#2f6f5acc'} onSelect={(c) => setFocus({ sceneId: c.id.replace(/^lv_/, ''), shotId: null })} text={(c) => c.label.replace('Narration · ', '')} />
              <Lane label="Music" clips={lanes.music} duration={D} pxPerSec={zoom} color={() => '#5b4aa8cc'} text={(c) => c.label.replace('Score · ', '')} />
              <Lane label="Ambience" clips={lanes.amb} duration={D} pxPerSec={zoom} color={() => '#3b5568cc'} text={(c) => c.label.replace('Ambience · ', '')} />
              {lanes.fx.length > 0 && <Lane label="Effects" clips={lanes.fx} duration={D} pxPerSec={zoom} color={() => '#8a5a2bcc'} />}
              <Lane label="Subtitles" clips={lanes.subs} duration={D} pxPerSec={zoom} height={26} color={(c) => (comp.assembly.cues.find((q) => Math.abs(q.start - c.start) < 0.002)?.timing === 'estimated' ? '#8a6a1ccc' : '#2a3b5acc')} text={(c) => c.text.replace(/\n/g, ' ')} />
              <div className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]" style={{ left: 96 + playhead * zoom }} />
            </div>
          </div>
          <p className="border-t border-line px-2 py-1.5 text-[11px] text-faint">Lines on music and ambience show their level: they dip under each spoken line and breathe between lines (the same automation the export uses).</p>
        </div>
      </section>

      {hit && <ShotInspector key={hit.shot.id} shot={hit.shot} scene={hit.scene} props={props} />}
      {!hit && scene && <SceneInspector scene={scene} props={props} />}
      {scene && hit && <SceneInspector scene={scene} props={props} />}

      <Section title="Film treatment" sub="Optional, subtle and rendered locally (deterministic). Never required for a strong result; it never covers subtitles.">
        <LookControls look={spec.setup.look} onChange={(l) => update((s) => ({ ...s, setup: { ...s.setup, look: { ...s.setup.look, ...l } } }), 'look')} />
      </Section>
    </>
  );
}
