import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Film, FileText, Image as ImageIcon, Mic, Music2, Repeat, Save, Scissors, Sparkles, Upload, Wand2 } from 'lucide-react';
import {
  EMPTY_BRIEF,
  languageName,
  MUSIC_MODE_LABELS,
  MUSIC_MODES,
  needsLanguageVerification,
  structureTimeline,
  type MusicBrief,
  type MusicMode,
  type MusicProjectDoc,
  type MusicVersionDoc,
  type ProjectDoc,
  type SongDoc,
} from '@az-studio/shared';
import { useAiRun } from '../../lib/ai';
import { errorMessage } from '../../lib/api';
import { musicAddVersion, saveContinuity } from '../../lib/continuity';
import { useDoc, type WithId } from '../../lib/data';
import { useBoot } from '../../lib/session';
import { updateSubDoc } from '../../lib/studio';
import { useJobSubmitter } from '../jobs';
import { LyricsWorkflow, useMusicAvailability } from '../lyrics';
import { AssetPicker, AssetThumb, UploadZone, useAsset, useWaveform, type Asset } from '../media';
import { Badge, Button, Card, cx, EmptyState, Field, Notice, Segmented, Textarea } from '../ui';
import { BriefForm } from './brief-form';
import { TransportBar, useAudioTransport } from './transport';

export type MusicProject = WithId<MusicProjectDoc>;
export type MusicVersion = WithId<MusicVersionDoc>;

const MODE_ICON: Record<MusicMode, React.ReactNode> = {
  lyrics_only: <FileText className="size-4" />,
  song: <Music2 className="size-4" />,
  instrumental: <Music2 className="size-4" />,
  film_score: <Film className="size-4" />,
  jingle: <Sparkles className="size-4" />,
  upload: <Upload className="size-4" />,
  alternate: <Repeat className="size-4" />,
  intro_outro: <Scissors className="size-4" />,
  scene_background: <Film className="size-4" />,
  from_media: <ImageIcon className="size-4" />,
};

const MODE_HELP: Record<MusicMode, string> = {
  lyrics_only: 'Gemini writes lyrics from the brief; nothing is sung yet. Generate the song later and they are sung exactly.',
  song: 'Lyria writes and performs a complete song from the brief (your lyrics are sung exactly when given).',
  instrumental: 'A complete instrumental piece — no vocals and no lyrics.',
  film_score: 'An instrumental cue for a film scene. For a whole film with a cue sheet and musical bible, use Score in the film project.',
  jingle: 'A short, catchy piece (up to 30 seconds).',
  upload: 'Upload finished music: it is analysed (tempo, key, bars, sections, energy, vocals, edit points) and can be arranged, separated and mixed.',
  alternate: 'Another take of the same brief — say what should change. It is a new generation, not an edit of the existing audio.',
  intro_outro: 'A short intro or outro in the song’s style (up to 40 seconds).',
  scene_background: 'Unobtrusive background music for a scene, leaving room for dialogue.',
  from_media: 'Start from an image (sent to Lyria), or from a treatment or screenplay (Gemini drafts the brief first).',
};

const INSTRUMENTAL_MODES: MusicMode[] = ['instrumental', 'film_score', 'scene_background'];

function MediaThumb({ id, onRemove }: { id: string; onRemove: () => void }) {
  const a = useAsset(id);
  return (
    <button type="button" onClick={onRemove} title="Remove" className="w-24 cursor-pointer">
      {a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} aspect="aspect-square" hoverPlay={false} /> : <div className="aspect-square rounded-lg bg-white/5" />}
    </button>
  );
}

/** Saves the editable parts of a music project (server-owned links are kept by the API). */
export function saveMusicProject(projectId: string, mp: MusicProject, patch: Partial<Pick<MusicProjectDoc, 'mode' | 'brief' | 'lyricsText' | 'sections' | 'markers' | 'mix'>>) {
  const { id: _id, updatedAt: _u, ...rest } = mp;
  void [_id, _u];
  const body = { mode: rest.mode, brief: { ...EMPTY_BRIEF, ...rest.brief }, lyricsText: rest.lyricsText ?? '', lyricsSheetId: rest.lyricsSheetId ?? null, songId: rest.songId ?? null, masterVersionId: rest.masterVersionId ?? null, sections: rest.sections ?? [], markers: rest.markers ?? [], mix: rest.mix, ...patch };
  return saveContinuity(projectId, 'musicProjects', body as unknown as Record<string, unknown>, mp.id);
}

