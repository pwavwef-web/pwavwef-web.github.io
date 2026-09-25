import { Navigate, useNavigate, useParams } from 'react-router';
import { Award, BookOpenText, BookUser, Clapperboard, FileDown, Film, GitCompareArrows, Lightbulb, ListChecks, MapPin, Move3d, Music, NotebookPen, Package, Palette, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import { useProject } from '../../lib/studio';
import { ProjectHeader } from '../../components/project-header';
import { BibleBoard } from '../../components/bibles';
import { BlockingWorkspace } from '../../components/blocking';
import { CreditsStudio } from '../../components/credits-studio';
import { FinalInspectionWorkspace } from '../../components/final-inspection';
import { WorkspaceNav, type WorkspaceTab } from '../../components/workspace-nav';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui';
import { IdeaTab } from './IdeaTab';
import { ScreenplayTab, useScreenplayExtract } from './ScreenplayTab';
import { BreakdownTab } from './BreakdownTab';
import { VisualBibleTab } from './VisualBibleTab';
import { FilmShotsTab } from './FilmShotsTab';
import { ContinuityTab } from './ContinuityTab';
import { AssemblyTab } from './AssemblyTab';
import { NotesTab } from './NotesTab';
import { ExportTab } from './ExportTab';
import { ScoreTab } from './ScoreTab';
import { QualityTab } from '../../components/director';

const GROUPS = [
  { value: 'develop', label: 'Develop', icon: <Lightbulb className="size-3.5" /> },
  { value: 'bibles', label: 'Bibles', icon: <BookUser className="size-3.5" /> },
  { value: 'direct', label: 'Direct', icon: <Clapperboard className="size-3.5" /> },
  { value: 'finish', label: 'Finish', icon: <Film className="size-3.5" /> },
];

const TABS: WorkspaceTab[] = [
  { value: 'idea', label: 'Idea & treatment', icon: <Lightbulb className="size-4" />, group: 'develop' },
  { value: 'screenplay', label: 'Screenplay', icon: <BookOpenText className="size-4" />, group: 'develop' },
  { value: 'breakdown', label: 'Breakdown', icon: <ListChecks className="size-4" />, group: 'develop' },
  { value: 'notes', label: 'Notes', icon: <NotebookPen className="size-4" />, group: 'develop' },
  { value: 'visual', label: 'Visual Bible', icon: <Palette className="size-4" />, group: 'bibles' },
  { value: 'characters', label: 'Characters', icon: <UserRound className="size-4" />, group: 'bibles' },
  { value: 'locations', label: 'Locations', icon: <MapPin className="size-4" />, group: 'bibles' },
  { value: 'props', label: 'Props & costumes', icon: <Package className="size-4" />, group: 'bibles' },
  { value: 'shots', label: 'Storyboard & shots', icon: <Film className="size-4" />, group: 'direct' },
  { value: 'blocking', label: 'Blocking', icon: <Move3d className="size-4" />, group: 'direct', advanced: true },
  { value: 'continuity', label: 'Continuity', icon: <GitCompareArrows className="size-4" />, group: 'direct', advanced: true },
  { value: 'quality', label: 'AI Director Review', icon: <Sparkles className="size-4" />, group: 'direct' },
  { value: 'score', label: 'Score', icon: <Music className="size-4" />, group: 'finish' },
  { value: 'assembly', label: 'Timeline & render', icon: <Clapperboard className="size-4" />, group: 'finish' },
  { value: 'credits', label: 'Credits', icon: <Award className="size-4" />, group: 'finish' },
  { value: 'final', label: 'Final inspection', icon: <ShieldCheck className="size-4" />, group: 'finish' },
  { value: 'export', label: 'Export docs', icon: <FileDown className="size-4" />, group: 'finish' },
];

/** Earlier tab names that moved. */
const ALIASES: Record<string, string> = { lookbook: 'visual' };

export default function FilmStudio() {
  const { projectId, tab = 'idea' } = useParams();
  const navigate = useNavigate();
  const project = useProject(projectId);
  const extract = useScreenplayExtract(project.data ?? null);
  if (project.loading) return <Skeleton className="h-96" />;
  if (project.error) return <ErrorState error={project.error} />;
  if (!project.data) return <EmptyState title="Project not found" />;
  const p = project.data;
  if (ALIASES[tab]) return <Navigate to={`/projects/${p.id}/film/${ALIASES[tab]}`} replace />;
  return (
    <div className="space-y-6">
      <ProjectHeader project={p} eyebrow="Film Studio" />
      <WorkspaceNav groups={GROUPS} tabs={TABS} value={tab} advanced={Boolean(p.continuity?.advanced)} onChange={(v) => navigate(`/projects/${p.id}/film/${v}`)} />
      {tab === 'idea' && <IdeaTab project={p} />}
      {tab === 'screenplay' && <ScreenplayTab project={p} />}
      {tab === 'breakdown' && <BreakdownTab project={p} />}
      {tab === 'notes' && <NotesTab project={p} />}
      {tab === 'visual' && <VisualBibleTab project={p} />}
      {tab === 'characters' && <BibleBoard kind="characters" project={p} onExtract={() => void extract.run('characters')} extracting={extract.busy} />}
      {tab === 'locations' && <BibleBoard kind="locations" project={p} onExtract={() => void extract.run('locations')} extracting={extract.busy} />}
      {tab === 'props' && <BibleBoard kind="elements" project={p} />}
      {tab === 'shots' && <FilmShotsTab project={p} />}
      {tab === 'blocking' && <BlockingWorkspace project={p} />}
      {tab === 'continuity' && <ContinuityTab project={p} />}
      {tab === 'quality' && <QualityTab project={p} />}
      {tab === 'score' && <ScoreTab project={p} />}
      {tab === 'assembly' && <AssemblyTab project={p} />}
      {tab === 'credits' && <CreditsStudio project={p} />}
      {tab === 'final' && <FinalInspectionWorkspace project={p} />}
      {tab === 'export' && <ExportTab project={p} />}
      {extract.dialog}
    </div>
  );
}
