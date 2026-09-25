import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Flag, Play, Plus, RefreshCw, Repeat, Save, Scissors, Trash2, Wand2 } from 'lucide-react';
import {
  arrangementPlan,
  formatTimecode,
  SECTION_LABELS,
  type MusicMarker,
  type ProjectDoc,
  type SectionEdit,
  type SectionLabel,
} from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { musicCorrectAnalysis } from '../../lib/continuity';
import type { WithId } from '../../lib/data';
import { useJobSubmitter } from '../jobs';
import { useWaveform, Waveform } from '../media';
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, Notice, Select, Textarea, Toggle } from '../ui';
import { saveMusicProject, type MusicProject, type MusicVersion } from './create';
import { TransportBar, useAudioTransport } from './transport';

export const SECTION_COLOURS: Record<string, string> = {
  intro: 'rgba(120,140,180,0.18)',
  verse: 'rgba(76,141,255,0.16)',
  'pre-chorus': 'rgba(155,140,255,0.18)',
  chorus: 'rgba(244,184,74,0.18)',
  'post-chorus': 'rgba(244,184,74,0.12)',
  bridge: 'rgba(62,214,144,0.16)',
  breakdown: 'rgba(255,107,107,0.14)',
  drop: 'rgba(255,107,107,0.2)',
  instrumental: 'rgba(138,182,255,0.12)',
  hook: 'rgba(244,184,74,0.22)',
  outro: 'rgba(120,140,180,0.18)',
  other: 'rgba(255,255,255,0.07)',
};

let n = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(n = (n + 1) % 1000).toString(36)}`;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function VersionSelect({ versions, value, onChange, masterId }: { versions: MusicVersion[]; value: string | null; onChange: (id: string) => void; masterId: string | null }) {
  return (
    <Select className="h-9 w-72" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label="Version">
      {versions.map((v) => (
        <option key={v.id} value={v.id}>
          v{v.index} · {v.label}
          {v.id === masterId ? ' (master)' : ''}
        </option>
      ))}
    </Select>
  );
}

function ReplaceSectionDialog({ project, mp, version, section, onClose }: { project: WithId<ProjectDoc>; mp: MusicProject; version: MusicVersion; section: SectionEdit; onClose: () => void }) {
  const [direction, setDirection] = useState('');
  const [lyrics, setLyrics] = useState('');
  const { submit, busy, dialog } = useJobSubmitter();
  const go = async () => {
    const ids = await submit([{ type: 'music.replace_section', projectId: project.id, musicProjectId: mp.id, versionId: version.id, sectionId: section.id, direction: direction.trim(), lyrics: lyrics.trim() || null, label: `Replace ${section.name || section.label}` }], { label: `Replace ${section.name || section.label}`, alwaysConfirm: true });
    if (ids) {
      toast.success('Composing the replacement passage', { description: 'It becomes a new version; the original is kept.' });
      onClose();
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Replace the ${section.name || section.label}`}
      description="The music model cannot edit part of an existing recording. It composes a new passage in the song’s tempo and key; AZ Studio blends it in on the beat with short crossfades and saves the result as a new version (the original is untouched)."
      footer={
        <Button variant="primary" loading={busy} onClick={() => void go()} icon={<Wand2 className="size-4" />}>
          Compose replacement
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-dim">
          {formatTimecode(section.start)} – {formatTimecode(section.end)} ({(section.end - section.start).toFixed(1)} s)
          {version.analysis ? ` · ${Math.round(version.analysis.bpm)} BPM · ${version.analysis.key}` : ' · analyse the version first for tempo and key matching'}
        </p>
        <Field label="Direction for the new passage">
          <Textarea rows={3} value={direction} onChange={(e) => setDirection(e.target.value.slice(0, 2000))} placeholder="e.g. strip it back to voice and guitar, then build" />
        </Field>
        <Field label="Lyrics to sing (optional)" hint="Empty = instrumental passage.">
          <Textarea rows={3} value={lyrics} onChange={(e) => setLyrics(e.target.value.slice(0, 4000))} />
        </Field>
      </div>
      {dialog}
    </Modal>
  );
}

