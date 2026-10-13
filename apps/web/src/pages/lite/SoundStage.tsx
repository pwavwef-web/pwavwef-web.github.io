import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AudioLines, Download, FileUp, LoaderCircle, Mic, Music2, Pause, Play, RefreshCw, Trash2, TriangleAlert, Upload, Wand2, Wind } from 'lucide-react';
import {
  AMBIENCE_KINDS,
  AMBIENCE_LABELS,
  SUBTITLE_PRESETS,
  estimateNarrationSec,
  formatSrt,
  formatVtt,
  importCuesToScenes,
  liteCaptionStyle,
  liteId,
  mapScene,
  parseSubtitles,
  speechLanguageSupported,
  spokenText,
  stableHash,
  voiceDirection,
  type LiteAspect,
  type LiteMusicTrack,
  type LiteScene,
  type LiteSpec,
  type SubtitlePreset,
} from '@az-studio/shared';
import { jobIndex, type SceneVoice } from '../../lib/lite';
import { getMediaUrls, uploadFile } from '../../lib/media';
import { useCaps } from '../../lib/session';
import { useJobSubmitter } from '../../components/jobs';
import { AssetPicker, useAsset, useWaveform, Waveform } from '../../components/media';
import { Badge, Button, cx, Field, IconButton, Input, Notice, Segmented, Select, Textarea, Toggle } from '../../components/ui';
import { fmtSec, LabeledSlider, Section, type StageProps } from './common';

const PRESET_LABEL: Record<SubtitlePreset, string> = { cinema: 'Cinema', serif: 'Serif', boxed: 'Boxed', minimal: 'Minimal' };

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** One shared audio element for auditioning takes, samples and music. */
const audition = typeof Audio !== 'undefined' ? new Audio() : null;
function useAudition() {
  const [playing, setPlaying] = useState<string | null>(null);
  const play = async (assetId: string, from = 0, to?: number) => {
    if (!audition) return;
    if (playing === assetId) {
      audition.pause();
      setPlaying(null);
      return;
    }
    const u = await getMediaUrls(assetId);
    if (!u.file) return;
    audition.src = u.file;
    audition.currentTime = from;
    audition.ontimeupdate = () => {
      if (to !== undefined && audition.currentTime >= to) {
        audition.pause();
        setPlaying(null);
      }
    };
    audition.onended = () => setPlaying(null);
    void audition.play();
    setPlaying(assetId);
  };
  return { playing, play };
}

function TakeRow({ scene, index, voice, props, audio }: { scene: LiteScene; index: number; voice: SceneVoice | undefined; props: StageProps; audio: ReturnType<typeof useAudition> }) {
  const { spec, update, work, jobs, project } = props;
  const idx = useMemo(() => jobIndex(jobs), [jobs]);
  const active = idx.active('lite_scene', scene.id);
  const failed = idx.failed('lite_scene', scene.id);
  const take = voice?.take ?? null;
  const wave = useWaveform(take?.assetId ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const est = estimateNarrationSec(scene.narration, spec.setup.wordsPerMinute);
  const speech = take ? take.speechEnd - take.speechStart : null;
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const assetId = await uploadFile(file, { kind: 'audio', projectId: project.id, collections: ['lite:narration'] });
      update((s) => mapScene(s, scene.id, (x) => ({ ...x, voiceUploadAssetId: assetId, voiceJobId: null })), 'voice');
      toast.success('Recording uploaded', { description: 'Time it against the text to place it and build its subtitles.' });
    } catch (e) {
      toast.error('Upload failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
    }
  };
  if (!scene.narration.trim()) return null;
  return (
    <li className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="timecode text-xs text-faint">{String(index + 1).padStart(2, '0')}</span>
        <p className="min-w-0 flex-1 truncate text-sm text-fg">{scene.title || `Scene ${index + 1}`}</p>
        {active ? (
          <Badge tone="accent" icon={<LoaderCircle className="size-3 animate-spin" />}>
            {active.stage || 'Working'}
          </Badge>
        ) : take ? (
          <>
            <Badge tone={take.alignment === 'aligned' ? 'success' : 'warning'}>{take.alignment === 'aligned' ? `Word-timed${take.coverage !== null ? ` · ${Math.round(take.coverage * 100)}% heard` : ''}` : 'Timing estimated'}</Badge>
            {voice?.stale && <Badge tone="warning">Out of date</Badge>}
            <span className="timecode text-xs text-dim">{fmtSec(speech ?? 0)} <span className="text-faint">(est. {fmtSec(est)})</span></span>
          </>
        ) : (
          <Badge>Not voiced · est. {fmtSec(est)}</Badge>
        )}
        {take && (
          <IconButton size="sm" label={audio.playing === take.assetId ? 'Stop' : 'Play narration'} onClick={() => void audio.play(take.assetId, take.inPoint, take.outPoint)}>
            {audio.playing === take.assetId ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </IconButton>
        )}
        {spec.voice.mode === 'generate' && !scene.voiceUploadAssetId && (
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} disabled={Boolean(active) || Boolean(work.busy)} onClick={() => void work.run('narration', { targetIds: [scene.id], force: Boolean(take && !voice?.stale) })}>
            {take && !voice?.stale ? 'Re-voice' : 'Voice'}
          </Button>
        )}
        {spec.voice.mode !== 'upload_whole' && (
          <>
            <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} loading={uploading} onClick={() => fileRef.current?.click()}>
              {scene.voiceUploadAssetId ? 'Replace recording' : 'Upload recording'}
            </Button>
            <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          </>
        )}
        {scene.voiceUploadAssetId && (
          <>
            <Button size="sm" variant="secondary" icon={<AudioLines className="size-3.5" />} disabled={Boolean(active)} onClick={() => void work.run('narration', { targetIds: [scene.id] })}>
              Time recording
            </Button>
            {spec.voice.mode === 'generate' && (
              <Button size="sm" variant="ghost" onClick={() => update((s) => mapScene(s, scene.id, (x) => ({ ...x, voiceUploadAssetId: null, voiceJobId: null })), 'voice')}>
                Use studio voice
              </Button>
            )}
          </>
        )}
      </div>
      {wave && take && <Waveform peaks={wave} duration={wave.durationSec} height={40} className="mt-2" regions={[{ start: take.speechStart, end: take.speechEnd, color: 'rgba(76,141,255,0.10)' }]} />}
      {take && take.flags.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-warning">
          {take.flags.map((f) => (
            <li key={f} className="flex gap-1.5">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {f.replace(/^[a-z_]+: /, '')}
            </li>
          ))}
        </ul>
      )}
      {voice && voice.takes.length > 1 && (
        <Select aria-label="Narration take" className="mt-2 !w-auto !py-1 !text-xs" value={scene.voiceJobId ?? ''} onChange={(e) => update((s) => mapScene(s, scene.id, (x) => ({ ...x, voiceJobId: e.target.value || null })), 'take')}>
          <option value="">Newest take for the current text</option>
          {voice.takes.map((t, i) => (
            <option key={t.jobId} value={t.jobId}>
              Take {voice.takes.length - i} · {fmtSec(t.speechEnd - t.speechStart)} · {t.source === 'generated' ? t.voice ?? 'studio voice' : 'recording'} · {new Date(t.createdAt).toLocaleString()}
            </option>
          ))}
        </Select>
      )}
      {failed && !active && <p className="mt-1 text-xs text-danger">{failed.error?.message}</p>}
    </li>
  );
}

