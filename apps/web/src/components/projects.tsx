import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Clapperboard, Film, Image as ImageIcon, Music2, Scissors } from 'lucide-react';
import { formatUsd, PROJECT_TYPE_LABELS, relativeTime, toMillis, type FrameAspect, type ProjectDoc, type ProjectType } from '@az-studio/shared';
import type { WithId } from '../lib/data';
import { useMediaUrls } from '../lib/media';
import { useUid } from '../lib/session';
import { createProject } from '../lib/studio';
import { Badge, Button, cx, Field, Input, Modal, Segmented, Textarea } from './ui';

export const PROJECT_ICON: Record<ProjectType, ReactNode> = {
  quick_video: <Film className="size-4" />,
  music_video: <Music2 className="size-4" />,
  film: <Clapperboard className="size-4" />,
  image: <ImageIcon className="size-4" />,
  remix: <Scissors className="size-4" />,
};

const GRADIENT: Record<ProjectType, string> = {
  quick_video: 'from-[#12264d] via-[#0b1426] to-[#05070b]',
  music_video: 'from-[#2a1a4d] via-[#0f1230] to-[#05070b]',
  film: 'from-[#1d2e45] via-[#0c1422] to-[#05070b]',
  image: 'from-[#123a45] via-[#0b1a24] to-[#05070b]',
  remix: 'from-[#3a1f2e] via-[#150f1c] to-[#05070b]',
};

export function projectPath(p: Pick<ProjectDoc, 'type'> & { id: string }): string {
  switch (p.type) {
    case 'film':
      return `/projects/${p.id}/film`;
    case 'music_video':
      return `/projects/${p.id}/music`;
    default:
      return `/projects/${p.id}`;
  }
}

export function ProjectCard({ project, className }: { project: WithId<ProjectDoc>; className?: string }) {
  const cover = useMediaUrls(project.coverAssetId ?? null);
  const img = cover?.poster ?? cover?.thumb ?? cover?.file;
  return (
    <Link to={projectPath(project)} className={cx('group block animate-rise', className)}>
      <div className={cx('cinema-thumb aspect-[16/10] rounded-2xl border border-line bg-gradient-to-br transition-all duration-300 group-hover:border-line-strong group-hover:shadow-[var(--shadow-float)]', GRADIENT[project.type])}>
        {img ? (
          <img src={img} alt="" loading="lazy" className="absolute inset-0 size-full object-cover transition-transform duration-700 group-hover:scale-[1.04]" />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <span className="display text-6xl text-white/[0.07] select-none">{project.title.slice(0, 2)}</span>
          </div>
        )}
        <div className="absolute top-3 left-3 z-10">
          <Badge tone="neutral" icon={PROJECT_ICON[project.type]} className="bg-black/50 backdrop-blur">
            {PROJECT_TYPE_LABELS[project.type]}
          </Badge>
        </div>
        <div className="absolute inset-x-0 bottom-0 z-10 p-4">
          <p className="display truncate text-[26px] leading-tight text-fg">{project.title}</p>
          <p className="mt-0.5 line-clamp-1 text-xs text-dim">{project.logline || 'No logline yet'}</p>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-faint">
        <span>Updated {relativeTime(toMillis(project.updatedAt))}</span>
        {project.usage?.costUsd ? <span>≈ {formatUsd(project.usage.costUsd)} used</span> : null}
      </div>
    </Link>
  );
}

export function NewProjectDialog({ open, onOpenChange, defaultType = 'film' }: { open: boolean; onOpenChange: (o: boolean) => void; defaultType?: ProjectType }) {
  const uid = useUid();
  const navigate = useNavigate();
  const [type, setType] = useState<ProjectType>(defaultType);
  const [title, setTitle] = useState('');
  const [logline, setLogline] = useState('');
  const [aspect, setAspect] = useState<FrameAspect>('16:9');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const id = await createProject(uid, { title, type, logline, aspectRatio: aspect });
      onOpenChange(false);
      setTitle('');
      setLogline('');
      navigate(projectPath({ id, type }));
    } catch (e) {
      toast.error('Could not create project', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="Projects keep every script, shot, take, asset and render together."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void create()}>
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Type">
          <Segmented
            label="Project type"
            value={type}
            onChange={setType}
            options={(Object.keys(PROJECT_TYPE_LABELS) as ProjectType[]).map((t) => ({ value: t, label: <span className="inline-flex items-center gap-1.5">{PROJECT_ICON[t]} {PROJECT_TYPE_LABELS[t]}</span> }))}
          />
        </Field>
        <Field label="Title" htmlFor="np-title">
          <Input id="np-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type === 'music_video' ? 'e.g. Indigen World — “Homecoming”' : 'e.g. The Last Drum'} maxLength={160} autoFocus onKeyDown={(e) => e.key === 'Enter' && void create()} />
        </Field>
        <Field label="Logline" htmlFor="np-logline" hint="Optional — one sentence about the story or concept.">
          <Textarea id="np-logline" value={logline} onChange={(e) => setLogline(e.target.value)} rows={2} maxLength={400} />
        </Field>
        <Field label="Primary format" hint="Omni generates 16:9 or 9:16; square exports are reframed in the renderer.">
          <Segmented
            label="Aspect ratio"
            value={aspect}
            onChange={setAspect}
            options={[
              { value: '16:9', label: '16:9 widescreen' },
              { value: '9:16', label: '9:16 vertical' },
              { value: '1:1', label: '1:1 square' },
            ]}
          />
        </Field>
      </div>
    </Modal>
  );
}
