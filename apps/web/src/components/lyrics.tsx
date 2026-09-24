import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCheck, Download, FileText, Languages, Mic, Music2, Pause, Play, RefreshCw, Sparkles, Upload, Wand2 } from 'lucide-react';
import {
  editLineText,
  formatTimecode,
  LYRIC_LANGUAGES,
  needsLanguageVerification,
  languageName,
  parseLyricsText,
  resyncSheet,
  SECTION_LABELS,
  setLineTiming,
  sheetFromParsed,
  sheetText,
  sheetToLyricLines,
  toLrc,
  toSrt,
  toVtt,
  type LyricSheetLine,
  type LyricsSheet,
  type ModelAvailability,
  type ProjectDoc,
  type SectionLabel,
  type SongDoc,
} from '@az-studio/shared';
import { errorMessage } from '../lib/api';
import { useAiRun, waitForJobOutput } from '../lib/ai';
import type { WithId } from '../lib/data';
import { modelStatus } from '../lib/production';
import { useBoot } from '../lib/session';
import { updateSubDoc } from '../lib/studio';
import { useJobSubmitter } from './jobs';
import { Badge, Button, Card, ConfirmDialog, cx, Field, IconButton, Input, Modal, Notice, Select, Textarea, Toggle } from './ui';

type Song = WithId<SongDoc>;

export interface Transport {
  time: number;
  seek: (t: number) => void;
  playRange: (start: number, end: number) => void;
  playing: boolean;
  pause: () => void;
}

const BOM = String.fromCharCode(0xfeff);

function download(name: string, text: string, type: string) {
  const blob = new Blob([BOM + text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const safeName = (s: string) => s.replace(/[^\p{L}\p{N}\- _]+/gu, '').trim() || 'lyrics';

async function saveSheet(projectId: string, song: Song, sheet: LyricsSheet | null, extra: Record<string, unknown> = {}) {
  const src = sheet?.source === 'uploaded' ? 'upload' : sheet?.source === 'manual' ? 'manual' : 'ai';
  await updateSubDoc(projectId, 'songs', song.id, { lyricsSheet: sheet, lyrics: sheet ? { source: src, lines: sheetToLyricLines(sheet) } : null, ...extra });
}

function LanguageSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Language">
      {LYRIC_LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.name} ({l.code})
        </option>
      ))}
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

type Mode = 'generate' | 'music' | 'extract' | 'upload' | 'instrumental' | 'choose';

const OPTIONS: { value: Exclude<Mode, 'choose'>; title: string; body: string; icon: React.ReactNode }[] = [
  { value: 'generate', title: 'Generate lyrics only', body: 'Gemini writes an editable draft in your language, subject, structure, tone and genre.', icon: <Wand2 className="size-4" /> },
  { value: 'music', title: 'Generate music and lyrics', body: 'Lyria 3.5 writes and performs a full song; lyrics, structure and timing are stored.', icon: <Music2 className="size-4" /> },
  { value: 'extract', title: 'Extract lyrics from the song', body: 'Detect vocals, transcribe with word timing and flag uncertain words for you to correct.', icon: <Mic className="size-4" /> },
  { value: 'upload', title: 'Upload existing lyrics', body: 'Plain text, .txt, .lrc, .srt or .vtt — your wording is kept exactly and aligned to the vocals.', icon: <Upload className="size-4" /> },
  { value: 'instrumental', title: 'Instrumental — no lyrics', body: 'Nothing is transcribed or invented; captions stay off.', icon: <Music2 className="size-4" /> },
];

