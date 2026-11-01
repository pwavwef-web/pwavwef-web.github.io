import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ArrowRight, Presentation } from 'lucide-react';
import { LINKAD_STAGE_LABELS, normalizeLinkAd, POSTER_TEMPLATE_INFO, POSTER_TEMPLATES, relativeTime, toMillis, type PosterTemplate } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { useBrandKits } from '../../lib/brand-kits';
import { linkAdCall, newRequestId } from '../../lib/linkad';
import { useProjects } from '../../lib/studio';
import { Badge, Button, cx, EmptyState, Field, Input, SectionHeader, Select, Skeleton } from '../../components/ui';
import { KitWarningList } from '../../components/brand-kit-picker';

/** Create → Motion Poster Ad: choose a template (and a brand kit), then fill in the facts. */
export default function PosterStudio() {
  const navigate = useNavigate();
  const projects = useProjects({ type: 'poster_ad', status: 'active' });
  const kits = useBrandKits();
  const [template, setTemplate] = useState<PosterTemplate>('product_hero');
  const [kitId, setKitId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const kit = kits.data.find((k) => k.id === kitId) ?? null;

  const start = async () => {
    setBusy(true);
    try {
      const r = await linkAdCall<{ projectId: string }>({ op: 'createPoster', requestId: newRequestId(), template, title: title.trim(), kitId: kitId || null });
      navigate(`/poster/${r.projectId}/facts`);
    } catch (e) {
      toast.error('Could not start', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <SectionHeader eyebrow="Create" title={<span className="text-5xl">Motion Poster Ad</span>} sub="Facts and real photos in; a designed poster and a 15–30 s vertical ad with voice, captions and music out." />
      <section className="card max-w-4xl space-y-5 p-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {POSTER_TEMPLATES.map((t) => (
            <button key={t} type="button" aria-pressed={t === template} onClick={() => setTemplate(t)} className={cx('cursor-pointer rounded-2xl border p-4 text-left transition-colors', t === template ? 'border-accent/60 bg-accent/10' : 'border-line hover:border-line-strong')}>
              <p className="text-sm font-medium text-fg">{POSTER_TEMPLATE_INFO[t].label}</p>
              <p className="mt-1 text-xs text-dim">{POSTER_TEMPLATE_INFO[t].body}</p>
              <p className="mt-2 text-[11px] text-faint">Needs: {POSTER_TEMPLATE_INFO[t].needs}</p>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Brand kit" hint={kits.data.length ? 'Colours, fonts, logo, real photos, prices and contacts are filled in from it.' : undefined}>
            {kits.data.length ? (
              <Select value={kitId} onChange={(e) => setKitId(e.target.value)} aria-label="Brand kit">
                <option value="">No kit — I will fill everything in</option>
                {kits.data.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.kit.name}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-xs text-faint">
                No brand kits yet.{' '}
                <Link to="/studio/brands/new" className="text-accent-2 underline">
                  Make one
                </Link>{' '}
                for each client so the next poster fills itself in.
              </p>
            )}
          </Field>
          <Field label="Name (optional)">
            <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={kit ? `${kit.kit.name} · ${POSTER_TEMPLATE_INFO[template].label}` : POSTER_TEMPLATE_INFO[template].label} />
          </Field>
        </div>
        {kit && <KitWarningList kit={kit.kit} kitId={kit.id} />}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" loading={busy} icon={<Presentation className="size-4" />} onClick={() => void start()}>
            Start
          </Button>
          <p className="text-xs text-faint">Nothing paid happens until you ask for the voice, a music bed or the export — each shows its estimate first.</p>
        </div>
      </section>

      <section className="space-y-3">
        <p className="eyebrow">Your poster ads</p>
        {projects.loading ? (
          <Skeleton className="h-24" />
        ) : projects.data.length === 0 ? (
          <EmptyState title="No poster ads yet" body="Choose a template above to make the first one." />
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {projects.data.map((p) => {
              const d = normalizeLinkAd(p.linkad);
              return (
                <li key={p.id}>
                  <Link to={`/poster/${p.id}`} className="card group flex items-start justify-between gap-3 p-4 transition-colors hover:border-accent/35">
                    <div className="min-w-0 space-y-1.5">
                      <p className="truncate text-sm font-medium text-fg">{p.title}</p>
                      <p className="truncate text-xs text-faint">{d.poster ? POSTER_TEMPLATE_INFO[d.poster.template].label : 'Poster ad'}{d.brandKit ? ` · ${d.brandKit.name}` : ''}</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={d.stage === 'ready' ? 'success' : d.stage === 'failed' ? 'danger' : 'neutral'}>{LINKAD_STAGE_LABELS[d.stage]}</Badge>
                        {Object.keys(d.poster?.exports ?? {}).length > 0 && <Badge tone="success">Poster saved</Badge>}
                        <span className="text-[11px] text-faint">Updated {relativeTime(toMillis(p.updatedAt))}</span>
                      </div>
                    </div>
                    <ArrowRight className="mt-1 size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent-2" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
