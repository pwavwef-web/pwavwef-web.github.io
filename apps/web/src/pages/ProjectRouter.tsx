import { Navigate, useParams } from 'react-router';
import { useProject } from '../lib/studio';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import QuickVideo from './QuickVideo';
import ImageStudio from './ImageStudio';
import Remix from './Remix';

/** Opens a project in the studio that matches its type. */
export default function ProjectRouter() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  if (project.loading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Spinner />
      </div>
    );
  }
  if (project.error) return <ErrorState error={project.error} />;
  if (!project.data) return <EmptyState title="Project not found" body="It may have been deleted." />;
  const p = project.data;
  switch (p.type) {
    case 'film':
      return <Navigate to={`/projects/${p.id}/film`} replace />;
    case 'music_video':
      return <Navigate to={`/projects/${p.id}/music`} replace />;
    case 'music':
      return <Navigate to={`/projects/${p.id}/studio`} replace />;
    case 'image':
      return <ImageStudio project={p} />;
    case 'remix':
      return <Remix project={p} />;
    default:
      return <QuickVideo project={p} />;
  }
}