function GenerateLyricsForm({ project, song, onDone }: { project: WithId<ProjectDoc>; song: Song; onDone: () => void }) {
  const ai = useAiRun(project.id);
  const [language, setLanguage] = useState(project.language ?? 'en');
  const [subject, setSubject] = useState(project.idea ?? '');
  const [structure, setStructure] = useState('intro, verse, pre-chorus, chorus, verse, pre-chorus, chorus, bridge, chorus, outro');
  const [tone, setTone] = useState('');
  const [genre, setGenre] = useState(song.ai?.genre ?? '');
  const [title, setTitle] = useState(song.title);
  const run = async () => {
    const out = await ai.run<{ title?: string; languageCode?: string; sections?: { label: string; name: string; lines: string[] }[]; notes?: string }>('music.lyrics', { language, languageName: languageName(language), subject, structure, tone, genre, title, notes: project.treatment?.logline ?? '' }, 'Write song lyrics');
    if (!out?.sections?.length) return;
    const text = out.sections.map((s) => `[${s.name || s.label}]\n${s.lines.join('\n')}`).join('\n\n');
    const sheet = sheetFromParsed(parseLyricsText(text, 'plain'), { source: 'generated', language, status: 'draft' });
    for (const [i, sec] of sheet.sections.entries()) {
      const want = out.sections[i]?.label;
      if (want && (SECTION_LABELS as readonly string[]).includes(want)) sec.label = want as SectionLabel;
    }
    if (out.notes) sheet.timing.notes = [`Writer’s notes: ${out.notes}`];
    await saveSheet(project.id, song, sheet, { instrumental: false });
    toast.success('Draft lyrics ready', { description: sheet.requiresLanguageVerification ? `${languageName(language)} lyrics written by AI must be checked by a fluent speaker before approval.` : 'Edit them, then approve.' });
    onDone();
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Language">
          <LanguageSelect value={language} onChange={setLanguage} />
        </Field>
        <Field label="Title idea">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
      </div>
      <Field label="Subject">
        <Textarea rows={2} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What is the song about?" />
      </Field>
      <Field label="Structure">
        <Input value={structure} onChange={(e) => setStructure(e.target.value)} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Tone">
          <Input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="e.g. hopeful, defiant" />
        </Field>
        <Field label="Genre">
          <Input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="e.g. highlife, afrobeats" />
        </Field>
      </div>
      {needsLanguageVerification(language, 'generated') && <Notice tone="warning" icon={<Languages className="size-4" />}>AI-written {languageName(language)} lyrics are marked as needing verification by a fluent speaker. Your own spelling and diacritics are always kept exactly.</Notice>}
      <Button variant="primary" loading={ai.busy} disabled={!subject.trim()} onClick={() => void run()} icon={<Wand2 className="size-4" />}>
        Write draft lyrics
      </Button>
      {ai.dialog}
    </div>
  );
}