/** Writes lyrics with Gemini from the brief (the text is kept on the music project for generation). */
function useLyricsWriter(projectId: string) {
  const ai = useAiRun(projectId);
  const write = async (brief: MusicBrief): Promise<string | null> => {
    const out = await ai.run<{ sections?: { label: string; name: string; lines: string[] }[]; notes?: string }>(
      'music.lyrics',
      { language: brief.language || 'en', languageName: languageName(brief.language || 'en'), subject: brief.concept || brief.title, structure: structureTimeline(brief).map((p) => p.label).join(', '), tone: brief.mood, genre: [brief.genre, brief.subgenre].filter(Boolean).join(' / '), title: brief.title, notes: brief.culturalDirection },
      'Write song lyrics',
    );
    if (!out?.sections?.length) return null;
    if (out.notes) toast.message('Writer’s notes', { description: out.notes.slice(0, 400) });
    return out.sections.map((s) => `[${s.name || s.label}]\n${s.lines.join('\n')}`).join('\n\n');
  };
  return { write, busy: ai.busy, dialog: ai.dialog };
}

export function CreatePanel({ project, mp, versions }: { project: WithId<ProjectDoc>; mp: MusicProject; versions: MusicVersion[] }) {
  const boot = useBoot();
  const availability = useMusicAvailability();
  const ai = useAiRun(project.id);
  const lyricsWriter = useLyricsWriter(project.id);
  const { submit, busy, dialog } = useJobSubmitter();
  const [mode, setMode] = useState<MusicMode>(mp.mode);
  const [brief, setBrief] = useState<MusicBrief>({ ...EMPTY_BRIEF, ...mp.brief });
  const [lyrics, setLyrics] = useState(mp.lyricsText ?? '');
  const [direction, setDirection] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [mediaText, setMediaText] = useState('');
  const [mediaKind, setMediaKind] = useState<'image' | 'treatment' | 'screenplay'>('image');
  const [picker, setPicker] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const instrumentalMode = INSTRUMENTAL_MODES.includes(mode) || brief.vocals === 'none';
  const unavailable = availability.status?.status === 'unavailable';
  const maxImages = boot?.capabilities.music.maxImageInputs ?? 0;

  const save = async (patch: Partial<Pick<MusicProjectDoc, 'mode' | 'brief' | 'lyricsText'>> = {}) => {
    setSaving(true);
    try {
      await saveMusicProject(project.id, mp, { mode, brief, lyricsText: lyrics, ...patch });
      setDirty(false);
      return true;
    } catch (e) {
      toast.error('Could not save the brief', { description: errorMessage(e) });
      return false;
    } finally {
      setSaving(false);
    }
  };
  const generate = async () => {
    if (!(await save())) return;
    const label = `${MUSIC_MODE_LABELS[mode]}${brief.title ? ` · ${brief.title}` : ''}`;
    const ids = await submit(
      [
        {
          type: 'music.generate',
          projectId: project.id,
          purpose: 'song',
          musicProjectId: mp.id,
          mode,
          alternate: false,
          prompt: direction.trim() || 'brief',
          lyrics: instrumentalMode ? null : lyrics.trim() || null,
          instrumental: instrumentalMode,
          languageCode: brief.language || null,
          imageAssetIds: mode === 'from_media' ? images.slice(0, maxImages) : [],
          title: brief.title || project.title,
          label,
        },
      ],
      { label, alwaysConfirm: true },
    );
    if (ids) toast.success('Generating', { description: 'The new version appears under Versions, analysed and (for songs) with lyrics aligned to the vocals.' });
  };
  const writeLyrics = async () => {
    const text = await lyricsWriter.write(brief);
    if (!text) return;
    setLyrics(text);
    await save({ lyricsText: text });
    toast.success('Lyrics written', { description: needsLanguageVerification(brief.language, 'generated') ? `${languageName(brief.language)} lyrics written by AI must be checked by a fluent speaker.` : 'Edit them freely — they are sung exactly as written.' });
  };
  const briefFromMedia = async () => {
    const out = await ai.run<Partial<MusicBrief> & { instrumentation?: string[]; avoidInstruments?: string[] }>('music.brief_from_media', { kind: mediaKind, text: mediaText, purpose: INSTRUMENTAL_MODES.includes(mode) ? 'an instrumental cue' : 'a song', notes: direction }, 'Music brief from material');
    if (!out) return;
    const next: MusicBrief = {
      ...brief,
      ...(out.title ? { title: out.title } : {}),
      ...(out.concept ? { concept: out.concept } : {}),
      ...(out.genre ? { genre: out.genre } : {}),
      ...(out.subgenre ? { subgenre: out.subgenre } : {}),
      ...(out.mood ? { mood: out.mood } : {}),
      ...(typeof out.tempoBpm === 'number' && out.tempoBpm >= 30 && out.tempoBpm <= 260 ? { tempoBpm: Math.round(out.tempoBpm) } : {}),
      ...(out.key ? { key: out.key } : {}),
      ...(out.vocals ? { vocals: out.vocals } : {}),
      ...(out.vocalCharacter ? { vocalCharacter: out.vocalCharacter } : {}),
      ...(out.instrumentation?.length ? { instrumentation: out.instrumentation.slice(0, 24) } : {}),
      ...(out.energy ? { energy: out.energy } : {}),
      ...(out.culturalDirection ? { culturalDirection: out.culturalDirection } : {}),
      ...(out.avoidInstruments?.length ? { avoidInstruments: out.avoidInstruments.slice(0, 20) } : {}),
    };
    setBrief(next);
    setDirty(true);
    toast.success('Brief drafted from the material', { description: 'Review it, then generate.' });
  };
  const uploaded = async (ids: string[]) => {
    for (const id of ids) {
      try {
        const r = await musicAddVersion(project.id, mp.id, id, 'upload');
        await submit([{ type: 'music.analyze', projectId: project.id, audioAssetId: id, musicProjectId: mp.id, versionId: r.versionId, detectVocals: true, label: 'Analyse uploaded music' }], { label: 'Music analysis' });
      } catch (e) {
        toast.error('Could not add the upload', { description: errorMessage(e) });
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {MUSIC_MODES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setDirty(true);
            }}
            className={cx('cursor-pointer rounded-xl border p-3 text-left text-xs transition-colors', mode === m ? 'border-accent/60 bg-accent/10 text-fg' : 'border-line text-dim hover:text-fg')}
          >
            <span className="flex items-center gap-1.5 text-sm text-fg">
              {MODE_ICON[m]} {MUSIC_MODE_LABELS[m]}
            </span>
          </button>
        ))}
      </div>
      <Notice icon={MODE_ICON[mode]}>{MODE_HELP[mode]}</Notice>
      {unavailable && mode !== 'upload' && mode !== 'lyrics_only' && (
        <Notice tone="danger" icon={<AlertTriangle className="size-4" />}>
          {availability.status!.detail}
        </Notice>
      )}
      {mode === 'upload' ? (
        <Card className="space-y-3 p-4">
          <UploadZone accept="audio/*" kind="audio" projectId={project.id} collections={['music']} label="Upload music (MP3, WAV, FLAC, M4A…)" hint="Each file becomes a version and is analysed; correct anything the analysis gets wrong under Structure." onUploaded={(ids) => void uploaded(ids)} />
        </Card>
      ) : (
        <>
          {mode === 'from_media' && (
            <Card className="space-y-3 p-4">
              <Segmented label="Material" value={mediaKind} onChange={setMediaKind} options={[{ value: 'image', label: 'Image' }, { value: 'treatment', label: 'Treatment' }, { value: 'screenplay', label: 'Screenplay' }]} />
              {mediaKind === 'image' ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {images.map((id) => (
                      <MediaThumb key={id} id={id} onRemove={() => setImages((x) => x.filter((y) => y !== id))} />
                    ))}
                    <Button size="sm" variant="ghost" icon={<ImageIcon className="size-3.5" />} disabled={images.length >= maxImages} onClick={() => setPicker(true)}>
                      Choose image{maxImages > 1 ? 's' : ''}
                    </Button>
                  </div>
                  <p className="text-xs text-faint">{maxImages ? `${boot?.capabilities.music.displayName ?? 'Lyria'} takes up to ${maxImages} image${maxImages === 1 ? '' : 's'} as inspiration alongside the brief.` : 'The music model does not accept images; describe the picture in the concept instead.'}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Textarea rows={6} value={mediaText} onChange={(e) => setMediaText(e.target.value)} placeholder={mediaKind === 'treatment' ? 'Paste the treatment…' : 'Paste the scene or screenplay…'} aria-label="Material" />
                  <Button size="sm" variant="subtle" loading={ai.busy} disabled={!mediaText.trim()} icon={<Wand2 className="size-3.5" />} onClick={() => void briefFromMedia()}>
                    Draft the brief from it
                  </Button>
                </div>
              )}
            </Card>
          )}
          <Card className="p-4">
            <BriefForm brief={brief} instrumentalMode={instrumentalMode} onChange={(b) => {
                setBrief(b);
                setDirty(true);
              }} />
          </Card>
          {!instrumentalMode && (
            <Card className="space-y-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="eyebrow">Lyrics to sing</p>
                <Button size="sm" variant="subtle" loading={lyricsWriter.busy} icon={<Wand2 className="size-3.5" />} disabled={!brief.concept.trim() && !brief.title.trim()} onClick={() => void writeLyrics()}>
                  {lyrics.trim() ? 'Rewrite with AI' : 'Write with AI'}
                </Button>
              </div>
              <Textarea rows={10} value={lyrics} onChange={(e) => {
                  setLyrics(e.target.value);
                  setDirty(true);
                }} placeholder={'[Verse 1]\n…\n\n[Chorus]\n…'} aria-label="Lyrics" />
              <p className="text-[11px] text-faint">Leave empty for the music model to write its own. Lyrics given here are sung exactly — spelling, diacritics and line breaks are kept.</p>
            </Card>
          )}
          {(mode === 'alternate' || mode === 'film_score' || mode === 'scene_background' || mode === 'intro_outro') && (
            <Field label={mode === 'alternate' ? 'What should the alternate change?' : mode === 'intro_outro' ? 'Intro or outro, and for what' : 'The scene and what the music must do'}>
              <Textarea rows={3} value={direction} onChange={(e) => setDirection(e.target.value.slice(0, 2000))} placeholder={mode === 'alternate' ? 'e.g. acoustic, half-time, female lead instead of male' : mode === 'intro_outro' ? 'e.g. a 15-second outro that resolves the chorus melody' : 'e.g. dawn over the market; tension under the conversation, resolving as she smiles'} />
            </Field>
          )}
          {mode === 'alternate' && !versions.length && <Notice tone="warning">There is no version yet to make an alternate of — generate the song first.</Notice>}
        </>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {dirty && <Badge tone="warning">Unsaved</Badge>}
        <Button variant="ghost" loading={saving} icon={<Save className="size-4" />} onClick={() => void save().then((ok) => ok && toast.success('Brief saved'))}>
          Save brief
        </Button>
        {mode === 'lyrics_only' ? (
          <Button variant="primary" loading={lyricsWriter.busy} icon={<Wand2 className="size-4" />} disabled={!brief.concept.trim() && !brief.title.trim()} onClick={() => void writeLyrics()}>
            Write lyrics
          </Button>
        ) : mode !== 'upload' ? (
          <Button variant="primary" loading={busy} disabled={unavailable || (mode === 'alternate' && !versions.length) || (mode === 'from_media' && mediaKind === 'image' && !images.length)} icon={<Sparkles className="size-4" />} onClick={() => void generate()}>
            Generate with {boot?.capabilities.music.displayName ?? 'Lyria'}
          </Button>
        ) : null}
      </div>
      <AssetPicker open={picker} onOpenChange={setPicker} kinds={['image']} projectId={project.id} multiple max={Math.max(1, maxImages - images.length)} onPick={(a) => {
          setImages((x) => [...new Set([...x, ...a.map((y) => y.id)])].slice(0, maxImages));
          setPicker(false);
        }} title="Images to inspire the music" />
      {dialog}
      {ai.dialog}
      {lyricsWriter.dialog}
    </div>
  );
}

