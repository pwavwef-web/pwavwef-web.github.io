import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CheckCheck, Copy, Crosshair, Pause, Play, Plus, Save, ScanFace, Trash2, Type } from 'lucide-react';
import {
  ASPECT_SIZES,
  defaultLyricStyleDoc,
  formatTimecode,
  layoutLyrics,
  LYRIC_ASPECTS,
  LYRIC_PRESET_LABELS,
  LYRIC_PRESET_STYLES,
  LYRIC_PRESETS,
  SAFE_AREAS,
  TEXT_FONTS,
  type AspectPlacement,
  type Box,
  type LayoutIssue,
  type LyricAspect,
  type LyricInputLine,
  type LyricPreset,
  type LyricsTrackDoc,
  type LyricStyle,
  type LyricStyleDoc,
  type ProjectDoc,
  type SectionLabel,
  type SongDoc,
} from '@az-studio/shared';
import { errorMessage } from '../lib/api';
import type { WithId } from '../lib/data';
import { saveContinuity, useProjectCollection, useProjectDoc } from '../lib/continuity';
import { useMediaUrls } from '../lib/media';
import { canvasMeasure, useFontsReady } from '../lib/text-canvas';
import { AssetSlot } from './fields';
import { useJobSubmitter } from './jobs';
import { AssetPicker, UploadZone, useAsset } from './media';
import { TextScenePreview } from './text-preview';
import { Badge, Button, Card, cx, EmptyState, Field, IconButton, Input, Notice, Segmented, Select, Slider, Toggle } from './ui';

type Draft = Omit<LyricStyleDoc, 'id' | 'updatedAt'>;
type Panel = 'presets' | 'look' | 'motion' | 'placement' | 'sections' | 'fonts';

const BUILT_IN_FONTS = [...TEXT_FONTS, 'DejaVu Sans Mono'];
const ENTRANCES = ['none', 'fade', 'rise', 'drop', 'scale', 'slide_left', 'slide_right', 'blur'] as const;
const WORD_EFFECTS = ['none', 'sweep', 'instant', 'highlight', 'pop', 'typewriter', 'reveal'] as const;
const ISSUE_TONE: Record<LayoutIssue['kind'], 'danger' | 'warning' | 'neutral'> = { cropped: 'danger', covers_face: 'danger', outside_safe_area: 'warning', overlaps_next: 'warning', animation_too_long: 'warning', diacritics_clipped: 'warning', shrunk: 'neutral', unreadable_size: 'warning' };

