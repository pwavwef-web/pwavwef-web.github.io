import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AudioWaveform, Music2, Pause, Play, Sparkles, Upload } from 'lucide-react';
import { formatTimecode, LYRIC_CAPTION_MODE_LABELS, productionRange, SECTION_LABELS, snapToBeat, type AudioAnalysisResult, type MvLyricSettings, type SectionLabel, type SongDoc, type SongSection } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { analyzeAssetAudio } from '../../lib/audio-analysis';
import type { WithId } from '../../lib/data';
import { useMediaUrls } from '../../lib/media';
import { createSong, updateSubDoc, useSub } from '../../lib/studio';
import { GenerateMusicForm, LyricsWorkflow, type Transport } from '../../components/lyrics';
import { AssetPicker, useWaveform, Waveform } from '../../components/media';
import { Badge, Button, cx, EmptyState, Field, IconButton, Input, Modal, Notice, Segmented, Select, Toggle } from '../../components/ui';
import { fmtSec, Section, SECTION_COLORS, type MvStageProps } from './common';

/** Plays the song and reports its time (the lyric tools follow it). */
function useSongTransport(src: string | undefined) {
  const audio = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const stopAt = useRef<number | null>(null);
  useEffect(() => {
    const a = audio.current;
    if (!a || !playing) return;
    let raf = 0;
    const tick = () => {
      setTime(a.currentTime);
      if (stopAt.current !== null && a.currentTime >= stopAt.current) {
        a.pause();
        stopAt.current = null;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  const seek = (t: number) => {
    if (audio.current) audio.current.currentTime = Math.max(0, t);
    setTime(Math.max(0, t));
  };
  const transport: Transport = {
    time,
    seek,
    playing,
    pause: () => audio.current?.pause(),
    playRange: (start, end) => {
      seek(start);
      stopAt.current = end;
      void audio.current?.play();
    },
  };
  const element = <audio ref={audio} src={src} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(e) => !playing && setTime(e.currentTarget.currentTime)} />;
  const toggle = () => (playing ? audio.current?.pause() : void audio.current?.play());
  return { transport, element, toggle };
}

function ChooseSong({ props }: { props: MvStageProps }) {
  const { project, update } = props;
  const [picker, setPicker] = useState(false);
  const [composing, setComposing] = useState(false);
  const songs = useSub<SongDoc>(project.id, 'songs', 'createdAt', 'desc');
  const choose = async (assetId: string, title: string, dur: number) => {
    try {
      const id = await createSong(project.id, assetId, title, dur);
      update((s) => ({ ...s, song: { songId: id, range: null }, sections: [] }), 'song');
      toast.success('Song added', { description: 'Detect its beats and sections next — the cuts follow them.' });
    } catch (e) {
      toast.error('Could not add the song', { description: errorMessage(e) });
    }
  };
  return (
    <>
      <EmptyState
        icon={<Music2 className="size-5" />}
        title="Start with the song"
        body="Upload the finished track (MP3, WAV, FLAC, M4A…), choose one from your library, or generate music and lyrics. The video is cut to its beats and sections, and its lyrics become the captions."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setPicker(true)}>
              Upload or choose song
            </Button>
            <Button icon={<Sparkles className="size-4" />} onClick={() => setComposing(true)}>
              Generate music and lyrics
            </Button>
          </div>
        }
      />
      {songs.data.length > 0 && (
        <Section title="Songs in this project" sub="A generated song lands here when it is ready.">
          <ul className="divide-y divide-line rounded-xl border border-line">
            {songs.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-fg">{s.title || 'Song'}</p>
                  <p className="text-xs text-faint">
                    {fmtSec(s.durationSec || 0)}
                    {s.lyricsSheet?.lines.length ? ` · ${s.lyricsSheet.lines.length} lyric lines` : s.instrumental ? ' · instrumental' : ''}
                  </p>
                </div>
                <Button size="sm" onClick={() => update((sp) => ({ ...sp, song: { songId: s.id, range: null }, sections: [] }), 'song')}>
                  Use this song
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <AssetPicker open={picker} onOpenChange={setPicker} kinds={['audio']} projectId={project.id} onPick={(a) => a[0] && void choose(a[0].id, a[0].title, a[0].durationSec ?? 0)} title="Choose the song" />
      <Modal open={composing} onOpenChange={setComposing} size="lg" title="Generate music and lyrics" description="Lyria composes a full song; its lyrics and structure are stored and aligned to the vocals. It appears under “Songs in this project” when ready.">
        <GenerateMusicForm project={project} song={null} onDone={() => setComposing(false)} />
      </Modal>
    </>
  );
}

function SongStructure({ song, analysis, onChange }: { song: WithId<SongDoc>; analysis: NonNullable<SongDoc['analysis']>; onChange: (sections: SongSection[]) => void }) {
  const set = (i: number, patch: Partial<SongSection>) => onChange(analysis.sections.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
    <ul className="space-y-1.5">
      {analysis.sections.map((s, i) => (
        <li key={s.id} className="grid grid-cols-[120px_minmax(0,1fr)_90px] items-center gap-2">
          <Select value={s.label} onChange={(e) => set(i, { label: e.target.value as SectionLabel })} className="!py-1.5 text-xs" aria-label="Section type">
            {SECTION_LABELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          <Input value={s.name} onChange={(e) => set(i, { name: e.target.value })} className="!py-1.5 text-xs" aria-label="Section name" />
          <span className="timecode text-right text-xs text-faint" title={`${song.title} · ${s.start.toFixed(2)}–${s.end.toFixed(2)} s`}>
            {formatTimecode(s.start, 0)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SongStage(props: MvStageProps) {
  const { project, spec, update, songDoc, go } = props;
  const urls = useMediaUrls(songDoc?.audioAssetId ?? null);
  const serverPeaks = useWaveform(songDoc?.audioAssetId ?? null);
  const [peaks, setPeaks] = useState<AudioAnalysisResult['peaks'] | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const { transport, element, toggle } = useSongTransport(urls?.file);

  if (!spec.song.songId) return <ChooseSong props={props} />;
  if (!songDoc) return <Notice>Loading the song…</Notice>;
  const song = songDoc;
  const duration = song.durationSec || 0;
  const analysis = song.analysis ?? null;
  const range = productionRange(spec.song.range, duration);
  const whole = !spec.song.range;
  const grid = analysis?.downbeats.length ? analysis.downbeats : analysis?.beats ?? [];
  const snap = (t: number) => (grid.length ? snapToBeat(t, grid) : Math.round(t * 10) / 10);
  const setRange = (start: number, end: number) => update((s) => ({ ...s, song: { ...s.song, range: { start: Math.max(0, Math.min(start, end - 4)), end: Math.min(duration, Math.max(end, start + 4)) } } }), 'range');

  const analyse = async () => {
    try {
      const r = await analyzeAssetAudio(song.audioAssetId, setStage);
      setPeaks(r.peaks);
      await updateSubDoc(project.id, 'songs', song.id, { durationSec: r.durationSec, analysis: { bpm: r.bpm, beats: r.beats, downbeats: r.downbeats, energy: r.energy, energyHop: r.energyHop, sections: r.sections, method: 'dsp', analyzedAt: Date.now() } });
      toast.success(`${r.bpm} BPM · ${r.sections.length} sections · ${r.downbeats.length} bars`, { description: 'Measured in your browser from the real audio — no AI call. Correct the section names if they are wrong.' });
    } catch (e) {
      toast.error('Analysis failed', { description: errorMessage(e) });
    } finally {
      setStage(null);
    }
  };
  const lyrics = (patch: Partial<MvLyricSettings>) => update((s) => ({ ...s, lyrics: { ...s.lyrics, ...patch } }), 'lyrics');
  const sheet = song.lyricsSheet ?? null;
  const timed = sheet?.lines.filter((l) => l.start !== null).length ?? 0;

  return (
    <>
      {element}
      <Section
        title={song.title || 'Song'}
        sub={`${fmtSec(duration)}${analysis ? ` · ${analysis.bpm} BPM · ${analysis.downbeats.length} bars · ${analysis.sections.length} sections` : ' · beats not detected yet'}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <IconButton label={transport.playing ? 'Pause' : 'Play'} onClick={toggle}>
              {transport.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </IconButton>
            <Button size="sm" variant={analysis ? 'ghost' : 'primary'} loading={Boolean(stage)} icon={<AudioWaveform className="size-4" />} onClick={() => void analyse()}>
              {stage ?? (analysis ? 'Re-detect beats & sections' : 'Detect beats & sections')}
            </Button>
            <Button size="sm" variant="ghost" icon={<Upload className="size-4" />} onClick={() => setReplacing(true)}>
              Change song
            </Button>
          </div>
        }
      >
        <Waveform
          peaks={peaks ?? serverPeaks}
          duration={duration || 1}
          playhead={transport.time}
          height={110}
          beats={analysis?.downbeats}
          range={whole ? null : range}
          regions={analysis?.sections.map((s) => ({ start: s.start, end: s.end, color: SECTION_COLORS[s.label] ?? SECTION_COLORS.other!, label: s.name }))}
          onSeek={transport.seek}
        />
        <p className="timecode mt-1 text-xs text-faint">
          {formatTimecode(transport.time)} / {formatTimecode(duration)}
        </p>
        {!analysis && <Notice className="mt-3">Detect the beats and sections first: every cut lands on the beat grid, and the shot plan follows the song’s structure.</Notice>}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <Field label="Part of the song" hint="A shorter cut for social video; cuts snap to bar lines. The song fades where it is cut.">
              <Segmented size="sm" label="Part of the song" value={whole ? 'whole' : 'part'} onChange={(v) => (v === 'whole' ? update((s) => ({ ...s, song: { ...s.song, range: null } }), 'range') : setRange(0, Math.min(duration, 60)))} options={[{ value: 'whole', label: 'Whole song' }, { value: 'part', label: 'A part' }]} />
            </Field>
            {!whole && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="From (s)">
                  <Input type="number" step={0.1} value={range.start} onChange={(e) => setRange(Number(e.target.value) || 0, range.end)} className="!w-24" />
                </Field>
                <Field label="To (s)">
                  <Input type="number" step={0.1} value={range.end} onChange={(e) => setRange(range.start, Number(e.target.value) || duration)} className="!w-24" />
                </Field>
                <Button size="sm" variant="ghost" onClick={() => setRange(snap(transport.time), range.end)}>
                  Start at playhead
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRange(range.start, snap(transport.time))}>
                  End at playhead
                </Button>
                <Button size="sm" variant="ghost" icon={<Play className="size-3.5" />} onClick={() => transport.playRange(range.start, range.end)}>
                  Play the part
                </Button>
                <Badge>{fmtSec(range.end - range.start)}</Badge>
              </div>
            )}
            {spec.sections.length > 0 && <p className="text-xs text-faint">Changing the part or the sections after planning keeps your shots; replan on the Shots stage to follow the new structure.</p>}
          </div>
          <div>
            <p className="eyebrow mb-2">Sections (from the audio — correct the names if needed)</p>
            {analysis ? <SongStructure song={song} analysis={analysis} onChange={(sections) => void updateSubDoc(project.id, 'songs', song.id, { analysis: { ...analysis, sections } })} /> : <p className="text-sm text-faint">Not detected yet.</p>}
          </div>
        </div>
      </Section>

      <Section title="Lyrics" sub="Synchronised to the vocals word by word; the captions are placed from this sheet. The text is never rewritten by AI.">
        <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Toggle checked={spec.lyrics.enabled} onChange={(v) => lyrics({ enabled: v })} label="Lyric captions" description="Off for a video without words on screen." />
          <Toggle checked={spec.lyrics.burnIn} disabled={!spec.lyrics.enabled} onChange={(v) => lyrics({ burnIn: v })} label="Burn into the picture" description="Otherwise only the LRC / SRT files are exported." />
          <Field label="How lyrics appear">
            <Select value={spec.lyrics.mode} disabled={!spec.lyrics.enabled} onChange={(e) => lyrics({ mode: e.target.value as MvLyricSettings['mode'] })}>
              {(['karaoke', 'line', 'phrase', 'subtitle'] as const).map((m) => (
                <option key={m} value={m}>
                  {LYRIC_CAPTION_MODE_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {song.instrumental ? (
          <Notice>
            This song is marked instrumental — no lyrics and no captions.{' '}
            <Button size="sm" variant="ghost" onClick={() => void updateSubDoc(project.id, 'songs', song.id, { instrumental: false })}>
              It has vocals
            </Button>
          </Notice>
        ) : (
          <>
            <LyricsWorkflow project={project} song={song} transport={transport} peaks={peaks ?? serverPeaks} />
            {!sheet?.lines.length && (
              <Button className="mt-3" size="sm" variant="ghost" onClick={() => void updateSubDoc(project.id, 'songs', song.id, { instrumental: true })}>
                The song is instrumental
              </Button>
            )}
          </>
        )}
        <div className={cx('mt-4 flex flex-wrap items-center gap-2 text-xs')}>
          {sheet && <Badge tone={sheet.status === 'approved' ? 'success' : 'warning'}>{sheet.status === 'approved' ? 'Lyrics approved' : 'Lyrics not approved yet'}</Badge>}
          {sheet && <Badge tone={timed === sheet.lines.length ? 'success' : timed ? 'warning' : 'neutral'}>{timed}/{sheet.lines.length} lines timed</Badge>}
          <span className="flex-1" />
          <Button size="sm" variant="secondary" disabled={!analysis} onClick={() => go('concept')}>
            Concept →
          </Button>
        </div>
      </Section>
      <AssetPicker
        open={replacing}
        onOpenChange={setReplacing}
        kinds={['audio']}
        projectId={project.id}
        title="Choose another song"
        onPick={async (a) => {
          const x = a[0];
          if (!x) return;
          try {
            const id = await createSong(project.id, x.id, x.title, x.durationSec ?? 0);
            update((s) => ({ ...s, song: { songId: id, range: null } }), 'song');
            toast.success('Song changed', { description: 'Detect its beats and sections, then replan the shots.' });
          } catch (e) {
            toast.error('Could not change the song', { description: errorMessage(e) });
          }
        }}
      />
    </>
  );
}
