import { useEffect, useMemo, useRef, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { ArrowRight, Check, CircleAlert, Library, Mic, Pause, Play, RefreshCw, ShieldCheck, Trash2, Upload, Wand2 } from 'lucide-react';
import {
  AD_ASSET_ROLE_LABELS,
  AD_ASSET_ROLES,
  AD_FONTS,
  formatTimecode,
  LYRIC_LANGUAGES,
  type AdAssetRole,
  type AdSpec,
  type AssetDoc,
  type AssetKind,
  type JobDoc,
  type LyricSheetLine,
  type SongDoc,
} from '@az-studio/shared';
import { db } from '../../lib/firebase';
import { useDoc, type WithId } from '../../lib/data';
import { approveTranscript, attachAudio, saveTranscriptEdit, useNarration } from '../../lib/ads';
import { useMediaUrls } from '../../lib/media';
import { useBoot } from '../../lib/session';
import { useJobSubmitter } from '../../components/jobs';
import { JobErrorPanel } from '../../components/job-recovery';
import { acceptFor, AssetPicker, AssetThumb, UploadZone, useAsset, useWaveform, Waveform, type Asset } from '../../components/media';
import { Badge, Button, Card, cx, EmptyState, Field, IconButton, Input, Notice, ProgressBar, Segmented, Select, Textarea } from '../../components/ui';
import type { StepProps } from './AdStudio';

// ---------------------------------------------------------------------------
// One audio element shared by the soundtrack player and the transcript lines
// ---------------------------------------------------------------------------

function useTransport(src: string | undefined) {
  const ref = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [measured, setMeasured] = useState<number | null>(null);
  const stopAt = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = ref.current;
      if (a) {
        setTime(a.currentTime);
        if (stopAt.current !== null && a.currentTime >= stopAt.current) {
          a.pause();
          stopAt.current = null;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  const element = src ? (
    <audio ref={ref} src={src} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onLoadedMetadata={(e) => setMeasured(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)} />
  ) : null;
  return {
    element,
    time,
    playing,
    measured,
    toggle: () => (ref.current?.paused ? void ref.current.play() : ref.current?.pause()),
    seek: (t: number) => {
      if (ref.current) ref.current.currentTime = t;
      setTime(t);
    },
    playRange: (start: number, end: number) => {
      const a = ref.current;
      if (!a) return;
      a.currentTime = Math.max(0, start - 0.05);
      stopAt.current = end + 0.1;
      void a.play();
    },
  };
}
type Transport = ReturnType<typeof useTransport>;

// ---------------------------------------------------------------------------
// Soundtrack
// ---------------------------------------------------------------------------

function SoundtrackCard({ project, ad, update, transport }: Pick<StepProps, 'project' | 'ad' | 'update'> & { transport: Transport }) {
  const asset = useAsset(ad.audio.assetId);
  const peaks = useWaveform(ad.audio.assetId);
  const [picker, setPicker] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const attach = async (assetId: string) => {
    const snap = await getDoc(doc(db, 'assets', assetId));
    const a = { ...(snap.data() as AssetDoc), id: snap.id };
    if (a.kind !== 'audio') return toast.error('Choose an audio file.');
    const patch = await attachAudio(project.id, a, ad);
    update(patch);
    setReplacing(false);
    toast.success('Soundtrack attached', { description: a.durationSec ? `Measured length ${a.durationSec.toFixed(2)} s — the advert’s timeline authority.` : 'Measuring its length…' });
  };
  // The server's measurement (ffprobe) is the authority; keep the draft in step with it.
  const serverDur = asset.data?.status === 'ready' ? asset.data.durationSec ?? null : null;
  useEffect(() => {
    if (serverDur && Math.abs((ad.audio.durationSec ?? 0) - serverDur) > 0.0005) update((a) => ({ ...a, audio: { ...a.audio, durationSec: serverDur } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDur]);

  if (!ad.audio.assetId || replacing) {
    return (
      <Card className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="eyebrow">{ad.mode === 'audio_first' ? 'Approved narration or soundtrack' : 'Voice-over or soundtrack'}</p>
          {replacing && (
            <Button size="sm" variant="ghost" onClick={() => setReplacing(false)}>
              Keep the current audio
            </Button>
          )}
        </div>
        <UploadZone accept="audio/*,.mp3,.wav,.m4a,.flac,.aac,.ogg" kind="audio" projectId={project.id} collections={['ad:soundtrack']} multiple={false} onUploaded={(ids) => ids[0] && void attach(ids[0])} label="Upload the audio file" hint="MP3, WAV, M4A, FLAC… It is stored as uploaded, measured on the server, and never re-timed, regenerated or cut." />
        <Button variant="ghost" icon={<Library className="size-4" />} onClick={() => setPicker(true)}>
          Choose from the library
        </Button>
        {ad.mode === 'brief_first' && <VoiceoverGenerator project={project} ad={ad} onReady={(id) => void attach(id)} />}
        <AssetPicker open={picker} onOpenChange={setPicker} kinds={['audio']} projectId={project.id} onPick={(a) => a[0] && void attach(a[0].id)} title="Choose the soundtrack" />
      </Card>
    );
  }
  const a = asset.data;
  const dur = ad.audio.durationSec ?? a?.durationSec ?? 0;
  const mismatch = transport.measured && dur && Math.abs(transport.measured - dur) > 0.15;
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <IconButton label={transport.playing ? 'Pause' : 'Play'} onClick={transport.toggle} disabled={!a || a.status !== 'ready'}>
            {transport.playing ? <Pause className="size-5" /> : <Play className="size-5" />}
          </IconButton>
          <div className="min-w-0">
            <p className="truncate text-sm text-fg">{a?.fileName ?? ad.audio.fileName}</p>
            <p className="timecode text-xs text-faint">
              {formatTimecode(transport.time)} / {formatTimecode(dur)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {a?.status === 'ready' ? (
            <Badge tone="success" icon={<ShieldCheck className="size-3" />}>
              Measured {dur.toFixed(3)} s · timeline authority
            </Badge>
          ) : a?.status === 'rejected' ? (
            <Badge tone="danger">Rejected</Badge>
          ) : (
            <Badge>Measuring…</Badge>
          )}
          <Badge tone="violet">Preserved — never re-timed or cut</Badge>
          <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} onClick={() => setReplacing(true)}>
            Replace
          </Button>
        </div>
      </div>
      {transport.element}
      <Waveform peaks={peaks} duration={dur || peaks?.durationSec || 1} playhead={transport.time} height={96} onSeek={transport.seek} />
      {a?.rejection && <Notice tone="danger">{a.rejection.reason}</Notice>}
      {mismatch ? <Notice tone="warning">The browser reports {transport.measured!.toFixed(2)} s for this file; the server’s measurement ({dur.toFixed(3)} s, from the file itself) is used as the authority.</Notice> : null}
      <p className="text-xs text-faint">
        {a ? `${a.mimeType} · ${(a.sizeBytes / 1048576).toFixed(2)} MB` : ''} · The final render passes this audio through unchanged (no loudness normalisation, no added music).
      </p>
    </Card>
  );
}

/** Brief-first: a guide voice-over spoken from the script (Gemini TTS), joined into one file. */
function VoiceoverGenerator({ project, ad, onReady }: { project: StepProps['project']; ad: AdSpec; onReady: (assetId: string) => void }) {
  const boot = useBoot();
  const voices = boot?.capabilities.speech.voices ?? [];
  const [voice, setVoice] = useState(voices[0] ?? 'Kore');
  const { submit, busy, dialog } = useJobSubmitter();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useDoc<JobDoc>(jobId ? `jobs/${jobId}` : null);
  const lines = ad.audio.referenceScript.split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);
  const done = job.data?.status === 'completed' ? (job.data.result?.data?.voiceoverAssetId as string | undefined) : undefined;
  useEffect(() => {
    if (done) onReady(done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  const run = async () => {
    const ids = await submit([{ type: 'speech.generate', projectId: project.id, lines: lines.slice(0, 40).map((text, index) => ({ index, character: 'Narrator', text, voice, direction: ad.brief.tone ? `Read warmly and naturally (${ad.brief.tone})` : 'Read warmly and naturally' })), voiceover: true, label: 'Guide voice-over' }], { label: 'Guide voice-over' });
    if (ids?.[0]) setJobId(ids[0]);
  };
  return (
    <div className="space-y-2 rounded-xl border border-line p-3.5">
      <p className="flex items-center gap-1.5 text-sm text-fg">
        <Mic className="size-4 text-accent-2" /> Guide voice-over from the script
      </p>
      <p className="text-xs text-faint">A synthetic voice reads the script so timing and captions can be planned; replace it with a recorded voice-over before publishing.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Voice" className="w-40">
          <Select value={voice} onChange={(e) => setVoice(e.target.value)}>
            {voices.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="subtle" loading={busy || (job.data ? !['completed', 'failed', 'cancelled'].includes(job.data.status) : false)} disabled={!lines.length} onClick={() => void run()} icon={<Wand2 className="size-4" />}>
          Generate voice-over ({lines.length} lines)
        </Button>
      </div>
      {job.data && job.data.status !== 'completed' && job.data.status !== 'failed' && <ProgressBar value={job.data.progress} label="Voice-over progress" />}
      {job.data?.status === 'failed' && <JobErrorPanel job={job.data} compact onRetried={setJobId} />}
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function TranscriptLine({ line, onSave, onPlay, active }: { line: LyricSheetLine; onSave: (text: string) => Promise<void>; onPlay: () => void; active: boolean }) {
  const [text, setText] = useState(line.text);
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(line.text), [line.text]);
  const commit = async () => {
    if (text.trim() === line.text || !text.trim()) return setText(line.text);
    setSaving(true);
    try {
      await onSave(text.trim());
    } finally {
      setSaving(false);
    }
  };
  const flagged = line.flags.includes('low_confidence') || line.flags.includes('uncertain_words');
  return (
    <li className={cx('grid grid-cols-[32px_92px_minmax(0,1fr)] items-center gap-2 rounded-lg px-1.5 py-1', active && 'bg-accent/10')}>
      <IconButton label="Play this line" size="sm" onClick={onPlay}>
        <Play className="size-3.5" />
      </IconButton>
      <span className="timecode text-[11px] text-faint">
        {line.start !== null ? formatTimecode(line.start, 1) : '—'}–{line.end !== null ? formatTimecode(line.end, 1) : '—'}
      </span>
      <div className="flex min-w-0 items-center gap-1.5">
        <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => void commit()} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} className={cx('!py-1.5 text-sm', flagged && 'border-warning/50')} aria-label={`Caption line at ${line.start?.toFixed(1) ?? ''} s`} disabled={saving} />
        {flagged && (
          <span title="Low confidence — listen and correct if needed">
            <CircleAlert className="size-4 shrink-0 text-warning" aria-label="Needs a listen" />
          </span>
        )}
      </div>
    </li>
  );
}

function TranscriptCard({ project, ad, update, transport }: Pick<StepProps, 'project' | 'ad' | 'update'> & { transport: Transport }) {
  const song = useNarration(project.id, ad.audio.songId);
  const { submit, busy, dialog } = useJobSubmitter();
  const s = song.data;
  const report = s?.narration?.report ?? null;
  const [jobId, setJobId] = useState<string | null>(null);
  const live = useDoc<JobDoc>(jobId ? `jobs/${jobId}` : null);
  const running = live.data && !['completed', 'failed', 'cancelled'].includes(live.data.status);
  const sheet = s?.lyricsSheet ?? null;
  const [terms, setTerms] = useState(ad.audio.protectedTerms.join(', '));

  const extract = async () => {
    if (!ad.audio.songId || !ad.audio.assetId) return;
    const ids = await submit([{ type: 'narration.transcribe', projectId: project.id, songId: ad.audio.songId, audioAssetId: ad.audio.assetId, reference: ad.audio.referenceScript.trim() || null, protectedTerms: ad.audio.protectedTerms, languageCode: ad.audio.languageCode || 'en', label: 'Narration transcript' }], { label: 'Narration transcript' });
    if (ids?.[0]) setJobId(ids[0]);
  };
  const saveTerms = () => update((a) => ({ ...a, audio: { ...a.audio, protectedTerms: terms.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 30) } }));
  const sections = useMemo(() => {
    if (!sheet) return [];
    return sheet.sections.map((sec) => ({ sec, lines: sheet.lines.filter((l) => l.sectionId === sec.id) })).filter((g) => g.lines.length);
  }, [sheet]);
  const approve = async () => {
    if (!sheet || !s) return;
    await approveTranscript(project.id, s.id, sheet);
    update((a) => ({ ...a, audio: { ...a.audio, transcriptApprovedAt: Date.now() } }));
    toast.success('Transcript approved', { description: 'Captions and scene cuts use it exactly.' });
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="eyebrow">Transcript & captions</p>
        <div className="flex gap-2">
          {sheet && (
            <Button size="sm" variant={sheet.status === 'approved' ? 'ghost' : 'subtle'} icon={<Check className="size-3.5" />} onClick={() => void approve()} disabled={sheet.status === 'approved'}>
              {sheet.status === 'approved' ? 'Approved' : 'Approve transcript'}
            </Button>
          )}
          <Button size="sm" variant={sheet ? 'ghost' : 'primary'} loading={busy || Boolean(running)} disabled={!ad.audio.songId || !ad.audio.durationSec} onClick={() => void extract()} icon={sheet ? <RefreshCw className="size-3.5" /> : <Wand2 className="size-3.5" />}>
            {sheet ? 'Transcribe again' : 'Extract transcript'}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Field label="Approved script (reference)" hint="Used for spelling and sentence breaks only where the recording agrees — never as proof that a word was spoken.">
          <Textarea rows={6} value={ad.audio.referenceScript} onChange={(e) => update((a) => ({ ...a, audio: { ...a.audio, referenceScript: e.target.value } }))} placeholder="Paste the approved script…" />
        </Field>
        <div className="space-y-3">
          <Field label="Names that must be spelled exactly" hint="Comma-separated, e.g. Kasem, Indigen World.">
            <Input value={terms} onChange={(e) => setTerms(e.target.value)} onBlur={saveTerms} />
          </Field>
          <Field label="Spoken language">
            <Select value={ad.audio.languageCode} onChange={(e) => update((a) => ({ ...a, audio: { ...a.audio, languageCode: e.target.value } }))}>
              {LYRIC_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      {live.data && running && (
        <div className="space-y-1.5">
          <p className="text-xs text-dim">{live.data.stage}</p>
          <ProgressBar value={live.data.progress} label="Transcript progress" />
        </div>
      )}
      {live.data?.status === 'failed' && <JobErrorPanel job={live.data} onRetried={setJobId} />}
      {report && (
        <div className="grid grid-cols-2 gap-3 rounded-xl border border-line p-3 text-xs sm:grid-cols-4">
          <div>
            <p className="text-faint">Script heard</p>
            <p className="timecode text-sm text-fg">{Math.round(report.coverage * 100)}%</p>
          </div>
          <div>
            <p className="text-faint">Speech</p>
            <p className="timecode text-sm text-fg">{report.speechStart !== null ? `${report.speechStart.toFixed(2)}–${report.speechEnd?.toFixed(2)} s` : '—'}</p>
          </div>
          <div>
            <p className="text-faint">Corrected spellings</p>
            <p className="timecode text-sm text-fg">{report.corrected.length}</p>
          </div>
          <div>
            <p className="text-faint">Exact names</p>
            <p className="text-sm text-fg">{report.protectedTerms.map((t) => `${t.term} ${t.found}/${t.expected}`).join(' · ') || '—'}</p>
          </div>
          {report.corrected.length > 0 && (
            <ul className="col-span-full space-y-0.5 text-dim">
              {report.corrected.slice(0, 12).map((c, i) => (
                <li key={i}>
                  {c.start !== null ? <span className="timecode text-faint">{c.start.toFixed(1)} s · </span> : null}
                  heard “{c.heard}” → caption “{c.used === 'script' ? c.written : c.heard}” {c.kind === 'heard_differently' ? <span className="text-warning">(recording differs from the script — listen)</span> : null}
                </li>
              ))}
            </ul>
          )}
          {report.notDetected.length > 0 && <p className="col-span-full text-warning">Not clearly heard: {report.notDetected.map((n) => `“${n.text}”${n.kept ? '' : ' (left out)'}`).join(', ')}</p>}
          {report.extra.filter((x) => x.kept).length > 0 && <p className="col-span-full text-dim">Heard but not in the script: {report.extra.filter((x) => x.kept).map((x) => `“${x.text}”`).join(', ')}</p>}
        </div>
      )}
      {!sheet ? (
        <EmptyState title="No transcript yet" body={ad.audio.assetId ? 'Extract it to get word timing; captions and scene cuts follow the recording.' : 'Attach the audio first.'} />
      ) : (
        <div className="space-y-3">
          {sheet.timing.status === 'needs_review' && <Notice tone="warning">Lines marked with a warning had low confidence — play them and correct the text if needed. Edits are re-timed against the recording instantly.</Notice>}
          {sections.map(({ sec, lines }) => (
            <div key={sec.id} className="rounded-xl border border-line p-2">
              <p className="px-1.5 pb-1 text-[11px] text-faint">{sec.label === 'verse' ? 'Sentence' : sec.label === 'hook' ? 'Typography' : sec.label === 'outro' ? 'End card' : sec.label}</p>
              <ul className="space-y-0.5">
                {lines.map((l) => (
                  <TranscriptLine key={l.id} line={l} active={l.start !== null && transport.time >= l.start && transport.time < (l.end ?? 0)} onPlay={() => l.start !== null && transport.playRange(l.start, l.end ?? l.start + 2)} onSave={async (text) => void (await saveTranscriptEdit(project.id, s as WithId<SongDoc>, sheet, l.id, text))} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {dialog}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Brand and supplied assets
// ---------------------------------------------------------------------------

const ROLE_KINDS: Record<AdAssetRole, AssetKind[]> = { logo: ['image'], screenshot: ['image'], recording: ['video'], photo: ['image'], footage: ['video'] };

function ColourInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-9 w-10 cursor-pointer rounded-lg border border-line bg-transparent" aria-label={`${label} colour`} />
        <Input value={value} onChange={(e) => /^#[0-9a-f]{0,6}$/i.test(e.target.value) && onChange(e.target.value.toUpperCase())} className="timecode !py-1.5" aria-label={`${label} hex`} />
      </div>
    </Field>
  );
}

function BrandCard({ ad, update }: Pick<StepProps, 'ad' | 'update'>) {
  const set = <K extends keyof AdSpec['brand']>(k: K, v: AdSpec['brand'][K]) => update((a) => ({ ...a, brand: { ...a.brand, [k]: v } }));
  const logos = ad.assets.filter((x) => x.role === 'logo');
  return (
    <Card className="space-y-4 p-5">
      <p className="eyebrow">Brand & format</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ColourInput label="Brand colour" value={ad.brand.primary} onChange={(v) => set('primary', v)} />
        <ColourInput label="Background" value={ad.brand.background} onChange={(v) => set('background', v)} />
        <ColourInput label="Accent" value={ad.brand.accent} onChange={(v) => set('accent', v)} />
        <ColourInput label="Text" value={ad.brand.text} onChange={(v) => set('text', v)} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Typeface" hint="Rendered with the real font files; Noto Sans covers Kasem’s special letters.">
          <Select value={ad.brand.font} onChange={(e) => set('font', e.target.value)}>
            {AD_FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Aspect ratio (first version)">
          <Segmented
            label="Aspect ratio"
            value={ad.aspect}
            onChange={(aspect) => update({ aspect })}
            options={[
              { value: '9:16', label: '9:16' },
              { value: '16:9', label: '16:9' },
              { value: '1:1', label: '1:1' },
            ]}
          />
        </Field>
        <Field label="Official logo" hint={logos.length ? 'Shown on the end card; never generated or redrawn.' : 'Upload the official logo under Logos below. Without it the end card uses typography only.'}>
          <Select value={ad.brand.logoAssetId ?? ''} onChange={(e) => set('logoAssetId', e.target.value || null)}>
            <option value="">No logo (typography only)</option>
            {logos.map((l) => (
              <option key={l.assetId} value={l.assetId}>
                {l.label || l.assetId}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Logo source" hint="Where this file comes from (shown in the review).">
          <Input value={ad.brand.logoSource} onChange={(e) => set('logoSource', e.target.value)} placeholder="e.g. indigenworld.com header mark" />
        </Field>
      </div>
    </Card>
  );
}

function SuppliedAsset({ entry, onChange, onRemove }: { entry: AdSpec['assets'][number]; onChange: (p: Partial<AdSpec['assets'][number]>) => void; onRemove: () => void }) {
  const asset = useAsset(entry.assetId);
  const [label, setLabel] = useState(entry.label);
  const [note, setNote] = useState(entry.note);
  return (
    <li className="space-y-2 rounded-xl border border-line p-2.5">
      {asset.data ? <AssetThumb asset={asset.data as Asset} aspect={entry.role === 'screenshot' ? 'aspect-[9/16]' : 'aspect-video'} showMeta={false} /> : <div className="aspect-video rounded-lg bg-black/30" />}
      <Input value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => label !== entry.label && onChange({ label })} placeholder="What it shows" className="!py-1.5 text-xs" aria-label="Asset label" />
      <Input value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== entry.note && onChange({ note })} placeholder="Source / permission note" className="!py-1.5 text-xs" aria-label="Asset note" />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-faint">{asset.data ? `${asset.data.width ?? '?'}×${asset.data.height ?? '?'}${asset.data.durationSec ? ` · ${asset.data.durationSec.toFixed(1)} s` : ''}` : ''}</span>
        <IconButton label="Remove from this advert" size="sm" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
    </li>
  );
}

function SuppliedAssetsCard({ project, ad, update }: Pick<StepProps, 'project' | 'ad' | 'update'>) {
  const [role, setRole] = useState<AdAssetRole>('screenshot');
  const [picker, setPicker] = useState(false);
  const add = (ids: string[], titles: Record<string, string> = {}) =>
    update((a) => ({ ...a, assets: [...a.assets, ...ids.filter((id) => !a.assets.some((x) => x.assetId === id && x.role === role)).map((assetId) => ({ assetId, role, label: titles[assetId] ?? '', note: '' }))] }));
  const list = ad.assets.filter((x) => x.role === role);
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="eyebrow">Supplied material</p>
        <Segmented label="Material type" size="sm" value={role} onChange={setRole} options={AD_ASSET_ROLES.map((r) => ({ value: r, label: `${AD_ASSET_ROLE_LABELS[r]}${ad.assets.some((x) => x.role === r) ? ` (${ad.assets.filter((x) => x.role === r).length})` : ''}` }))} />
      </div>
      <p className="text-xs text-faint">Real product screens and footage are preferred over generated pictures. Nothing here is altered; screens are placed whole on the brand ground.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <UploadZone compact accept={acceptFor(ROLE_KINDS[role])} kind={ROLE_KINDS[role][0]} projectId={project.id} collections={[`ad:${role}`]} onUploaded={(ids) => add(ids)} label={`Upload ${AD_ASSET_ROLE_LABELS[role].toLowerCase()}`} />
        <Button variant="ghost" icon={<Library className="size-4" />} onClick={() => setPicker(true)}>
          From library
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-faint">No {AD_ASSET_ROLE_LABELS[role].toLowerCase()} yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {list.map((entry) => (
            <SuppliedAsset
              key={`${entry.role}-${entry.assetId}`}
              entry={entry}
              onChange={(p) => update((a) => ({ ...a, assets: a.assets.map((x) => (x.assetId === entry.assetId && x.role === entry.role ? { ...x, ...p } : x)) }))}
              onRemove={() => update((a) => ({ ...a, assets: a.assets.filter((x) => !(x.assetId === entry.assetId && x.role === entry.role)), brand: a.brand.logoAssetId === entry.assetId && entry.role === 'logo' ? { ...a.brand, logoAssetId: null } : a.brand }))}
            />
          ))}
        </ul>
      )}
      <AssetPicker open={picker} onOpenChange={setPicker} kinds={ROLE_KINDS[role]} projectId={project.id} multiple max={20} onPick={(as) => add(as.map((x) => x.id), Object.fromEntries(as.map((x) => [x.id, x.title])))} title={`Choose ${AD_ASSET_ROLE_LABELS[role].toLowerCase()}`} />
    </Card>
  );
}

export function AssetsStep({ project, ad, update, go }: StepProps) {
  const urls = useMediaUrls(ad.audio.assetId);
  const transport = useTransport(urls?.file);
  return (
    <div className="space-y-5">
      <SoundtrackCard project={project} ad={ad} update={update} transport={transport} />
      {ad.audio.assetId && <TranscriptCard project={project} ad={ad} update={update} transport={transport} />}
      <BrandCard ad={ad} update={update} />
      <SuppliedAssetsCard project={project} ad={ad} update={update} />
      <div className="flex justify-end">
        <Button variant="primary" icon={<ArrowRight className="size-4" />} onClick={() => go('storyboard')}>
          Storyboard
        </Button>
      </div>
    </div>
  );
}