/** Lyria 3.5 availability (the exact Vertex AI limitation is shown when it is not served). */
function useMusicAvailability() {
  const [status, setStatus] = useState<ModelAvailability | null>(null);
  const load = async (refresh = false) => {
    try {
      const r = await modelStatus(refresh);
      setStatus(r.models.find((m) => m.role === 'music') ?? null);
    } catch {
      setStatus(null);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return { status, refresh: () => load(true) };
}

export function GenerateMusicForm({ project, song, onDone }: { project: WithId<ProjectDoc>; song: Song | null; onDone: () => void }) {
  const boot = useBoot();
  const { submit, busy, dialog } = useJobSubmitter();
  const { status, refresh } = useMusicAvailability();
  const [prompt, setPrompt] = useState(song?.ai?.summary ?? '');
  const [lyrics, setLyrics] = useState(song?.lyricsSheet && song.lyricsSheet.status === 'approved' ? sheetText(song.lyricsSheet) : '');
  const [instrumental, setInstrumental] = useState(Boolean(song?.instrumental));
  const [language, setLanguage] = useState(project.language ?? 'en');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const unavailable = status?.status === 'unavailable';
  const go = async () => {
    const ids = await submit([{ type: 'music.generate', projectId: project.id, purpose: 'song', prompt, lyrics: instrumental ? null : lyrics.trim() || null, instrumental, languageCode: language, imageAssetIds: [], songId: song?.id ?? null, title: song?.title ?? project.title, label: 'Generate music and lyrics' }], { label: 'Generate music and lyrics' });
    if (!ids?.[0]) return;
    setWaiting(true);
    try {
      await waitForJobOutput(ids[0], project.id, 30 * 60_000).catch(() => undefined);
      onDone();
    } finally {
      setWaiting(false);
    }
  };
  return (
    <div className="space-y-3">
      {unavailable && (
        <Notice tone="danger" icon={<AlertTriangle className="size-4" />}>
          <p>{status!.detail}</p>
          <Button size="sm" variant="ghost" className="mt-1" onClick={() => void refresh()} icon={<RefreshCw className="size-3.5" />}>
            Check again
          </Button>
        </Notice>
      )}
      <Field label="Music direction" hint="Genre, mood, instruments, tempo, vocal style. Timestamps like [0:00 - 0:15] Intro: … shape the structure.">
        <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      <Toggle checked={instrumental} onChange={setInstrumental} label="Instrumental" description="No vocals and no lyrics — none will be invented." />
      {!instrumental && (
        <>
          <Field label="Language">
            <LanguageSelect value={language} onChange={setLanguage} />
          </Field>
          <Field label="Lyrics to sing (optional)" hint="Leave empty for Lyria to write them. Your wording is sung and kept exactly as the approved text.">
            <Textarea rows={6} value={lyrics} onChange={(e) => setLyrics(e.target.value)} />
          </Field>
        </>
      )}
      <Button variant="primary" loading={busy || waiting} disabled={!prompt.trim() || unavailable} onClick={() => (song ? setConfirmReplace(true) : void go())} icon={<Sparkles className="size-4" />}>
        Generate with {boot?.capabilities.music.displayName ?? 'Lyria'}
      </Button>
      <ConfirmDialog open={confirmReplace} onOpenChange={setConfirmReplace} title="Replace the song’s audio?" body="The generated song becomes this project’s song (the current audio stays in your media library)." confirmLabel="Generate" onConfirm={() => {
        setConfirmReplace(false);
        void go();
      }} />
      {dialog}
    </div>
  );
}

function UploadLyricsForm({ project, song, onDone }: { project: WithId<ProjectDoc>; song: Song; onDone: () => void }) {
  const [text, setText] = useState('');
  const [language, setLanguage] = useState(project.language ?? 'en');
  const parsed = useMemo(() => (text.trim() ? parseLyricsText(text) : null), [text]);
  const save = async () => {
    if (!parsed?.lines.length) return;
    const sheet = sheetFromParsed(parsed, { source: 'uploaded', language });
    await saveSheet(project.id, song, sheet, { instrumental: false });
    toast.success(`${sheet.lines.length} lines saved exactly as written`, { description: parsed.format === 'plain' ? 'Next: synchronise them to the vocals.' : `Timestamps from the ${parsed.format.toUpperCase()} file are kept and will be validated against the vocals.` });
    onDone();
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Language" className="w-60">
          <LanguageSelect value={language} onChange={setLanguage} />
        </Field>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[13px] text-dim hover:text-fg">
          <FileText className="size-3.5" /> Choose .txt / .lrc / .srt / .vtt
          <input type="file" accept=".txt,.lrc,.srt,.vtt,text/plain,text/vtt" className="hidden" onChange={(e) => e.target.files?.[0]?.text().then(setText)} />
        </label>
      </div>
      <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Paste lyrics (section tags like [Chorus] are recognised) or a timed LRC / SRT / VTT file.'} aria-label="Lyrics" />
      {parsed && (
        <p className="text-xs text-faint">
          {parsed.format.toUpperCase()} · {parsed.lines.length} lines · {parsed.sections.length} sections{parsed.problems.length ? ` · ${parsed.problems.length} timing problem(s) will be checked` : ''}
        </p>
      )}
      <Button variant="primary" disabled={!parsed?.lines.length} onClick={() => void save()} icon={<Upload className="size-4" />}>
        Use these lyrics
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync editor
// ---------------------------------------------------------------------------

/** Detail waveform around the selected line with draggable start/end handles. */
function LineTimingEditor({ line, peaks, duration, transport, onChange }: { line: LyricSheetLine; peaks: { min: number[]; max: number[] } | null; duration: number; transport: Transport; onChange: (start: number, end: number) => void }) {
  const start = line.start ?? 0;
  const end = line.end ?? Math.min(duration, start + 3);
  const [range, setRange] = useState({ start, end });
  useEffect(() => setRange({ start, end }), [start, end, line.id]);
  const t0 = Math.max(0, range.start - 3);
  const t1 = Math.min(duration || range.end + 3, range.end + 3);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(100, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !peaks || !duration) return;
    const H = 96;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, H);
    g.fillStyle = '#6ea3ff';
    const n = peaks.max.length;
    for (let x = 0; x < width; x++) {
      const t = t0 + ((t1 - t0) * x) / width;
      const i = Math.min(n - 1, Math.floor((t / duration) * n));
      const hi = Math.max(0, peaks.max[i] ?? 0);
      const lo = Math.min(0, peaks.min[i] ?? 0);
      g.fillRect(x, H / 2 - hi * (H / 2) * 0.95, 1, Math.max(1, (hi - lo) * (H / 2) * 0.95));
    }
  }, [peaks, width, t0, t1, duration]);
  const toX = (t: number) => ((t - t0) / (t1 - t0)) * width;
  const toT = (x: number) => t0 + (x / width) * (t1 - t0);
  const drag = (edge: 'start' | 'end') => (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = wrap.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const t = Math.round(toT(ev.clientX - rect.left) * 100) / 100;
      setRange((r) => (edge === 'start' ? { ...r, start: Math.max(0, Math.min(t, r.end - 0.1)) } : { ...r, end: Math.min(duration || t, Math.max(t, r.start + 0.1)) }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setRange((r) => {
        onChange(r.start, r.end);
        return r;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const nudge = (edge: 'start' | 'end', d: number) => {
    const next = edge === 'start' ? { ...range, start: Math.max(0, Math.min(range.end - 0.1, range.start + d)) } : { ...range, end: Math.max(range.start + 0.1, range.end + d) };
    setRange(next);
    onChange(next.start, next.end);
  };
  return (
    <div className="space-y-2">
      <div ref={wrap} className="relative h-24 w-full touch-none overflow-hidden rounded-lg border border-line bg-black/40" onPointerDown={(e) => e.target === e.currentTarget && transport.seek(toT(e.clientX - e.currentTarget.getBoundingClientRect().left))}>
        <canvas ref={canvas} style={{ width, height: 96 }} className="pointer-events-none block" />
        <div className="pointer-events-none absolute inset-y-0 border-x-0 bg-accent/15" style={{ left: toX(range.start), width: Math.max(1, toX(range.end) - toX(range.start)) }} />
        {line.words.filter((w) => w.start !== null).map((w, i) => (
          <div key={i} className={cx('pointer-events-none absolute top-0 h-3 w-px', w.flag === 'uncertain' ? 'bg-warning' : 'bg-white/50')} style={{ left: toX(w.start!) }} title={w.text} />
        ))}
        {transport.time >= t0 && transport.time <= t1 && <div className="pointer-events-none absolute inset-y-0 w-px bg-white" style={{ left: toX(transport.time) }} />}
        {(['start', 'end'] as const).map((edge) => (
          <div key={edge} role="slider" aria-label={`Line ${edge}`} aria-valuenow={range[edge]} tabIndex={0} onPointerDown={drag(edge)} onKeyDown={(e) => (e.key === 'ArrowLeft' ? nudge(edge, -0.05) : e.key === 'ArrowRight' ? nudge(edge, 0.05) : undefined)} className="absolute inset-y-0 w-2 -translate-x-1 cursor-ew-resize bg-accent-2/80 hover:bg-accent-2" style={{ left: toX(range[edge]) }} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-dim">
        <span className="timecode">
          {formatTimecode(range.start, 2)} – {formatTimecode(range.end, 2)}
        </span>
        <Button size="sm" variant="ghost" onClick={() => nudge('start', -0.05)}>
          Start −
        </Button>
        <Button size="sm" variant="ghost" onClick={() => nudge('start', 0.05)}>
          Start +
        </Button>
        <Button size="sm" variant="ghost" onClick={() => nudge('end', -0.05)}>
          End −
        </Button>
        <Button size="sm" variant="ghost" onClick={() => nudge('end', 0.05)}>
          End +
        </Button>
        <Button size="sm" variant="subtle" icon={<Play className="size-3.5" />} onClick={() => transport.playRange(range.start, range.end)}>
          Play line
        </Button>
      </div>
    </div>
  );
}

function flagBadges(l: LyricSheetLine) {
  return l.flags.map((f) => (
    <Badge key={f} tone={f === 'unaligned' ? 'danger' : f === 'low_confidence' || f === 'uncertain_words' || f === 'no_vocal_match' ? 'warning' : f === 'manual_timing' ? 'violet' : 'neutral'}>
      {f.replace(/_/g, ' ')}
    </Badge>
  ));
}

export function LyricsWorkflow({ project, song, transport, peaks }: { project: WithId<ProjectDoc>; song: Song; transport: Transport; peaks: { min: number[]; max: number[] } | null }) {
  const sheet = song.lyricsSheet ?? null;
  const [mode, setMode] = useState<Mode | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const { submit, busy, dialog } = useJobSubmitter();
  const [jobBusy, setJobBusy] = useState(false);
  const duration = song.durationSec;
  const asr = song.asr && song.asr.audioAssetId === song.audioAssetId ? song.asr.words : null;
  const line = sheet?.lines.find((l) => l.id === selected) ?? null;
  const current = sheet?.lines.find((l) => l.start !== null && l.end !== null && transport.time >= l.start && transport.time < l.end) ?? null;

  const runJob = async (type: 'lyrics.transcribe' | 'lyrics.align', label: string, retranscribe = false) => {
    const job = type === 'lyrics.align' ? { type, projectId: project.id, songId: song.id, audioAssetId: song.audioAssetId, languageCode: sheet?.language ?? project.language ?? null, retranscribe, label } : { type, projectId: project.id, songId: song.id, audioAssetId: song.audioAssetId, languageCode: project.language ?? null, label };
    const ids = await submit([job], { label });
    if (!ids?.[0]) return;
    setJobBusy(true);
    try {
      await waitForJobOutput(ids[0], project.id, 30 * 60_000).catch((e) => toast.error(`${label} did not finish`, { description: errorMessage(e) }));
    } finally {
      setJobBusy(false);
    }
  };

  /** Corrections re-synchronise instantly from the cached transcript (no model call, nothing re-uploaded). */
  const correct = async (next: LyricsSheet) => {
    const synced = asr && next.timing.status !== 'none' ? resyncSheet(next, asr, duration) : next;
    await saveSheet(project.id, song, synced);
  };

  if (song.instrumental) {
    return (
      <Card className="space-y-3 p-5">
        <p className="eyebrow">Lyrics</p>
        <Notice icon={<Music2 className="size-4" />}>This song is marked instrumental — AZ Studio will not transcribe or invent lyrics, and lyric captions stay off.</Notice>
        <Button size="sm" variant="ghost" onClick={() => void updateSubDoc(project.id, 'songs', song.id, { instrumental: false })}>
          It has vocals
        </Button>
      </Card>
    );
  }

  if (!sheet || mode) {
    return (
      <Card className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <p className="eyebrow">Lyrics</p>
          {sheet && (
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Back to the lyric sheet
            </Button>
          )}
        </div>
        {!mode || mode === 'choose' ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {OPTIONS.map((o) => (
              <button key={o.value} type="button" onClick={() => (o.value === 'instrumental' ? void saveSheet(project.id, song, null, { instrumental: true }) : setMode(o.value))} className="card cursor-pointer p-3 text-left transition-colors hover:border-accent/40">
                <p className="flex items-center gap-2 text-sm text-fg">
                  {o.icon} {o.title}
                </p>
                <p className="mt-1 text-xs text-dim">{o.body}</p>
              </button>
            ))}
          </div>
        ) : mode === 'generate' ? (
          <GenerateLyricsForm project={project} song={song} onDone={() => setMode(null)} />
        ) : mode === 'music' ? (
          <GenerateMusicForm project={project} song={song} onDone={() => setMode(null)} />
        ) : mode === 'upload' ? (
          <UploadLyricsForm project={project} song={song} onDone={() => setMode(null)} />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-dim">The song is checked for vocals, transcribed with word timing, and every uncertain word is flagged for you to correct. Existing approved lyrics are never replaced.</p>
            <Button variant="primary" loading={busy || jobBusy} onClick={() => void runJob('lyrics.transcribe', 'Extract lyrics').then(() => setMode(null))} icon={<Mic className="size-4" />}>
              Extract lyrics
            </Button>
          </div>
        )}
        {dialog}
      </Card>
    );
  }

  const approve = async (verified: boolean) => {
    await saveSheet(project.id, song, { ...sheet, status: 'approved', approvedAt: Date.now(), ...(verified ? { languageVerifiedAt: Date.now(), requiresLanguageVerification: false } : {}) });
    toast.success('Lyrics approved', { description: 'This text is now the source of truth for captions and exports.' });
  };
  const exportAs = (kind: 'lrc' | 'lrc-words' | 'srt' | 'vtt' | 'vtt-words') => {
    const base = safeName(song.title);
    const range = song.range ?? null;
    const o = { title: song.title, artist: song.artist, range, offsetSec: range?.start ?? 0 };
    if (kind === 'lrc' || kind === 'lrc-words') download(`${base}${kind === 'lrc-words' ? '.words' : ''}.lrc`, toLrc(sheet, { ...o, wordLevel: kind === 'lrc-words' }), 'text/plain');
    else if (kind === 'srt') download(`${base}.srt`, toSrt(sheet, o), 'application/x-subrip');
    else download(`${base}${kind === 'vtt-words' ? '.karaoke' : ''}.vtt`, toVtt(sheet, { ...o, wordLevel: kind === 'vtt-words' }), 'text/vtt');
  };
  const timingTone = sheet.timing.status === 'aligned' ? 'success' : sheet.timing.status === 'needs_review' ? 'warning' : sheet.timing.status === 'none' ? 'neutral' : 'accent';
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="eyebrow">Lyrics</p>
        <Badge tone={sheet.status === 'approved' ? 'success' : 'warning'}>{sheet.status === 'approved' ? 'Approved' : 'Draft'}</Badge>
        <Badge>{sheet.source}</Badge>
        {sheet.language && <Badge icon={<Languages className="size-3" />}>{sheet.languageName ?? sheet.language}</Badge>}
        {sheet.requiresLanguageVerification && <Badge tone="warning">needs language verification</Badge>}
        <Badge tone={timingTone}>timing: {sheet.timing.status.replace('_', ' ')}</Badge>
        <span className="text-xs text-faint">{sheet.lines.length} lines</span>
      </div>
      {sheet.timing.notes.length > 0 && <p className="text-xs text-dim">{sheet.timing.notes.join(' ')}</p>}
      {song.lyricsCandidate && (
        <Notice tone="accent">
          A transcription draft of the vocals was kept aside because these lyrics are approved.{' '}
          <button type="button" className="cursor-pointer text-accent-2 underline" onClick={() => void updateSubDoc(project.id, 'songs', song.id, { lyricsCandidate: null })}>
            Discard it
          </button>
        </Notice>
      )}
      <div className="flex flex-wrap gap-2">
        {sheet.status === 'draft' && (
          <Button size="sm" variant="primary" icon={<CheckCheck className="size-3.5" />} onClick={() => (sheet.requiresLanguageVerification ? setVerifyOpen(true) : void approve(false))}>
            Approve lyrics
          </Button>
        )}
        <Button size="sm" variant="secondary" loading={busy || jobBusy} icon={<RefreshCw className="size-3.5" />} onClick={() => void runJob('lyrics.align', sheet.timing.status === 'none' ? 'Synchronise lyrics' : 'Resynchronise lyrics')}>
          {sheet.timing.status === 'none' ? 'Synchronise to the vocals' : 'Resync'}
        </Button>
        <Select className="!w-44 !py-1.5 text-xs" value="" onChange={(e) => e.target.value && exportAs(e.target.value as Parameters<typeof exportAs>[0])} aria-label="Export lyrics">
          <option value="">Export…</option>
          <option value="lrc">.lrc (lines)</option>
          <option value="lrc-words">.lrc (word timing)</option>
          <option value="srt">.srt</option>
          <option value="vtt">.vtt</option>
          <option value="vtt-words">.vtt (karaoke)</option>
        </Select>
        <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => setConfirmReset(true)}>
          Replace lyrics…
        </Button>
      </div>
      {line && line.start !== null && <LineTimingEditor line={line} peaks={peaks} duration={duration} transport={transport} onChange={(s, e) => void saveSheet(project.id, song, setLineTiming(sheet, line.id, s, e))} />}
      <ul className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
        {sheet.lines.map((l, i) => {
          const section = sheet.sections.find((s) => s.id === l.sectionId);
          const firstOfSection = section && sheet.lines.findIndex((x) => x.sectionId === section.id) === i;
          return (
            <li key={l.id}>
              {firstOfSection && <p className="mt-2 mb-1 text-[11px] tracking-wide text-faint uppercase">{section!.name}</p>}
              <div className={cx('grid grid-cols-[28px_76px_minmax(0,1fr)] items-start gap-2 rounded-lg px-1 py-1', selected === l.id ? 'bg-accent/10' : current?.id === l.id ? 'bg-white/[0.04]' : '')}>
                <IconButton size="sm" label="Play line" onClick={() => (l.start !== null ? transport.playRange(l.start, l.end ?? l.start + 3) : undefined)}>
                  {transport.playing && current?.id === l.id ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                </IconButton>
                <button type="button" className="timecode cursor-pointer pt-1.5 text-left text-[11px] text-faint hover:text-fg" onClick={() => setSelected(l.id === selected ? null : l.id)}>
                  {l.start !== null ? formatTimecode(l.start, 1) : '—'}
                  <span className={cx('ml-1 inline-block size-1.5 rounded-full', l.confidence >= 0.75 ? 'bg-success' : l.confidence >= 0.5 ? 'bg-warning' : l.start !== null ? 'bg-danger' : 'bg-white/20')} aria-hidden />
                </button>
                <div className="min-w-0">
                  <Input defaultValue={l.text} key={`${l.id}:${l.text}`} onBlur={(e) => e.target.value !== l.text && void correct(editLineText(sheet, l.id, e.target.value))} className="!py-1 text-sm" aria-label={`Line ${i + 1}`} />
                  {(l.flags.length > 0 || l.words.some((w) => w.flag === 'uncertain')) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {flagBadges(l)}
                      {l.words
                        .filter((w) => w.flag === 'uncertain')
                        .map((w, k) => (
                          <button key={k} type="button" onClick={() => w.start !== null && transport.playRange(Math.max(0, w.start - 0.3), (w.end ?? w.start) + 0.3)} className="cursor-pointer rounded bg-warning/15 px-1 text-[11px] text-warning" title="Uncertain word — listen and correct">
                            {w.text}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <Modal
        open={verifyOpen}
        onOpenChange={setVerifyOpen}
        size="sm"
        title="Language verification"
        description={`These ${sheet.languageName ?? sheet.language ?? ''} lyrics were written or transcribed by AI. Approve them only after a fluent speaker has checked the wording, spelling and diacritics.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setVerifyOpen(false)}>
              Not yet
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setVerifyOpen(false);
                void approve(true);
              }}
            >
              A fluent speaker has verified them
            </Button>
          </>
        }
      />
      <ConfirmDialog open={confirmReset} onOpenChange={setConfirmReset} title="Replace the lyrics?" body="Choose a new way to add lyrics. The current sheet is replaced when you save the new one." confirmLabel="Choose" onConfirm={() => {
        setConfirmReset(false);
        setMode('choose');
      }} />
      {dialog}
    </Card>
  );
}
