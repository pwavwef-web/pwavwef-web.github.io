import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AudioWaveform, Clapperboard, Scissors, Sparkles, Upload } from 'lucide-react';
import { addAudioBed, assemblePicture, emptyTimeline, estimateVideo, formatTimecode, type JobRequest, type ProjectDoc } from '@az-studio/shared';
import { api, errorMessage } from '../lib/api';
import type { WithId } from '../lib/data';
import { useBoot, useUid } from '../lib/session';
import { analyzeAssetAudio, beatCues } from '../lib/audio-analysis';
import { createTimeline } from '../lib/studio';
import { useMediaUrls } from '../lib/media';
import { ChainList, ChainView, useChains } from '../components/chain';
import { EstimateText, useJobSubmitter } from '../components/jobs';
import { AssetPicker, useAsset, type Asset } from '../components/media';
import { ProjectHeader } from '../components/project-header';
import { Badge, Button, Card, EmptyState, Field, Input, Notice, SectionHeader, Segmented, Select, Skeleton, Slider, Textarea } from '../components/ui';

const PRESETS = [
  { label: 'Change location', text: 'Move the whole scene to a different location: ' },
  { label: 'Visual style', text: 'Restyle the video as ' },
  { label: 'Replace an object', text: 'Replace the ' },
  { label: 'Time of day', text: 'Change the time of day to golden hour, with long warm shadows and matching light on the subjects.' },
  { label: 'Modify action', text: 'Change the action so that ' },
  { label: 'Camera perspective', text: 'Re-imagine the shot from a different camera perspective: ' },
  { label: 'Cinematic effects', text: 'Add cinematic effects: subtle anamorphic lens flares, drifting haze and a filmic colour grade.' },
] as const;

