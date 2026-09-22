import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, Pencil, Trash2 } from 'lucide-react';
import { formatUsd, PROJECT_TYPE_LABELS, type ProjectDoc } from '@az-studio/shared';
import { api, errorMessage } from '../lib/api';
import type { WithId } from '../lib/data';
import { updateProject } from '../lib/studio';
import { PROJECT_ICON } from './projects';
import { Badge, ConfirmDialog, IconButton, Input } from './ui';

export function ProjectHeader({ project, actions, eyebrow }: { project: WithId<ProjectDoc>; actions?: ReactNode; eyebrow?: string }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const saveTitle = async () => {
    setEditing(false);
    if (title.trim() && title.trim() !== project.title) await updateProject(project.id, { title: title.trim() });
  };
  const toggleArchive = async () => {
    await updateProject(project.id, { status: project.status === 'archived' ? 'active' : 'archived' });
    toast.success(project.status === 'archived' ? 'Project restored' : 'Project archived');
  };
  const remove = async () => {
    setBusy(true);
    try {
      const r = await api<{ detachedAssets: number }, 'deleteProject'>('deleteProject', { projectId: project.id, confirmTitle });
      toast.success('Project deleted', { description: `${r.detachedAssets} media files were kept in your library.` });
      navigate('/projects');
    } catch (e) {
      toast.error('Could not delete', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge icon={PROJECT_ICON[project.type]}>{eyebrow ?? PROJECT_TYPE_LABELS[project.type]}</Badge>
          {project.status === 'archived' && <Badge tone="warning">Archived</Badge>}
          {project.usage?.costUsd ? <span className="text-xs text-faint" data-private>≈ {formatUsd(project.usage.costUsd)} used</span> : null}
        </div>
        {editing ? (
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => e.key === 'Enter' && void saveTitle()}
            className="display mt-2 !py-1 !text-4xl"
            aria-label="Project title"
          />
        ) : (
          <h1 className="display mt-2 flex items-center gap-2 text-4xl leading-tight sm:text-5xl">
            <span className="truncate">{project.title}</span>
            <IconButton label="Rename project" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="size-4" />
            </IconButton>
          </h1>
        )}
        {project.logline && <p className="mt-1 max-w-3xl text-sm text-dim">{project.logline}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <IconButton label={project.status === 'archived' ? 'Restore project' : 'Archive project'} onClick={() => void toggleArchive()}>
          {project.status === 'archived' ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
        </IconButton>
        <IconButton label="Delete project" onClick={() => setDeleteOpen(true)}>
          <Trash2 className="size-4" />
        </IconButton>
      </div>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this project?"
        danger
        confirmLabel="Delete project"
        loading={busy}
        confirmDisabled={confirmTitle.trim() !== project.title.trim()}
        onConfirm={() => void remove()}
        body={<>Scripts, scenes, shots, takes, timelines and notes are removed permanently. Generated and uploaded media stay in your library. Type the title to confirm.</>}
      >
        <Input className="mt-3" value={confirmTitle} onChange={(e) => setConfirmTitle(e.target.value)} placeholder={project.title} aria-label="Type the project title" />
      </ConfirmDialog>
    </header>
  );
}