/**
 * Lyrics: the text sung in generations, and — once there is audio — the full lyric workflow on the
 * linked song (transcription, alignment to the vocals, uploaded .txt/.lrc/.srt/.vtt kept exactly,
 * uncertain timing flagged, corrections re-synchronised).
 */
export function LyricsPanel({ project, mp, versions }: { project: WithId<ProjectDoc>; mp: MusicProject; versions: MusicVersion[] }) {
  const song = useDoc<SongDoc>(mp.songId ? `projects/${project.id}/songs/${mp.songId}` : null);
  const t = useAudioTransport(song.data?.audioAssetId ?? null);
  const peaks = useWaveform(song.data?.audioAssetId ?? null);
  const lyricsWriter = useLyricsWriter(project.id);
  const { submit, busy, dialog } = useJobSubmitter();
  const [text, setText] = useState(mp.lyricsText ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(mp.lyricsText ?? ''), [mp.lyricsText]);
  const master = versions.find((v) => v.id === mp.masterVersionId) ?? null;
  const s = song.data;
  const saveText = async (value = text) => {
    setSaving(true);
    try {
      await saveMusicProject(project.id, mp, { lyricsText: value });
      toast.success('Lyrics saved', { description: 'They are sung exactly in the next generation.' });
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };
  const followMaster = async () => {
    if (!s || !master) return;
    if (s.lyricsSheet?.lines.some((l) => l.start !== null)) {
      await submit([{ type: 'lyrics.resync_audio', projectId: project.id, songId: s.id, fromAssetId: s.lyricsSheet.timing.audioAssetId ?? s.audioAssetId, toAssetId: master.assetId, label: 'Re-sync lyrics to the master version' }], { label: 'Lyric re-sync' });
    } else {
      await updateSubDoc(project.id, 'songs', s.id, { audioAssetId: master.assetId, durationSec: master.durationSec ?? s.durationSec, analysis: null });
      toast.success('Lyrics now follow the master version');
    }
  };
  return (
    <div className="space-y-4">
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="eyebrow">Lyrics for the next generation</p>
          <div className="flex gap-2">
            <Button size="sm" variant="subtle" loading={lyricsWriter.busy} icon={<Wand2 className="size-3.5" />} onClick={() => void lyricsWriter.write({ ...EMPTY_BRIEF, ...mp.brief }).then((v) => v && (setText(v), void saveText(v)))}>
              Write with AI
            </Button>
            <Button size="sm" variant="primary" loading={saving} icon={<Save className="size-3.5" />} onClick={() => void saveText()}>
              Save
            </Button>
          </div>
        </div>
        <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} aria-label="Lyrics" />
      </Card>
      {!s ? (
        <EmptyState icon={<Mic className="size-5" />} title="No audio yet" body="Generate, upload or record a version: its lyrics are then transcribed or aligned to the vocals here, word by word." />
      ) : (
        <>
          {master && master.assetId !== s.audioAssetId && (
            <Notice tone="warning">
              The lyric timing follows “{versions.find((v) => v.assetId === s.audioAssetId)?.label ?? 'another recording'}”, not the master version “{master.label}”.{' '}
              <Button size="sm" variant="ghost" loading={busy} onClick={() => void followMaster()}>
                Follow the master
              </Button>
            </Notice>
          )}
          <TransportBar t={t} duration={s.durationSec} label={s.title} />
          <LyricsWorkflow project={project} song={s} peaks={peaks} transport={t.transport} />
        </>
      )}
      {dialog}
      {lyricsWriter.dialog}
    </div>
  );
}
