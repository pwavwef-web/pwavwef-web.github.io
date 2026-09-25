import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AudioLines, Crown, Download, Film, Mic, Music2, Plus, Send, Square, Upload } from 'lucide-react';
import {
  defaultMixTrack,
  DEFAULT_MIX,
  EMPTY_BRIEF,
  formatTimecode,
  relativeTime,
  sheetText,
  toLrc,
  toMillis,
  toSrt,
  toVtt,
  VERSION_SOURCE_LABELS,
  type MusicProjectDoc,
  type ProjectDoc,
  type SongDoc,
} from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { musicAddVersion, musicSetMaster, musicToVideo, saveContinuity, useProjectCollection } from '../../lib/continuity';
import { useDoc, type WithId } from '../../lib/data';
import { openDownload, uploadFile } from '../../lib/media';
import { useProjects } from '../../lib/studio';
import { useJobSubmitter } from '../jobs';
import { UploadZone } from '../media';
import { Badge, Button, Card, cx, EmptyState, Field, Input, Notice, Select, Toggle } from '../ui';
import type { MusicProject, MusicVersion } from './create';
import { TransportBar, useAudioTransport } from './transport';

type StemsDoc = { sourceAssetId: string; musicProjectId: string | null; versionId: string | null; modelId: string; stems: Record<string, string>; seconds: number | null; createdAt?: unknown };