function SubtitleSample({ preset, active, onClick, aspect, spec }: { preset: SubtitlePreset; active: boolean; onClick: () => void; aspect: LiteAspect; spec: LiteSpec }) {
  const { style } = liteCaptionStyle({ ...spec.subtitles, preset, font: preset === 'serif' ? 'EB Garamond' : spec.subtitles.font === 'EB Garamond' ? 'Inter' : spec.subtitles.font, contrast: preset === 'boxed' ? 'box' : spec.subtitles.contrast === 'box' ? 'shadow' : spec.subtitles.contrast }, aspect, '');
  const font = style.font === 'EB Garamond' ? '"EB Garamond", Georgia, serif' : '"Inter Variable", Inter, sans-serif';
  return (
    <button type="button" role="radio" aria-checked={active} onClick={onClick} className={cx('cursor-pointer overflow-hidden rounded-xl border text-left transition-colors', active ? 'border-accent/60' : 'border-line hover:border-line-strong')}>
      <div className="relative aspect-video bg-[radial-gradient(ellipse_at_30%_30%,#5b4a33,#1b2133_55%,#07090f)]">
        <span className="absolute inset-x-2 bottom-[9%] text-center text-[11px] leading-tight text-white" style={{ fontFamily: font, fontWeight: style.bold ? 600 : 400, textShadow: style.background ? undefined : '0 1px 3px rgba(0,0,0,0.9)' }}>
          <span style={style.background ? { background: 'rgba(0,0,0,0.72)', padding: '1px 5px', borderRadius: 2 } : undefined}>The river keeps its secrets.</span>
        </span>
      </div>
      <p className="px-2.5 py-1.5 text-xs text-dim">{PRESET_LABEL[preset]}</p>
    </button>
  );
}

