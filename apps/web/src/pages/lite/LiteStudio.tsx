import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Clapperboard, Monitor, Plus, Smartphone, Square } from 'lucide-react';
import { LITE_DIRECTION_PRESETS, LITE_DIRECTIONS, LITE_DURATION, LITE_STAGE_LABELS, clampDuration, normalizeLiteSpec, relativeTime, toMillis, type LiteAspect, type LiteDirectionId, type ProjectDoc } from '@az-studio/shared';
import type { WithId } from '../../lib/data';
import { createLiteProject } from '../../lib/lite';
import { useMediaUrls } from '../../lib/media';
import { usePresenterPrivacy } from '../../lib/presenter';
import { useUid } from '../../lib/session';
import { useProjects } from '../../lib/studio';
import { Badge, Button, cx, EmptyState, Field, Input, Modal, SectionHeader, Segmented, Skeleton, Textarea } from '../../components/ui';
import { fmtSec } from './common';

const ASPECT_ICON: Record<LiteAspect, typeof Monitor> = { '16:9': Monitor, '9:16': Smartphone, '1:1': Square };

/** First approved image of the film (cover until a render poster exists). */
function firstImage(p: WithId<ProjectDoc>): string | null {
  const spec = normalizeLiteSpec(p.lite);
  for (const s of spec.scenes) for (const sh of s.shots) if (sh.image.approvedAssetId) return sh.image.approvedAssetId;
  return p.coverAssetId ?? null;
}

function FilmCard({ project }: { project: WithId<ProjectDoc> }) {
  const spec = normalizeLiteSpec(project.lite);
  const cover = useMediaUrls(firstImage(project));
  const privacy = usePresenterPrivacy();
  const Icon = ASPECT_ICON[spec.setup.aspect];
  const img = cover?.poster ?? cover?.thumb ?? cover?.file;
  return (
    <Link to={`/lite/${project.id}`} className="group block animate-rise" {...privacy(project.createdAt)}>
      <div className="cinema-thumb aspect-[16/10] rounded-2xl border border-line bg-gradient-to-br from-[#2b2416] via-[#121520] to-[#05070b] transition-all duration-300 group-hover:border-line-strong group-hover:shadow-[var(--shadow-float)]">
        {img ? <img src={img} alt="" loading="lazy" className="absolute inset-0 size-full object-cover opacity-85 transition-transform duration-[2400ms] ease-out group-hover:scale-[1.06]" /> : <div className="absolute inset-0 grid place-items-center"><Clapperboard className="size-14 text-white/[0.07]" aria-hidden /></div>}
        <div className="absolute top-3 left-3 z-10 flex gap-1.5">
          <Badge className="bg-black/50 backdrop-blur">{LITE_DIRECTION_PRESETS[spec.setup.direction].label}</Badge>
          <Badge className="bg-black/50 backdrop-blur" icon={<Icon className="size-3" />}>
            {spec.setup.aspect}
          </Badge>
        </div>
        <div className="absolute inset-x-0 bottom-0 z-10 p-4">
          <p className="display truncate text-[26px] leading-tight text-fg">{project.title}</p>
          <p className="mt-0.5 line-clamp-1 text-xs text-dim">
            {LITE_STAGE_LABELS[spec.stage]} · {spec.scenes.length ? `${spec.scenes.length} scenes` : 'No scenes yet'} · target {fmtSec(spec.setup.targetSec)}
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

export function NewLiteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const uid = useUid();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [idea, setIdea] = useState('');
  const [direction, setDirection] = useState<LiteDirectionId>('folklore');
  const [minutes, setMinutes] = useState(5);
  const [aspect, setAspect] = useState<LiteAspect>('16:9');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const id = await createLiteProject(uid, { title, idea, direction, targetSec: clampDuration(minutes * 60), aspect });
      onOpenChange(false);
      navigate(`/lite/${id}/story`);
    } catch (e) {
      toast.error('Could not create the film', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="New Film Studio Lite film"
      description="Cinematic stories from images, voice and sound — still images with slow camera movement, narration, subtitles, music and ambience. No generated video."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void create()}>
            Create film
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Title" htmlFor="lite-title">
          <Input id="lite-title" autoFocus value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. The River Stones" onKeyDown={(e) => e.key === 'Enter' && void create()} />
        </Field>
        <Field label="Starting direction">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Starting direction">
            {LITE_DIRECTIONS.map((id) => {
              const d = LITE_DIRECTION_PRESETS[id];
              return (
                <button key={id} type="button" role="radio" aria-checked={direction === id} onClick={() => setDirection(id)} className={cx('cursor-pointer rounded-xl border p-3 text-left transition-colors', direction === id ? 'border-accent/60 bg-accent/10' : 'border-line hover:border-line-strong')}>
                  <p className="text-sm font-medium text-fg">{d.label}</p>
                  <p className="mt-0.5 text-xs leading-snug text-dim">{d.blurb}</p>
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Length" hint="An estimate until the narration is recorded.">
            <Segmented label="Length" value={String(minutes)} onChange={(v) => setMinutes(Number(v))} options={LITE_DURATION.presets.map((s) => ({ value: String(s / 60), label: `${s / 60} min` }))} />
          </Field>
          <Field label="Format" hint="Landscape suits longer films; other formats can be added later.">
            <Segmented label="Format" value={aspect} onChange={setAspect} options={[{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }]} />
          </Field>
        </div>
        <Field label="Story idea" htmlFor="lite-new-idea" hint="Optional — you can also paste a full script or source text in the Story stage.">
          <Textarea id="lite-new-idea" rows={3} value={idea} onChange={(e) => setIdea(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export default function LiteStudio() {
  const projects = useProjects({ type: 'film_lite' });
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Film Studio Lite"
        title={<span className="text-5xl">Film Studio Lite</span>}
        sub="Cinematic stories from images, voice and sound: Story → Scenes → Voice & Sound → Edit → Export."
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            New film
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
          icon={<Clapperboard className="size-5" />}
          title="No films yet"
          body="Tell a story of several minutes with high-quality stills, slow purposeful camera movement, an expressive voice, accurate subtitles, music and ambience — at a fraction of the cost of generated video."
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
              New film
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {projects.data.map((p) => (
            <FilmCard key={p.id} project={p} />
          ))}
        </div>
      )}
      <NewLiteDialog open={open} onOpenChange={setOpen} key={open ? 'open' : 'closed'} />
    </div>
  );
}