function Colour({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-dim">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} className="size-7 cursor-pointer rounded border border-line bg-transparent" aria-label={label} />
      {label}
    </label>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

/** Lines of the song's lyric sheet (or legacy timed lines) as layout input. */
function inputLines(song: WithId<SongDoc>): LyricInputLine[] {
  const sheet = song.lyricsSheet;
  if (sheet?.lines.length) {
    const label = new Map(sheet.sections.map((s) => [s.id, s.label]));
    return sheet.lines
      .filter((l) => l.start !== null && l.end !== null && l.end > l.start && l.text.trim())
      .map((l) => ({
        id: l.id,
        text: l.text,
        start: l.start!,
        end: l.end!,
        section: l.sectionId ? label.get(l.sectionId) ?? null : null,
        words: l.words.length && l.words.every((w) => w.start !== null && w.end !== null) ? l.words.map((w) => ({ text: w.text, start: w.start!, end: w.end! })) : null,
        translation: l.translation ?? null,
        part: l.part ?? null,
      }));
  }
  return (song.lyrics?.lines ?? []).filter((l) => l.end > l.start && l.text.trim()).map((l) => ({ id: l.id, text: l.text, start: l.start, end: l.end, section: null, words: null, translation: null, part: null }));
}

function FontRow({ font, onRemove }: { font: Draft['fonts'][number]; onRemove: () => void }) {
  const a = useAsset(font.assetId);
  return (
    <li className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-xs">
      <Type className="size-3.5 text-faint" />
      <span className="text-fg">{font.family}</span>
      <span className="truncate text-faint">{a.data?.title ?? ''}</span>
      <Badge tone="success" className="ml-auto">
        licence confirmed
      </Badge>
      <IconButton label={`Remove ${font.family}`} size="sm" onClick={onRemove}>
        <Trash2 className="size-3.5" />
      </IconButton>
    </li>
  );
}

function PendingFont({ assetId, onAdd, onCancel, taken }: { assetId: string; onAdd: (family: string) => void; onCancel: () => void; taken: string[] }) {
  const a = useAsset(assetId);
  const [family, setFamily] = useState('');
  const [licence, setLicence] = useState(false);
  const name = family || (a.data?.title ?? '').replace(/\.(ttf|otf)$/i, '').replace(/[-_]+/g, ' ').trim();
  const clash = taken.includes(name) || BUILT_IN_FONTS.includes(name as never);
  return (
    <Card className="space-y-2 p-3">
      <Field label="Family name used in styles" error={clash ? 'Choose a name that is not already used.' : null}>
        <Input value={name} onChange={(e) => setFamily(e.target.value.slice(0, 80))} />
      </Field>
      <Toggle checked={licence} onChange={setLicence} label="I hold a licence to use this font in videos I publish" description="Fonts are only embedded in renders after you confirm this." />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!licence || !name.trim() || clash} onClick={() => onAdd(name.trim())}>
          Add font
        </Button>
      </div>
    </Card>
  );
}

/**
 * Lyric Style Studio: the song's lyrics laid out and animated by a real text engine in 16:9, 9:16, 1:1
 * and 4:5 at once, from the song's own timing. Eighteen presets, global settings, per-section overrides,
 * per-aspect positions, per-line locked placements, uploaded licensed fonts, face avoidance on a
 * reference picture and validation (cropping, safe areas, overlaps, diacritics, readable size). Renders
 * use exactly the saved style.
 */
export function LyricStyleStudio({ project, song }: { project: WithId<ProjectDoc>; song: WithId<SongDoc> }) {
  const styles = useProjectCollection<LyricStyleDoc>(project.id, 'lyricStyles', { order: 'name' });
  const track = useProjectDoc<LyricsTrackDoc>(project.id, 'lyricsTracks', song.id);
  const audio = useMediaUrls(song.audioAssetId);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [styleId, setStyleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => defaultLyricStyleDoc('karaoke'));
  const [dirty, setDirty] = useState(false);
  const [panel, setPanel] = useState<Panel>('presets');
  const [focus, setFocus] = useState<LyricAspect>(project.format.aspectRatio === '9:16' ? '9:16' : '16:9');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [bgId, setBgId] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [pendingFont, setPendingFont] = useState<string | null>(null);
  const [section, setSection] = useState<SectionLabel | ''>('');
  const bgUrls = useMediaUrls(bgId);
  const bgTrack = useProjectDoc<{ samples: { t: number; faces: { box: Box; confidence: number }[] }[] }>(project.id, 'subjectTracks', bgId);
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const { submit, busy: submitting, dialog } = useJobSubmitter();

  // Load the style the song uses (or the first one) once.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded || styles.loading || track.loading) return;
    const id = track.data?.styleId ?? styles.data[0]?.id ?? null;
    const s = id ? styles.data.find((x) => x.id === id) : null;
    if (s) {
      setStyleId(s.id);
      setDraft({ name: s.name, global: s.global, sections: s.sections ?? {}, fonts: s.fonts ?? [] });
    }
    setLoaded(true);
  }, [loaded, styles.loading, styles.data, track.loading, track.data]);

  useEffect(() => {
    if (!bgUrls?.file) {
      setBgImage(null);
      return;
    }
    // Drawn only (never read back), so the signed URL needs no CORS.
    const img = new Image();
    img.onload = () => setBgImage(img);
    img.src = bgUrls.file;
  }, [bgUrls?.file]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a || !playing) return;
    let raf = 0;
    const tick = () => {
      setTime(a.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const fontsVersion = useFontsReady(
    [draft.global, ...Object.values(draft.sections), ...LYRIC_PRESETS.map((p) => LYRIC_PRESET_STYLES[p])].filter(Boolean).map((s) => ({ family: s!.fontFamily ?? draft.global.fontFamily, weight: s!.fontWeight ?? draft.global.fontWeight, italic: s!.italic ?? draft.global.italic })),
    draft.fonts.map((f) => ({ family: f.family, assetId: f.assetId })),
  );
  const faces = useMemo(() => (bgTrack.data?.samples[0]?.faces ?? []).filter((f) => f.confidence >= 0.5).map((f) => f.box), [bgTrack.data]);
  const lines = useMemo(() => inputLines(song), [song]);
  const placements = useMemo(() => track.data?.placements ?? {}, [track.data?.placements]);
  const layouts = useMemo(() => {
    void fontsVersion;
    return Object.fromEntries(
      LYRIC_ASPECTS.map((aspect) => {
        const size = ASPECT_SIZES[aspect];
        const withPlacement = lines.map((l) => ({ ...l, avoid: faces, placement: placements[aspect]?.[l.id] ?? null }));
        return [aspect, layoutLyrics({ lines: withPlacement, doc: draft, aspect, width: size.width, height: size.height, measure: canvasMeasure, fps: project.format.fps })];
      }),
    ) as Record<LyricAspect, ReturnType<typeof layoutLyrics>>;
  }, [lines, draft, faces, placements, fontsVersion, project.format.fps]);
  const currentLine = lines.find((l) => time >= l.start && time < l.end) ?? null;
  const sectionsUsed = useMemo(() => [...new Set(lines.map((l) => l.section).filter((x): x is SectionLabel => Boolean(x)))], [lines]);
  const allIssues = LYRIC_ASPECTS.flatMap((a) => layouts[a].issues.map((i) => ({ ...i, aspect: a })));

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const setG = (patch: Partial<LyricStyle>) => set({ global: { ...draft.global, ...patch } });
  const setAspect = (patch: Partial<AspectPlacement>) => setG({ aspects: { ...draft.global.aspects, [focus]: { ...(draft.global.aspects[focus] ?? {}), ...patch } } });
  const g = draft.global;
  const aspectPlacement = g.aspects[focus] ?? {};

  const seek = (t: number) => {
    if (audioRef.current) audioRef.current.currentTime = t;
    setTime(t);
  };
  const saveStyle = async (): Promise<string | null> => {
    setBusy('save');
    try {
      const r = await saveContinuity(project.id, 'lyricStyles', { name: draft.name.trim() || 'Lyric style', global: draft.global, sections: draft.sections, fonts: draft.fonts.filter((f) => f.licenceConfirmed) }, styleId);
      setStyleId(r.id);
      setDirty(false);
      toast.success('Lyric style saved');
      return r.id;
    } catch (e) {
      toast.error('Could not save the style', { description: errorMessage(e) });
      return null;
    } finally {
      setBusy(null);
    }
  };
  const saveTrack = async (patch: Partial<Pick<LyricsTrackDoc, 'styleId' | 'placements'>>, done?: string) => {
    try {
      await saveContinuity(project.id, 'lyricsTracks', { songId: song.id, styleId: track.data?.styleId ?? null, placements: track.data?.placements ?? {}, ...patch });
      if (done) toast.success(done);
    } catch (e) {
      toast.error('Could not update the song', { description: errorMessage(e) });
    }
  };
  const apply = async () => {
    const id = dirty || !styleId ? await saveStyle() : styleId;
    if (!id) return;
    setBusy('apply');
    await saveTrack({ styleId: id }, `“${draft.name}” now renders ${song.title}’s lyrics`);
    setBusy(null);
  };
  const choosePreset = (p: LyricPreset) => {
    set({ global: { ...LYRIC_PRESET_STYLES[p], aspects: g.aspects }, name: dirty || styleId ? draft.name : LYRIC_PRESET_LABELS[p] });
    setPanel('look');
  };
  const placeAt = (p: { x: number; y: number }) => {
    if (!placing || !currentLine) return;
    const next = { ...placements, [focus]: { ...(placements[focus] ?? {}), [currentLine.id]: { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000, locked: true } } };
    void saveTrack({ placements: next }, 'Line position locked for this aspect ratio');
  };
  const detectFaces = async () => {
    if (!bgId) return;
    await submit([{ type: 'media.analyze_subjects', projectId: project.id, assetIds: [bgId], fps: 1, label: 'Faces for lyric placement' }], { label: 'Face detection' });
  };

  if (!lines.length) {
    return <EmptyState icon={<Type className="size-5" />} title="No timed lyrics yet" body="Add, transcribe or align the lyrics in the Song tab first; styles are previewed with the real timing of every line and word." />;
  }
  const trackStyle = track.data?.styleId ? styles.data.find((s) => s.id === track.data!.styleId) : null;
  const sectionOverride = section ? draft.sections[section] ?? null : null;
  const setSection_ = (patch: Partial<LyricStyle> | null) => {
    if (!section) return;
    const next = { ...draft.sections };
    if (patch === null) delete next[section];
    else next[section] = { ...(next[section] ?? {}), ...patch };
    set({ sections: next });
  };
  const familyOptions = [...BUILT_IN_FONTS, ...draft.fonts.map((f) => f.family)];
  const galleryT = Math.floor(time * 4) / 4;

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <Select className="h-9 w-56" value={styleId ?? ''} onChange={(e) => {
            const s = styles.data.find((x) => x.id === e.target.value);
            if (s) {
              setStyleId(s.id);
              setDraft({ name: s.name, global: s.global, sections: s.sections ?? {}, fonts: s.fonts ?? [] });
            } else {
              setStyleId(null);
              setDraft(defaultLyricStyleDoc('karaoke'));
            }
            setDirty(false);
          }} aria-label="Lyric style">
          <option value="">New style…</option>
          {styles.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Input className="h-9 w-56" value={draft.name} onChange={(e) => set({ name: e.target.value.slice(0, 120) })} aria-label="Style name" />
        {styleId && (
          <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => {
              setStyleId(null);
              set({ name: `${draft.name} copy` });
            }}>
            Duplicate
          </Button>
        )}
        <span className="ml-auto text-xs text-faint">{trackStyle ? `Song renders with “${trackStyle.name}”` : 'The song uses simple captions until a style is applied'}</span>
        <Button size="sm" variant="ghost" loading={busy === 'save'} disabled={!dirty && Boolean(styleId)} icon={<Save className="size-3.5" />} onClick={() => void saveStyle()}>
          Save style
        </Button>
        <Button size="sm" variant="primary" loading={busy === 'apply'} disabled={track.data?.styleId === styleId && !dirty && Boolean(styleId)} icon={<CheckCheck className="size-3.5" />} onClick={() => void apply()}>
          Use for this song
        </Button>
      </Card>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <IconButton label={playing ? 'Pause' : 'Play'} onClick={() => (playing ? audioRef.current?.pause() : void audioRef.current?.play())}>
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </IconButton>
            <span className="timecode text-xs text-dim">{formatTimecode(time)}</span>
            <input type="range" min={0} max={Math.max(1, song.durationSec)} step={0.05} value={time} onChange={(e) => seek(Number(e.target.value))} className="min-w-40 flex-1" aria-label="Preview time" />
            <Select className="h-8 w-44 text-xs" value="" onChange={(e) => {
                const l = lines.find((x) => x.id === e.target.value);
                if (l) seek(l.start + 0.01);
              }} aria-label="Jump to a line">
              <option value="">Jump to line…</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {formatTimecode(l.start)} {l.text.slice(0, 40)}
                </option>
              ))}
            </Select>
            <audio ref={audioRef} src={audio?.file} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_200px]">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Segmented size="sm" label="Aspect ratio" value={focus} onChange={setFocus} options={LYRIC_ASPECTS.map((a) => ({ value: a, label: a }))} />
                <Button size="sm" variant={placing ? 'subtle' : 'ghost'} icon={<Crosshair className="size-3.5" />} disabled={!currentLine} onClick={() => setPlacing((v) => !v)} title="Click the preview to lock the current line’s position in this aspect ratio">
                  {placing ? 'Click to place' : 'Place line'}
                </Button>
              </div>
              <div className={cx('mx-auto', focus === '9:16' ? 'max-w-[340px]' : focus === '4:5' ? 'max-w-[480px]' : focus === '1:1' ? 'max-w-[560px]' : '')}>
                <TextScenePreview scene={layouts[focus].scene} time={time} background={bgImage} safeArea={SAFE_AREAS[focus]} faces={faces} onPoint={placing ? placeAt : undefined} label={`${focus} lyric preview`} />
              </div>
              <p className="text-[11px] text-faint">
                {currentLine ? `“${currentLine.text.slice(0, 60)}”${currentLine.section ? ` · ${currentLine.section}` : ''}` : 'Between lines'} · dashed amber = platform safe area{faces.length ? ' · green = detected faces (text avoids them)' : ''}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
              {LYRIC_ASPECTS.filter((a) => a !== focus).map((a) => (
                <button key={a} type="button" onClick={() => setFocus(a)} className="cursor-pointer text-left">
                  <TextScenePreview scene={layouts[a].scene} time={time} background={bgImage} safeArea={SAFE_AREAS[a]} faces={faces} className={cx(a === '9:16' ? 'mx-auto max-w-[110px]' : '')} label={`${a} lyric preview`} />
                  <span className="mt-0.5 block text-center text-[10px] text-faint">
                    {a}
                    {layouts[a].issues.length ? ` · ${layouts[a].issues.length} issue${layouts[a].issues.length === 1 ? '' : 's'}` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <Card className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="eyebrow mr-auto">Validation ({allIssues.length})</p>
              <AssetSlot className="w-44" label="Reference picture" assetId={bgId} onPick={() => setPicker(true)} onClear={() => setBgId(null)} action={bgId ? <Button size="sm" variant="ghost" loading={submitting} icon={<ScanFace className="size-3.5" />} onClick={() => void detectFaces()}>Detect faces</Button> : undefined} />
            </div>
            {allIssues.length === 0 ? (
              <p className="text-xs text-success">Every line fits the frame and safe area in all four aspect ratios, with no overlaps or clipped accents.</p>
            ) : (
              <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
                {allIssues.slice(0, 80).map((i, k) => (
                  <li key={k} className="flex items-start gap-2">
                    <Badge tone={ISSUE_TONE[i.kind]}>{i.aspect}</Badge>
                    <button type="button" className="cursor-pointer text-left text-dim hover:text-fg" onClick={() => {
                        const l = lines.find((x) => x.id === i.lineId);
                        if (l) seek(l.start + 0.01);
                        setFocus(i.aspect);
                      }}>
                      {i.message}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card className="space-y-3 p-3">
          <Segmented
            size="sm"
            label="Style panel"
            value={panel}
            onChange={setPanel}
            options={[
              { value: 'presets', label: 'Presets' },
              { value: 'look', label: 'Look' },
              { value: 'motion', label: 'Motion' },
              { value: 'placement', label: 'Place' },
              { value: 'sections', label: 'Sections' },
              { value: 'fonts', label: 'Fonts' },
            ]}
          />
          {panel === 'presets' && (
            <div className="grid max-h-[70vh] grid-cols-2 gap-2 overflow-y-auto pr-1">
              {LYRIC_PRESETS.map((p) => (
                <PresetTile key={p} preset={p} active={g.preset === p} lines={lines} fps={project.format.fps} time={galleryT} version={fontsVersion} onChoose={() => choosePreset(p)} />
              ))}
            </div>
          )}
          {panel === 'look' && (
            <div className="space-y-3">
              <Row>
                <Field label="Font">
                  <Select value={g.fontFamily} onChange={(e) => setG({ fontFamily: e.target.value })}>
                    {familyOptions.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Weight">
                  <Select value={g.fontWeight} onChange={(e) => setG({ fontWeight: Number(e.target.value) })}>
                    {[300, 400, 500, 600, 700, 800, 900].map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </Select>
                </Field>
              </Row>
              <Slider label={`Size ${g.fontSizePct.toFixed(1)}% of frame height`} min={1.5} max={14} step={0.1} value={g.fontSizePct} onChange={(v) => setG({ fontSizePct: v })} />
              <Row>
                <Field label="Capitalisation">
                  <Select value={g.capitalisation} onChange={(e) => setG({ capitalisation: e.target.value as LyricStyle['capitalisation'] })}>
                    <option value="none">As written</option>
                    <option value="upper">UPPER</option>
                    <option value="lower">lower</option>
                    <option value="title">Title Case</option>
                  </Select>
                </Field>
                <Field label="Alignment">
                  <Select value={g.align} onChange={(e) => setG({ align: e.target.value as LyricStyle['align'] })}>
                    <option value="left">Left</option>
                    <option value="center">Centre</option>
                    <option value="right">Right</option>
                  </Select>
                </Field>
              </Row>
              <Toggle checked={g.italic} onChange={(v) => setG({ italic: v })} label="Italic" />
              <Slider label={`Letter spacing ${g.letterSpacing}`} min={-5} max={20} step={0.5} value={g.letterSpacing} onChange={(v) => setG({ letterSpacing: v })} />
              <Slider label={`Line spacing ${g.lineSpacing.toFixed(2)}×`} min={0.9} max={2.2} step={0.01} value={g.lineSpacing} onChange={(v) => setG({ lineSpacing: v })} />
              <Row>
                <Field label="Max characters per line">
                  <Input type="number" min={4} max={120} value={g.maxCharsPerLine} onChange={(e) => setG({ maxCharsPerLine: Math.max(4, Math.min(120, Math.round(Number(e.target.value) || 30))) })} />
                </Field>
                <Field label="Max lines">
                  <Input type="number" min={1} max={6} value={g.maxLines} onChange={(e) => setG({ maxLines: Math.max(1, Math.min(6, Math.round(Number(e.target.value) || 2))) })} />
                </Field>
              </Row>
              <div className="flex flex-wrap gap-3">
                <Colour label="Active / sung" value={g.activeColor} onChange={(v) => setG({ activeColor: v })} />
                <Colour label="Inactive" value={g.inactiveColor} onChange={(v) => setG({ inactiveColor: v })} />
              </div>
              <Toggle checked={g.outline !== null} onChange={(v) => setG({ outline: v ? { width: 3, color: '#000000' } : null })} label="Outline" />
              {g.outline && (
                <div className="flex items-center gap-3">
                  <Slider className="flex-1" label={`Outline ${g.outline.width}px`} min={0} max={12} step={0.5} value={g.outline.width} onChange={(v) => setG({ outline: { ...g.outline!, width: v } })} />
                  <Colour label="" value={g.outline.color} onChange={(v) => setG({ outline: { ...g.outline!, color: v } })} />
                </div>
              )}
              <Toggle checked={g.shadow !== null} onChange={(v) => setG({ shadow: v ? { x: 2, y: 3, blur: 4, color: '#000000', opacity: 0.55 } : null })} label="Shadow" />
              {g.shadow && (
                <div className="grid grid-cols-2 gap-2">
                  <Slider label={`Offset x ${g.shadow.x}`} min={-20} max={20} step={1} value={g.shadow.x} onChange={(v) => setG({ shadow: { ...g.shadow!, x: v } })} />
                  <Slider label={`Offset y ${g.shadow.y}`} min={-20} max={20} step={1} value={g.shadow.y} onChange={(v) => setG({ shadow: { ...g.shadow!, y: v } })} />
                  <Slider label={`Opacity ${Math.round(g.shadow.opacity * 100)}%`} min={0} max={1} step={0.05} value={g.shadow.opacity} onChange={(v) => setG({ shadow: { ...g.shadow!, opacity: v } })} />
                  <Colour label="Colour" value={g.shadow.color} onChange={(v) => setG({ shadow: { ...g.shadow!, color: v } })} />
                </div>
              )}
              <Toggle checked={g.glow !== null} onChange={(v) => setG({ glow: v ? { radius: 14, color: g.activeColor, strength: 0.5 } : null })} label="Glow" />
              {g.glow && (
                <div className="grid grid-cols-2 gap-2">
                  <Slider label={`Radius ${g.glow.radius}`} min={0} max={60} step={1} value={g.glow.radius} onChange={(v) => setG({ glow: { ...g.glow!, radius: v } })} />
                  <Slider label={`Strength ${Math.round(g.glow.strength * 100)}%`} min={0} max={1} step={0.05} value={g.glow.strength} onChange={(v) => setG({ glow: { ...g.glow!, strength: v } })} />
                  <Colour label="Colour" value={g.glow.color} onChange={(v) => setG({ glow: { ...g.glow!, color: v } })} />
                </div>
              )}
              <Toggle checked={g.gradient !== null} onChange={(v) => setG({ gradient: v ? { from: '#FFFFFF', to: g.activeColor } : null })} label="Two-tone gradient" />
              {g.gradient && (
                <div className="flex gap-3">
                  <Colour label="Top" value={g.gradient.from} onChange={(v) => setG({ gradient: { ...g.gradient!, from: v } })} />
                  <Colour label="Bottom" value={g.gradient.to} onChange={(v) => setG({ gradient: { ...g.gradient!, to: v } })} />
                </div>
              )}
              <Toggle checked={g.box !== null} onChange={(v) => setG({ box: v ? { color: '#000000', opacity: 0.55, padding: 16, radius: 10 } : null })} label="Background box" />
              {g.box && (
                <div className="grid grid-cols-2 gap-2">
                  <Slider label={`Opacity ${Math.round(g.box.opacity * 100)}%`} min={0} max={1} step={0.05} value={g.box.opacity} onChange={(v) => setG({ box: { ...g.box!, opacity: v } })} />
                  <Slider label={`Padding ${g.box.padding}`} min={0} max={60} step={1} value={g.box.padding} onChange={(v) => setG({ box: { ...g.box!, padding: v } })} />
                  <Slider label={`Corners ${g.box.radius}`} min={0} max={60} step={1} value={g.box.radius} onChange={(v) => setG({ box: { ...g.box!, radius: v } })} />
                  <Colour label="Colour" value={g.box.color} onChange={(v) => setG({ box: { ...g.box!, color: v } })} />
                </div>
              )}
              <Slider label={`Blur behind text ${g.backgroundBlur}`} min={0} max={40} step={1} value={g.backgroundBlur} onChange={(v) => setG({ backgroundBlur: v })} />
              <Slider label={`Opacity ${Math.round(g.opacity * 100)}%`} min={0.1} max={1} step={0.05} value={g.opacity} onChange={(v) => setG({ opacity: v })} />
              {(g.preset === 'dual_language' || lines.some((l) => l.translation)) && (
                <div className="flex items-center gap-3">
                  <Colour label="Translation" value={g.translation.color} onChange={(v) => setG({ translation: { ...g.translation, color: v } })} />
                  <Slider className="flex-1" label={`Translation size ${Math.round(g.translation.sizeRatio * 100)}%`} min={0.4} max={1.1} step={0.02} value={g.translation.sizeRatio} onChange={(v) => setG({ translation: { ...g.translation, sizeRatio: v } })} />
                </div>
              )}
            </div>
          )}
          {panel === 'motion' && (
            <div className="space-y-3">
              <Row>
                <Field label="Entrance">
                  <Select value={g.entrance} onChange={(e) => setG({ entrance: e.target.value as LyricStyle['entrance'] })}>
                    {ENTRANCES.map((x) => (
                      <option key={x} value={x}>
                        {x.replace('_', ' ')}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Exit">
                  <Select value={g.exit} onChange={(e) => setG({ exit: e.target.value as LyricStyle['exit'] })}>
                    {ENTRANCES.map((x) => (
                      <option key={x} value={x}>
                        {x.replace('_', ' ')}
                      </option>
                    ))}
                  </Select>
                </Field>
              </Row>
              <Field label="Word animation">
                <Select value={g.wordAnimation} onChange={(e) => setG({ wordAnimation: e.target.value as LyricStyle['wordAnimation'] })}>
                  {WORD_EFFECTS.map((x) => (
                    <option key={x} value={x}>
                      {x === 'sweep' ? 'karaoke sweep' : x === 'highlight' ? 'active word' : x}
                    </option>
                  ))}
                </Select>
              </Field>
              <Slider label={`Transition ${g.transitionMs} ms`} min={0} max={1500} step={10} value={g.transitionMs} onChange={(v) => setG({ transitionMs: Math.round(v) })} />
              <Field label="Script direction">
                <Select value={g.direction} onChange={(e) => setG({ direction: e.target.value as LyricStyle['direction'] })}>
                  <option value="ltr">Left to right</option>
                  <option value="rtl">Right to left</option>
                </Select>
              </Field>
              <p className="text-[11px] text-faint">Word timing comes from the aligned lyric sheet; lines without word timing spread their words over the line in proportion to their length.</p>
            </div>
          )}
          {panel === 'placement' && (
            <div className="space-y-3">
              <p className="text-xs text-dim">Position in <strong className="text-fg">{focus}</strong> (overrides the global position for this aspect ratio only).</p>
              <Slider label={`Horizontal ${Math.round((aspectPlacement.x ?? g.x) * 100)}%`} min={0} max={1} step={0.005} value={aspectPlacement.x ?? g.x} onChange={(v) => setAspect({ x: v })} />
              <Slider label={`Vertical ${Math.round((aspectPlacement.y ?? g.y) * 100)}%`} min={0} max={1} step={0.005} value={aspectPlacement.y ?? g.y} onChange={(v) => setAspect({ y: v })} />
              <Slider label={`Size ${(aspectPlacement.fontSizePct ?? g.fontSizePct).toFixed(1)}%`} min={1.5} max={14} step={0.1} value={aspectPlacement.fontSizePct ?? g.fontSizePct} onChange={(v) => setAspect({ fontSizePct: v })} />
              <Row>
                <Field label="Alignment">
                  <Select value={aspectPlacement.align ?? g.align} onChange={(e) => setAspect({ align: e.target.value as AspectPlacement['align'] })}>
                    <option value="left">Left</option>
                    <option value="center">Centre</option>
                    <option value="right">Right</option>
                  </Select>
                </Field>
                <Field label="Max characters">
                  <Input type="number" min={4} max={120} value={aspectPlacement.maxCharsPerLine ?? ''} placeholder={String(g.maxCharsPerLine)} onChange={(e) => setAspect({ maxCharsPerLine: e.target.value ? Math.max(4, Math.min(120, Math.round(Number(e.target.value)))) : undefined })} />
                </Field>
              </Row>
              <Slider label={`Extra safe margin ${Math.round(g.safeMargin * 100)}%`} min={0} max={0.2} step={0.005} value={g.safeMargin} onChange={(v) => setG({ safeMargin: v })} />
              <Button size="sm" variant="ghost" disabled={!g.aspects[focus]} onClick={() => {
                  const next = { ...g.aspects };
                  delete next[focus];
                  setG({ aspects: next });
                }}>
                Reset {focus} to the global position
              </Button>
              <div>
                <p className="eyebrow mb-1">Lines placed by hand in {focus}</p>
                {Object.keys(placements[focus] ?? {}).length === 0 ? (
                  <p className="text-xs text-faint">None — use “Place line” on the preview while a line is on screen.</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {Object.entries(placements[focus] ?? {}).map(([lineId, p]) => (
                      <li key={lineId} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-dim">{lines.find((l) => l.id === lineId)?.text ?? lineId}</span>
                        <span className="text-faint">
                          {Math.round(p.x * 100)}%, {Math.round(p.y * 100)}%
                        </span>
                        <button type="button" className="cursor-pointer text-faint hover:text-fg" onClick={() => {
                            const rest = { ...(placements[focus] ?? {}) };
                            delete rest[lineId];
                            void saveTrack({ placements: { ...placements, [focus]: rest } }, 'Line released to automatic placement');
                          }}>
                          release
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          {panel === 'sections' && (
            <div className="space-y-3">
              {sectionsUsed.length === 0 ? (
                <Notice>The lyric sheet has no sections yet. Mark verses, choruses and bridges in the lyric sheet to style them differently.</Notice>
              ) : (
                <>
                  <Field label="Section">
                    <Select value={section} onChange={(e) => setSection(e.target.value as SectionLabel | '')}>
                      <option value="">Choose…</option>
                      {sectionsUsed.map((s) => (
                        <option key={s} value={s}>
                          {s}
                          {draft.sections[s] ? ' (styled)' : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {section && (
                    <div className="space-y-3">
                      <Field label="Treatment">
                        <Select value={sectionOverride?.preset ?? ''} onChange={(e) => (e.target.value ? setSection_({ preset: e.target.value as LyricPreset }) : setSection_(null))}>
                          <option value="">Same as the global style</option>
                          {LYRIC_PRESETS.map((p) => (
                            <option key={p} value={p}>
                              {LYRIC_PRESET_LABELS[p]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      {sectionOverride && (
                        <>
                          <Slider label={`Size ${(sectionOverride.fontSizePct ?? LYRIC_PRESET_STYLES[sectionOverride.preset ?? g.preset].fontSizePct).toFixed(1)}%`} min={1.5} max={14} step={0.1} value={sectionOverride.fontSizePct ?? LYRIC_PRESET_STYLES[sectionOverride.preset ?? g.preset].fontSizePct} onChange={(v) => setSection_({ fontSizePct: v })} />
                          <Slider label={`Vertical ${Math.round((sectionOverride.y ?? LYRIC_PRESET_STYLES[sectionOverride.preset ?? g.preset].y) * 100)}%`} min={0} max={1} step={0.005} value={sectionOverride.y ?? LYRIC_PRESET_STYLES[sectionOverride.preset ?? g.preset].y} onChange={(v) => setSection_({ y: v })} />
                          <div className="flex gap-3">
                            <Colour label="Active" value={sectionOverride.activeColor ?? g.activeColor} onChange={(v) => setSection_({ activeColor: v })} />
                            <Colour label="Inactive" value={sectionOverride.inactiveColor ?? g.inactiveColor} onChange={(v) => setSection_({ inactiveColor: v })} />
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => {
                              const l = lines.find((x) => x.section === section);
                              if (l) seek(l.start + 0.01);
                            }}>
                            Preview a {section} line
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {panel === 'fonts' && (
            <div className="space-y-3">
              <p className="text-xs text-faint">Upload a .ttf or .otf you hold a licence for. It is measured in the preview and embedded in renders under the family name you give it.</p>
              {draft.fonts.length > 0 && (
                <ul className="space-y-1">
                  {draft.fonts.map((f) => (
                    <FontRow key={f.assetId} font={f} onRemove={() => set({ fonts: draft.fonts.filter((x) => x.assetId !== f.assetId), global: g.fontFamily === f.family ? { ...g, fontFamily: 'Inter' } : g })} />
                  ))}
                </ul>
              )}
              {pendingFont ? (
                <PendingFont
                  assetId={pendingFont}
                  taken={draft.fonts.map((f) => f.family)}
                  onCancel={() => setPendingFont(null)}
                  onAdd={(family) => {
                    set({ fonts: [...draft.fonts, { family, assetId: pendingFont, licenceConfirmed: true }], global: { ...g, fontFamily: family } });
                    setPendingFont(null);
                  }}
                />
              ) : (
                draft.fonts.length < 10 && <UploadZone accept=".ttf,.otf,font/ttf,font/otf" kind="document" projectId={project.id} collections={['fonts']} multiple={false} compact label="Upload a font (.ttf / .otf)" onUploaded={(ids) => ids[0] && setPendingFont(ids[0])} />
              )}
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={!draft.fonts.length} onClick={() => setG({ fontFamily: draft.fonts[draft.fonts.length - 1]!.family })}>
                Use the latest font
              </Button>
            </div>
          )}
        </Card>
      </div>
      <AssetPicker open={picker} onOpenChange={setPicker} kinds={['image']} projectId={project.id} onPick={(a) => {
          setBgId(a[0]?.id ?? null);
          setPicker(false);
        }} title="Reference picture for placement" />
      {dialog}
    </div>
  );
}

/** One preset rendered on the current line (16:9), so presets can be compared on the real lyrics. */
function PresetTile({ preset, active, lines, fps, time, version, onChoose }: { preset: LyricPreset; active: boolean; lines: LyricInputLine[]; fps: number; time: number; version: number; onChoose: () => void }) {
  const scene = useMemo(() => {
    void version;
    const doc = { global: LYRIC_PRESET_STYLES[preset], sections: {} };
    return layoutLyrics({ lines, doc, aspect: '16:9', width: 640, height: 360, measure: canvasMeasure, fps }).scene;
  }, [preset, lines, fps, version]);
  const shown = lines.some((l) => time >= l.start && time < l.end) ? time : (lines[0]?.start ?? 0) + Math.min(0.6, ((lines[0]?.end ?? 1) - (lines[0]?.start ?? 0)) / 2);
  return (
    <button type="button" onClick={onChoose} className={cx('cursor-pointer rounded-lg border p-1 text-left', active ? 'border-accent' : 'border-line hover:border-accent/40')}>
      <TextScenePreview scene={scene} time={shown} label={`${LYRIC_PRESET_LABELS[preset]} preview`} />
      <span className="mt-1 block truncate px-0.5 text-[11px] text-dim">{LYRIC_PRESET_LABELS[preset]}</span>
    </button>
  );
}
