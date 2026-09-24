import { useNavigate, useParams } from 'react-router';
import { BookOpenText, Clapperboard, FileDown, Film, Lightbulb, ListChecks, MapPin, Music, NotebookPen, Package, Palette, ShieldCheck, UserRound } from 'lucide-react';
import { useProject } from '../../lib/studio';
import { ProjectHeader } from '../../components/project-header';
import { BibleBoard } from '../../components/bibles';
import { EmptyState, ErrorState, Skeleton, Tabs } from '../../components/ui';
import { IdeaTab } from './IdeaTab';
import { ScreenplayTab, useScreenplayExtract } from './ScreenplayTab';
import { BreakdownTab } from './BreakdownTab';
import { LookbookTab } from './LookbookTab';
import { FilmShotsTab } from './FilmShotsTab';
import { AssemblyTab } from './AssemblyTab';
import { NotesTab } from './NotesTab';
import { ExportTab } from './ExportTab';
import { ScoreTab } from './ScoreTab';
import { QualityTab } from '../../components/director';

const TABS = [
  { value: 'idea', label: 'Idea & treatment', icon: <Lightbulb className="size-4" /> },
  { value: 'screenplay', label: 'Screenplay', icon: <BookOpenText className="size-4" /> },
  { value: 'breakdown', label: 'Breakdown', icon: <ListChecks className="size-4" /> },
  { value: 'characters', label: 'Characters', icon: <UserRound className="size-4" /> },
  { value: 'locations', label: 'Locations', icon: <MapPin className="size-4" /> },
  { value: 'continuity', label: 'Props & costumes', icon: <Package className="size-4" /> },
  { value: 'lookbook', label: 'Lookbook', icon: <Palette className="size-4" /> },
  { value: 'shots', label: 'Storyboard & shots', icon: <Film className="size-4" /> },
  { value: 'quality', label: 'Quality control', icon: <ShieldCheck className="size-4" /> },
  { value: 'score', label: 'Score', icon: <Music className="size-4" /> },
  { value: 'assembly', label: 'Timeline & render', icon: <Clapperboard className="size-4" /> },
  { value: 'notes', label: 'Notes', icon: <NotebookPen className="size-4" /> },
  { value: 'export', label: 'Export docs', icon: <FileDown className="size-4" /> },
];

export default function FilmStudio() {
  const { projectId, tab = 'idea' } = useParams();
  const navigate = useNavigate();
  const project = useProject(projectId);
  const extract = useScreenplayExtract(project.data ?? null);
  if (project.loading) return <Skeleton className="h-96" />;
  if (project.error) return <ErrorState error={project.error} />;
  if (!project.data) return <EmptyState title="Project not found" />;
  const p = project.data;
  return (
    <div className="space-y-6">
      <ProjectHeader project={p} eyebrow="Film Studio" />
      <Tabs value={tab} onValueChange={(v) => navigate(`/projects/${p.id}/film/${v}`)} tabs={TABS} />
      {tab === 'idea' && <IdeaTab project={p} />}
      {tab === 'screenplay' && <ScreenplayTab project={p} />}
      {tab === 'breakdown' && <BreakdownTab project={p} />}
      {tab === 'characters' && <BibleBoard kind="characters" project={p} onExtract={() => void extract.run('characters')} extracting={extract.busy} />}
      {tab === 'locations' && <BibleBoard kind="locations" project={p} onExtract={() => void extract.run('locations')} extracting={extract.busy} />}
      {tab === 'continuity' && <BibleBoard kind="elements" project={p} />}
      {tab === 'lookbook' && <LookbookTab project={p} />}
      {tab === 'shots' && <FilmShotsTab project={p} />}
      {tab === 'quality' && <QualityTab project={p} />}
      {tab === 'score' && <ScoreTab project={p} />}
      {tab === 'assembly' && <AssemblyTab project={p} />}
      {tab === 'notes' && <NotesTab project={p} />}
      {tab === 'export' && <ExportTab project={p} />}
      {extract.dialog}
    </div>
  );
}