function download(name: string, text: string, type: string) {
  const blob = new Blob([String.fromCharCode(0xfeff) + text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function SendToVideo({ project, mp, version }: { project: WithId<ProjectDoc>; mp: MusicProject; version: MusicVersion }) {
  const videos = useProjects({ type: 'music_video' });
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await musicToVideo(project.id, mp.id, version.id, target);
      toast.success('Sent to the music video', { description: r.note });
    } catch (e) {
      toast.error('Could not send', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex items-center gap-1.5">
      <Select className="h-8 w-44 text-xs" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Music-video project">
        <option value="">Music video…</option>
        {videos.data.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </Select>
      <Button size="sm" variant="ghost" loading={busy} disabled={!target} icon={<Send className="size-3.5" />} onClick={() => void send()}>
        Send
      </Button>
    </span>
  );
}

/**
 * Versions: every generated, uploaded, recorded, arranged, replaced and mixed version with how it was
 * made; audition, A/B, set the master, analyse, separate stems, add to the mix, export or send to a
 * music video.
 */
export function VersionsPanel({ project, mp, versions }: { project: WithId<ProjectDoc>; mp: MusicProject; versions: MusicVersion[] }) {
  const stems = useProjectCollection<StemsDoc>(project.id, 'stems', { where: [['musicProjectId', '==', mp.id]], order: 'createdAt', dir: 'desc' });
  const [a, setA] = useState<string | null>(mp.masterVersionId ?? versions[0]?.id ?? null);
  const [b, setB] = useState<string | null>(versions.find((v) => v.id !== a)?.id ?? null);
  const [side, setSide] = useState<'a' | 'b'>('a');
  const va = versions.find((v) => v.id === a) ?? null;
  const vb = versions.find((v) => v.id === b) ?? null;
  const ta = useAudioTransport(va?.assetId ?? null);
  const tb = useAudioTransport(vb?.assetId ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const { submit, busy: submitting, dialog } = useJobSubmitter();
  const flip = () => {
    const [from, to] = side === 'a' ? [ta, tb] : [tb, ta];
    const at = from.time;
    const wasPlaying = from.playing;
    from.transport.pause();
    to.seek(at);
    if (wasPlaying) to.toggle();
    setSide(side === 'a' ? 'b' : 'a');
  };
  const setMaster = async (id: string) => {
    setBusy(`master-${id}`);
    try {
      await musicSetMaster(project.id, mp.id, id);
      toast.success('Master version set', { description: 'Exports, lyric sync and music videos use it.' });
    } catch (e) {
      toast.error('Could not set the master', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const addToMix = async (v: MusicVersion) => {
    setBusy(`mix-${v.id}`);
    try {
      const { id: _id, ...fields } = defaultMixTrack('new', `v${v.index} ${v.label}`.slice(0, 80), v.assetId, 'version', 'music');
      void _id;
      await saveContinuity(project.id, 'audioTracks', { ...fields, musicProjectId: mp.id, order: 0 });
      toast.success('Added to the mix');
    } catch (e) {
      toast.error('Could not add to the mix', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  if (!versions.length) return <EmptyState icon={<Music2 className="size-5" />} title="No versions yet" body="Every generation, upload, recording, arrangement, replacement and mixdown becomes a numbered version here." />;
  return (
    <div className="space-y-4">
      <Card className="space-y-2 p-3">
        <p className="eyebrow">A/B compare</p>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {([['a', a, setA, ta], ['b', b, setB, tb]] as const).map(([k, val, setVal, tr]) => (
            <div key={k} className={cx('space-y-1.5 rounded-lg border p-2', side === k ? 'border-accent/50' : 'border-line')}>
              <Select className="h-8 text-xs" value={val ?? ''} onChange={(e) => setVal(e.target.value)} aria-label={`Version ${k.toUpperCase()}`}>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {k.toUpperCase()}: v{v.index} · {v.label}
                  </option>
                ))}
              </Select>
              <TransportBar t={tr} duration={versions.find((v) => v.id === val)?.durationSec ?? 0} />
            </div>
          ))}
        </div>
        <Button size="sm" variant="subtle" disabled={!va || !vb} onClick={flip}>
          Switch to {side === 'a' ? 'B' : 'A'} at the same moment
        </Button>
      </Card>
      <ul className="space-y-2">
        {versions.map((v) => {
          const hot = v.loudness?.truePeakDb !== null && v.loudness?.truePeakDb !== undefined && v.loudness.truePeakDb > -1;
          return (
            <li key={v.id} className={cx('space-y-1.5 rounded-xl border p-3', v.id === mp.masterVersionId ? 'border-success/40' : 'border-line')}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-fg">
                  v{v.index} · {v.label}
                </span>
                <Badge tone={v.source === 'lyria' || v.source === 'replacement' ? 'violet' : 'neutral'}>{VERSION_SOURCE_LABELS[v.source]}</Badge>
                {v.id === mp.masterVersionId && (
                  <Badge tone="success" icon={<Crown className="size-3" />}>
                    Master
                  </Badge>
                )}
                <span className="text-xs text-faint">
                  {v.durationSec ? formatTimecode(v.durationSec) : ''} · {relativeTime(toMillis(v.createdAt))}
                  {v.analysis ? ` · ${Math.round(v.analysis.bpm)} BPM · ${v.analysis.key}` : ''}
                </span>
                {v.loudness && (
                  <span className={cx('text-xs', hot ? 'text-warning' : 'text-dim')}>
                    {v.loudness.integratedLufs?.toFixed(1) ?? '—'} LUFS · TP {v.loudness.truePeakDb?.toFixed(1) ?? '—'}
                  </span>
                )}
              </div>
              <p className="text-xs text-dim">{v.method}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {v.id !== mp.masterVersionId && (
                  <Button size="sm" variant="ghost" loading={busy === `master-${v.id}`} icon={<Crown className="size-3.5" />} onClick={() => void setMaster(v.id)}>
                    Make master
                  </Button>
                )}
                {!v.analysis && (
                  <Button size="sm" variant="ghost" loading={submitting} onClick={() => void submit([{ type: 'music.analyze', projectId: project.id, audioAssetId: v.assetId, musicProjectId: mp.id, versionId: v.id, detectVocals: true, label: `Analyse v${v.index}` }], { label: 'Music analysis' })}>
                    Analyse
                  </Button>
                )}
                <Button size="sm" variant="ghost" loading={submitting} icon={<AudioLines className="size-3.5" />} onClick={() => void submit([{ type: 'audio.stems', projectId: project.id, audioAssetId: v.assetId, musicProjectId: mp.id, versionId: v.id, label: `Stems of v${v.index}` }], { label: 'Stem separation', alwaysConfirm: true })}>
                  Separate stems
                </Button>
                <Button size="sm" variant="ghost" loading={busy === `mix-${v.id}`} icon={<Plus className="size-3.5" />} onClick={() => void addToMix(v)}>
                  Add to mix
                </Button>
                <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void openDownload(v.assetId)}>
                  Download
                </Button>
                <SendToVideo project={project} mp={mp} version={v} />
              </div>
            </li>
          );
        })}
      </ul>
      {stems.data.length > 0 && (
        <Card className="space-y-2 p-3">
          <p className="eyebrow">Separated stems</p>
          {stems.data.map((s) => (
            <div key={s.id} className="space-y-1 text-xs">
              <p className="text-dim">
                {versions.find((v) => v.id === s.versionId) ? `From v${versions.find((v) => v.id === s.versionId)!.index}` : 'From an upload'} · {s.modelId}
                {s.seconds ? ` · ${Math.round(s.seconds / 60)} min on Cloud Run` : ''} — each stem is also a mixer track.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(s.stems).map(([name, assetId]) => (
                  <Button key={name} size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void openDownload(assetId)}>
                    {name}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </Card>
      )}
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Record or upload
// ---------------------------------------------------------------------------

function useRecorder() {
  const [state, setState] = useState<'idle' | 'recording' | 'done'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const raf = useRef(0);
  const started = useRef(0);
  const cleanup = () => {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    void ctx.current?.close();
    stream.current = null;
    ctx.current = null;
  };
  useEffect(() => cleanup, []);
  const start = async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    stream.current = s;
    const ac = new AudioContext();
    ctx.current = ac;
    const an = ac.createAnalyser();
    an.fftSize = 2048;
    ac.createMediaStreamSource(s).connect(an);
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      setLevel(peak);
      setElapsed((performance.now() - started.current) / 1000);
      raf.current = requestAnimationFrame(tick);
    };
    const chunks: Blob[] = [];
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const r = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      setBlob(new Blob(chunks, { type: (r.mimeType || 'audio/webm').split(';')[0] }));
      setState('done');
      cleanup();
    };
    rec.current = r;
    started.current = performance.now();
    r.start(1000);
    setState('recording');
    raf.current = requestAnimationFrame(tick);
  };
  const stop = () => rec.current?.state === 'recording' && rec.current.stop();
  const reset = () => {
    setBlob(null);
    setElapsed(0);
    setLevel(0);
    setState('idle');
  };
  return { state, elapsed, level, blob, start, stop, reset };
}

export function RecordPanel({ project, mp, versions }: { project: WithId<ProjectDoc>; mp: MusicProject; versions: MusicVersion[] }) {
  const master = versions.find((v) => v.id === mp.masterVersionId) ?? versions[0] ?? null;
  const backing = useAudioTransport(master?.assetId ?? null);
  const r = useRecorder();
  const [playAlong, setPlayAlong] = useState(Boolean(master));
  const [name, setName] = useState('Vocal take');
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const { submit, dialog } = useJobSubmitter();
  useEffect(() => {
    if (!r.blob) return;
    const url = URL.createObjectURL(r.blob);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [r.blob]);
  const start = async () => {
    try {
      await r.start();
      if (playAlong && master) {
        backing.seek(0);
        backing.toggle();
      }
    } catch (e) {
      toast.error('The microphone is not available', { description: errorMessage(e) });
    }
  };
  const stop = () => {
    r.stop();
    if (backing.playing) backing.transport.pause();
  };
  const upload = async (): Promise<string | null> => {
    if (!r.blob) return null;
    const ext = r.blob.type.includes('ogg') ? 'ogg' : 'webm';
    const file = new File([r.blob], `${name.replace(/[^\w -]+/g, '').trim() || 'recording'}-${Date.now()}.${ext}`, { type: r.blob.type || 'audio/webm' });
    return uploadFile(file, { kind: 'audio', projectId: project.id, collections: ['recordings'], title: name });
  };
  const saveVersion = async () => {
    setBusy('version');
    try {
      const id = await upload();
      if (!id) return;
      const res = await musicAddVersion(project.id, mp.id, id, 'recording', name);
      await submit([{ type: 'music.analyze', projectId: project.id, audioAssetId: id, musicProjectId: mp.id, versionId: res.versionId, detectVocals: true, label: `Analyse ${name}` }], { label: 'Music analysis' });
      r.reset();
    } catch (e) {
      toast.error('Could not save the recording', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const saveTrack = async () => {
    setBusy('track');
    try {
      const id = await upload();
      if (!id) return;
      const { id: _id, ...fields } = defaultMixTrack('new', name.slice(0, 80) || 'Recording', id, 'recording', 'vocal');
      void _id;
      await saveContinuity(project.id, 'audioTracks', { ...fields, musicProjectId: mp.id, order: 50 });
      toast.success('Recording added to the mix', { description: playAlong && master ? `It starts with “${master.label}” (offset 0 s); adjust the offset in Mix if you hear latency.` : undefined });
      r.reset();
    } catch (e) {
      toast.error('Could not save the recording', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const uploaded = async (ids: string[]) => {
    for (const id of ids) {
      try {
        const res = await musicAddVersion(project.id, mp.id, id, 'upload');
        await submit([{ type: 'music.analyze', projectId: project.id, audioAssetId: id, musicProjectId: mp.id, versionId: res.versionId, detectVocals: true, label: 'Analyse uploaded music' }], { label: 'Music analysis' });
      } catch (e) {
        toast.error('Could not add the upload', { description: errorMessage(e) });
      }
    }
  };
  const meter = Math.min(1, r.level);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card className="space-y-3 p-4">
        <p className="eyebrow flex items-center gap-1.5">
          <Mic className="size-3.5" /> Record
        </p>
        <Field label="Take name">
          <Input value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} />
        </Field>
        {master && <Toggle checked={playAlong} onChange={setPlayAlong} label={`Play “${master.label}” while recording`} description="Use headphones so the backing track is not recorded." />}
        <div className="h-2 overflow-hidden rounded-full bg-white/5" aria-label="Input level">
          <div className={cx('h-full transition-[width]', meter > 0.95 ? 'bg-danger' : meter > 0.7 ? 'bg-warning' : 'bg-success')} style={{ width: `${meter * 100}%` }} />
        </div>
        <div className="flex items-center gap-2">
          {r.state === 'recording' ? (
            <Button variant="danger" icon={<Square className="size-4" />} onClick={stop}>
              Stop · {formatTimecode(r.elapsed)}
            </Button>
          ) : (
            <Button variant="primary" icon={<Mic className="size-4" />} onClick={() => void start()} disabled={r.state === 'done'}>
              Record
            </Button>
          )}
          {r.level > 0.95 && r.state === 'recording' && <span className="text-xs text-danger">Clipping — move back from the microphone</span>}
        </div>
        {backing.element}
        {r.state === 'done' && preview && (
          <div className="space-y-2 border-t border-line pt-3">
            <audio src={preview} controls className="w-full" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" loading={busy === 'version'} onClick={() => void saveVersion()}>
                Save as a version
              </Button>
              <Button size="sm" variant="subtle" loading={busy === 'track'} onClick={() => void saveTrack()}>
                Add to the mix
              </Button>
              <Button size="sm" variant="ghost" onClick={r.reset}>
                Discard
              </Button>
            </div>
          </div>
        )}
      </Card>
      <Card className="space-y-3 p-4">
        <p className="eyebrow flex items-center gap-1.5">
          <Upload className="size-3.5" /> Upload
        </p>
        <UploadZone accept="audio/*" kind="audio" projectId={project.id} collections={['music']} label="Upload music or vocals" hint="Each file becomes a version and is analysed (tempo, key, bars, sections, energy, vocals, edit points)." onUploaded={(ids) => void uploaded(ids)} />
      </Card>
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score cues
// ---------------------------------------------------------------------------

/**
 * Score: instrumental cues, each its own brief and versions (so a cue's length and direction never
 * overwrite the song's). Whole films are scored in the film project (Score Director with a cue sheet and
 * a musical bible).
 */
export function ScorePanel({ project, cues, onOpen }: { project: WithId<ProjectDoc>; cues: WithId<MusicProjectDoc>[]; onOpen: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async (mode: 'film_score' | 'scene_background') => {
    setBusy(true);
    try {
      const r = await saveContinuity(project.id, 'musicProjects', { mode, brief: { ...EMPTY_BRIEF, title: title.trim() || (mode === 'film_score' ? 'Score cue' : 'Scene background'), vocals: 'none', durationSec: 60, verseCount: 0, chorusCount: 0, bridge: false, outro: true }, lyricsText: '', lyricsSheetId: null, songId: null, masterVersionId: null, sections: [], markers: [], mix: DEFAULT_MIX });
      setTitle('');
      onOpen(r.id);
    } catch (e) {
      toast.error('Could not create the cue', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <Notice icon={<Film className="size-4" />}>Scoring a whole film? Open the film project → Finish → Score: the Score Director analyses the screenplay into a cue sheet and a musical bible and composes connected movements with crossfades, ducking and intentional silence.</Notice>
      <Card className="flex flex-wrap items-end gap-2 p-3">
        <Field label="New cue" className="min-w-56 flex-1">
          <Input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 160))} placeholder="e.g. Dawn at the market" />
        </Field>
        <Button variant="primary" loading={busy} onClick={() => void create('film_score')}>
          Film score cue
        </Button>
        <Button variant="ghost" loading={busy} onClick={() => void create('scene_background')}>
          Scene background
        </Button>
      </Card>
      {cues.length === 0 ? (
        <p className="text-sm text-faint">No cues yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {cues.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
              <span className="text-fg">{c.brief.title || 'Cue'}</span>
              <Badge>{c.mode === 'film_score' ? 'Film score' : 'Scene background'}</Badge>
              <span className="text-xs text-faint">{formatTimecode(c.brief.durationSec)}</span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onOpen(c.id)}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function ExportPanel({ project, mp, versions }: { project: WithId<ProjectDoc>; mp: MusicProject; versions: MusicVersion[] }) {
  const master = versions.find((v) => v.id === mp.masterVersionId) ?? null;
  const song = useDoc<SongDoc>(mp.songId ? `projects/${project.id}/songs/${mp.songId}` : null);
  const t = useAudioTransport(master?.assetId ?? null);
  const sheet = song.data?.lyricsSheet ?? null;
  const timed = Boolean(sheet?.lines.some((l) => l.start !== null)) && song.data?.audioAssetId === master?.assetId;
  const base = (mp.brief.title || project.title).replace(/[^\p{L}\p{N}\- _]+/gu, '').trim() || 'song';
  if (!master) return <EmptyState icon={<Download className="size-5" />} title="No master version yet" body="Choose the master under Versions — it is what you export and send to music videos." />;
  const hot = master.loudness?.truePeakDb !== null && master.loudness?.truePeakDb !== undefined && master.loudness.truePeakDb > -1;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card className="space-y-3 p-4">
        <p className="eyebrow">Master</p>
        <p className="text-sm text-fg">
          v{master.index} · {master.label} <Badge className="ml-1">{VERSION_SOURCE_LABELS[master.source]}</Badge>
        </p>
        <TransportBar t={t} duration={master.durationSec ?? 0} />
        {master.loudness ? (
          <p className={cx('text-xs', hot ? 'text-warning' : 'text-dim')}>
            {master.loudness.integratedLufs?.toFixed(1) ?? '—'} LUFS integrated · true peak {master.loudness.truePeakDb?.toFixed(1) ?? '—'} dBTP{hot ? ' — above −1 dBTP; render a mixdown with the limiter on' : ''}
          </p>
        ) : (
          <p className="text-xs text-faint">Loudness is measured when the version is analysed or mixed.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<Download className="size-4" />} onClick={() => void openDownload(master.assetId)}>
            Download audio
          </Button>
          <SendToVideo project={project} mp={mp} version={master} />
        </div>
      </Card>
      <Card className="space-y-3 p-4">
        <p className="eyebrow">Lyrics</p>
        {!sheet ? (
          <p className="text-xs text-faint">No lyric sheet yet (Lyrics).</p>
        ) : (
          <>
            {!timed && <Notice tone="warning">The lyric timing does not follow the master version; timed formats are disabled until it does (Lyrics → Follow the master).</Notice>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => download(`${base}.txt`, sheetText(sheet), 'text/plain')}>
                Text (.txt)
              </Button>
              <Button size="sm" variant="ghost" disabled={!timed} onClick={() => download(`${base}.lrc`, toLrc(sheet), 'text/plain')}>
                LRC
              </Button>
              <Button size="sm" variant="ghost" disabled={!timed} onClick={() => download(`${base}.srt`, toSrt(sheet), 'application/x-subrip')}>
                SRT
              </Button>
              <Button size="sm" variant="ghost" disabled={!timed} onClick={() => download(`${base}.vtt`, toVtt(sheet), 'text/vtt')}>
                WebVTT
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