function AnalysisCard({ project, version }: { project: WithId<ProjectDoc>; version: MusicVersion }) {
  const a = version.analysis;
  const [bpm, setBpm] = useState(a ? String(Math.round(a.bpm * 10) / 10) : '');
  const [key, setKey] = useState(a?.key ?? '');
  const [ts, setTs] = useState(a?.timeSignature ?? '4/4');
  const [busy, setBusy] = useState(false);
  const { submit, busy: submitting, dialog } = useJobSubmitter();
  useEffect(() => {
    setBpm(a ? String(Math.round(a.bpm * 10) / 10) : '');
    setKey(a?.key ?? '');
    setTs(a?.timeSignature ?? '4/4');
  }, [a]);
  const analyse = () => void submit([{ type: 'music.analyze', projectId: project.id, audioAssetId: version.assetId, musicProjectId: version.musicProjectId, versionId: version.id, detectVocals: true, label: `Analyse v${version.index}` }], { label: 'Music analysis' });
  if (!a) {
    return (
      <Card className="space-y-2 p-4">
        <p className="text-sm text-dim">This version has not been analysed.</p>
        <Button size="sm" variant="primary" loading={submitting} icon={<RefreshCw className="size-3.5" />} onClick={analyse}>
          Analyse (tempo, key, bars, sections, energy, vocals)
        </Button>
        {dialog}
      </Card>
    );
  }
  const correct = async () => {
    setBusy(true);
    try {
      const b = Number(bpm);
      await musicCorrectAnalysis(project.id, version.id, { ...(b >= 30 && b <= 300 && Math.abs(b - a.bpm) > 0.05 ? { bpm: b } : {}), ...(key.trim() && key.trim() !== a.key ? { key: key.trim() } : {}), ...(/^\d{1,2}\/\d{1,2}$/.test(ts) && ts !== a.timeSignature ? { timeSignature: ts } : {}) });
      toast.success('Analysis corrected', { description: 'Corrections are kept when the version is analysed again.' });
    } catch (e) {
      toast.error('Could not correct the analysis', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const list = (regions: { start: number; end: number }[] | null | undefined) => (regions?.length ? regions.slice(0, 8).map((r) => `${formatTimecode(r.start, 0)}–${formatTimecode(r.end, 0)}`).join(', ') + (regions.length > 8 ? ` +${regions.length - 8}` : '') : '—');
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="eyebrow mr-auto">Analysis</p>
        <Badge>{a.method === 'dsp+ai' ? 'DSP + vocal listening' : 'DSP'}</Badge>
        {a.corrected.length > 0 && <Badge tone="accent">corrected: {a.corrected.join(', ')}</Badge>}
        <Button size="sm" variant="ghost" loading={submitting} icon={<RefreshCw className="size-3.5" />} onClick={analyse}>
          Re-analyse
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="BPM">
          <Input value={bpm} onChange={(e) => setBpm(e.target.value)} />
        </Field>
        <Field label={`Key (${Math.round(a.keyConfidence * 100)}% sure)`}>
          <Input value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label="Time signature">
          <Input value={ts} onChange={(e) => setTs(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void correct()}>
          Save corrections
        </Button>
      </div>
      <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-faint">Duration · bars</dt>
        <dd className="text-fg">
          {formatTimecode(a.durationSec)} · {a.bars.length} bars · {a.beats.length} beats
        </dd>
        <dt className="text-faint">Vocals</dt>
        <dd className="text-dim">{a.vocalPresence === null ? 'not checked' : a.vocalPresence.length ? list(a.vocalPresence) : 'none heard'}</dd>
        <dt className="text-faint">Instrumental</dt>
        <dd className="text-dim">{list(a.instrumental)}</dd>
        <dt className="text-faint">Quiet · loud</dt>
        <dd className="text-dim">
          {list(a.quiet)} · {list(a.loud)}
        </dd>
        <dt className="text-faint">Major transitions</dt>
        <dd className="text-dim">{a.transitions.length ? a.transitions.slice(0, 12).map((x) => formatTimecode(x, 0)).join(', ') : '—'}</dd>
        <dt className="text-faint">Edit points</dt>
        <dd className="text-dim">{a.editPoints.length ? a.editPoints.slice(0, 10).map((p) => `${formatTimecode(p.t, 1)} (${p.reason.replace(/_/g, ' ')})`).join(', ') : '—'}</dd>
        {version.loudness && (
          <>
            <dt className="text-faint">Loudness</dt>
            <dd className={version.loudness.truePeakDb !== null && version.loudness.truePeakDb > -1 ? 'text-warning' : 'text-dim'}>
              {version.loudness.integratedLufs?.toFixed(1) ?? '—'} LUFS · true peak {version.loudness.truePeakDb?.toFixed(1) ?? '—'} dBTP
              {version.loudness.truePeakDb !== null && version.loudness.truePeakDb > -1 ? ' — peaks above −1 dBTP may clip on streaming platforms' : ''}
            </dd>
          </>
        )}
      </dl>
      {dialog}
    </Card>
  );
}

/**
 * Structure: the version's waveform with its labelled sections; relabel, re-time, reorder, loop, trim,
 * fade and set per-section volume; add markers and visual ideas; replace a section (honestly: a new
 * passage blended in); correct the automatic analysis.
 */
export function StructurePanel({ project, mp, versions }: { project: WithId<ProjectDoc>; mp: MusicProject; versions: MusicVersion[] }) {
  const [versionId, setVersionId] = useState<string | null>(mp.masterVersionId ?? versions[0]?.id ?? null);
  const v = versions.find((x) => x.id === versionId) ?? versions[0] ?? null;
  const t = useAudioTransport(v?.assetId ?? null);
  const peaks = useWaveform(v?.assetId ?? null);
  const [sections, setSections] = useState<SectionEdit[]>(mp.sections ?? []);
  const [markers, setMarkers] = useState<MusicMarker[]>(mp.markers ?? []);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [replace, setReplace] = useState<SectionEdit | null>(null);
  useEffect(() => {
    if (dirty) return;
    setSections(mp.sections ?? []);
    setMarkers(mp.markers ?? []);
  }, [mp.sections, mp.markers, dirty]);
  if (!v) return <EmptyState icon={<Scissors className="size-5" />} title="No versions yet" body="Generate, upload or record music first; its structure appears here." />;
  const duration = v.durationSec ?? v.analysis?.durationSec ?? peaks?.durationSec ?? 0;
  const edit = (next: SectionEdit[]) => {
    setSections(next);
    setDirty(true);
  };
  const setOne = (id: string, patch: Partial<SectionEdit>) => edit(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const fromAnalysis = () => edit((v.analysis?.sections ?? []).map((s) => ({ id: uid('sec'), label: s.label, name: s.name, start: r2(s.start), end: r2(s.end), loop: 1, muted: false, gainDb: 0, fadeIn: 0, fadeOut: 0, visualIdea: '' })));
  const save = async () => {
    setSaving(true);
    try {
      await saveMusicProject(project.id, mp, { sections, markers });
      setDirty(false);
      toast.success('Structure saved');
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <VersionSelect versions={versions} value={v.id} onChange={setVersionId} masterId={mp.masterVersionId} />
        <TransportBar t={t} duration={duration} />
        <span className="ml-auto flex items-center gap-2">
          {dirty && <Badge tone="warning">Unsaved</Badge>}
          <Button size="sm" variant="primary" loading={saving} disabled={!dirty} icon={<Save className="size-3.5" />} onClick={() => void save()}>
            Save structure
          </Button>
        </span>
      </div>
      <Card className="space-y-2 p-3">
        <Waveform peaks={peaks} duration={duration || 1} playhead={t.time} height={120} beats={v.analysis?.downbeats} regions={sections.map((s) => ({ start: s.start, end: s.end, color: s.muted ? 'rgba(255,255,255,0.03)' : SECTION_COLOURS[s.label] ?? SECTION_COLOURS.other!, label: s.name || s.label }))} onSeek={t.seek} />
        <div className="relative h-4">
          {markers.map((m) => (
            <button key={m.id} type="button" title={`${m.label} · ${formatTimecode(m.t)}`} onClick={() => t.seek(m.t)} className="absolute top-0 h-4 w-1 -translate-x-1/2 cursor-pointer rounded-sm" style={{ left: `${(m.t / Math.max(1, duration)) * 100}%`, background: m.color }} />
          ))}
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="eyebrow mr-auto">Sections ({sections.length})</p>
            {v.analysis?.sections.length ? (
              <Button size="sm" variant="ghost" onClick={fromAnalysis}>
                Use the analysed sections
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={sections.length >= 60} onClick={() => edit([...sections, { id: uid('sec'), label: 'other', name: 'New section', start: r2(t.time), end: r2(Math.min(duration, t.time + 8)), loop: 1, muted: false, gainDb: 0, fadeIn: 0, fadeOut: 0, visualIdea: '' }])}>
              Add at playhead
            </Button>
          </div>
          {sections.length === 0 ? (
            <p className="text-xs text-faint">{v.analysis ? 'Use the analysed sections or add your own.' : 'Analyse the version to find its sections, or add them by hand.'}</p>
          ) : (
            <ul className="space-y-2">
              {sections.map((s, i) => (
                <li key={s.id} className="space-y-1.5 rounded-lg border border-line p-2" style={{ background: s.muted ? undefined : SECTION_COLOURS[s.label] }}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Select className="h-8 w-32 text-xs" value={s.label} onChange={(e) => setOne(s.id, { label: e.target.value as SectionLabel })} aria-label="Section type">
                      {SECTION_LABELS.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </Select>
                    <Input className="h-8 w-36 text-xs" value={s.name} onChange={(e) => setOne(s.id, { name: e.target.value.slice(0, 60) })} aria-label="Section name" />
                    <Input className="h-8 w-20 text-xs" type="number" step={0.01} value={s.start} onChange={(e) => setOne(s.id, { start: Math.max(0, r2(Number(e.target.value))) })} aria-label="Start" />
                    <button type="button" className="cursor-pointer text-[10px] text-accent-2 hover:underline" onClick={() => setOne(s.id, { start: r2(t.time) })}>
                      ⟵ playhead
                    </button>
                    <Input className="h-8 w-20 text-xs" type="number" step={0.01} value={s.end} onChange={(e) => setOne(s.id, { end: Math.max(0, r2(Number(e.target.value))) })} aria-label="End" />
                    <button type="button" className="cursor-pointer text-[10px] text-accent-2 hover:underline" onClick={() => setOne(s.id, { end: r2(t.time) })}>
                      ⟵ playhead
                    </button>
                    <span className="ml-auto flex">
                      <IconButton size="sm" label="Play section" onClick={() => t.transport.playRange(s.start, s.end)}>
                        <Play className="size-3.5" />
                      </IconButton>
                      <IconButton size="sm" label="Loop section" onClick={() => t.loopRange({ start: s.start, end: s.end })}>
                        <Repeat className="size-3.5" />
                      </IconButton>
                      <IconButton size="sm" label="Move up" disabled={i === 0} onClick={() => {
                          const a = [...sections];
                          [a[i - 1], a[i]] = [a[i]!, a[i - 1]!];
                          edit(a);
                        }}>
                        <ArrowUp className="size-3.5" />
                      </IconButton>
                      <IconButton size="sm" label="Move down" disabled={i === sections.length - 1} onClick={() => {
                          const a = [...sections];
                          [a[i + 1], a[i]] = [a[i]!, a[i + 1]!];
                          edit(a);
                        }}>
                        <ArrowDown className="size-3.5" />
                      </IconButton>
                      <IconButton size="sm" label="Remove section" onClick={() => edit(sections.filter((x) => x.id !== s.id))}>
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <label className="flex items-center gap-1 text-dim">
                      ×
                      <Input className="h-7 w-14 text-xs" type="number" min={1} max={8} value={s.loop} onChange={(e) => setOne(s.id, { loop: Math.max(1, Math.min(8, Math.round(Number(e.target.value) || 1))) })} aria-label="Repeat count" />
                    </label>
                    <label className="flex items-center gap-1 text-dim">
                      gain dB
                      <Input className="h-7 w-16 text-xs" type="number" min={-40} max={12} step={0.5} value={s.gainDb} onChange={(e) => setOne(s.id, { gainDb: Math.max(-40, Math.min(12, Number(e.target.value) || 0)) })} aria-label="Gain" />
                    </label>
                    <label className="flex items-center gap-1 text-dim">
                      fade in
                      <Input className="h-7 w-14 text-xs" type="number" min={0} max={30} step={0.1} value={s.fadeIn} onChange={(e) => setOne(s.id, { fadeIn: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })} aria-label="Fade in" />
                    </label>
                    <label className="flex items-center gap-1 text-dim">
                      out
                      <Input className="h-7 w-14 text-xs" type="number" min={0} max={30} step={0.1} value={s.fadeOut} onChange={(e) => setOne(s.id, { fadeOut: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })} aria-label="Fade out" />
                    </label>
                    <Toggle checked={s.muted} onChange={(m) => setOne(s.id, { muted: m })} label="Cut" />
                    <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />} disabled={dirty} title={dirty ? 'Save the structure first' : undefined} onClick={() => setReplace(s)}>
                      Replace…
                    </Button>
                  </div>
                  <Input className="h-7 text-xs" value={s.visualIdea} onChange={(e) => setOne(s.id, { visualIdea: e.target.value.slice(0, 600) })} placeholder="Visual idea for this part (used when it becomes a music video)" aria-label="Visual idea" />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-4">
          <AnalysisCard project={project} version={v} />
          <Card className="space-y-2 p-3">
            <div className="flex items-center justify-between">
              <p className="eyebrow">Markers</p>
              <Button size="sm" variant="ghost" icon={<Flag className="size-3.5" />} disabled={markers.length >= 100} onClick={() => {
                  setMarkers([...markers, { id: uid('m'), t: r2(t.time), label: `Marker ${markers.length + 1}`, color: '#F4B84A' }].sort((a, b) => a.t - b.t));
                  setDirty(true);
                }}>
                Add at playhead
              </Button>
            </div>
            {markers.length === 0 ? (
              <p className="text-xs text-faint">Mark drops, cues and edit points.</p>
            ) : (
              <ul className="space-y-1">
                {markers.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 text-xs">
                    <input type="color" className="size-6 cursor-pointer rounded border border-line bg-transparent" value={m.color} onChange={(e) => {
                        setMarkers(markers.map((x) => (x.id === m.id ? { ...x, color: e.target.value.toUpperCase() } : x)));
                        setDirty(true);
                      }} aria-label="Marker colour" />
                    <button type="button" className="timecode cursor-pointer text-accent-2" onClick={() => t.seek(m.t)}>
                      {formatTimecode(m.t)}
                    </button>
                    <Input className="h-7 flex-1 text-xs" value={m.label} onChange={(e) => {
                        setMarkers(markers.map((x) => (x.id === m.id ? { ...x, label: e.target.value.slice(0, 80) } : x)));
                        setDirty(true);
                      }} aria-label="Marker label" />
                    <IconButton size="sm" label="Remove marker" onClick={() => {
                        setMarkers(markers.filter((x) => x.id !== m.id));
                        setDirty(true);
                      }}>
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      {replace && <ReplaceSectionDialog project={project} mp={mp} version={v} section={replace} onClose={() => setReplace(null)} />}
    </div>
  );
}

/**
 * Arrange: the saved sections rendered in their new order from the real audio (repeats, cuts, gains and
 * fades) with short crossfades. Nothing is regenerated; lyric timing can follow the arrangement's map.
 */
export function ArrangePanel({ project, mp, versions }: { project: WithId<ProjectDoc>; mp: MusicProject; versions: MusicVersion[] }) {
  const [versionId, setVersionId] = useState<string | null>(mp.masterVersionId ?? versions[0]?.id ?? null);
  const v = versions.find((x) => x.id === versionId) ?? versions[0] ?? null;
  const plan = useMemo(() => arrangementPlan(mp.sections ?? []), [mp.sections]);
  const { submit, busy, dialog } = useJobSubmitter();
  if (!v) return <EmptyState icon={<Scissors className="size-5" />} title="No versions yet" body="Generate, upload or record music first." />;
  const kept = (mp.sections ?? []).filter((s) => !s.muted);
  const render = async () => {
    const ids = await submit([{ type: 'music.arrange', projectId: project.id, musicProjectId: mp.id, versionId: v.id, label: `Arrangement of v${v.index}` }], { label: 'Arrangement' });
    if (ids) toast.success('Rendering the arrangement', { description: 'It becomes a new version; lyric timing can follow it through its time map.' });
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <VersionSelect versions={versions} value={v.id} onChange={setVersionId} masterId={mp.masterVersionId} />
        <Button variant="primary" className="ml-auto" loading={busy} disabled={!kept.length} icon={<Scissors className="size-4" />} onClick={() => void render()}>
          Render arrangement ({formatTimecode(plan.durationSec)})
        </Button>
      </div>
      <Notice>The real audio of the chosen version is cut, re-ordered, repeated and faded exactly as the saved sections say ({Math.round(plan.crossfadeSec * 1000)} ms crossfades between parts). Nothing is regenerated. Edit the order, repeats, cuts, gains and fades under Structure.</Notice>
      {kept.length === 0 ? (
        <p className="text-sm text-faint">Save sections under Structure first.</p>
      ) : (
        <ol className="flex flex-wrap gap-1.5">
          {plan.segments.map((seg, i) => {
            const s = mp.sections.find((x) => x.id === seg.sectionId)!;
            return (
              <li key={`${seg.sectionId}${i}`} className="rounded-lg border border-line px-2.5 py-1.5 text-xs" style={{ background: SECTION_COLOURS[s.label] }}>
                <span className="text-fg">{s.name || s.label}</span>
                <span className="block text-faint">
                  {formatTimecode(seg.dstStart)} · {(seg.srcEnd - seg.srcStart).toFixed(1)} s{seg.gain !== 1 ? ` · ${s.gainDb > 0 ? '+' : ''}${s.gainDb} dB` : ''}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {dialog}
    </div>
  );
}