function TrackRow({ t, props }: { t: LiteMusicTrack; props: StageProps }) {
  const { spec, update } = props;
  const a = useAsset(t.assetId);
  const set = (patch: Partial<LiteMusicTrack>) => update((s) => ({ ...s, sound: { ...s.sound, music: { ...s.sound.music, tracks: s.sound.music.tracks.map((x) => (x.id === t.id ? { ...x, ...patch } : x)) } } }), 'track');
  const gen = a.data?.generation;
  return (
    <li className="space-y-2 rounded-xl border border-line p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Music2 className="size-4 text-accent-2" />
        <span className="min-w-0 flex-1 truncate text-sm text-fg">{a.data?.title ?? 'Loading…'}</span>
        <span className="text-faint">{a.data?.durationSec ? fmtSec(a.data.durationSec) : ''}</span>
        <IconButton size="sm" label="Remove track" onClick={() => update((s) => ({ ...s, sound: { ...s.sound, music: { ...s.sound.music, tracks: s.sound.music.tracks.filter((x) => x.id !== t.id) } } }), 'track')}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-faint">Starts at</span>
        <Select aria-label="Starts at scene" value={t.fromSceneId ?? ''} onChange={(e) => set({ fromSceneId: e.target.value || null })} className="!w-auto !py-0.5 !text-xs">
          <option value="">The opening</option>
          {spec.scenes.map((s, i) => (
            <option key={s.id} value={s.id}>
              {s.title || `Scene ${i + 1}`}
            </option>
          ))}
        </Select>
        <span className="text-faint">If too short</span>
        <Segmented size="sm" label="If too short" value={t.fit} onChange={(v: 'loop' | 'end') => set({ fit: v })} options={[{ value: 'loop', label: 'Crossfaded reuse' }, { value: 'end', label: 'End early' }]} />
        <span className="text-faint">Level</span>
        <Input type="number" step={1} min={-24} max={6} value={t.gainDb} onChange={(e) => set({ gainDb: Number(e.target.value) || 0 })} className="!w-16 !py-0.5 !text-xs" aria-label="Track level (dB)" />
        <span className="text-faint">dB</span>
      </div>
      {gen ? (
        <p className="text-faint">Provenance: generated in AZ Studio with {gen.modelId} (job {gen.jobId.slice(0, 8)}). Check the provider’s terms for your use.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <Select aria-label="Rights" value={t.licence.kind} onChange={(e) => set({ licence: { ...t.licence, kind: e.target.value as LiteMusicTrack['licence']['kind'] } })} className="!py-1 !text-xs">
            <option value="unknown">Rights not recorded</option>
            <option value="own">My own recording</option>
            <option value="licensed">Licensed</option>
            <option value="public_domain">Public domain</option>
          </Select>
          <Input aria-label="Source" placeholder="Source (library, composer)" value={t.licence.source} onChange={(e) => set({ licence: { ...t.licence, source: e.target.value } })} className="!py-1 !text-xs" />
          <Input aria-label="Attribution" placeholder="Attribution required" value={t.licence.attribution} onChange={(e) => set({ licence: { ...t.licence, attribution: e.target.value } })} className="!py-1 !text-xs" />
          <Input aria-label="Licence link" placeholder="Licence link" value={t.licence.url} onChange={(e) => set({ licence: { ...t.licence, url: e.target.value } })} className="!py-1 !text-xs" />
        </div>
      )}
      {!gen && t.licence.kind === 'unknown' && <p className="text-warning">AZ Studio cannot check rights: record where this music comes from and its licence before publishing.</p>}
    </li>
  );
}

