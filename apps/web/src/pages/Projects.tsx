import { useMemo, useState } from 'react';
import { Clapperboard, Plus, Search } from 'lucide-react';
import { PROJECT_TYPE_LABELS, type ProjectType } from '@az-studio/shared';
import { useProjects } from '../lib/studio';
import { NewProjectDialog, ProjectCard } from '../components/projects';
import { Button, EmptyState, ErrorState, Input, Segmented, SectionHeader, Skeleton } from '../components/ui';

export default function Projects() {
  const [type, setType] = useState<ProjectType | 'all'>('all');
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const projects = useProjects({ status, ...(type !== 'all' ? { type } : {}) });
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? projects.data.filter((p) => `${p.title} ${p.logline ?? ''}`.toLowerCase().includes(q)) : projects.data;
  }, [projects.data, search]);

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Library"
        title={<span className="text-5xl">Projects</span>}
        sub="Films, music videos, quick clips, image sets and remixes — every session saved."
        action={
          <Button variant="primary" onClick={() => setOpen(true)} icon={<Plus className="size-4" />}>
            New project
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Filter by type"
          value={type}
          onChange={setType}
          options={[{ value: 'all' as const, label: 'All' }, ...(Object.keys(PROJECT_TYPE_LABELS) as ProjectType[]).map((t) => ({ value: t, label: PROJECT_TYPE_LABELS[t] }))]}
        />
        <Segmented
          label="Status"
          size="sm"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'archived', label: 'Archived' },
          ]}
        />
        <div className="relative ml-auto w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects" className="pl-9" aria-label="Search projects" />
        </div>
      </div>
      {projects.error ? (
        <ErrorState error={projects.error} />
      ) : projects.loading ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="aspect-[16/10] rounded-2xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Clapperboard className="size-5" />}
          title={search ? 'No matches' : status === 'archived' ? 'Nothing archived' : 'No projects yet'}
          body={search ? 'Try a different search.' : 'Create a project to start developing, generating and cutting.'}
          action={!search && status === 'active' ? <Button variant="primary" onClick={() => setOpen(true)}>New project</Button> : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {filtered.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
      <NewProjectDialog open={open} onOpenChange={setOpen} defaultType={type === 'all' ? 'film' : type} />
    </div>
  );
}
