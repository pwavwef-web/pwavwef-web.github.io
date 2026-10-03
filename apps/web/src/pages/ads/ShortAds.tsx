import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AudioLines, FileText, Megaphone, Plus, Smartphone, Monitor, Square } from 'lucide-react';
import { AD_DURATION, AD_MODE_LABELS, AD_STEP_LABELS, formatDuration, normalizeAdSpec, relativeTime, toMillis, type AdAspect, type AdMode, type ProjectDoc } from '@az-studio/shared';
import type { WithId } from '../../lib/data';
import { createAdProject } from '../../lib/ads';
import { useUid } from '../../lib/session';
import { useProjects } from '../../lib/studio';
import { useMediaUrls } from '../../lib/media';
import { usePresenterPrivacy } from '../../lib/presenter';
import { Badge, Button, cx, EmptyState, Field, Input, Modal, SectionHeader, Segmented, Skeleton, Textarea } from '../../components/ui';

const ASPECT_ICON: Record<AdAspect, typeof Smartphone> = { '9:16': Smartphone, '16:9': Monitor, '1:1': Square };

function AdCard({ project }: { project: WithId<ProjectDoc> }) {
  const ad = normalizeAdSpec(project.ad);
  const cover = useMediaUrls(project.coverAssetId ?? null);
  const privacy = usePresenterPrivacy();
  const Icon = ASPECT_ICON[ad.aspect];
  const img = cover?.poster ?? cover?.thumb ?? cover?.file;
  return (
    <Link to={`/ads/${project.id}`} className="group block animate-rise" {...privacy(project.createdAt)}>
      <div className="cinema-thumb aspect-[16/10] rounded-2xl border border-line bg-gradient-to-br from-[#0f2f4a] via-[#0b1830] to-[#05070b] transition-all duration-300 group-hover:border-line-strong group-hover:shadow-[var(--shadow-float)]">
        {img ? <img src={img} alt="" loading="lazy" className="absolute inset-0 size-full object-cover opacity-80 transition-transform duration-700 group-hover:scale-[1.04]" /> : <div className="absolute inset-0 grid place-items-center"><Megaphone className="size-14 text-white/[0.07]" aria-hidden /></div>}
        <div className="absolute top-3 left-3 z-10 flex gap-1.5">
          <Badge className="bg-black/50 backdrop-blur" icon={ad.mode === 'audio_first' ? <AudioLines className="size-3" /> : <FileText className="size-3" />}>
            {AD_MODE_LABELS[ad.mode]}
          </Badge>
          <Badge className="bg-black/50 backdrop-blur" icon={<Icon className="size-3" />}>
            {ad.aspect}
          </Badge>
        </div>
        <div className="absolute inset-x-0 bottom-0 z-10 p-4">
          <p className="display truncate text-[26px] leading-tight text-fg">{project.title}</p>
          <p className="mt-0.5 line-clamp-1 text-xs text-dim">
            {AD_STEP_LABELS[ad.step]}
            {ad.audio.durationSec ? ` · ${formatDuration(ad.audio.durationSec)}` : ad.mode === 'brief_first' ? ` · ${ad.brief.durationSec} s planned` : ''}
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

export function NewAdDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const uid = useUid();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [logline, setLogline] = useState('');
  const [mode, setMode] = useState<AdMode>('audio_first');
  const [aspect, setAspect] = useState<AdAspect>('9:16');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const id = await createAdProject(uid, { title, mode, aspect, logline });
      onOpenChange(false);
      navigate(`/ads/${id}/brief`);
    } catch (e) {
      toast.error('Could not create the advert', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New short ad"
      description={`A ${AD_DURATION.min}–${AD_DURATION.max} second promotional video. Drafts save as you work.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void create()}>
            Create advert
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Start from">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Start from">
            {(
              [
                { value: 'audio_first', icon: AudioLines, title: 'Audio-first', body: 'You have the approved narration or finished soundtrack. Its real timing drives captions and cuts.' },
                { value: 'brief_first', icon: FileText, title: 'Brief-first', body: 'Start from the product, audience, message and call to action; write the script and voice-over here.' },
              ] as const
            ).map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={mode === o.value}
                onClick={() => setMode(o.value)}
                className={cx('cursor-pointer rounded-xl border p-3.5 text-left transition-colors', mode === o.value ? 'border-accent/60 bg-accent/10' : 'border-line hover:border-line-strong')}
              >
                <o.icon className="size-4 text-accent-2" aria-hidden />
                <p className="mt-2 text-sm font-medium text-fg">{o.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-dim">{o.body}</p>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Title" htmlFor="ad-title">
          <Input id="ad-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Indigen World — Keep the Conversation Going" maxLength={160} autoFocus onKeyDown={(e) => e.key === 'Enter' && void create()} />
        </Field>
        <Field label="One-line summary" htmlFor="ad-logline" hint="Optional.">
          <Textarea id="ad-logline" rows={2} value={logline} onChange={(e) => setLogline(e.target.value)} maxLength={400} />
        </Field>
        <Field label="First version" hint="Other ratios can be exported later from the same edit (generated scenes are reframed).">
          <Segmented
            label="Aspect ratio"
            value={aspect}
            onChange={setAspect}
            options={[
              { value: '9:16', label: '9:16 vertical' },
              { value: '16:9', label: '16:9 widescreen' },
              { value: '1:1', label: '1:1 square' },
            ]}
          />
        </Field>
      </div>
    </Modal>
  );
}

export default function ShortAds() {
  const projects = useProjects({ type: 'short_ad' });
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Short Ads"
        title={<span className="text-5xl">Short Ads</span>}
        sub={`${AD_DURATION.min}–${AD_DURATION.max} second promotional videos: brief → audio & assets → storyboard → generate → review → export.`}
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            New short ad
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
          icon={<Megaphone className="size-5" />}
          title="No adverts yet"
          body="Upload an approved narration or soundtrack, or start from a brief. Captions, cuts and branding follow the real audio; text is composed in the edit, never generated inside video."
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
              New short ad
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {projects.data.map((p) => (
            <AdCard key={p.id} project={p} />
          ))}
        </div>
      )}
      <NewAdDialog open={open} onOpenChange={setOpen} key={open ? 'open' : 'closed'} />
    </div>
  );
}