function Trimmer({ asset, onClip }: { asset: Asset; onClip: (assetId: string) => void }) {
  const boot = useBoot();
  const max = boot?.capabilities.video.maxEditInputSeconds ?? 10;
  const urls = useMediaUrls(asset.id);
  const videoRef = useRef<HTMLVideoElement>(null);
  const duration = asset.durationSec ?? 0;
  const [start, setStart] = useState(0);
  const [len, setLen] = useState(Math.min(max, duration));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (videoRef.current) videoRef.current.currentTime = start;
  }, [start]);
  const cut = async () => {
    setBusy(true);
    try {
      const r = await api<{ assetId: string }, 'deriveClip'>('deriveClip', { assetId: asset.id, startSec: start, durationSec: len });
      toast.success('Clip ready', { description: `${len.toFixed(1)}s window saved to your library.` });
      onClip(r.assetId);
    } catch (e) {
      toast.error('Trim failed', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <Notice tone="warning">
        This clip is {duration.toFixed(1)}s. Omni edits uploaded videos of up to {max}s — choose a window to cut (the cut is made server-side with FFmpeg).
      </Notice>
      {urls?.file && <video ref={videoRef} src={urls.file} className="w-full rounded-xl bg-black" controls playsInline muted />}
      <Field label={`Start: ${formatTimecode(start)}`}>
        <Slider label="Window start" min={0} max={Math.max(0, duration - len)} step={0.1} value={start} onChange={setStart} />
      </Field>
      <Field label={`Length: ${len.toFixed(1)}s`}>
        <Slider label="Window length" min={1} max={Math.min(max, duration)} step={0.1} value={len} onChange={(v) => setLen(Math.min(v, duration - start))} />
      </Field>
      <Button variant="primary" loading={busy} onClick={() => void cut()} icon={<Scissors className="size-4" />}>
        Cut {len.toFixed(1)}s clip
      </Button>
    </div>
  );
}

export default function Remix({ project }: { project?: WithId<ProjectDoc> }) {
  const boot = useBoot();
  const uid = useUid();
  const navigate = useNavigate();
  const caps = boot?.capabilities.video;
  const projectId = project?.id ?? null;
  const [sourceId, setSourceId] = useState<string | null>(null);
  const source = useAsset(sourceId);
  const [prompt, setPrompt] = useState('');
  const [resolution, setResolution] = useState(boot?.settings.defaultVideoResolution ?? '720p');
  const [reframe, setReframe] = useState<string | null>(null);
  const [picker, setPicker] = useState<'video' | 'audio' | null>(null);
  const [audioId, setAudioId] = useState<string | null>(null);
  const audio = useAsset(audioId);
  const [beats, setBeats] = useState<number[] | null>(null);
  const [audioStart, setAudioStart] = useState(0);
  const [beatEffect, setBeatEffect] = useState('a burst of warm light pulses through the scene');
  const [analysing, setAnalysing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const chains = useChains('video', projectId);
  const { submit, busy, dialog } = useJobSubmitter();

  useEffect(() => {
    if (!selected && chains.data[0]) setSelected(chains.data[0].id);
  }, [chains.data, selected]);

  const srcDur = source.data?.durationSec ?? 0;
  const tooLong = caps ? srcDur > caps.maxEditInputSeconds + 0.05 : false;
  const cues = beats ? beatCues(beats, audioStart, srcDur || 10, beatEffect) : '';
  const fullPrompt = [prompt.trim(), reframe ? `Reframe the video for ${reframe} ${reframe === '9:16' ? 'vertical' : 'widescreen'} while keeping the main subject centred and fully in frame.` : '', cues].filter(Boolean).join('\n');
  const estimate = useMemo(() => (boot && fullPrompt ? estimateVideo({ resolution, outputSeconds: srcDur || 8, promptChars: fullPrompt.length, imageInputs: 0, videoInputSeconds: srcDur, task: 'edit' }, boot.pricing) : null), [boot, fullPrompt, resolution, srcDur]);

  if (!boot || !caps) return <Skeleton className="h-96" />;

  const analyse = async () => {
    if (!audioId) return;
    try {
      const r = await analyzeAssetAudio(audioId, setAnalysing);
      setBeats(r.beats);
      toast.success(`Found ${r.beats.length} beats at ${r.bpm} BPM`);
    } catch (e) {
      toast.error('Audio analysis failed', { description: errorMessage(e) });
    } finally {
      setAnalysing(null);
    }
  };

  const run = async () => {
    if (!sourceId || !fullPrompt) return;
    const job: JobRequest = { type: 'video.generate', projectId, mode: 'edit', prompt: fullPrompt, resolution, ...(reframe ? { aspectRatio: reframe } : {}), media: [{ role: 'source_video', assetId: sourceId, label: source.data?.title }], characterIds: [], title: `Remix · ${prompt.slice(0, 60) || 'edit'}` };
    const ids = await submit([job], { label: 'Video remix' });
    if (ids) setSelected(null);
  };

  const openScored = async () => {
    if (!project || !sourceId || !audio.data) return;
    try {
      let state = emptyTimeline(project.format.aspectRatio);
      state = assemblePicture(state, [{ assetId: sourceId, kind: 'video', durationSec: srcDur, sourceDuration: srcDur, label: source.data?.title ?? 'Remix' }]);
      state = addAudioBed(state, audio.data.id, Math.min(audio.data.durationSec ?? srcDur, srcDur || 10), audio.data.title);
      const tid = await createTimeline(uid, project.id, `Remix + ${audio.data.title}`, state, project.format.aspectRatio);
      navigate(`/projects/${project.id}/timeline/${tid}`);
    } catch (e) {
      toast.error('Could not create timeline', { description: errorMessage(e) });
    }
  };

  return (
    <div className="space-y-8">
      {project ? <ProjectHeader project={project} /> : <SectionHeader eyebrow="Create" title={<span className="text-5xl">Video Remix</span>} sub={`${caps.displayName} · edit an existing video conversationally, turn by turn.`} />}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <p className="eyebrow">Source video</p>
              <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} onClick={() => setPicker('video')}>
                {sourceId ? 'Change' : 'Choose or upload'}
              </Button>
            </div>
            {!source.data ? (
              <EmptyState icon={<Clapperboard className="size-5" />} title="Pick a clip to remix" body={`Upload footage or pick a generated clip. Uploaded videos can be up to ${caps.maxEditInputSeconds}s per edit.`} action={<Button variant="primary" onClick={() => setPicker('video')}>Choose video</Button>} />
            ) : tooLong ? (
              <Trimmer asset={source.data as Asset} onClip={setSourceId} />
            ) : (
              <div className="space-y-2">
                <VideoPreview assetId={source.data.id} />
                <p className="text-xs text-faint">
                  {source.data.title} · {srcDur.toFixed(1)}s {source.data.width ? `· ${source.data.width}×${source.data.height}` : ''}
                </p>
              </div>
            )}
          </Card>
          <Card className="space-y-4 p-5">
            <p className="eyebrow">What should change?</p>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <Button key={p.label} size="sm" variant="secondary" onClick={() => setPrompt((v) => (v ? `${v}\n${p.text}` : p.text))}>
                  {p.label}
                </Button>
              ))}
            </div>
            <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Change the location to a rooftop in Lagos at night, neon signs reflecting in puddles. Keep the dancer’s choreography identical." aria-label="Edit instruction" />
            <Field label="Produce another aspect-ratio version" hint="Adds a reframing instruction and requests that output aspect ratio.">
              <Segmented label="Reframe" value={reframe ?? 'none'} onChange={(v) => setReframe(v === 'none' ? null : v)} options={[{ value: 'none', label: 'Keep' }, ...caps.aspectRatios.map((a) => ({ value: a, label: a }))]} />
            </Field>
          </Card>
          <Card className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <p className="eyebrow flex items-center gap-1.5">
                <AudioWaveform className="size-3.5" /> Drive changes from an audio track
              </p>
              <Button size="sm" variant="ghost" onClick={() => setPicker('audio')}>
                {audioId ? 'Change track' : 'Choose track'}
              </Button>
            </div>
            <p className="text-xs text-faint">Omni can’t hear audio files, so AZ Studio detects the track’s beats and writes them into the prompt as timed directions.</p>
            {audio.data && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{audio.data.title}</Badge>
                  <Button size="sm" loading={Boolean(analysing)} onClick={() => void analyse()}>
                    {analysing ?? (beats ? 'Re-analyse' : 'Detect beats')}
                  </Button>
                  {beats && <span className="text-xs text-dim">{beats.length} beats</span>}
                </div>
                {beats && (
                  <>
                    <Field label={`Track offset: ${formatTimecode(audioStart)}`}>
                      <Slider label="Track offset" min={0} max={Math.max(0, (audio.data.durationSec ?? 0) - (srcDur || 1))} step={0.1} value={audioStart} onChange={setAudioStart} />
                    </Field>
                    <Field label="On each beat…">
                      <Input value={beatEffect} onChange={(e) => setBeatEffect(e.target.value)} />
                    </Field>
                    {project ? (
                      <Button size="sm" variant="subtle" onClick={() => void openScored()} icon={<Clapperboard className="size-3.5" />}>
                        Open source + track in the timeline
                      </Button>
                    ) : (
                      <p className="text-xs text-faint">Create a Remix project to lay this track under the result on a timeline and export it.</p>
                    )}
                  </>
                )}
              </div>
            )}
          </Card>
          <Card className="space-y-4 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Output resolution">
                <Select value={resolution} onChange={(e) => setResolution(e.target.value)} aria-label="Resolution">
                  {caps.resolutions.map((r) => (
                    <option key={r} value={r}>
                      {r.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <EstimateText estimate={estimate} />
              </div>
            </div>
            {fullPrompt && <pre className="max-h-48 overflow-auto rounded-xl border border-line bg-black/25 p-3 font-sans text-xs whitespace-pre-wrap text-dim">{fullPrompt}</pre>}
            <Button variant="primary" className="w-full" loading={busy} disabled={!sourceId || tooLong || !fullPrompt} onClick={() => void run()} icon={<Sparkles className="size-4" />}>
              Remix with {caps.displayName}
            </Button>
          </Card>
        </div>
        <div className="space-y-5">
          <SectionHeader eyebrow="Results" title="Remix chains" sub="Each edit continues from the exact prior result." />
          {chains.loading ? (
            <Skeleton className="aspect-video" />
          ) : chains.data.length === 0 ? (
            <EmptyState title="No remixes yet" body="Your first edit starts a chain; follow-up edits continue from the correct prior result." />
          ) : (
            <>
              {selected && <ChainView key={selected} chainId={selected} kind="video" projectId={projectId} />}
              <ChainList chains={chains.data} selected={selected} onSelect={setSelected} />
            </>
          )}
        </div>
      </div>
      <AssetPicker
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        kinds={picker === 'audio' ? ['audio'] : ['video']}
        projectId={projectId}
        onPick={(a) => {
          if (picker === 'audio') {
            setAudioId(a[0]?.id ?? null);
            setBeats(null);
          } else setSourceId(a[0]?.id ?? null);
        }}
        title={picker === 'audio' ? 'Choose an audio track' : 'Choose a video to remix'}
      />
      {dialog}
    </div>
  );
}

function VideoPreview({ assetId }: { assetId: string }) {
  const urls = useMediaUrls(assetId);
  return urls?.file ? <video src={urls.file} poster={urls.poster} className="w-full rounded-xl bg-black" controls playsInline /> : <Skeleton className="aspect-video" />;
}
