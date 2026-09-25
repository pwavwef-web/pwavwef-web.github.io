import { useEffect, useMemo, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Clapperboard, Pause, Play, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import {
  addTrack,
  ASPECT_SIZES,
  clipsOnTrack,
  closingCreditsStart,
  creditsFromMetadata,
  CREDIT_LAYOUTS,
  CREDIT_SECTION_TYPES,
  defaultCreditSequence,
  findFreeStart,
  formatTimecode,
  layoutCredits,
  makeClip,
  TEXT_FONTS,
  timelineDuration,
  type CreditKind,
  type CreditSection,
  type CreditSequenceDoc,
  type LyricAspect,
  type ProjectDoc,
  type TimelineDoc,
  type TimelineState,
} from '@az-studio/shared';
import { errorMessage } from '../lib/api';
import { creditsMetadata, deleteContinuity, saveContinuity, useProjectCollection } from '../lib/continuity';
import type { WithId } from '../lib/data';
import { db } from '../lib/firebase';
import { saveTimeline, snapshotTimeline, updateProject, useSub } from '../lib/studio';
import { canvasMeasure, useFontsReady } from '../lib/text-canvas';
import { AssetPicker, useAsset } from './media';
import { TextScenePreview } from './text-preview';
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Notice, Segmented, Select, Slider, Textarea } from './ui';

type Draft = Omit<CreditSequenceDoc, 'id' | 'updatedAt'>;

const SECTION_LABEL: Record<CreditSection['type'], string> = { title: 'Title', cast: 'Cast', crew: 'Crew', music: 'Music', voices: 'Voices', ai_disclosure: 'AI disclosure', special_thanks: 'Special thanks', copyright: 'Copyright', branding: 'Branding', custom: 'Custom' };
const LAYOUT_LABEL: Record<Draft['layout'], string> = { rolling: 'Rolling', cards: 'Cards', side_by_side: 'Side by side' };
let seq = 0;
const newSectionId = () => `cs${Date.now().toString(36)}${(seq = (seq + 1) % 1000).toString(36)}`;
const lines = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean);

function Colour({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-dim">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} className="size-7 cursor-pointer rounded border border-line bg-transparent" aria-label={label} />
      {label}
    </label>
  );
}

/** Writer, director, producer, editors and brand on the project (imported into new credit sequences). */
function ProjectCredits({ project }: { project: WithId<ProjectDoc> }) {
  const c = project.credits ?? { writer: [], director: [], producer: [], editors: [], brand: 'Indigen World' };
  const [d, setD] = useState({ writer: c.writer.join('\n'), director: c.director.join('\n'), producer: c.producer.join('\n'), editors: c.editors.join('\n'), brand: c.brand });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await updateProject(project.id, { credits: { writer: lines(d.writer).slice(0, 20), director: lines(d.director).slice(0, 20), producer: lines(d.producer).slice(0, 20), editors: lines(d.editors).slice(0, 20), brand: d.brand.trim().slice(0, 120) } });
      toast.success('Project credits saved');
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-4">
      <p className="eyebrow">Project credits (one name per line)</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(['writer', 'director', 'producer', 'editors'] as const).map((k) => (
          <Field key={k} label={k === 'editors' ? 'Editors' : k[0]!.toUpperCase() + k.slice(1)}>
            <Textarea rows={2} value={d[k]} onChange={(e) => setD((x) => ({ ...x, [k]: e.target.value }))} />
          </Field>
        ))}
        <Field label="Brand">
          <Input value={d.brand} onChange={(e) => setD((x) => ({ ...x, brand: e.target.value }))} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" loading={busy} icon={<Save className="size-3.5" />} onClick={() => void save()}>
          Save project credits
        </Button>
      </div>
    </Card>
  );
}

