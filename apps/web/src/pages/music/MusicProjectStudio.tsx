import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { AudioWaveform, Download, FileText, Film, Layers, Mic, Music2, PenLine, Plus, Scissors, SlidersHorizontal, Sparkles } from 'lucide-react';
import { DEFAULT_MIX, EMPTY_BRIEF, MUSIC_MODE_LABELS, type MusicProjectDoc } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { saveContinuity, useProjectCollection } from '../../lib/continuity';
import { useProject } from '../../lib/studio';
import { ProjectHeader } from '../../components/project-header';
import { WorkspaceNav, type WorkspaceTab } from '../../components/workspace-nav';
import { Button, EmptyState, ErrorState, Select, Skeleton } from '../../components/ui';
import { CreatePanel, LyricsPanel, type MusicProject, type MusicVersion } from '../../components/music/create';
import { MixerPanel, type AudioTrack } from '../../components/music/mixer';
import { ArrangePanel, StructurePanel } from '../../components/music/structure';
import { ExportPanel, RecordPanel, ScorePanel, VersionsPanel } from '../../components/music/versions';

const GROUPS = [
  { value: 'write', label: 'Write', icon: <PenLine className="size-3.5" /> },
  { value: 'shape', label: 'Shape', icon: <Scissors className="size-3.5" /> },
  { value: 'finish', label: 'Finish', icon: <SlidersHorizontal className="size-3.5" /> },
];

const TABS: WorkspaceTab[] = [
  { value: 'create', label: 'Create', icon: <Sparkles className="size-4" />, group: 'write' },
  { value: 'lyrics', label: 'Lyrics', icon: <FileText className="size-4" />, group: 'write' },
  { value: 'structure', label: 'Structure', icon: <AudioWaveform className="size-4" />, group: 'shape' },
  { value: 'record', label: 'Record or upload', icon: <Mic className="size-4" />, group: 'shape' },
  { value: 'arrange', label: 'Arrange', icon: <Scissors className="size-4" />, group: 'shape' },
  { value: 'mix', label: 'Mix', icon: <SlidersHorizontal className="size-4" />, group: 'finish' },
  { value: 'score', label: 'Score', icon: <Film className="size-4" />, group: 'finish' },
  { value: 'versions', label: 'Versions', icon: <Layers className="size-4" />, group: 'finish' },
  { value: 'export', label: 'Export', icon: <Download className="size-4" />, group: 'finish' },
];

const CUE_MODES = new Set(['film_score', 'scene_background']);

/**
 * Music Studio: a focused AI songwriting, soundtrack and finishing workspace — create from a brief
 * (Lyria 3.5), write and sync lyrics, shape the structure, record or upload, arrange real audio, separate
 * stems, mix with measured loudness, score cues, keep every version and export.
 */
export default function MusicProjectStudio() {
  const { projectId, tab = 'create' } = useParams();
  const navigate = useNavigate();
  const project = useProject(projectId);
  const musicProjects = useProjectCollection<MusicProjectDoc>(projectId, 'musicProjects', { order: 'updatedAt', dir: 'desc' });
  const [mpId, setMpId] = useState<string | null>(null);
  const mp = (musicProjects.data.find((m) => m.id === mpId) ?? musicProjects.data.find((m) => !CUE_MODES.has(m.mode)) ?? musicProjects.data[0] ?? null) as MusicProject | null;
  const versions = useProjectCollection<Omit<MusicVersion, 'id'>>(projectId, 'musicVersions', { where: [['musicProjectId', '==', mp?.id ?? '_']], order: 'index', dir: 'desc' });
  const tracks = useProjectCollection<Omit<AudioTrack, 'id'>>(projectId, 'audioTracks', { where: [['musicProjectId', '==', mp?.id ?? '_']], order: 'order' });
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!mpId && mp) setMpId(mp.id);
  }, [mpId, mp]);
  if (project.loading || musicProjects.loading) return <Skeleton className="h-96" />;
  if (project.error) return <ErrorState error={project.error} />;
  if (!project.data) return <EmptyState title="Project not found" />;
  const p = project.data;
  const create = async () => {
    setCreating(true);
    try {
      const r = await saveContinuity(p.id, 'musicProjects', { mode: 'song', brief: { ...EMPTY_BRIEF, title: p.title }, lyricsText: '', lyricsSheetId: null, songId: null, masterVersionId: null, sections: [], markers: [], mix: DEFAULT_MIX });
      setMpId(r.id);
      navigate(`/projects/${p.id}/studio/create`);
    } catch (e) {
      toast.error('Could not start the music project', { description: errorMessage(e) });
    } finally {
      setCreating(false);
    }
  };
  const cues = musicProjects.data.filter((m) => CUE_MODES.has(m.mode)) as MusicProject[];
  const vs = versions.data as MusicVersion[];
  return (
    <div className="space-y-6">
      <ProjectHeader
        project={p}
        eyebrow="Music Studio"
        actions={
          musicProjects.data.length > 0 ? (
            <>
              <Select className="h-9 w-64" value={mp?.id ?? ''} onChange={(e) => setMpId(e.target.value)} aria-label="Piece">
                {musicProjects.data.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.brief.title || 'Untitled'} · {MUSIC_MODE_LABELS[m.mode]}
                  </option>
                ))}
              </Select>
              <Button size="sm" variant="ghost" loading={creating} icon={<Plus className="size-4" />} onClick={() => void create()}>
                New piece
              </Button>
            </>
          ) : undefined
        }
      />
      {!mp ? (
        <EmptyState
          icon={<Music2 className="size-5" />}
          title="Start a piece of music"
          body="A song, an instrumental, a jingle, score cues or your own recordings — each piece keeps its brief, lyrics, structure, versions and mix."
          action={
            <Button variant="primary" loading={creating} icon={<Plus className="size-4" />} onClick={() => void create()}>
              New piece
            </Button>
          }
        />
      ) : (
        <>
          <WorkspaceNav groups={GROUPS} tabs={TABS} value={tab} advanced onChange={(v) => navigate(`/projects/${p.id}/studio/${v}`)} />
          {tab === 'create' && <CreatePanel key={mp.id} project={p} mp={mp} versions={vs} />}
          {tab === 'lyrics' && <LyricsPanel key={mp.id} project={p} mp={mp} versions={vs} />}
          {tab === 'structure' && <StructurePanel key={mp.id} project={p} mp={mp} versions={vs} />}
          {tab === 'record' && <RecordPanel key={mp.id} project={p} mp={mp} versions={vs} />}
          {tab === 'arrange' && <ArrangePanel key={mp.id} project={p} mp={mp} versions={vs} />}
          {tab === 'mix' && <MixerPanel key={mp.id} project={p} mp={mp} versions={vs} tracks={tracks.data as AudioTrack[]} />}
          {tab === 'score' && (
            <ScorePanel
              project={p}
              cues={cues}
              onOpen={(id) => {
                setMpId(id);
                navigate(`/projects/${p.id}/studio/create`);
              }}
            />
          )}
          {tab === 'versions' && <VersionsPanel key={mp.id} project={p} mp={mp} versions={vs} />}
          {tab === 'export' && <ExportPanel key={mp.id} project={p} mp={mp} versions={vs} />}
        </>
      )}
    </div>
  );
}
