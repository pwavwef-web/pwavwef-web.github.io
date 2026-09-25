import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { toast } from 'sonner';
import { ArrowLeft, Captions as CaptionsIcon, Clapperboard, Download, History as HistoryIcon, Magnet, Monitor, Pause, Play, Plus, Redo2, RotateCcw, Save, SkipBack, SkipForward, RectangleVertical, Smartphone, Square, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import {
  addClip,
  addClips,
  addTrack,
  checkLyricSync,
  clipsOnTrack,
  createHistory,
  DEFAULT_CAPTION_POSITION,
  DEFAULT_TEXT_STYLE,
  deleteClips,
  EXPORT_PRESETS,
  estimateRender,
  formatSrt,
  formatTimecode,
  makeClip,
  moveClip,
  parseSubtitles,
  pushHistory,
  redo,
  resyncLyricCaptions,
  setClipDuration,
  songClipsChanged,
  splitClip,
  timelineDuration,
  trackEnd,
  undo,
  updateClip,
  validateTimeline,
  type ExportPreset,
  type History,
  type LyricsSheet,
  type RenderDoc,
  type SongDoc,
  type RenderQuality,
  type TimelineDoc,
  type TimelineState,
  type TrackKind,
} from '@az-studio/shared';
import { db } from '../../lib/firebase';
import { useDebounced, useDoc, useLatest, useQuery, type WithId } from '../../lib/data';
import { downloadUrl } from '../../lib/media';
import { AssetPicker, VideoPlayer, type Asset } from '../../components/media';
import { useBoot, useUid } from '../../lib/session';
import { saveTimeline, snapshotTimeline, updateSubDoc, useProject, useSub } from '../../lib/studio';
import { EstimateText, useJobSubmitter } from '../../components/jobs';
import { Badge, Button, EmptyState, ErrorState, IconButton, Input, Modal, Notice, ProgressBar, Segmented, Select, Spinner, Tip } from '../../components/ui';
import { Preview } from './Preview';
import { HEADER_W, TimelineLanes, type DroppedAsset } from './Tracks';
import { Inspector } from './Inspector';
import { MediaBin } from './MediaBin';

type SaveStatus = 'saved' | 'saving' | 'dirty' | 'conflict';

const pick = (d: TimelineDoc): TimelineState => ({ tracks: d.tracks, clips: d.clips, markers: d.markers ?? [], fps: d.fps, aspectRatio: d.aspectRatio, beatGrid: d.beatGrid ?? null });

function RenderDialog({ projectId, timeline, onClose, ensureSaved, sheets, onResync }: { projectId: string; timeline: WithId<TimelineDoc>; onClose: () => void; ensureSaved: () => Promise<boolean>; sheets: Record<string, LyricsSheet | null>; onResync: () => void }) {
  const boot = useBoot();
  const uid = useUid();
  const [quality, setQuality] = useState<RenderQuality>('draft');
  const { submit, busy, dialog } = useJobSubmitter();
  const [watching, setWatching] = useState<string | null>(null);
  const renders = useQuery<RenderDoc>(() => (uid ? query(collection(db, 'renders'), where('ownerUid', '==', uid), where('timelineId', '==', timeline.id), orderBy('createdAt', 'desc'), limit(8)) : null), [uid, timeline.id]);
  const icons = { youtube_16x9: Monitor, vertical_9x16: Smartphone, square_1x1: Square, portrait_4x5: RectangleVertical };
  const syncIssues = checkLyricSync(timeline, sheets);
  const [acceptSync, setAcceptSync] = useState(false);
  const run = async (preset: ExportPreset['id']) => {
    if (!(await ensureSaved())) return;
    await submit([{ type: 'render.timeline', projectId, timelineId: timeline.id, preset, quality, inspect: quality === 'final', acceptLyricSync: acceptSync }], { label: `${EXPORT_PRESETS[preset].label} ${quality}`, alwaysConfirm: quality === 'final' });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Render" description="FFmpeg on Cloud Run renders the saved timeline. Draft is fast; final uses full quality and loudness normalisation." size="lg">
      <Segmented label="Quality" value={quality} onChange={setQuality} options={[{ value: 'draft', label: 'Draft' }, { value: 'final', label: 'Final' }]} />
      {syncIssues.length > 0 ? (
        <Notice tone="warning" className="mt-4">
          <p className="text-fg">Lyric sync check: {syncIssues.length} caption{syncIssues.length === 1 ? '' : 's'} out of step with the vocals.</p>
          <ul className="mt-1 list-disc pl-4 text-xs">
            {syncIssues.slice(0, 5).map((i, k) => (
              <li key={k}>{i.message}</li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={onResync}>
              Resync lyrics to the vocals
            </Button>
            <Button size="sm" variant={acceptSync ? 'subtle' : 'ghost'} onClick={() => setAcceptSync((v) => !v)}>
              {acceptSync ? 'Will render anyway' : 'Render anyway'}
            </Button>
          </div>
        </Notice>
      ) : timeline.clips.some((c) => c.lyric) ? (
        <p className="mt-3 text-xs text-success">Lyric sync check passed — every caption starts with its vocal and clears before the next line.</p>
      ) : null}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(Object.values(EXPORT_PRESETS) as ExportPreset[]).map((p) => {
          const Icon = icons[p.id];
          const d = quality === 'final' ? p.final : p.draft;
          return (
            <button key={p.id} type="button" disabled={busy} onClick={() => void run(p.id)} className="card cursor-pointer p-4 text-left hover:border-accent/40 disabled:opacity-50">
              <Icon className="size-5 text-accent-2" />
              <p className="mt-2 text-sm text-fg">{p.label}</p>
              <p className="text-xs text-faint">
                {d.width}×{d.height}
              </p>
              {boot && <EstimateText className="mt-1" estimate={estimateRender({ durationSec: timelineDuration(timeline.clips), quality }, boot.pricing)} />}
            </button>
          );
        })}
      </div>
      <ul className="mt-5 space-y-2">
        {renders.data.map((r) => (
          <li key={r.id} className="rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-fg">{EXPORT_PRESETS[r.preset as ExportPreset['id']]?.label}</span>
              <Badge tone={r.quality === 'final' ? 'violet' : 'neutral'}>{r.quality}</Badge>
              <Badge tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'accent'}>{r.status}</Badge>
              <span className="text-xs text-faint">{r.stage}</span>
              {r.status === 'completed' && r.outputAssetId && (
                <div className="ml-auto flex gap-1.5">
                  <Button size="sm" variant={watching === r.id ? 'subtle' : 'ghost'} icon={<Play className="size-3.5" />} onClick={() => setWatching(watching === r.id ? null : r.id)}>
                    {watching === r.id ? 'Close' : 'Play'}
                  </Button>
                  <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => void downloadUrl(r.outputAssetId!).then((u) => u && window.open(u, '_blank', 'noopener'))}>
                    Download
                  </Button>
                </div>
              )}
            </div>
            {watching === r.id && r.outputAssetId && <VideoPlayer assetId={r.outputAssetId} autoPlay className="mt-3 rounded-lg" />}
            {!['completed', 'failed', 'cancelled'].includes(r.status) && <ProgressBar value={r.progress} className="mt-2" />}
            {r.error && <p className="mt-1 text-xs text-[#ff9b9b]">{r.error.message}</p>}
          </li>
        ))}
      </ul>
      {dialog}
    </Modal>
  );
}

function VersionsDialog({ projectId, timelineId, onRestore, onClose, state, version }: { projectId: string; timelineId: string; onRestore: (s: TimelineState) => void; onClose: () => void; state: TimelineState; version: number }) {
  const versions = useQuery<{ version: number; note: string; tracks: TimelineState['tracks']; clips: TimelineState['clips']; markers: TimelineState['markers']; createdAt?: { toMillis(): number } }>(() => query(collection(db, 'projects', projectId, 'timelines', timelineId, 'versions'), orderBy('createdAt', 'desc'), limit(50)), [projectId, timelineId]);
  const [note, setNote] = useState('');
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Timeline versions" size="md">
      <div className="mb-4 flex gap-2">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Describe this cut" aria-label="Version note" />
        <Button
          variant="primary"
          icon={<Save className="size-4" />}
          onClick={() =>
            void snapshotTimeline(projectId, timelineId, state, version, note || `Cut v${version}`).then(() => {
              setNote('');
              toast.success('Version saved');
            })
          }
        >
          Save version
        </Button>
      </div>
      {versions.data.length === 0 ? (
        <p className="text-sm text-faint">No saved versions.</p>
      ) : (
        <ul className="space-y-2">
          {versions.data.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5">
              <div>
                <p className="text-sm text-fg">{v.note}</p>
                <p className="text-xs text-faint">
                  {v.clips.length} clips · {formatTimecode(timelineDuration(v.clips), 0)} · {v.createdAt ? new Date(v.createdAt.toMillis()).toLocaleString() : ''}
                </p>
              </div>
              <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => onRestore({ ...state, tracks: v.tracks, clips: v.clips, markers: v.markers ?? [] })}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export default function TimelineEditor() {
  const { projectId = '', timelineId = '' } = useParams();
  const project = useProject(projectId);
  const remote = useDoc<TimelineDoc>(`projects/${projectId}/timelines/${timelineId}`);
  const [history, setHistory] = useState<History<TimelineState> | null>(null);
  const [draft, setDraft] = useState<TimelineState | null>(null);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pps, setPps] = useState(40);
  const [snapOn, setSnapOn] = useState(true);
  const [selection, setSelection] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState<'render' | 'versions' | null>(null);
  const [replacing, setReplacing] = useState(false);
  const songs = useSub<SongDoc>(projectId, 'songs', 'createdAt', 'asc');
  const sheets = Object.fromEntries(songs.data.map((s) => [s.id, s.lyricsSheet ?? null])) as Record<string, LyricsSheet | null>;
  const sheetsRef = useLatest(sheets);
  const baseVersion = useRef(0);
  const savedJson = useRef('');
  const lastEdit = useRef<{ label: string; at: number } | null>(null);

  useEffect(() => {
    if (remote.data && !history) {
      const s = pick(remote.data);
      setHistory(createHistory(s));
      baseVersion.current = remote.data.version ?? 0;
      savedJson.current = JSON.stringify(s);
      const dur = timelineDuration(s.clips);
      setPps(Math.max(8, Math.min(120, Math.floor((window.innerWidth - HEADER_W - 80) / Math.max(20, dur + 10)))));
    }
  }, [remote.data, history]);
  useEffect(() => {
    if (history && remote.data && (remote.data.version ?? 0) > baseVersion.current) setStatus('conflict');
  }, [remote.data, history]);

  const present = history?.present ?? null;
  const view = draft ?? present;

  const commit = useCallback((incoming: TimelineState, label: string) => {
    setHistory((h) => {
      if (!h) return h;
      // Lyric captions follow their song: moving, trimming or splitting the music re-times them.
      const next = songClipsChanged(h.present, incoming) ? resyncLyricCaptions(incoming, sheetsRef.current) : incoming;
      const now = Date.now();
      const coalesce = lastEdit.current && lastEdit.current.label === label && now - lastEdit.current.at < 900 && !/^(Move|Trim|Split|Delete|Add)/.test(label);
      lastEdit.current = { label, at: now };
      return coalesce ? { ...h, present: next } : pushHistory(h, next);
    });
    setStatus((s) => (s === 'conflict' ? s : 'dirty'));
  }, [sheetsRef]);

  const save = useCallback(
    async (state: TimelineState): Promise<boolean> => {
      const json = JSON.stringify(state);
      if (json === savedJson.current) return true;
      setStatus('saving');
      const v = baseVersion.current + 1;
      try {
        await saveTimeline(projectId, timelineId, state, v);
        baseVersion.current = v;
        savedJson.current = json;
        setStatus('saved');
        return true;
      } catch (e) {
        setStatus('dirty');
        toast.error('Autosave failed', { description: e instanceof Error ? e.message : String(e) });
        return false;
      }
    },
    [projectId, timelineId],
  );

  const debounced = useDebounced(present, 1500);
  useEffect(() => {
    if (debounced && status !== 'conflict') void save(debounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (status === 'dirty' || status === 'saving') e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [status]);

  const duration = view ? timelineDuration(view.clips) : 0;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setTime((t) => {
        const nt = t + dt;
        if (nt >= duration) {
          setPlaying(false);
          return duration;
        }
        return nt;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);

  const selected = view?.clips.find((c) => c.id === selection[selection.length - 1]) ?? null;
  const fps = view?.fps ?? 24;

  const doSplit = useCallback(() => {
    if (!present || !selected) return;
    const r = splitClip(present, selected.id, time);
    if (r.rightId) {
      commit(r.state, 'Split clip');
      setSelection([r.rightId]);
    }
  }, [present, selected, time, commit]);
  const doDelete = useCallback(() => {
    if (!present || !selection.length) return;
    commit(deleteClips(present, selection), 'Delete clips');
    setSelection([]);
  }, [present, selection, commit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        setHistory((h) => (h ? (e.shiftKey ? redo(h) : undo(h)) : h));
        setStatus('dirty');
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        setHistory((h) => (h ? redo(h) : h));
        setStatus('dirty');
      } else if (e.key === 's' && !mod) doSplit();
      else if (e.key === 'Delete' || e.key === 'Backspace') doDelete();
      else if (e.key === 'ArrowLeft') setTime((t) => Math.max(0, t - 1 / fps));
      else if (e.key === 'ArrowRight') setTime((t) => t + 1 / fps);
      else if (e.key === '=' || e.key === '+') setPps((p) => Math.min(400, p * 1.25));
      else if (e.key === '-') setPps((p) => Math.max(4, p / 1.25));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doSplit, doDelete, fps]);

  const addAsset = (a: DroppedAsset, trackId?: string, at?: number, append = false) => {
    if (!present) return;
    const want: TrackKind = a.kind === 'audio' ? 'audio' : 'video';
    const track = (trackId && present.tracks.find((t) => t.id === trackId && (t.kind === want || (want === 'video' && t.kind === 'overlay')))) || present.tracks.find((t) => t.kind === want);
    if (!track) return toast.error(`Add a ${want} track first.`);
    const dur = a.kind === 'image' ? 4 : Math.max(0.5, a.durationSec ?? 5);
    const start = append ? trackEnd(present, track.id) : (at ?? time);
    const clip = makeClip({ trackId: track.id, kind: a.kind === 'image' ? 'image' : a.kind, start, duration: dur, assetId: a.assetId, sourceDuration: a.kind === 'image' ? null : a.durationSec, label: a.title, useSourceAudio: a.kind === 'video' });
    try {
      commit(addClip(present, clip), 'Add clip');
      setSelection([clip.id]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const addText = (kind: 'caption' | 'title') => {
    if (!present) return;
    const track = present.tracks.find((t) => t.kind === (kind === 'caption' ? 'caption' : 'overlay'));
    if (!track) return;
    const clip = makeClip({ trackId: track.id, kind, start: time, duration: kind === 'title' ? 4 : 3, text: kind === 'title' ? 'Title' : 'Caption', label: kind === 'title' ? 'Title card' : 'Caption' });
    commit(addClip(present, clip), 'Add text');
    setSelection([clip.id]);
  };
  const captionClips = view ? view.clips.filter((c) => c.kind === 'caption' && !view.tracks.find((t) => t.id === c.trackId)?.muted).sort((a, b) => a.start - b.start) : [];
  const importCaptions = (text: string) => {
    if (!present) return;
    const cues = parseSubtitles(text);
    if (!cues.length) return toast.error('No captions found', { description: 'Use a SubRip (.srt) or WebVTT (.vtt) file.' });
    // Fill the first empty caption track, or add one, so existing captions are never disturbed.
    let state = present;
    let track = state.tracks.find((t) => t.kind === 'caption' && !clipsOnTrack(state, t.id).length);
    if (!track) {
      state = addTrack(state, 'caption');
      track = state.tracks.filter((t) => t.kind === 'caption').pop()!;
    }
    const clips = cues.map((c) => makeClip({ trackId: track.id, kind: 'caption', start: c.start, duration: Math.max(0.2, c.end - c.start), text: c.text, style: { ...DEFAULT_TEXT_STYLE }, position: DEFAULT_CAPTION_POSITION, label: 'Caption' }));
    commit(addClips(state, clips), 'Import captions');
    toast.success(`${clips.length} captions imported`, { description: `On ${track.name}.` });
  };
  const exportCaptions = () => {
    if (!captionClips.length) return;
    const srt = formatSrt(captionClips.map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text })));
    const url = URL.createObjectURL(new Blob([srt], { type: 'application/x-subrip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(remote.data?.name ?? 'captions').replace(/[^\w\- ]+/g, '').trim() || 'captions'}.srt`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const replaceMedia = (a: Asset) => {
    if (!present || !selected) return;
    const source = selected.kind === 'image' ? null : (a.durationSec ?? null);
    const duration = source !== null ? Math.min(selected.duration, source) : selected.duration;
    const inPoint = source !== null ? Math.min(selected.inPoint, Math.max(0, source - duration)) : 0;
    let next = updateClip(present, selected.id, { assetId: a.id, label: a.title, sourceDuration: source, inPoint, takeId: null });
    if (duration < selected.duration) next = setClipDuration(next, selected.id, duration);
    commit(next, 'Replace media');
    toast.success('Media replaced', { description: 'Timing, trims, transitions and levels were kept.' });
  };
  const onTiming = (patch: { start?: number; duration?: number; inPoint?: number }) => {
    if (!present || !selected) return;
    let s = present;
    if (patch.start !== undefined) s = moveClip(s, selected.id, Math.max(0, patch.start));
    if (patch.duration !== undefined) s = setClipDuration(s, selected.id, Math.max(0.1, patch.duration));
    if (patch.inPoint !== undefined) {
      const max = selected.sourceDuration !== null ? Math.max(0, selected.sourceDuration - selected.duration) : Infinity;
      s = updateClip(s, selected.id, { inPoint: Math.min(max, Math.max(0, patch.inPoint)) });
    }
    commit(s, 'Timing');
  };

  if (project.loading || remote.loading || (!history && remote.data)) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }
  if (remote.error) return <ErrorState className="m-8" error={remote.error} />;
  if (!remote.data || !view || !present) return <EmptyState className="m-8" title="Timeline not found" />;
  const problems = validateTimeline(view);

  return (
    <div className="flex h-dvh flex-col bg-obsidian">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-ink px-3 py-2">
        <Link to={project.data?.type === 'music_video' ? `/projects/${projectId}/music/edit` : project.data?.type === 'film' ? `/projects/${projectId}/film/assembly` : `/projects/${projectId}`} aria-label="Back to project">
          <IconButton label="Back to project">
            <ArrowLeft className="size-4" />
          </IconButton>
        </Link>
        <div className="min-w-0">
          <p className="truncate text-[11px] text-faint">{project.data?.title}</p>
          <Input defaultValue={remote.data.name} onBlur={(e) => e.target.value.trim() && e.target.value !== remote.data!.name && void updateSubDoc(projectId, 'timelines', timelineId, { name: e.target.value.trim() })} className="!border-transparent !bg-transparent !px-0 !py-0 text-sm font-medium" aria-label="Timeline name" />
        </div>
        <Badge tone={status === 'saved' ? 'success' : status === 'conflict' ? 'danger' : status === 'saving' ? 'accent' : 'warning'}>{status === 'saved' ? 'All changes saved' : status === 'saving' ? 'Saving…' : status === 'conflict' ? 'Changed elsewhere' : 'Unsaved'}</Badge>
        <Select value={String(view.fps)} onChange={(e) => commit({ ...present, fps: Number(e.target.value) as 24 | 25 | 30 }, 'Frame rate')} aria-label="Frame rate" className="!w-auto !py-1 text-xs">
          {[24, 25, 30].map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Undo (Ctrl+Z)" disabled={!history?.past.length} onClick={() => setHistory((h) => (h ? undo(h) : h))}>
            <Undo2 className="size-4" />
          </IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!history?.future.length} onClick={() => setHistory((h) => (h ? redo(h) : h))}>
            <Redo2 className="size-4" />
          </IconButton>
          {present.clips.some((c) => c.lyric) && (
            <Button size="sm" variant="ghost" icon={<CaptionsIcon className="size-4" />} onClick={() => { commit(resyncLyricCaptions(present, sheets), 'Resync lyrics'); toast.success('Lyrics resynchronised', { description: 'Captions follow the corrected lyrics and the song clip.' }); }}>
              Resync lyrics
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<HistoryIcon className="size-4" />} onClick={() => setDialogOpen('versions')}>
            Versions
          </Button>
          <Button size="sm" variant="primary" icon={<Clapperboard className="size-4" />} onClick={() => setDialogOpen('render')}>
            Render
          </Button>
        </div>
      </header>
      {status === 'conflict' && (
        <Notice tone="danger" className="m-2">
          This timeline was saved from another tab or device.{' '}
          <button type="button" className="cursor-pointer underline" onClick={() => { setHistory(createHistory(pick(remote.data!))); baseVersion.current = remote.data!.version; savedJson.current = JSON.stringify(pick(remote.data!)); setStatus('saved'); }}>
            Load the latest
          </button>{' '}
          or{' '}
          <button type="button" className="cursor-pointer underline" onClick={() => { baseVersion.current = remote.data!.version; setStatus('dirty'); void save(present); }}>
            keep mine and overwrite
          </button>
          .
        </Notice>
      )}
      <div className="lg:hidden">
        <Notice tone="neutral" className="m-2 text-xs">The timeline editor is optimised for desktop. Playback, trimming and the inspector work on mobile, with less room.</Notice>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 max-lg:overflow-y-auto lg:grid-cols-[260px_minmax(0,1fr)_320px]">
        <aside className="hidden min-h-0 border-r border-line lg:block">
          <MediaBin projectId={projectId} onAdd={(a, append) => addAsset(a, undefined, undefined, append)} onAddText={addText} onImportCaptions={importCaptions} onExportCaptions={exportCaptions} captionCount={captionClips.length} />
        </aside>
        <section className="flex min-h-0 flex-col items-center justify-center gap-3 p-4 max-lg:justify-start">
          <Preview state={view} time={time} playing={playing} className="max-h-[46vh] w-full max-w-[min(100%,calc(46vh*1.78))]" />
          <div className="flex items-center gap-2">
            <IconButton label="Go to start" onClick={() => setTime(0)}>
              <SkipBack className="size-4" />
            </IconButton>
            <Button variant="primary" size="sm" onClick={() => setPlaying((p) => !p)} icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? 'Pause' : 'Play'}
            </Button>
            <IconButton label="Go to end" onClick={() => setTime(duration)}>
              <SkipForward className="size-4" />
            </IconButton>
            <span className="timecode ml-2 text-sm text-dim">
              {formatTimecode(time, 2)} / {formatTimecode(duration, 2)}
            </span>
          </div>
          {problems.length > 0 && <p className="text-xs text-warning">{problems[0]}</p>}
        </section>
        <aside className="min-h-0 overflow-y-auto border-l border-line">
          <Inspector state={view} clip={selected} time={time} onChange={(patch, label) => selected && present && commit(updateClip(present, selected.id, patch), label)} onTiming={onTiming} onSplit={doSplit} onDelete={doDelete} onReplace={() => setReplacing(true)} />
        </aside>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line bg-ink px-3 py-1.5">
        <Tip label="Snap to clips, beats and playhead">
          <Button size="sm" variant={snapOn ? 'subtle' : 'ghost'} onClick={() => setSnapOn((v) => !v)} icon={<Magnet className="size-3.5" />}>
            Snap
          </Button>
        </Tip>
        <IconButton size="sm" label="Zoom out (-)" onClick={() => setPps((p) => Math.max(4, p / 1.25))}>
          <ZoomOut className="size-4" />
        </IconButton>
        <IconButton size="sm" label="Zoom in (+)" onClick={() => setPps((p) => Math.min(400, p * 1.25))}>
          <ZoomIn className="size-4" />
        </IconButton>
        <span className="mx-2 h-4 w-px bg-line" />
        {(['video', 'overlay', 'caption', 'audio'] as TrackKind[]).map((k) => (
          <Button key={k} size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => commit(addTrack(present, k), 'Add track')}>
            {k}
          </Button>
        ))}
        <span className="ml-auto hidden text-[11px] text-faint md:inline">
          {view.clips.length} clips · {view.tracks.map((t) => `${t.name.split(' ')[0]}:${clipsOnTrack(view, t.id).length}`).join(' ')}
        </span>
      </div>
      <div className="h-[36vh] min-h-56 overflow-auto border-t border-line bg-panel">
        <TimelineLanes
          state={view}
          pxPerSec={pps}
          time={time}
          selection={selection}
          snapOn={snapOn}
          onSelect={(id, additive) => setSelection((s) => (id === null ? [] : additive ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]))}
          onSeek={(t) => {
            setPlaying(false);
            setTime(t);
          }}
          onDraft={setDraft}
          onCommit={commit}
          onDropAsset={(a, trackId, t) => addAsset(a, trackId, t)}
        />
      </div>

      {replacing && selected && (
        <AssetPicker open onOpenChange={(o) => !o && setReplacing(false)} kinds={[selected.kind === 'audio' ? 'audio' : selected.kind === 'image' ? 'image' : 'video']} projectId={projectId} onPick={(a) => a[0] && replaceMedia(a[0])} title="Replace media" />
      )}
      {dialogOpen === 'render' && <RenderDialog projectId={projectId} timeline={{ ...remote.data, ...present }} sheets={sheets} onResync={() => commit(resyncLyricCaptions(present, sheets), 'Resync lyrics')} onClose={() => setDialogOpen(null)} ensureSaved={() => save(present)} />}
      {dialogOpen === 'versions' && (
        <VersionsDialog
          projectId={projectId}
          timelineId={timelineId}
          state={present}
          version={baseVersion.current}
          onClose={() => setDialogOpen(null)}
          onRestore={(s) => {
            commit(s, 'Restore version');
            setDialogOpen(null);
            toast.success('Version restored');
          }}
        />
      )}
    </div>
  );
}