function SectionEditor({ s, first, last, onChange, onMove, onRemove }: { s: CreditSection; first: boolean; last: boolean; onChange: (s: CreditSection) => void; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  return (
    <li className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="h-8 w-36 text-xs" value={s.type} onChange={(e) => onChange({ ...s, type: e.target.value as CreditSection['type'] })} aria-label="Section type">
          {CREDIT_SECTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {SECTION_LABEL[t]}
            </option>
          ))}
        </Select>
        <Input className="h-8 min-w-40 flex-1 text-xs" value={s.title} onChange={(e) => onChange({ ...s, title: e.target.value.slice(0, 200) })} placeholder={s.type === 'title' ? 'Film title' : 'Heading (optional)'} aria-label="Section heading" />
        <IconButton label="Move up" size="sm" disabled={first} onClick={() => onMove(-1)}>
          <ArrowUp className="size-3.5" />
        </IconButton>
        <IconButton label="Move down" size="sm" disabled={last} onClick={() => onMove(1)}>
          <ArrowDown className="size-3.5" />
        </IconButton>
        <IconButton label="Remove section" size="sm" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
      {s.type !== 'title' && s.type !== 'copyright' && s.type !== 'branding' && s.type !== 'ai_disclosure' && (
        <div className="space-y-1.5">
          {s.entries.map((e, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] gap-2">
              <Input className="h-8 text-xs" value={e.role} onChange={(ev) => onChange({ ...s, entries: s.entries.map((x, k) => (k === i ? { ...x, role: ev.target.value.slice(0, 160) } : x)) })} placeholder="Role / character" aria-label="Role" />
              <Textarea rows={Math.min(4, Math.max(1, e.names.length))} className="text-xs" value={e.names.join('\n')} onChange={(ev) => onChange({ ...s, entries: s.entries.map((x, k) => (k === i ? { ...x, names: ev.target.value.split('\n').map((n) => n.slice(0, 160)).slice(0, 20) } : x)) })} placeholder="Name (one per line)" aria-label="Names" />
              <IconButton label="Remove entry" size="sm" onClick={() => onChange({ ...s, entries: s.entries.filter((_, k) => k !== i) })}>
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={s.entries.length >= 200} onClick={() => onChange({ ...s, entries: [...s.entries, { role: '', names: [''] }] })}>
            Add entry
          </Button>
        </div>
      )}
      {(s.type === 'copyright' || s.type === 'branding' || s.type === 'ai_disclosure' || s.type === 'custom' || s.body) && (
        <Textarea rows={s.type === 'ai_disclosure' ? 4 : 2} className="text-xs" value={s.body} onChange={(e) => onChange({ ...s, body: e.target.value.slice(0, 3000) })} placeholder="Text" aria-label="Section text" />
      )}
    </li>
  );
}

function MusicSlot({ assetId, onPick, onClear }: { assetId: string | null; onPick: () => void; onClear: () => void }) {
  const a = useAsset(assetId);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate text-dim">{assetId ? a.data?.title ?? 'Loading…' : 'No music (the film’s soundtrack continues)'}</span>
      <Button size="sm" variant="ghost" onClick={onPick}>
        {assetId ? 'Change' : 'Choose music'}
      </Button>
      {assetId && (
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      )}
    </div>
  );
}

/**
 * Credits Studio: opening and closing sequences built from the project's own metadata (writer,
 * director, performers, voices, music, the models that generated its media), edited section by
 * section, laid out with the lyric text engine (rolling, cards or side by side), previewed live in every
 * aspect ratio, validated (reading speed, safe area, finishing before the film ends) and placed on a
 * timeline with optional music.
 */