export function SoundStage(props: StageProps) {
  const { project, spec, update, work, comp, score, aspect } = props;
  const caps = useCaps();
  const audio = useAudition();
  const { submit, busy: sampling, dialog } = useJobSubmitter();
  const [sampleJob, setSampleJob] = useState<string | null>(null);
  const [pickMusic, setPickMusic] = useState(false);
  const [wholeUploading, setWholeUploading] = useState(false);
  const wholeRef = useRef<HTMLInputElement>(null);
  const srtRef = useRef<HTMLInputElement>(null);
  const idx = useMemo(() => jobIndex(props.jobs), [props.jobs]);
  const voices = caps?.speech.voices ?? ['Sulafat'];
  const languageOk = speechLanguageSupported(spec.setup.language);
  const narrated = spec.scenes.filter((s) => s.narration.trim());
  const voiced = narrated.filter((s) => comp.voices[s.id]?.take && !comp.voices[s.id]?.stale).length;
  const setSound = (fn: (s: LiteSpec['sound']) => LiteSpec['sound'], label = 'sound') => update((s) => ({ ...s, sound: fn(s.sound) }), label);
  const setSubs = (patch: Partial<LiteSpec['subtitles']>) => update((s) => ({ ...s, subtitles: { ...s.subtitles, ...patch } }), 'subtitles');
  const sampleTake = sampleJob ? props.jobs.find((j) => j.id === sampleJob) : null;
  const sampleAsset = sampleTake?.status === 'completed' ? sampleTake.result?.assetIds?.[0] ?? null : null;

  const sample = async () => {
    const first = (spec.scenes[0]?.narration || spec.story.script).split(/(?<=[.!?])\s+/)[0]?.slice(0, 240) ?? '';
    if (!first.trim()) return toast.error('Write some narration first.');
    const ids = await submit([{ type: 'lite.narration', projectId: project.id, mode: 'tts', sceneId: 'voice-sample', text: first, spokenText: spokenText(first, spec.pronunciation), voice: spec.voice.voice, direction: voiceDirection(spec.voice), languageCode: spec.setup.language, vocabulary: [], scenes: [], inputHash: stableHash({ first, v: spec.voice }), label: `Voice sample · ${spec.voice.voice}` }], { label: 'Voice sample', alwaysConfirm: true });
    if (ids?.[0]) setSampleJob(ids[0]);
  };

  const uploadWhole = async (file: File) => {
    setWholeUploading(true);
    try {
      const assetId = await uploadFile(file, { kind: 'audio', projectId: project.id, collections: ['lite:narration'] });
      update((s) => ({ ...s, voice: { ...s.voice, wholeAssetId: assetId } }), 'voice');
      toast.success('Narration uploaded', { description: 'Now time it against the script to find each scene.' });
    } catch (e) {
      toast.error('Upload failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setWholeUploading(false);
    }
  };

  const importSubs = async (file: File) => {
    const cues = parseSubtitles(await file.text());
    if (!cues.length) return toast.error('No subtitles found in that file.');
    const byScene = importCuesToScenes(cues, comp.timing);
    update((s) => ({ ...s, scenes: s.scenes.map((sc) => (byScene[sc.id] ? { ...sc, subtitleOverrides: byScene[sc.id]! } : sc)) }), 'subtitles');
    toast.success(`Imported ${cues.length} subtitles`, { description: 'They now follow each scene if timing changes. Times are as written in the file.' });
  };

  const cues = comp.assembly.cues;
  const movements = (score?.movements ?? []).slice().sort((a, b) => a.index - b.index);
  const composing = props.jobs.filter((j) => j.type === 'music.generate' && ['queued', 'validating', 'generating', 'downloading'].includes(j.status));

  return (
    <>
      <Section title="Voice" sub="Narration is spoken (or recorded), measured, and every word is timed from the actual audio — that timing drives the edit and the subtitles.">
        <Segmented
          label="Narration source"
          value={spec.voice.mode}
          onChange={(v: LiteSpec['voice']['mode']) => update((s) => ({ ...s, voice: { ...s.voice, mode: v } }), 'voice')}
          options={[
            { value: 'generate', label: 'Studio voice' },
            { value: 'upload_whole', label: 'One recording of everything' },
            { value: 'upload_scenes', label: 'A recording per scene' },
          ]}
        />
        {spec.voice.mode === 'generate' && (
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            <Field label="Voice">
              <Select aria-label="Voice" value={spec.voice.voice} onChange={(e) => update((s) => ({ ...s, voice: { ...s.voice, voice: e.target.value } }), 'voice')}>
                {voices.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Delivery" hint="Directions are followed approximately — the speech model has no numeric speed or pitch controls.">
              <Textarea rows={2} value={spec.voice.delivery} onChange={(e) => update((s) => ({ ...s, voice: { ...s.voice, delivery: e.target.value } }), 'delivery')} />
            </Field>
            <Field label="Pace">
              <Segmented label="Pace" value={spec.voice.pace} onChange={(v: LiteSpec['voice']['pace']) => update((s) => ({ ...s, voice: { ...s.voice, pace: v } }), 'voice')} options={[{ value: 'slow', label: 'Slow' }, { value: 'measured', label: 'Measured' }, { value: 'natural', label: 'Natural' }]} />
            </Field>
            <div className="flex flex-wrap items-end gap-2">
              <Button variant="ghost" icon={<Mic className="size-4" />} loading={sampling || (sampleTake ? !['completed', 'failed', 'cancelled'].includes(sampleTake.status) : false)} onClick={() => void sample()}>
                Hear a sample line
              </Button>
              {sampleAsset && (
                <Button variant="secondary" icon={audio.playing === sampleAsset ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={() => void audio.play(sampleAsset)}>
                  {audio.playing === sampleAsset ? 'Stop' : 'Play sample'}
                </Button>
              )}
              {sampleTake?.status === 'failed' && <span className="text-xs text-danger">{sampleTake.error?.message}</span>}
            </div>
          </div>
        )}
        {spec.voice.mode === 'generate' && !languageOk && (
          <Notice tone="warning" className="mt-3" icon={<TriangleAlert className="size-4" />}>
            The studio voices do not document {spec.setup.language} — they may mispronounce it. For Kasem and other less-supported languages, record the narration (one file or per scene) or keep the studio voice for English passages only.
          </Notice>
        )}
        {spec.voice.mode === 'upload_whole' && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {spec.voice.wholeAssetId ? <WholeRecording assetId={spec.voice.wholeAssetId} audio={audio} /> : <span className="text-sm text-faint">No recording yet.</span>}
            <Button variant="ghost" icon={<Upload className="size-4" />} loading={wholeUploading} onClick={() => wholeRef.current?.click()}>
              {spec.voice.wholeAssetId ? 'Replace recording' : 'Upload narration'}
            </Button>
            <input ref={wholeRef} type="file" accept="audio/*" className="hidden" onChange={(e) => e.target.files?.[0] && void uploadWhole(e.target.files[0])} />
            <Button variant="primary" icon={<AudioLines className="size-4" />} disabled={!spec.voice.wholeAssetId || Boolean(work.busy)} loading={work.busy === 'narration'} onClick={() => void work.run('narration')}>
              Find each scene in the recording
            </Button>
          </div>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Badge>{voiced}/{narrated.length} scenes voiced</Badge>
          {spec.voice.mode === 'generate' && (
            <Button variant="primary" icon={<Wand2 className="size-4" />} disabled={!narrated.length || Boolean(work.busy)} loading={work.busy === 'narration'} onClick={() => void work.run('narration')}>
              Review & voice {narrated.length - voiced > 0 ? `${narrated.length - voiced} scene${narrated.length - voiced === 1 ? '' : 's'}` : 'scenes'}
            </Button>
          )}
        </div>
        <ul className="mt-3 space-y-2">
          {spec.scenes.map((s, i) => (
            <TakeRow key={s.id} scene={s} index={i} voice={comp.voices[s.id]} props={props} audio={audio} />
          ))}
        </ul>
      </Section>

      <Section
        title="Subtitles"
        sub="Timed from the narration audio. Changing their look never regenerates speech or images."
        action={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={<FileUp className="size-3.5" />} onClick={() => srtRef.current?.click()}>
              Import SRT / VTT
            </Button>
            <input ref={srtRef} type="file" accept=".srt,.vtt,text/vtt" className="hidden" onChange={(e) => e.target.files?.[0] && void importSubs(e.target.files[0])} />
            <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} disabled={!cues.length} onClick={() => download(`${project.title}-${aspect.replace(':', 'x')}.srt`, formatSrt(cues), 'application/x-subrip')}>
              SRT
            </Button>
            <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} disabled={!cues.length} onClick={() => download(`${project.title}-${aspect.replace(':', 'x')}.vtt`, formatVtt(cues), 'text/vtt')}>
              VTT
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap gap-5">
          <Toggle checked={spec.subtitles.enabled} onChange={(v) => setSubs({ enabled: v })} label="Subtitles" />
          <Toggle checked={spec.subtitles.burnIn} onChange={(v) => setSubs({ burnIn: v })} label="Burn into the picture" description="Off: deliver them only as SRT / VTT files." />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4" role="radiogroup" aria-label="Subtitle style">
          {SUBTITLE_PRESETS.map((p) => (
            <SubtitleSample key={p} preset={p} aspect={aspect} spec={spec} active={spec.subtitles.preset === p} onClick={() => setSubs({ preset: p, font: p === 'serif' ? 'EB Garamond' : spec.subtitles.font === 'EB Garamond' ? 'Inter' : spec.subtitles.font, contrast: p === 'boxed' ? 'box' : spec.subtitles.contrast === 'box' ? 'shadow' : spec.subtitles.contrast })} />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <LabeledSlider label="Size" value={spec.subtitles.sizePct} display={`${spec.subtitles.sizePct.toFixed(1)} % of height`} min={3} max={7} step={0.1} onChange={(v) => setSubs({ sizePct: v })} />
          <LabeledSlider label="Lift from the bottom" value={spec.subtitles.lift} display={`+${Math.round(spec.subtitles.lift * 100)} %`} min={0} max={0.2} step={0.01} onChange={(v) => setSubs({ lift: v })} />
          <Field label="Contrast">
            <Segmented size="sm" label="Contrast" value={spec.subtitles.contrast} onChange={(v: LiteSpec['subtitles']['contrast']) => setSubs({ contrast: v })} options={[{ value: 'shadow', label: 'Shadow' }, { value: 'outline', label: 'Outline' }, { value: 'box', label: 'Box' }]} />
          </Field>
          <Field label="Font" hint="Noto Sans covers Kasem letters (ɛ ɔ ŋ and tone marks).">
            <Select aria-label="Subtitle font" value={spec.subtitles.font} onChange={(e) => setSubs({ font: e.target.value as LiteSpec['subtitles']['font'] })}>
              {(['Inter', 'EB Garamond', 'Noto Sans', 'DejaVu Sans'] as const).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <SubtitleEditor props={props} />
      </Section>

      <Section title="Music" sub="One musical identity across the film: movements share a theme and crossfade, following the story’s intensity, with deliberate silences.">
        <Segmented label="Music source" value={spec.sound.music.mode} onChange={(v: LiteSpec['sound']['music']['mode']) => setSound((s) => ({ ...s, music: { ...s.music, mode: v } }), 'music')} options={[{ value: 'score', label: 'Generated score' }, { value: 'tracks', label: 'My music' }, { value: 'none', label: 'No music' }]} />
        {spec.sound.music.mode === 'score' && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Field label="Style">
                <Input value={spec.sound.music.identity.style} onChange={(e) => setSound((s) => ({ ...s, music: { ...s.music, identity: { ...s.music.identity, style: e.target.value } } }), 'music')} />
              </Field>
              <Field label="Instruments" hint="Comma separated.">
                <Input value={spec.sound.music.identity.instrumentation.join(', ')} onChange={(e) => setSound((s) => ({ ...s, music: { ...s.music, identity: { ...s.music.identity, instrumentation: e.target.value.split(',').map((x) => x.trim()) } } }), 'music')} />
              </Field>
              <Field label="Main theme (motif)">
                <Input value={spec.sound.music.identity.motif} placeholder="e.g. a four-note falling figure on the kologo" onChange={(e) => setSound((s) => ({ ...s, music: { ...s.music, identity: { ...s.music.identity, motif: e.target.value } } }), 'music')} />
              </Field>
              <Field label="Key and tempo">
                <div className="flex items-center gap-2">
                  <Input aria-label="Key" placeholder="Key (optional)" value={spec.sound.music.identity.key} onChange={(e) => setSound((s) => ({ ...s, music: { ...s.music, identity: { ...s.music.identity, key: e.target.value } } }), 'music')} />
                  <Input aria-label="Slowest tempo" type="number" className="!w-20" value={spec.sound.music.identity.tempo[0]} onChange={(e) => setSound((s) => ({ ...s, music: { ...s.music, identity: { ...s.music.identity, tempo: [Number(e.target.value) || 60, s.music.identity.tempo[1]] } } }), 'music')} />
                  <span className="text-faint">–</span>
                  <Input aria-label="Fastest tempo" type="number" className="!w-20" value={spec.sound.music.identity.tempo[1]} onChange={(e) => setSound((s) => ({ ...s, music: { ...s.music, identity: { ...s.music.identity, tempo: [s.music.identity.tempo[0], Number(e.target.value) || 90] } } }), 'music')} />
                  <span className="text-xs text-faint">BPM</span>
                </div>
              </Field>
            </div>
            {comp.timing.estimated && <Notice tone="warning">Voice the narration first: the score is composed to the measured timing of each scene.</Notice>}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" icon={<Music2 className="size-4" />} disabled={!spec.scenes.length || Boolean(work.busy)} loading={work.busy === 'music'} onClick={() => void work.run('music')}>
                {movements.length ? 'Compose missing movements' : 'Plan & compose the score'}
              </Button>
              {composing.length > 0 && (
                <Badge tone="accent" icon={<LoaderCircle className="size-3 animate-spin" />}>
                  {composing.length} composing
                </Badge>
              )}
            </div>
            {movements.length > 0 && (
              <ul className="space-y-2">
                {movements.map((m) => {
                  const span = m.end - m.start;
                  const short = m.durationSec !== null && m.durationSec < span - 0.5;
                  const fit = spec.sound.music.fit[m.id] ?? 'loop';
                  const job = idx.forTarget('score', 'lite-score').find((j) => (j.params as { movementId?: string }).movementId === m.id);
                  return (
                    <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-3 text-xs">
                      <span className="text-sm text-fg">Movement {m.index + 1}</span>
                      <span className="text-faint">{fmtSec(m.start)} – {fmtSec(m.end)}</span>
                      <Badge tone={m.assetId ? 'success' : m.status === 'failed' ? 'danger' : m.status === 'generating' ? 'accent' : 'neutral'}>{m.assetId ? `Ready · ${fmtSec(m.durationSec ?? 0)}` : m.status === 'generating' ? 'Composing…' : m.status === 'failed' ? 'Failed' : 'Planned'}</Badge>
                      {short && (
                        <>
                          <span className="text-warning">{(span - (m.durationSec ?? 0)).toFixed(1)} s shorter than its scenes</span>
                          <Segmented size="sm" label="Fill" value={fit} onChange={(v: 'loop' | 'end') => setSound((s) => ({ ...s, music: { ...s.music, fit: { ...s.music.fit, [m.id]: v } } }), 'music')} options={[{ value: 'loop', label: 'Crossfaded reuse' }, { value: 'end', label: 'End early' }]} />
                        </>
                      )}
                      <span className="flex-1" />
                      {m.assetId && (
                        <IconButton size="sm" label={audio.playing === m.assetId ? 'Stop' : 'Play movement'} onClick={() => void audio.play(m.assetId!)}>
                          {audio.playing === m.assetId ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                        </IconButton>
                      )}
                      <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} disabled={m.status === 'generating' || Boolean(work.busy)} onClick={() => void work.run('music', { targetIds: [m.id], force: Boolean(m.assetId) })}>
                        {m.assetId ? 'Recompose' : 'Compose'}
                      </Button>
                      {m.status === 'failed' && <span className="w-full text-danger">{m.error ?? job?.error?.message}</span>}
                      {m.assetId && <span className="w-full text-faint">Generated by the studio music model ({score?.title ? `“${score.title}”, ` : ''}instrumental). Provenance is recorded with the file.</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {spec.sound.music.mode === 'tracks' && (
          <div className="mt-4 space-y-3">
            <ul className="space-y-2">
              {spec.sound.music.tracks.map((t) => (
                <TrackRow key={t.id} t={t} props={props} />
              ))}
            </ul>
            <Button variant="ghost" icon={<Music2 className="size-4" />} onClick={() => setPickMusic(true)}>
              Add music from upload or library
            </Button>
            <AssetPicker open={pickMusic} onOpenChange={setPickMusic} kinds={['audio']} projectId={project.id} title="Choose music" onPick={(as) => as[0] && setSound((s) => ({ ...s, music: { ...s.music, tracks: [...s.music.tracks, { id: liteId('mt'), assetId: as[0]!.id, fromSceneId: null, fit: 'loop', gainDb: 0, licence: { kind: as[0]!.generation ? 'generated' : 'unknown', source: '', attribution: '', url: '' } }] } }), 'track')} />
          </div>
        )}
      </Section>

      <Section
        title="Ambience and sound"
        sub="Restrained atmosphere gives the image a world beyond its frame. Synthesised beds are filtered noise made locally (not field recordings, no AI cost); upload real recordings for specific places."
        action={
          <Button variant="secondary" icon={<Wind className="size-4" />} disabled={!spec.scenes.some((s) => s.ambience.kind !== 'none' && s.ambience.kind !== 'upload') || Boolean(work.busy)} loading={work.busy === 'ambience'} onClick={() => void work.run('ambience')}>
            Make ambience beds
          </Button>
        }
      >
        <ul className="divide-y divide-line rounded-xl border border-line">
          {spec.scenes.map((s, i) => (
            <AmbienceRow key={s.id} scene={s} index={i} props={props} ready={s.ambience.kind !== 'none' && s.ambience.kind !== 'upload' ? Boolean(comp.beds[s.ambience.kind]) : true} />
          ))}
        </ul>
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <LabeledSlider label="Narration" value={spec.sound.levels.voiceDb} display={`${spec.sound.levels.voiceDb} dB`} min={-12} max={6} step={1} onChange={(v) => setSound((s) => ({ ...s, levels: { ...s.levels, voiceDb: v } }))} />
          <LabeledSlider label="Music" value={spec.sound.levels.musicDb} display={`${spec.sound.levels.musicDb} dB`} min={-36} max={0} step={1} onChange={(v) => setSound((s) => ({ ...s, levels: { ...s.levels, musicDb: v } }))} />
          <LabeledSlider label="Ambience" value={spec.sound.levels.ambienceDb} display={`${spec.sound.levels.ambienceDb} dB`} min={-42} max={-6} step={1} onChange={(v) => setSound((s) => ({ ...s, levels: { ...s.levels, ambienceDb: v } }))} />
          <LabeledSlider label="Sound effects" value={spec.sound.levels.effectsDb} display={`${spec.sound.levels.effectsDb} dB`} min={-30} max={0} step={1} onChange={(v) => setSound((s) => ({ ...s, levels: { ...s.levels, effectsDb: v } }))} />
          <LabeledSlider label="Music dips under narration" value={spec.sound.duck.depthDb} display={`−${spec.sound.duck.depthDb} dB`} min={0} max={18} step={1} onChange={(v) => setSound((s) => ({ ...s, duck: { ...s.duck, depthDb: v } }))} />
          <LabeledSlider label="Dip before a line" value={spec.sound.duck.attackSec} display={`${spec.sound.duck.attackSec.toFixed(2)} s`} min={0.1} max={1.5} step={0.05} onChange={(v) => setSound((s) => ({ ...s, duck: { ...s.duck, attackSec: v } }))} />
          <LabeledSlider label="Recovery after a line" value={spec.sound.duck.releaseSec} display={`${spec.sound.duck.releaseSec.toFixed(1)} s`} min={0.3} max={3} step={0.1} onChange={(v) => setSound((s) => ({ ...s, duck: { ...s.duck, releaseSec: v } }))} />
          <LabeledSlider label="Closing hold after the last line" value={spec.sound.endHoldSec} display={`${spec.sound.endHoldSec.toFixed(1)} s`} min={1} max={15} step={0.5} onChange={(v) => setSound((s) => ({ ...s, endHoldSec: v }))} />
        </div>
        <p className="mt-3 text-xs text-faint">The final mix is loudness-normalised with a true-peak ceiling, so nothing clips; the draft mix uses a limiter.</p>
      </Section>
      {dialog}
    </>
  );
}

function WholeRecording({ assetId, audio }: { assetId: string; audio: ReturnType<typeof useAudition> }) {
  const a = useAsset(assetId);
  const wave = useWaveform(assetId);
  return (
    <div className="w-full space-y-1.5">
      <div className="flex items-center gap-2 text-sm">
        <IconButton size="sm" label={audio.playing === assetId ? 'Stop' : 'Play'} onClick={() => void audio.play(assetId)}>
          {audio.playing === assetId ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </IconButton>
        <span className="truncate text-fg">{a.data?.title ?? 'Recording'}</span>
        {a.data?.durationSec ? <span className="timecode text-xs text-faint">{fmtSec(a.data.durationSec)}</span> : null}
      </div>
      {wave && <Waveform peaks={wave} duration={wave.durationSec} height={48} />}
    </div>
  );
}

function AmbienceRow({ scene, index, props, ready }: { scene: LiteScene; index: number; props: StageProps; ready: boolean }) {
  const { update, project } = props;
  const [uploading, setUploading] = useState<'ambience' | 'cue' | null>(null);
  const ambRef = useRef<HTMLInputElement>(null);
  const cueRef = useRef<HTMLInputElement>(null);
  const set = (fn: (s: LiteScene) => LiteScene) => update((sp) => mapScene(sp, scene.id, fn), 'ambience');
  const up = async (file: File, what: 'ambience' | 'cue') => {
    setUploading(what);
    try {
      const id = await uploadFile(file, { kind: 'audio', projectId: project.id, collections: [what === 'cue' ? 'lite:effect' : 'lite:ambience'] });
      if (what === 'ambience') set((s) => ({ ...s, ambience: { ...s.ambience, kind: 'upload', assetId: id } }));
      else set((s) => ({ ...s, soundCue: { label: s.soundCue?.label || file.name.replace(/\.[^.]+$/, ''), assetId: id, atSec: s.soundCue?.atSec ?? 1, levelDb: s.soundCue?.levelDb ?? 0 } }));
    } catch (e) {
      toast.error('Upload failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(null);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
      <span className="w-40 truncate text-dim">
        {String(index + 1).padStart(2, '0')} · {scene.title || `Scene ${index + 1}`}
      </span>
      <Select aria-label="Ambience" value={scene.ambience.kind} onChange={(e) => set((s) => ({ ...s, ambience: { ...s.ambience, kind: e.target.value as LiteScene['ambience']['kind'] } }))} className="!w-auto !py-0.5 !text-xs">
        <option value="none">None</option>
        {AMBIENCE_KINDS.map((k) => (
          <option key={k} value={k}>
            {AMBIENCE_LABELS[k]} (synthesised)
          </option>
        ))}
        <option value="upload">Uploaded recording</option>
      </Select>
      {scene.ambience.kind === 'upload' && (
        <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} loading={uploading === 'ambience'} onClick={() => ambRef.current?.click()}>
          {scene.ambience.assetId ? 'Replace' : 'Upload'}
        </Button>
      )}
      {!ready && <Badge tone="warning">Not made yet</Badge>}
      <Input type="number" aria-label="Ambience level (dB)" min={-12} max={12} step={1} value={scene.ambience.levelDb} onChange={(e) => set((s) => ({ ...s, ambience: { ...s.ambience, levelDb: Number(e.target.value) || 0 } }))} className="!w-16 !py-0.5 !text-xs" />
      <span className="text-faint">dB</span>
      <span className="flex-1" />
      {scene.soundCue?.assetId ? (
        <span className="inline-flex items-center gap-1.5">
          <Input aria-label="Sound cue name" value={scene.soundCue.label} onChange={(e) => set((s) => ({ ...s, soundCue: s.soundCue && { ...s.soundCue, label: e.target.value } }))} className="!w-32 !py-0.5 !text-xs" />
          at
          <Input type="number" aria-label="Sound cue time (s into the scene)" min={0} step={0.1} value={scene.soundCue.atSec} onChange={(e) => set((s) => ({ ...s, soundCue: s.soundCue && { ...s.soundCue, atSec: Math.max(0, Number(e.target.value) || 0) } }))} className="!w-16 !py-0.5 !text-xs" />s
          <IconButton size="sm" label="Remove sound cue" onClick={() => set((s) => ({ ...s, soundCue: null }))}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </span>
      ) : (
        <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} loading={uploading === 'cue'} onClick={() => cueRef.current?.click()}>
          {scene.soundCue?.label ? `Add “${scene.soundCue.label}”` : 'Add sound cue'}
        </Button>
      )}
      <input ref={ambRef} type="file" accept="audio/*" className="hidden" onChange={(e) => e.target.files?.[0] && void up(e.target.files[0], 'ambience')} />
      <input ref={cueRef} type="file" accept="audio/*" className="hidden" onChange={(e) => e.target.files?.[0] && void up(e.target.files[0], 'cue')} />
    </li>
  );
}

/** Per-scene cue list: edit text and timing (kept relative to the scene's first word), or go back to the audio timing. */
function SubtitleEditor({ props }: { props: StageProps }) {
  const { spec, update, comp } = props;
  const [sceneId, setSceneId] = useState<string>(spec.scenes[0]?.id ?? '');
  const scene = spec.scenes.find((s) => s.id === sceneId);
  const st = comp.timing.scenes.find((s) => s.sceneId === sceneId);
  const cues = comp.assembly.cues.filter((c) => c.sceneId === sceneId);
  if (!scene || !st || st.voiceAt === null) return null;
  const voiceAt = st.voiceAt;
  const save = (rows: { start: number; end: number; text: string }[]) => update((s) => mapScene(s, sceneId, (x) => ({ ...x, subtitleOverrides: rows.map((r) => ({ ...r, source: 'manual' as const })) })), 'cues');
  const rows = cues.map((c) => ({ start: Math.round((c.start - voiceAt) * 100) / 100, end: Math.round((c.end - voiceAt) * 100) / 100, text: c.text.replace(/\n/g, ' ') }));
  return (
    <div className="mt-5 rounded-xl border border-line p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-dim">Edit subtitles of</span>
        <Select aria-label="Scene" value={sceneId} onChange={(e) => setSceneId(e.target.value)} className="!w-auto !py-1 !text-xs">
          {spec.scenes.map((s, i) => (
            <option key={s.id} value={s.id}>
              {s.title || `Scene ${i + 1}`}
            </option>
          ))}
        </Select>
        {cues[0] && <Badge tone={cues[0].timing === 'aligned' ? 'success' : cues[0].timing === 'estimated' ? 'warning' : 'violet'}>{cues[0].timing === 'aligned' ? 'Timed from the audio' : cues[0].timing === 'estimated' ? 'Estimated — not word-timed' : cues[0].timing === 'manual' ? 'Edited by hand' : 'Imported'}</Badge>}
        {scene.subtitleOverrides && (
          <Button size="sm" variant="ghost" onClick={() => update((s) => mapScene(s, sceneId, (x) => ({ ...x, subtitleOverrides: null })), 'cues')}>
            Back to audio timing
          </Button>
        )}
      </div>
      <ul className="space-y-1.5">
        {rows.map((r, i) => (
          <li key={i} className="grid grid-cols-[72px_72px_1fr] items-center gap-2">
            <Input type="number" step={0.05} aria-label="Start (s after the first word)" value={r.start} onChange={(e) => save(rows.map((x, k) => (k === i ? { ...x, start: Number(e.target.value) } : x)))} className="!py-1 !text-xs" />
            <Input type="number" step={0.05} aria-label="End" value={r.end} onChange={(e) => save(rows.map((x, k) => (k === i ? { ...x, end: Number(e.target.value) } : x)))} className="!py-1 !text-xs" />
            <Input aria-label="Text" value={r.text} onChange={(e) => save(rows.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} className={cx('!py-1 !text-xs', cues[i]?.confidence !== null && (cues[i]?.confidence ?? 1) < 0.55 && 'border-warning/60')} />
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-faint">Times are seconds after the scene’s first spoken word, so edited subtitles move with the scene. Highlighted lines have uncertain alignment.</p>
    </div>
  );
}
