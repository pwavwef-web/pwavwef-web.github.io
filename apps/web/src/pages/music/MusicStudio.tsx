import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { AudioWaveform, CheckCheck, Clapperboard, Film, GalleryHorizontal, ImagePlus, Music2, Palette, Pause, Play, Plus, Scissors, Sparkles, Trash2, Upload, UserRound, Wand2 } from 'lucide-react';
import {
  addAudioBed,
  assemblePicture,
  beatsInRange,
  emptyTimeline,
  formatDuration,
  formatTimecode,
  isWholeSong,
  lyricsInRange,
  lyricsToCaptions,
  makeClip,
  planShotSlots,
  productionRange,
  SECTION_LABELS,
  sectionsInRange,
  snapToBeat,
  type AudioAnalysisResult,
  type LyricLine,
  type ProjectDoc,
  type SectionLabel,
  type ShotDoc,
  type SongDoc,
  type SongSection,
  type StyleBible,
  type TakeDoc,
  type TimeRange,
  type Treatment,
} from '@az-studio/shared';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { errorMessage } from '../../lib/api';
import { useAiRun, waitForJobOutput } from '../../lib/ai';
import { analyzeAssetAudio } from '../../lib/audio-analysis';
import { useDebounced, type WithId } from '../../lib/data';
import { useMediaUrls } from '../../lib/media';
import { parseLyrics } from '../../lib/text-utils';
import { useBoot, useUid } from '../../lib/session';
import { addDocs, addShots, createSong, createTimeline, newCharacter, newLocation, newShot, updateProject, updateSubDoc, useProject, useSub } from '../../lib/studio';
import { BibleBoard } from '../../components/bibles';
import { EditAndExport } from '../../components/assembly';
import { useJobSubmitter } from '../../components/jobs';
import { AssetPicker, useWaveform, Waveform } from '../../components/media';
import { ProjectHeader } from '../../components/project-header';
import { ShotQueue, useShotContext, type Shot } from '../../components/shots';
import { Badge, Button, Card, EmptyState, ErrorState, Field, IconButton, Input, Notice, SectionHeader, Select, Skeleton, Tabs, Textarea, Toggle } from '../../components/ui';
import { sameData } from '../../lib/compare';
import { LookbookTab } from '../film/LookbookTab';
import ImageStudio from '../ImageStudio';

const SECTION_COLORS: Record<string, string> = {
  intro: 'rgba(120,140,180,0.16)',
  verse: 'rgba(76,141,255,0.14)',
  'pre-chorus': 'rgba(155,140,255,0.16)',
  chorus: 'rgba(244,184,74,0.16)',
  'post-chorus': 'rgba(244,184,74,0.1)',
  bridge: 'rgba(62,214,144,0.14)',
  breakdown: 'rgba(255,107,107,0.12)',
  drop: 'rgba(255,107,107,0.18)',
  instrumental: 'rgba(138,182,255,0.1)',
  hook: 'rgba(244,184,74,0.2)',
  outro: 'rgba(120,140,180,0.16)',
  other: 'rgba(255,255,255,0.06)',
};


// ---------------------------------------------------------------------------
// Song tab
// ---------------------------------------------------------------------------