export function CreditsStudio({ project }: { project: WithId<ProjectDoc> }) {
  const sequences = useProjectCollection<CreditSequenceDoc>(project.id, 'creditSequences', { order: 'name' });
  const timelines = useSub<TimelineDoc>(project.id, 'timelines', 'updatedAt', 'desc');
  const [id, setId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [aspect, setAspect] = useState<LyricAspect>(project.format.aspectRatio === '9:16' ? '9:16' : '16:9');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [timelineId, setTimelineId] = useState('');
  const [picker, setPicker] = useState(false);
  const family = draft?.fontFamily ?? 'Inter';
  const fontsVersion = useFontsReady([{ family, weight: 400 }, { family, weight: 700 }, { family, weight: 800 }, { family, weight: 400, italic: true }]);
  const layout = useMemo(() => {
    void fontsVersion;
    return draft ? layoutCredits({ ...draft, id: id ?? 'draft' }, ASPECT_SIZES[aspect], 0, canvasMeasure, null) : null;
  }, [draft, aspect, id, fontsVersion]);
  const total = layout?.finishesAt ?? 0;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      setTime((t) => {
        const next = t + (now - last) / 1000;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);
  useEffect(() => {
    if (!timelineId && timelines.data[0]) setTimelineId(timelines.data[0].id);
  }, [timelines.data, timelineId]);

  const open = (s: WithId<CreditSequenceDoc>) => {
    const { id: sid, updatedAt: _u, ...rest } = s;
    void _u;
    setId(sid);
    setDraft(rest);
    setDirty(false);
    setTime(0);
  };
  const create = async (kind: CreditKind) => {
    setBusy(`new-${kind}`);
    try {
      const m = await creditsMetadata(project.id);
      setId(null);
      setDraft(defaultCreditSequence(kind, creditsFromMetadata(m, kind)));
      setDirty(true);
      setTime(0);
    } catch (e) {
      toast.error('Could not read the project metadata', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const refresh = async () => {
    if (!draft) return;
    setBusy('refresh');
    try {
      const m = await creditsMetadata(project.id);
      setDraft({ ...draft, sections: creditsFromMetadata(m, draft.kind) });
      setDirty(true);
      toast.success('Sections rebuilt from the project', { description: 'Your style settings were kept.' });
    } catch (e) {
      toast.error('Could not read the project metadata', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };
  const save = async (): Promise<string | null> => {
    if (!draft) return null;
    setBusy('save');
    try {
      const r = await saveContinuity(project.id, 'creditSequences', { ...draft, logoAssetIds: [] }, id);
      setId(r.id);
      setDirty(false);
      toast.success('Credits saved');
      return r.id;
    } catch (e) {
      toast.error('Could not save the credits', { description: errorMessage(e) });
      return null;
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!id) return;
    setBusy('delete');
    try {
      await deleteContinuity(project.id, 'creditSequences', id);
      setId(null);
      setDraft(null);
    } catch (e) {
      toast.error('Could not delete', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const timeline = timelines.data.find((t) => t.id === timelineId) ?? null;
  const placement = useMemo(() => {
    if (!timeline || !draft) return null;
    const others = timeline.clips.filter((c) => !(id && c.credits?.sequenceId === id));
    const picture = timelineDuration(others.filter((c) => c.kind === 'video' || c.kind === 'image'));
    const end = timelineDuration(others) || picture;
    const overPicture = draft.background.type === 'transparent';
    const start = draft.startSec ?? (draft.kind === 'opening' ? 0 : overPicture ? closingCreditsStart(end, total) : end);
    const videoEnd = Math.max(end, start + total);
    const check = layoutCredits({ ...draft, id: id ?? 'draft' }, ASPECT_SIZES[aspect], start, canvasMeasure, overPicture ? end : videoEnd);
    return { start, end: start + total, filmEnd: end, extends: start + total > end + 1e-3, issues: check.issues };
  }, [timeline, draft, id, total, aspect]);

  const addToTimeline = async () => {
    if (!timeline || !draft) return;
    const savedId = dirty || !id ? await save() : id;
    if (!savedId) return;
    setBusy('timeline');
    try {
      const snap = await getDoc(doc(db, 'projects', project.id, 'timelines', timeline.id));
      const tl = snap.data() as TimelineDoc | undefined;
      if (!tl) throw new Error('Timeline not found.');
      const before: TimelineState = { tracks: tl.tracks, clips: tl.clips, markers: tl.markers ?? [], beatGrid: tl.beatGrid ?? null, fps: tl.fps, aspectRatio: tl.aspectRatio };
      let state: TimelineState = { ...before, clips: before.clips.filter((c) => c.credits?.sequenceId !== savedId && !(c.label === `${draft.name} music` && c.kind === 'audio')) };
      const picture = timelineDuration(state.clips.filter((c) => c.kind === 'video' || c.kind === 'image'));
      const end = timelineDuration(state.clips) || picture;
      const desired = draft.startSec ?? (draft.kind === 'opening' ? 0 : draft.background.type === 'transparent' ? closingCreditsStart(end, total) : end);
      if (!state.tracks.some((t) => t.kind === 'overlay' && t.name === 'Credits')) state = addTrack(state, 'overlay', 'Credits');
      const track = state.tracks.find((t) => t.kind === 'overlay' && t.name === 'Credits')!;
      const start = findFreeStart(clipsOnTrack(state, track.id), desired, total);
      const clip = makeClip({ trackId: track.id, kind: 'title', start, duration: Math.round(total * 1000) / 1000, text: '', label: draft.name, credits: { sequenceId: savedId } });
      state = { ...state, clips: [...state.clips, clip] };
      if (draft.musicAssetId) {
        const a = (await getDoc(doc(db, 'assets', draft.musicAssetId))).data() as { durationSec?: number } | undefined;
        if (!state.tracks.some((t) => t.kind === 'audio' && t.name === 'Credits music')) state = addTrack(state, 'audio', 'Credits music');
        const at = state.tracks.find((t) => t.kind === 'audio' && t.name === 'Credits music')!;
        const len = Math.min(total, a?.durationSec ?? total);
        state = { ...state, clips: [...state.clips, makeClip({ trackId: at.id, kind: 'audio', start, duration: Math.round(len * 1000) / 1000, assetId: draft.musicAssetId, sourceDuration: a?.durationSec ?? null, volume: draft.musicVolume, fadeIn: 0.5, fadeOut: Math.min(2, len / 3), role: 'music', label: `${draft.name} music` })] };
      }
      await snapshotTimeline(project.id, timeline.id, before, tl.version ?? 0, `Before adding ${draft.name}`);
      await saveTimeline(project.id, timeline.id, state, (tl.version ?? 0) + 1);
      toast.success(`${draft.name} placed at ${formatTimecode(start)}`, { description: start + total > end + 1e-3 ? `The film now ends at ${formatTimecode(start + total)} (credits over ${draft.background.type === 'black' ? 'black' : 'colour'}).` : 'They finish before the film ends.' });
    } catch (e) {
      toast.error('Could not add the credits', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <ProjectCredits project={project} />
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <Select className="h-9 w-56" value={id ?? ''} onChange={(e) => {
            const s = sequences.data.find((x) => x.id === e.target.value);
            if (s) open(s);
          }} aria-label="Credit sequence">
          <option value="">{draft && !id ? 'Unsaved sequence' : 'Choose a sequence…'}</option>
          {sequences.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.kind})
            </option>
          ))}
        </Select>
        <Button size="sm" variant="ghost" loading={busy === 'new-opening'} icon={<Plus className="size-3.5" />} onClick={() => void create('opening')}>
          Opening credits
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'new-closing'} icon={<Plus className="size-3.5" />} onClick={() => void create('closing')}>
          Closing credits
        </Button>
        {draft && (
          <>
            <Button size="sm" variant="ghost" loading={busy === 'refresh'} icon={<RefreshCw className="size-3.5" />} onClick={() => void refresh()} className="ml-auto">
              Rebuild from project
            </Button>
            {id && (
              <Button size="sm" variant="ghost" loading={busy === 'delete'} icon={<Trash2 className="size-3.5" />} onClick={() => void remove()}>
                Delete
              </Button>
            )}
            <Button size="sm" variant="primary" loading={busy === 'save'} disabled={!dirty && Boolean(id)} icon={<Save className="size-3.5" />} onClick={() => void save()}>
              Save
            </Button>
          </>
        )}
      </Card>
      {!draft || !layout ? (
        <EmptyState icon={<Clapperboard className="size-5" />} title="No credit sequence open" body="Start opening or closing credits: they are drafted from the project’s crew, cast, voices, music and the AI models that generated its media, and stay fully editable." />
      ) : (
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_440px]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <IconButton label={playing ? 'Pause' : 'Play'} onClick={() => {
                  if (!playing && time >= total - 0.01) setTime(0);
                  setPlaying((p) => !p);
                }}>
                {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
              </IconButton>
              <span className="timecode text-xs text-dim">
                {formatTimecode(time)} / {formatTimecode(total)}
              </span>
              <input type="range" min={0} max={Math.max(0.1, total)} step={0.02} value={time} onChange={(e) => setTime(Number(e.target.value))} className="min-w-40 flex-1" aria-label="Preview time" />
              <Segmented size="sm" label="Aspect ratio" value={aspect} onChange={setAspect} options={(['16:9', '9:16', '1:1', '4:5'] as const).map((a) => ({ value: a, label: a }))} />
            </div>
            <div className={aspect === '9:16' ? 'mx-auto max-w-[360px]' : aspect === '4:5' ? 'mx-auto max-w-[520px]' : aspect === '1:1' ? 'mx-auto max-w-[600px]' : ''}>
              <TextScenePreview scene={layout.scene} time={time} safeArea={{ top: draft.safeMargin, bottom: draft.safeMargin, left: draft.safeMargin, right: draft.safeMargin }} label="Credits preview" />
            </div>
            {layout.issues.length > 0 ? (
              <Notice tone="warning">
                <ul className="space-y-0.5">
                  {layout.issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </Notice>
            ) : (
              <p className="text-xs text-success">Readable speed, inside the safe area in {aspect}.</p>
            )}
            <Card className="space-y-2 p-3">
              <p className="eyebrow">Place on a timeline</p>
              {timelines.data.length === 0 ? (
                <p className="text-xs text-faint">Assemble a timeline first (Timeline & render).</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select className="h-8 w-64 text-xs" value={timelineId} onChange={(e) => setTimelineId(e.target.value)} aria-label="Timeline">
                      {timelines.data.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                    <Field label="Start (s, empty = automatic)" className="w-44">
                      <Input type="number" min={0} step={0.1} value={draft.startSec ?? ''} onChange={(e) => set({ startSec: e.target.value === '' ? null : Math.max(0, Math.min(36000, Number(e.target.value))) })} />
                    </Field>
                    <Button size="sm" variant="primary" className="ml-auto" loading={busy === 'timeline'} disabled={!timeline} onClick={() => void addToTimeline()}>
                      Add to timeline
                    </Button>
                  </div>
                  {placement && (
                    <p className="text-xs text-dim">
                      {formatTimecode(placement.start)} → {formatTimecode(placement.end)} · the film currently ends at {formatTimecode(placement.filmEnd)}
                      {placement.extends ? ' — the credits extend it' : ''}
                      {placement.issues.filter((i) => i.includes('video ends')).length > 0 && <Badge tone="danger" className="ml-1.5">finishes after the end</Badge>}
                    </p>
                  )}
                </>
              )}
            </Card>
          </div>
          <Card className="space-y-3 p-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => set({ name: e.target.value.slice(0, 120) })} />
              </Field>
              <Field label="Layout">
                <Select value={draft.layout} onChange={(e) => set({ layout: e.target.value as Draft['layout'] })}>
                  {CREDIT_LAYOUTS.map((l) => (
                    <option key={l} value={l}>
                      {LAYOUT_LABEL[l]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Font">
                <Select value={draft.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })}>
                  {TEXT_FONTS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Alignment">
                <Select value={draft.align} onChange={(e) => set({ align: e.target.value as Draft['align'] })}>
                  <option value="center">Centred</option>
                  <option value="left">Left</option>
                </Select>
              </Field>
            </div>
            {draft.layout === 'rolling' ? <Slider label={`Length ${draft.durationSec.toFixed(0)} s`} min={4} max={180} step={1} value={draft.durationSec} onChange={(v) => set({ durationSec: v })} /> : <Slider label={`${draft.cardSec.toFixed(1)} s per card`} min={1} max={10} step={0.1} value={draft.cardSec} onChange={(v) => set({ cardSec: v })} />}
            <Slider label={`Title size ${draft.titleSizePct.toFixed(1)}%`} min={2} max={12} step={0.1} value={draft.titleSizePct} onChange={(v) => set({ titleSizePct: v })} />
            <Slider label={`Text size ${draft.bodySizePct.toFixed(1)}%`} min={1.5} max={8} step={0.1} value={draft.bodySizePct} onChange={(v) => set({ bodySizePct: v })} />
            <Slider label={`Line spacing ${draft.lineSpacing.toFixed(2)}×`} min={0.9} max={2.5} step={0.01} value={draft.lineSpacing} onChange={(v) => set({ lineSpacing: v })} />
            <Slider label={`Space between sections ${Math.round(draft.sectionSpacing * 100)}%`} min={0} max={0.3} step={0.005} value={draft.sectionSpacing} onChange={(v) => set({ sectionSpacing: v })} />
            <Slider label={`Safe margin ${Math.round(draft.safeMargin * 100)}%`} min={0} max={0.2} step={0.005} value={draft.safeMargin} onChange={(v) => set({ safeMargin: v })} />
            <Slider label={`Fade ${draft.fadeSec.toFixed(1)} s`} min={0} max={3} step={0.1} value={draft.fadeSec} onChange={(v) => set({ fadeSec: v })} />
            <div className="flex flex-wrap items-center gap-3">
              <Colour label="Text" value={draft.textColor} onChange={(v) => set({ textColor: v })} />
              <Colour label="Headings" value={draft.accentColor} onChange={(v) => set({ accentColor: v })} />
              <Select className="h-8 w-40 text-xs" value={draft.background.type} onChange={(e) => set({ background: { ...draft.background, type: e.target.value as Draft['background']['type'] } })} aria-label="Background">
                <option value="transparent">Over the picture</option>
                <option value="black">On black</option>
                <option value="colour">On a colour</option>
              </Select>
              {draft.background.type === 'colour' && <Colour label="Background" value={draft.background.colour} onChange={(v) => set({ background: { ...draft.background, colour: v } })} />}
            </div>
            <div className="space-y-1.5">
              <p className="eyebrow">Music under the credits</p>
              <MusicSlot assetId={draft.musicAssetId} onPick={() => setPicker(true)} onClear={() => set({ musicAssetId: null })} />
              {draft.musicAssetId && <Slider label={`Volume ${Math.round(draft.musicVolume * 100)}%`} min={0} max={1.5} step={0.05} value={draft.musicVolume} onChange={(v) => set({ musicVolume: v })} />}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="eyebrow">Sections</p>
                <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={draft.sections.length >= 40} onClick={() => set({ sections: [...draft.sections, { id: newSectionId(), type: 'custom', title: '', entries: [], body: '' }] })}>
                  Add section
                </Button>
              </div>
              <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
                {draft.sections.map((s, i) => (
                  <SectionEditor
                    key={s.id}
                    s={s}
                    first={i === 0}
                    last={i === draft.sections.length - 1}
                    onChange={(next) => set({ sections: draft.sections.map((x) => (x.id === s.id ? next : x)) })}
                    onRemove={() => set({ sections: draft.sections.filter((x) => x.id !== s.id) })}
                    onMove={(d) => {
                      const arr = [...draft.sections];
                      const j = i + d;
                      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
                      set({ sections: arr });
                    }}
                  />
                ))}
              </ul>
            </div>
          </Card>
        </div>
      )}
      <AssetPicker open={picker} onOpenChange={setPicker} kinds={['audio']} projectId={project.id} onPick={(a) => {
          set({ musicAssetId: a[0]?.id ?? null });
          setPicker(false);
        }} title="Music under the credits" />
    </div>
  );
}

