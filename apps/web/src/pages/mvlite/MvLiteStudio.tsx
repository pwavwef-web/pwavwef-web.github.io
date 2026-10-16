import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Disc3, Monitor, Plus, Smartphone, Square } from 'lucide-react';
import { MV_DIRECTION_PRESETS, MV_DIRECTIONS, MV_STAGE_LABELS, normalizeMvLiteSpec, relativeTime, toMillis, type LiteAspect, type MvDirectionId, type ProjectDoc } from '@az-studio/shared';
import type { WithId } from '../../lib/data';
import { createMvLiteProject } from '../../lib/mvlite';
import { useMediaUrls } from '../../lib/media';
import { usePresenterPrivacy } from '../../lib/presenter';
import { useUid } from '../../lib/session';
import { useProjects } from '../../lib/studio';
import { Badge, Button, cx, EmptyState, Field, Input, Modal, SectionHeader, Segmented, Skeleton, Textarea } from '../../components/ui';

const ASPECT_ICON: Record<LiteAspect, typeof Monitor> = { '16:9': Monitor, '9:16': Smartphone, '1:1': Square };

/** First approved image of the video (cover until a render poster exists). */
function firstImage(p: WithId<ProjectDoc>): string | null {
  const spec = normalizeMvLiteSpec(p.mvlite);
  for (const s of spec.sections) for (const sh of s.shots) if (sh.image.approvedAssetId) return sh.image.approvedAssetId;
  return p.coverAssetId ?? null;
}

function VideoCard({ project }: { project: WithId<ProjectDoc> }) {
  const spec = normalizeMvLiteSpec(project.mvlite);
  const cover = useMediaUrls(firstImage(project));
  const privacy = usePresenterPrivacy();
  const Icon = ASPECT_ICON[spec.setup.aspect];
  const img = cover?.poster ?? cover?.thumb ?? cover?.file;
  const shots = spec.sections.reduce((a, s) => a + s.shots.length, 0);
  return (
    <Link to={`/mvlite/${project.id}`} className="group block animate-rise" {...privacy(project.createdAt)}>
      <div className="cinema-thumb aspect-[16/10] rounded-2xl border border-line bg-gradient-to-br from-[#3a1630] via-[#16122a] to-[#05070b] transition-all duration-300 group-hover:border-line-strong group-hover:shadow-[var(--shadow-float)]">
        {img ? <img src={img} alt="" loading="lazy" className="absolute inset-0 size-full object-cover opacity-85 transition-transform duration-[2400ms] ease-out group-hover:scale-[1.06]" /> : <div className="absolute inset-0 grid place-items-center"><Disc3 className="size-14 text-white/[0.07]" aria-hidden /></div>}
        <div className="absolute top-3 left-3 z-10 flex gap-1.5">
          <Badge className="bg-black/50 backdrop-blur">{MV_DIRECTION_PRESETS[spec.setup.direction].label}</Badge>
          <Badge className="bg-black/50 backdrop-blur" icon={<Icon className="size-3" />}>
            {spec.setup.aspect}
          </Badge>
        </div>
        <div className="absolute inset-x-0 bottom-0 z-10 p-4">
          <p className="display truncate text-[26px] leading-tight text-fg">{project.title}</p>
          <p className="mt-0.5 line-clamp-1 text-xs text-dim">
            {MV_STAGE_LABELS[spec.stage]} · {spec.sections.length ? `${spec.sections.length} sections · ${shots} shots` : spec.song.songId ? 'Song chosen' : 'No song yet'}
          </p>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-faint">
        <span>Updated {relativeTime(toMillis(project.updatedAt))}</span>
        {project.usage?.costUsd ? <span data-private>≈ ${project.usage.costUsd.toFixed(2)} used</span> : null}
      </div>
    </Link>
  );
}

export function NewMvLiteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const uid = useUid();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [idea, setIdea] = useState('');
  const [direction, setDirection] = useState<MvDirectionId>('performance');
  const [aspect, setAspect] = useState<LiteAspect>('16:9');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const id = await createMvLiteProject(uid, { title, idea, direction, aspect });
      onOpenChange(false);
      navigate(`/mvlite/${id}/song`);
    } catch (e) {
      toast.error('Could not create the video', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="New Music Video Lite video"
      description="A music video from still images, camera movement over them and your song — cut on the beat, with the lyrics synchronised to the vocals. No generated video."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void create()}>
            Create video
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Title" htmlFor="mvlite-title">
          <Input id="mvlite-title" autoFocus value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Homecoming" onKeyDown={(e) => e.key === 'Enter' && void create()} />
        </Field>
        <Field label="Starting direction">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Starting direction">
            {MV_DIRECTIONS.map((id) => {
              const d = MV_DIRECTION_PRESETS[id];
              return (
                <button key={id} type="button" role="radio" aria-checked={direction === id} onClick={() => setDirection(id)} className={cx('cursor-pointer rounded-xl border p-3 text-left transition-colors', direction === id ? 'border-accent/60 bg-accent/10' : 'border-line hover:border-line-strong')}>
                  <p className="text-sm font-medium text-fg">{d.label}</p>
                  <p className="mt-0.5 text-xs leading-snug text-dim">{d.blurb}</p>
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="Format" hint="9:16 suits Reels, TikTok and Shorts; other formats can be added later.">
          <Segmented label="Format" value={aspect} onChange={setAspect} options={[{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }]} />
        </Field>
        <Field label="Idea" htmlFor="mvlite-new-idea" hint="Optional — a story, a place, a feeling, who appears.">
          <Textarea id="mvlite-new-idea" rows={3} value={idea} onChange={(e) => setIdea(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export default function MvLiteStudio() {
  const projects = useProjects({ type: 'mv_lite' });
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Music Video Lite"
        title={<span className="text-5xl">Music Video Lite</span>}
        sub="Music videos from stills, motion and your song: Song & lyrics → Concept → Shots → Edit → Export."
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            New video
          </Button>
        }
      />
      {projects.loading ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="aspect-[16/10]" />
          ))}
        </div>
      ) : projects.data.length === 0 ? (
        <EmptyState
          icon={<Disc3 className="size-5" />}
          title="No music videos yet"
          body="Bring a finished song (or generate one). Its beats and sections drive the cuts, its lyrics become synchronised captions, and every image moves — at a fraction of the cost of generated video."
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
              New video
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {projects.data.map((p) => (
            <VideoCard key={p.id} project={p} />
          ))}
        </div>
      )}
      <NewMvLiteDialog open={open} onOpenChange={setOpen} key={open ? 'open' : 'closed'} />
    </div>
  );
}