function SongTab({ project, song }: { project: WithId<ProjectDoc>; song: WithId<SongDoc> | null }) {
  const [picker, setPicker] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<AudioAnalysisResult['peaks'] | null>(null);
  const [lyricsText, setLyricsText] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const stopAt = useRef<number | null>(null);
  const urls = useMediaUrls(song?.audioAssetId ?? null);
  const serverPeaks = useWaveform(song?.audioAssetId ?? null);
  const { submit, busy, dialog } = useJobSubmitter();
  const [aiBusy, setAiBusy] = useState(false);
  const duration = song?.durationSec ?? 0;
  const analysis = song?.analysis ?? null;

  const choose = async (assetId: string, title: string, dur: number) => {
    await createSong(project.id, assetId, title, dur);
  };
  const analyse = async () => {
    if (!song) return;
    try {
      const r = await analyzeAssetAudio(song.audioAssetId, setStage);
      setPeaks(r.peaks);
      await updateSubDoc(project.id, 'songs', song.id, { durationSec: r.durationSec, analysis: { bpm: r.bpm, beats: r.beats, downbeats: r.downbeats, energy: r.energy, energyHop: r.energyHop, sections: r.sections, method: 'dsp', analyzedAt: Date.now() } });
      toast.success(`${r.bpm} BPM · ${r.sections.length} sections · ${r.beats.length} beats`);
    } catch (e) {
      toast.error('Analysis failed', { description: errorMessage(e) });
    } finally {
      setStage(null);
    }
  };
  const aiAnalyse = async () => {
    if (!song) return;
    const ids = await submit([{ type: 'audio.analyze', projectId: project.id, songId: song.id, audioAssetId: song.audioAssetId, transcribeLyrics: !song.lyrics?.lines.length || song.lyrics.source === 'ai' }], { label: 'Song analysis' });
    if (!ids?.[0]) return;
    setAiBusy(true);
    try {
      await waitForJobOutput(ids[0], project.id);
      toast.success('AI analysis ready', { description: 'Review the suggested sections below.' });
    } catch (e) {
      toast.error('AI analysis failed', { description: errorMessage(e) });
    } finally {
      setAiBusy(false);
    }
  };
  const applyAiSections = async () => {
    const ai = (song as unknown as { aiSections?: SongSection[] })?.aiSections;
    if (!song || !ai?.length) return;
    const beats = analysis?.downbeats ?? analysis?.beats ?? [];
    const snapped = ai.map((s, i) => ({ ...s, id: `s${i}`, start: i === 0 ? 0 : beats.length ? snapToBeat(s.start, beats) : s.start, end: i === ai.length - 1 ? duration : beats.length ? snapToBeat(s.end, beats) : s.end }));
    await updateSubDoc(project.id, 'songs', song.id, { analysis: { ...(analysis ?? { bpm: 0, beats: [], downbeats: [], energy: [], energyHop: 0.5, analyzedAt: Date.now() }), sections: snapped, method: 'dsp+ai' } });
  };
  const setSections = (sections: SongSection[]) => song && analysis && void updateSubDoc(project.id, 'songs', song.id, { analysis: { ...analysis, sections } });
  const saveLyrics = async (lines: LyricLine[], source: 'upload' | 'manual') => song && updateSubDoc(project.id, 'songs', song.id, { lyrics: { source, lines } });

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    let raf = 0;
    const tick = () => {
      setTime(a.currentTime);
      if (stopAt.current !== null && a.currentTime >= stopAt.current) {
        a.pause();
        stopAt.current = null;
      }
      raf = requestAnimationFrame(tick);
    };
    if (playing) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  if (!song) {
    return (
      <>
        <EmptyState icon={<Music2 className="size-5" />} title="Add the finished song" body="Upload a mastered track (MP3, WAV, FLAC, M4A…). AZ Studio finds the tempo, beats and sections and builds the video around them." action={<Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setPicker(true)}>Upload or choose song</Button>} />
        <AssetPicker open={picker} onOpenChange={setPicker} kinds={['audio']} projectId={project.id} onPick={(a) => a[0] && void choose(a[0].id, a[0].title, a[0].durationSec ?? 0)} title="Choose the song" />
      </>
    );
  }

  const shownPeaks = peaks ?? serverPeaks;
  const aiSections = (song as unknown as { aiSections?: SongSection[] }).aiSections ?? [];
  const current = analysis?.sections.find((s) => time >= s.start && time < s.end);
  const range = productionRange(song.range, duration);
  const playRange = () => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = range.start;
    stopAt.current = range.end;
    void a.play();
  };

  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <IconButton label={playing ? 'Pause' : 'Play'} onClick={() => (playing ? audioRef.current?.pause() : void audioRef.current?.play())}>
              {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
            </IconButton>
            <div>
              <p className="text-sm text-fg">{song.title}</p>
              <p className="timecode text-xs text-faint">
                {formatTimecode(time)} / {formatTimecode(duration)} {current ? `· ${current.name}` : ''}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {analysis && <Badge tone="accent">{analysis.bpm} BPM</Badge>}
            {analysis && <Badge>{analysis.beats.length} beats</Badge>}
            <Button size="sm" loading={Boolean(stage)} onClick={() => void analyse()} icon={<AudioWaveform className="size-4" />}>
              {stage ?? (analysis ? 'Re-detect beats & sections' : 'Detect beats & sections')}
            </Button>
            <Button size="sm" variant="subtle" loading={busy || aiBusy} onClick={() => void aiAnalyse()} icon={<Sparkles className="size-4" />}>
              AI sections & lyrics
            </Button>
          </div>
        </div>
        <audio ref={audioRef} src={urls?.file} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onLoadedMetadata={(e) => !duration && void updateSubDoc(project.id, 'songs', song.id, { durationSec: e.currentTarget.duration })} />
        <Waveform
          peaks={shownPeaks}
          duration={duration || shownPeaks?.max.length || 1}
          playhead={time}
          height={120}
          beats={analysis?.downbeats}
          range={range}
          regions={analysis?.sections.map((s) => ({ start: s.start, end: s.end, color: SECTION_COLORS[s.label] ?? SECTION_COLORS.other!, label: s.name }))}
          onSeek={(t) => {
            if (audioRef.current) audioRef.current.currentTime = t;
            setTime(t);
          }}
        />
        {analysis && (
          <div className="scroll-x flex gap-1">
            {analysis.sections.map((s) => (
              <button key={s.id} type="button" onClick={() => audioRef.current && (audioRef.current.currentTime = s.start)} className="shrink-0 cursor-pointer rounded-lg border border-line px-2.5 py-1 text-xs text-dim hover:text-fg" style={{ background: SECTION_COLORS[s.label] }}>
                {s.name} · {formatTimecode(s.start, 0)}
              </button>
            ))}
          </div>
        )}
      </Card>

      <RangeCard project={project} song={song} time={time} onPlay={playRange} />

      {song.ai && (
        <Notice tone="accent" icon={<Sparkles className="size-4" />}>
          <strong className="text-fg">{song.ai.genre}</strong> · {song.ai.mood} · {song.ai.tempoFeel}. {song.ai.summary}
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <p className="eyebrow">Sections</p>
            <div className="flex gap-2">
              {aiSections.length > 0 && (
                <Button size="sm" variant="subtle" onClick={() => void applyAiSections()}>
                  Use AI sections ({aiSections.length})
                </Button>
              )}
              {analysis && (
                <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setSections([...analysis.sections, { id: `s${Date.now()}`, label: 'other' as SectionLabel, name: 'New section', start: time, end: Math.min(duration, time + 8), energy: 0 }].sort((a, b) => a.start - b.start))}>
                  Add at playhead
                </Button>
              )}
            </div>
          </div>
          {!analysis ? (
            <p className="text-sm text-faint">Detect beats & sections to begin.</p>
          ) : (
            <ul className="space-y-2">
              {analysis.sections.map((s, i) => (
                <li key={s.id} className="grid grid-cols-[110px_minmax(0,1fr)_80px_80px_32px] items-center gap-2">
                  <Select value={s.label} onChange={(e) => setSections(analysis.sections.map((x, k) => (k === i ? { ...x, label: e.target.value as SectionLabel } : x)))} className="!py-1.5 text-xs" aria-label="Section type">
                    {SECTION_LABELS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </Select>
                  <Input value={s.name} onChange={(e) => setSections(analysis.sections.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} className="!py-1.5 text-xs" aria-label="Section name" />
                  <Input type="number" step={0.1} value={s.start} onChange={(e) => setSections(analysis.sections.map((x, k) => (k === i ? { ...x, start: Number(e.target.value) } : x)))} className="!py-1.5 text-xs" aria-label="Start seconds" />
                  <Input type="number" step={0.1} value={s.end} onChange={(e) => setSections(analysis.sections.map((x, k) => (k === i ? { ...x, end: Number(e.target.value) } : x)))} className="!py-1.5 text-xs" aria-label="End seconds" />
                  <IconButton label="Remove section" size="sm" onClick={() => setSections(analysis.sections.filter((_, k) => k !== i))}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <p className="eyebrow">Lyrics {song.lyrics ? `· ${song.lyrics.source}` : ''}</p>
            {song.lyrics && <Badge>{song.lyrics.lines.length} lines</Badge>}
          </div>
          <Textarea rows={4} value={lyricsText} onChange={(e) => setLyricsText(e.target.value)} placeholder={'Paste lyrics or LRC (e.g. [00:12.40] First line). Untimed lines are spread across the song for you to refine.'} aria-label="Lyrics text" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!lyricsText.trim()} onClick={() => void saveLyrics(parseLyrics(lyricsText, duration), 'upload').then(() => setLyricsText(''))}>
              Import lyrics
            </Button>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-dim hover:bg-white/5 hover:text-fg">
              <Upload className="size-3.5" /> .lrc / .txt file
              <input type="file" accept=".lrc,.txt,text/plain" className="hidden" onChange={(e) => e.target.files?.[0]?.text().then((t) => void saveLyrics(parseLyrics(t, duration), 'upload'))} />
            </label>
          </div>
          {song.lyrics?.lines.length ? (
            <ul className="max-h-80 space-y-1 overflow-y-auto pr-1">
              {song.lyrics.lines.map((l, i) => (
                <li key={l.id} className={`grid grid-cols-[64px_64px_minmax(0,1fr)] items-center gap-2 rounded-lg px-1 ${time >= l.start && time < l.end ? 'bg-accent/10' : ''}`}>
                  <Input type="number" step={0.1} value={l.start} onChange={(e) => void saveLyrics(song.lyrics!.lines.map((x, k) => (k === i ? { ...x, start: Number(e.target.value) } : x)), 'manual')} className="!px-2 !py-1 text-xs" aria-label="Line start" />
                  <Input type="number" step={0.1} value={l.end} onChange={(e) => void saveLyrics(song.lyrics!.lines.map((x, k) => (k === i ? { ...x, end: Number(e.target.value) } : x)), 'manual')} className="!px-2 !py-1 text-xs" aria-label="Line end" />
                  <button type="button" className="cursor-pointer truncate text-left text-sm text-dim hover:text-fg" onClick={() => audioRef.current && (audioRef.current.currentTime = l.start)}>
                    {l.text}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-faint">No lyrics yet — import them or use AI transcription.</p>
          )}
        </Card>
      </div>
      {dialog}
    </div>
  );
}

/** The part of the song being produced. Shot planning, assembly and lyric captions follow it. */
function RangeCard({ project, song, time, onPlay }: { project: WithId<ProjectDoc>; song: WithId<SongDoc>; time: number; onPlay: () => void }) {
  const duration = song.durationSec;
  const range = productionRange(song.range, duration);
  const whole = isWholeSong(range, duration);
  const sections = song.analysis?.sections ?? [];
  const bars = song.analysis?.downbeats?.length ? song.analysis.downbeats : (song.analysis?.beats ?? []);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [startText, setStartText] = useState<string | null>(null);
  const [endText, setEndText] = useState<string | null>(null);
  const snap = (t: number) => (bars.length ? snapToBeat(t, bars) : Math.round(t * 10) / 10);
  const save = (r: TimeRange | null) => {
    const next = r ? productionRange(r, duration) : null;
    void updateSubDoc(project.id, 'songs', song.id, { range: next && !isWholeSong(next, duration) ? { start: Math.round(next.start * 1000) / 1000, end: Math.round(next.end * 1000) / 1000 } : null });
  };
  const useSections = () => {
    const a = sections.find((s) => s.id === (from || sections[0]?.id));
    const b = sections.find((s) => s.id === (to || from || sections[0]?.id));
    if (a && b) save({ start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) });
  };
  const commit = (which: 'start' | 'end', text: string | null) => {
    if (text === null) return;
    const v = Number(text);
    if (Number.isFinite(v)) save(which === 'start' ? { start: v, end: Math.max(range.end, v + 1) } : { start: range.start, end: v });
    if (which === 'start') setStartText(null);
    else setEndText(null);
  };
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow flex items-center gap-1.5">
            <Scissors className="size-3.5" /> Production range
          </p>
          <p className="mt-1 text-sm text-dim">
            <span className="timecode text-fg">{whole ? 'Whole song' : `${formatTimecode(range.start)} – ${formatTimecode(range.end)}`}</span> · {formatDuration(range.end - range.start)}. Shot planning, assembly and lyric captions use this part of the song — widen it any time to cover more.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="subtle" icon={<Play className="size-3.5" />} onClick={onPlay}>
            Play range
          </Button>
          {!whole && (
            <Button size="sm" variant="ghost" onClick={() => save(null)}>
              Use whole song
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {sections.length > 0 && (
          <>
            <Field label="From section" className="w-44">
              <Select value={from || sections[0]!.id} onChange={(e) => setFrom(e.target.value)}>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {formatTimecode(s.start, 0)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="To section" className="w-44">
              <Select value={to || from || sections[0]!.id} onChange={(e) => setTo(e.target.value)}>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {formatTimecode(s.end, 0)}
                  </option>
                ))}
              </Select>
            </Field>
            <Button size="sm" onClick={useSections}>
              Use these sections
            </Button>
          </>
        )}
        <Field label="Start (s)" className="w-28">
          <Input type="number" step={0.1} min={0} value={startText ?? String(Math.round(range.start * 10) / 10)} onChange={(e) => setStartText(e.target.value)} onBlur={() => commit('start', startText)} onKeyDown={(e) => e.key === 'Enter' && commit('start', startText)} />
        </Field>
        <Field label="End (s)" className="w-28">
          <Input type="number" step={0.1} min={0} value={endText ?? String(Math.round(range.end * 10) / 10)} onChange={(e) => setEndText(e.target.value)} onBlur={() => commit('end', endText)} onKeyDown={(e) => e.key === 'Enter' && commit('end', endText)} />
        </Field>
        <Button size="sm" variant="ghost" onClick={() => save({ start: snap(time), end: Math.max(range.end, snap(time) + 1) })}>
          Start at playhead
        </Button>
        <Button size="sm" variant="ghost" onClick={() => save({ start: range.start, end: snap(time) })}>
          End at playhead
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Concept tab
// ---------------------------------------------------------------------------

function ConceptTab({ project, song }: { project: WithId<ProjectDoc>; song: WithId<SongDoc> | null }) {
  const ai = useAiRun(project.id);
  const [brief, setBrief] = useState(project.idea ?? '');
  const [treatment, setTreatment] = useState<Treatment>(project.treatment ?? {});
  const [style, setStyle] = useState<StyleBible>(project.styleBible ?? {});
  const approved = Boolean(treatment.approvedAt);
  const debTreat = useDebounced(treatment, 1200);
  const debStyle = useDebounced(style, 1200);
  useEffect(() => {
    if (!sameData(debTreat, project.treatment ?? {})) void updateProject(project.id, { treatment: debTreat });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debTreat]);
  useEffect(() => {
    if (!sameData(debStyle, project.styleBible ?? {})) void updateProject(project.id, { styleBible: debStyle });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debStyle]);

  const generate = async () => {
    await updateProject(project.id, { idea: brief });
    const out = await ai.run<Treatment & { concept?: string; characters?: { name: string; description: string }[]; locations?: { name: string; description: string }[] }>(
      'music.treatment',
      { songTitle: song?.title ?? project.title, artist: '', brief, bpm: song?.analysis?.bpm, sections: song?.analysis?.sections.map((s) => ({ name: s.name, label: s.label, start: s.start, end: s.end })), lyrics: song?.lyrics?.lines.map((l) => l.text).join('\n') },
      'Music video treatment',
    );
    if (!out) return;
    const t: Treatment = { title: out.title, logline: out.logline, body: out.concept ?? out.body, visualStyle: out.visualStyle, palette: out.palette, motifs: out.motifs, wardrobe: out.wardrobe, performanceVsNarrative: out.performanceVsNarrative, sectionIdeas: out.sectionIdeas };
    setTreatment(t);
    setStyle((s) => ({ ...s, visualStyle: s.visualStyle || out.visualStyle, palette: s.palette || (out.palette ?? []).join(', ') }));
    await updateProject(project.id, { treatment: t, ...(out.logline && !project.logline ? { logline: out.logline } : {}) });
    if (out.characters?.length) await addDocs(project.id, 'characters', out.characters.map((c) => newCharacter({ name: c.name, appearance: c.description })));
    if (out.locations?.length) await addDocs(project.id, 'locations', out.locations.map((l) => newLocation({ name: l.name, description: l.description })));
    toast.success('Treatment ready', { description: `${out.characters?.length ?? 0} characters and ${out.locations?.length ?? 0} locations added to the bibles.` });
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Card className="space-y-4 p-5">
        <Field label="Artist brief" hint="Vision, references, brand world (e.g. Indigen World), must-have moments.">
          <Textarea rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Button variant="primary" loading={ai.busy} disabled={approved} onClick={() => void generate()} icon={<Wand2 className="size-4" />}>
            {treatment.body ? 'Regenerate treatment' : 'Generate treatment'}
          </Button>
          {treatment.body && (
            <div className="flex min-w-0 items-center gap-3">
              {approved && (
                <Badge tone="success" icon={<CheckCheck className="size-3" />}>
                  Approved
                </Badge>
              )}
              <Toggle checked={approved} onChange={(v) => setTreatment({ ...treatment, approvedAt: v ? Date.now() : null })} label="Approved for production" description={approved ? 'Locked — shot planning follows this treatment.' : 'Edit freely, then approve it before planning shots.'} />
            </div>
          )}
        </div>
        <Field label="Logline">
          <Input value={treatment.logline ?? ''} disabled={approved} onChange={(e) => setTreatment({ ...treatment, logline: e.target.value })} />
        </Field>
        <Field label="Concept">
          <Textarea rows={10} value={treatment.body ?? ''} disabled={approved} onChange={(e) => setTreatment({ ...treatment, body: e.target.value })} />
        </Field>
        {treatment.sectionIdeas?.length ? (
          <div>
            <p className="eyebrow mb-2">Section ideas</p>
            <ul className="space-y-1.5 text-sm">
              {treatment.sectionIdeas.map((s, i) => (
                <li key={i} className="rounded-lg border border-line px-3 py-2">
                  <span className="text-accent-2">{s.sectionLabel}</span> <span className="text-dim">— {s.idea}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>
      <Card className="space-y-4 p-5">
        <p className="eyebrow flex items-center gap-1.5">
          <Palette className="size-3.5" /> Style bible — applied to every shot
        </p>
        {(['visualStyle', 'palette', 'lighting', 'cameraLanguage', 'texture', 'continuityNotes'] as const).map((k) => (
          <Field key={k} label={{ visualStyle: 'Visual style', palette: 'Colour palette', lighting: 'Lighting', cameraLanguage: 'Camera language', texture: 'Texture & grain', continuityNotes: 'Continuity rules' }[k]}>
            <Textarea rows={2} value={style[k] ?? ''} disabled={approved} onChange={(e) => setStyle({ ...style, [k]: e.target.value })} />
          </Field>
        ))}
      </Card>
      {ai.dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shots tab
// ---------------------------------------------------------------------------

function ShotsTab({ project, song }: { project: WithId<ProjectDoc>; song: WithId<SongDoc> | null }) {
  const boot = useBoot();
  const ctx = useShotContext(project);
  const shots = useSub<ShotDoc>(project.id, 'shots', 'order');
  const ai = useAiRun(project.id);
  const [minLen, setMinLen] = useState(3);
  const [maxLen, setMaxLen] = useState(7);
  const analysis = song?.analysis;
  const range = song ? productionRange(song.range, song.durationSec) : null;
  const rangeKey = range ? `${range.start}-${range.end}` : '';
  const inRange = useMemo(() => (analysis && range ? sectionsInRange(analysis.sections, range) : []), [analysis, rangeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const slots = useMemo(() => (analysis ? inRange.flatMap((sec) => planShotSlots(sec, analysis.downbeats, minLen, maxLen).map((s) => ({ ...s, sectionId: sec.id, sectionName: sec.name }))) : []), [analysis, inRange, minLen, maxLen]);
  const whole = !range || !song || isWholeSong(range, song.durationSec);

  const timedCuesFor = (s: Shot) => {
    if (!s.timing || !analysis) return undefined;
    const cues: string[] = [];
    const beats = analysis.downbeats.filter((b) => b >= s.timing!.start && b < s.timing!.end).map((b) => Math.round((b - s.timing!.start) * 10) / 10);
    if (beats.length) cues.push(`Strong musical downbeats at ${beats.map((b) => `${b}s`).join(', ')} — time cuts of motion and camera accents to them.`);
    const lyric = song?.lyrics?.lines.filter((l) => l.start < s.timing!.end && l.end > s.timing!.start).map((l) => l.text);
    if (lyric?.length) cues.push(`Lyric during this shot: “${lyric.join(' / ')}”.`);
    cues.push('Music-video footage: no spoken dialogue; the song will be laid over the edit.');
    return cues;
  };

  const plan = async () => {
    if (!analysis || !slots.length) return;
    const out = await ai.run<{ shots: { slotIndex: number; title: string; description: string; framing: string; cameraMovement: string; lens: string; lighting: string; mood: string; performance: string; action: string; ambientSound: string; characterNames: string[]; locationName: string; lyricCue: string }[] }>(
      'music.shotlist',
      {
        treatment: project.treatment ?? {},
        slots: slots.map((s, i) => ({ slotIndex: i, start: s.start, end: s.end, section: s.sectionName })),
        sections: inRange.map((s) => ({ id: s.id, name: s.name, label: s.label, start: s.start, end: s.end })),
        lyrics: (song?.lyrics?.lines ?? []).filter((l) => !range || (l.end > range.start && l.start < range.end)).map((l) => ({ start: l.start, end: l.end, text: l.text })),
        characters: ctx.characters.map((c) => ({ name: c.name, description: c.appearance })),
        locations: ctx.locations.map((l) => ({ name: l.name, description: l.description })),
        styleBible: project.styleBible ?? {},
      },
      'Plan music video shots',
    );
    if (!out?.shots?.length) return;
    const byName = (list: { id: string; name: string }[], names: string[]) => names.map((n) => list.find((x) => x.name.toLowerCase() === n.toLowerCase())?.id).filter((x): x is string => Boolean(x));
    const docs = out.shots
      .filter((s) => slots[s.slotIndex])
      .map((s) => {
        const slot = slots[s.slotIndex]!;
        const loc = ctx.locations.find((l) => l.name.toLowerCase() === (s.locationName ?? '').toLowerCase());
        return newShot({
          order: slot.start,
          number: String(s.slotIndex + 1).padStart(2, '0'),
          title: s.title,
          description: s.description,
          sectionId: slot.sectionId,
          timing: { start: slot.start, end: slot.end },
          durationSec: Math.min(10, Math.max(3, Math.ceil(slot.end - slot.start))),
          aspectRatio: project.format.aspectRatio === '9:16' ? '9:16' : '16:9',
          resolution: project.format.videoResolution ?? boot?.settings.defaultVideoResolution ?? '720p',
          directions: { framing: s.framing, cameraMovement: s.cameraMovement, lens: s.lens, lighting: s.lighting, mood: s.mood, style: '', performance: s.performance, action: s.action, dialogue: [], ambientSound: s.ambientSound, avoid: 'text, subtitles or watermarks on screen' },
          refs: { characterIds: byName(ctx.characters, s.characterNames ?? []), locationIds: loc ? [loc.id] : [], elementIds: [], assetIds: [], firstFrameAssetId: null, lastFrameAssetId: null, storyboardAssetId: null },
        });
      });
    await addShots(project.id, docs);
    toast.success(`${docs.length} shots planned`, { description: 'Review them, generate storyboards, then queue the generations.' });
  };

  if (!song) return <EmptyState title="Add the song first" body="Shots are planned against the song’s sections and beats." />;
  return (
    <div className="space-y-5">
      {project.treatment?.body && !project.treatment.approvedAt && <Notice tone="warning">Approve the treatment on the Concept tab first — the shot plan is written from it.</Notice>}
      <Card className="flex flex-wrap items-end gap-4 p-5">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Beat-aligned shot plan</p>
          <p className="mt-1 text-sm text-dim">
            {analysis
              ? `${slots.length} slots across ${inRange.length} sections${whole || !range ? '' : ` in the production range (${formatTimecode(range.start)} – ${formatTimecode(range.end)})`}, cut on bar lines. Each slot becomes one Omni clip (3–10 s).`
              : 'Detect beats & sections on the Song tab first.'}
          </p>
        </div>
        <Field label={`Shortest ${minLen}s`} className="w-32">
          <Input type="number" min={3} max={maxLen} value={minLen} onChange={(e) => setMinLen(Math.max(3, Math.min(maxLen, Number(e.target.value))))} />
        </Field>
        <Field label={`Longest ${maxLen}s`} className="w-32">
          <Input type="number" min={minLen} max={10} value={maxLen} onChange={(e) => setMaxLen(Math.max(minLen, Math.min(10, Number(e.target.value))))} />
        </Field>
        <Button variant="primary" loading={ai.busy} disabled={!analysis || !slots.length} onClick={() => void plan()} icon={<Sparkles className="size-4" />}>
          Plan {slots.length} shots with AI
        </Button>
      </Card>
      <ShotQueue ctx={ctx} shots={shots.data} timedCuesFor={timedCuesFor} emptyAction={<Button onClick={() => void addShots(project.id, [newShot({ aspectRatio: project.format.aspectRatio === '9:16' ? '9:16' : '16:9', resolution: project.format.videoResolution ?? boot?.settings.defaultVideoResolution ?? '720p' })])}>Add a shot manually</Button>} />
      {ai.dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit tab
// ---------------------------------------------------------------------------

function EditTab({ project, song }: { project: WithId<ProjectDoc>; song: WithId<SongDoc> | null }) {
  const uid = useUid();
  const navigate = useNavigate();
  const shots = useSub<ShotDoc>(project.id, 'shots', 'order');
  const [captions, setCaptions] = useState(true);
  const [title, setTitle] = useState(true);
  const [keepOmniAudio, setKeepOmniAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const range = song ? productionRange(song.range, song.durationSec) : null;
  const approved = shots.data.filter((s) => (s.approvedTakeId || s.selectedTakeId) && (!range || !s.timing || (s.timing.end > range.start + 0.05 && s.timing.start < range.end - 0.05)));

  const assemble = async () => {
    if (!song || !range) return;
    setBusy(true);
    try {
      const items = [];
      for (const s of approved.sort((a, b) => (a.timing?.start ?? a.order) - (b.timing?.start ?? b.order))) {
        const takeId = s.approvedTakeId ?? s.selectedTakeId!;
        const take = (await getDoc(doc(db, 'projects', project.id, 'shots', s.id, 'takes', takeId))).data() as TakeDoc | undefined;
        if (!take?.assetId) continue;
        const asset = (await getDoc(doc(db, 'assets', take.assetId))).data() as { durationSec?: number } | undefined;
        // Shots sit at their song position relative to the production range.
        const start = s.timing ? Math.max(s.timing.start, range.start) : null;
        const len = s.timing ? Math.min(s.timing.end, range.end) - start! : s.durationSec;
        items.push({ assetId: take.assetId, kind: 'video' as const, durationSec: len, sourceDuration: asset?.durationSec ?? s.durationSec, label: s.title, shotId: s.id, takeId, at: start === null ? null : start - range.start });
      }
      if (!items.length) throw new Error('Approve or select at least one take first.');
      let state = emptyTimeline(project.format.aspectRatio, project.format.fps);
      state = assemblePicture(state, items);
      state = { ...state, clips: state.clips.map((c) => (c.kind === 'video' ? { ...c, useSourceAudio: keepOmniAudio, volume: keepOmniAudio ? 0.2 : 1 } : c)) };
      state = addAudioBed(state, song.audioAssetId, range.end - range.start, song.title, { inPoint: range.start, sourceDuration: song.durationSec });
      if (captions && song.lyrics?.lines.length) state = lyricsToCaptions(state, lyricsInRange(song.lyrics.lines, range));
      if (title) {
        const ov = state.tracks.find((t) => t.kind === 'overlay')!;
        state = { ...state, clips: [...state.clips, makeClip({ trackId: ov.id, kind: 'title', start: 0, duration: 3.5, text: project.title, fadeIn: 0.6, fadeOut: 0.8, label: 'Title card' })] };
      }
      if (song.analysis) state = { ...state, beatGrid: { bpm: song.analysis.bpm, beats: beatsInRange(song.analysis.beats, range) } };
      const id = await createTimeline(uid, project.id, `${project.title} — cut ${new Date().toLocaleDateString()}`, state, project.format.aspectRatio);
      navigate(`/projects/${project.id}/timeline/${id}`);
    } catch (e) {
      toast.error('Could not assemble', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center gap-6 p-5">
        <Toggle checked={captions} onChange={setCaptions} label="Lyric captions" />
        <Toggle checked={title} onChange={setTitle} label="Opening title card" />
        <Toggle checked={keepOmniAudio} onChange={setKeepOmniAudio} label="Keep Omni ambience at 20%" description="Off: the song carries all audio." />
      </Card>
      <EditAndExport project={project} onAssemble={() => void assemble()} assembling={busy} assembleLabel={`Assemble ${approved.length} approved shots`} assembleHint={range && !isWholeSong(range, song!.durationSec) ? `Shots are placed at their song positions within the production range (${formatTimecode(range.start)} – ${formatTimecode(range.end)}); gaps show black until filled.` : 'Shots are placed at their song positions over the full track; gaps show black until filled.'} />
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function MusicStudio() {
  const { projectId, tab = 'song' } = useParams();
  const navigate = useNavigate();
  const project = useProject(projectId);
  const songs = useSub<SongDoc>(projectId, 'songs', 'createdAt', 'asc');
  if (project.loading) return <Skeleton className="h-96" />;
  if (project.error) return <ErrorState error={project.error} />;
  if (!project.data) return <EmptyState title="Project not found" />;
  const song = songs.data[0] ?? null;
  const tabs = [
    { value: 'song', label: 'Song', icon: <Music2 className="size-4" /> },
    { value: 'concept', label: 'Concept', icon: <Wand2 className="size-4" /> },
    { value: 'cast', label: 'Cast & places', icon: <UserRound className="size-4" /> },
    { value: 'look', label: 'Lookbook', icon: <GalleryHorizontal className="size-4" /> },
    { value: 'shots', label: 'Storyboard & shots', icon: <Film className="size-4" /> },
    { value: 'edit', label: 'Edit & export', icon: <Clapperboard className="size-4" /> },
    { value: 'images', label: 'Images', icon: <ImagePlus className="size-4" /> },
  ];
  return (
    <div className="space-y-6">
      <ProjectHeader project={project.data} eyebrow="Music Video Studio" />
      <Tabs value={tab} onValueChange={(v) => navigate(`/projects/${project.data!.id}/music/${v}`)} tabs={tabs} />
      {tab === 'song' && <SongTab project={project.data} song={song} />}
      {tab === 'concept' && <ConceptTab project={project.data} song={song} />}
      {tab === 'cast' && (
        <div className="space-y-10">
          <section className="space-y-4">
            <SectionHeader eyebrow="Continuity" title="Characters" />
            <BibleBoard kind="characters" project={project.data} />
          </section>
          <section className="space-y-4">
            <SectionHeader eyebrow="Continuity" title="Locations" />
            <BibleBoard kind="locations" project={project.data} />
          </section>
          <section className="space-y-4">
            <SectionHeader eyebrow="Continuity" title="Props & costumes" />
            <BibleBoard kind="elements" project={project.data} />
          </section>
        </div>
      )}
      {tab === 'look' && <LookbookTab project={project.data} />}
      {tab === 'shots' && <ShotsTab project={project.data} song={song} />}
      {tab === 'edit' && <EditTab project={project.data} song={song} />}
      {tab === 'images' && <ImageStudio project={project.data} embedded />}
    </div>
  );
}
