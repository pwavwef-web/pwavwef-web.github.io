import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ArrowRight, Link2, Settings2 } from 'lucide-react';
import { checkPublicUrl, LINKAD_LIMITS, LINKAD_STAGE_LABELS, normalizeLinkAd, relativeTime, toMillis } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { linkAdCall, newRequestId } from '../../lib/linkad';
import { useProjects } from '../../lib/studio';
import { Badge, Button, EmptyState, Field, Input, Notice, SectionHeader, Skeleton, Textarea } from '../../components/ui';
import { FixtureBadge } from './common';

interface Config {
  entitlement: { enabled: boolean; reason: string | null; audience: string };
  providers: { reasoning: string; speech: string; transcription: string; firecrawl: boolean };
  fixturesAllowed: boolean;
  limits: { maxPages: number };
  setup: { id: string; level: 'info' | 'action'; message: string }[];
}

export default function LinkAdStudio() {
  const navigate = useNavigate();
  const projects = useProjects({ type: 'link_ad', status: 'active' });
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [promote, setPromote] = useState('');
  const [open, setOpen] = useState(false);
  const [maxPages, setMaxPages] = useState<number>(LINKAD_LIMITS.defaultMaxPages);
  const [extra, setExtra] = useState('');
  const [notes, setNotes] = useState('');
  const [fixture, setFixture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    linkAdCall<Config>({ op: 'config' }).then(setConfig, (e) => setConfigError(errorMessage(e)));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const trimmed = url.trim();
    if (trimmed) {
      const c = checkPublicUrl(trimmed);
      if (!c.ok) return setProblem(c.reason);
    } else if (notes.trim().length < 20) return setProblem('Paste a website address, or open “More options” and write a few lines about what to promote.');
    setBusy(true);
    try {
      const created = await linkAdCall<{ projectId: string }>({ op: 'create', requestId: newRequestId(), url: trimmed, promote: promote.trim(), manualText: notes.trim(), maxPages, extraUrls: extra.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 4), fixture });
      await linkAdCall({ op: 'analyse', projectId: created.projectId, requestId: newRequestId(), manualOnly: !trimmed });
      navigate(`/linkad/${created.projectId}/source`);
    } catch (err) {
      setProblem(errorMessage(err));
      toast.error('Could not start', { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const disabled = config ? !config.entitlement.enabled : false;
  return (
    <div className="space-y-8">
      <SectionHeader eyebrow="Create" title={<span className="text-5xl">Link to Ad</span>} sub="Paste a website link. Get an editable first ad." />

      {configError && <Notice tone="warning">Could not check whether Link to Ad is available: {configError}</Notice>}
      {config && !config.entitlement.enabled && <Notice tone="warning">{config.entitlement.reason ?? 'Link to Ad is not available right now.'}</Notice>}

      <form onSubmit={(e) => void submit(e)} className="card max-w-3xl space-y-5 p-6">
        <Field label="Website address" htmlFor="linkad-url" hint="A public page for one product, service or offer. Pages behind a login are never read.">
          <Input id="linkad-url" type="text" inputMode="url" autoComplete="off" autoFocus placeholder="https://your-business.com/rooms" value={url} onChange={(e) => setUrl(e.target.value)} disabled={disabled || busy} />
        </Field>
        <Field label="What should the ad promote?" htmlFor="linkad-promote" hint="Optional — one sentence. If the site offers several things, this picks the focus.">
          <Input id="linkad-promote" value={promote} maxLength={300} placeholder="e.g. Our sea-view rooms" onChange={(e) => setPromote(e.target.value)} disabled={disabled || busy} />
        </Field>

        <div>
          <button type="button" className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-dim hover:text-fg" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Settings2 className="size-3.5" aria-hidden /> More options
          </button>
          {open && (
            <div className="mt-3 space-y-4 rounded-xl border border-line p-4">
              <Field label={`Pages to read (at most ${LINKAD_LIMITS.maxPagesCap})`} hint="The page above plus related pages of the same site, such as rooms, about or contact. Never the whole site.">
                <input type="range" min={1} max={LINKAD_LIMITS.maxPagesCap} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} aria-label="Pages to read" className="w-full max-w-xs accent-[var(--color-accent)]" />
                <span className="ml-3 text-sm text-dim">{maxPages}</span>
              </Field>
              <Field label="Other pages to include" htmlFor="linkad-extra" hint="Optional, one per line, up to four. They must be on the same website.">
                <Textarea id="linkad-extra" rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="https://your-business.com/about" />
              </Field>
              <Field label="Your own details" htmlFor="linkad-notes" hint="Use this when the site is blocked, empty or unsuitable. One fact per line (what it is, prices, phone or booking link). These are marked as yours, not as found on the site.">
                <Textarea id="linkad-notes" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={'Sea-view rooms near Cape Coast Castle\nBreakfast included\nCall +233 24 555 0142 to book'} />
              </Field>
              {config?.fixturesAllowed && (
                <label className="flex items-start gap-2 text-sm text-dim">
                  <input type="checkbox" className="mt-1" checked={fixture} onChange={(e) => setFixture(e.target.checked)} />
                  <span>
                    <strong className="text-fg">Fixture run.</strong> Use the built-in demo website, planner and tone-only voice instead of live providers (testing only; the address above is ignored for reading).
                  </span>
                </label>
              )}
            </div>
          )}
        </div>

        {problem && <Notice tone="danger">{problem}</Notice>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={disabled} icon={<Link2 className="size-4" />}>
            Analyse website
          </Button>
          <p className="text-xs text-faint">Reading a site costs next to nothing. Nothing paid is generated until you choose a direction and the voice, and you see the estimate first.</p>
        </div>
        {config && config.setup.length > 0 && (
          <ul className="space-y-1 text-xs text-faint">
            {config.setup.map((s) => (
              <li key={s.id}>{s.message}</li>
            ))}
          </ul>
        )}
      </form>

      <section className="space-y-3">
        <p className="eyebrow">Your ads</p>
        {projects.loading ? (
          <Skeleton className="h-24" />
        ) : projects.data.length === 0 ? (
          <EmptyState title="No ads yet" body="Paste a link above to make the first one." />
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {projects.data.map((p) => {
              const d = normalizeLinkAd(p.linkad);
              return (
                <li key={p.id}>
                  <Link to={`/linkad/${p.id}`} className="card group flex items-start justify-between gap-3 p-4 transition-colors hover:border-accent/35">
                    <div className="min-w-0 space-y-1.5">
                      <p className="truncate text-sm font-medium text-fg">{p.title}</p>
                      <p className="truncate text-xs text-faint">{d.input.url ? d.input.url.replace(/^https?:\/\//, '') : 'Your own details'}</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={d.stage === 'ready' ? 'success' : d.stage === 'failed' ? 'danger' : 'neutral'}>{LINKAD_STAGE_LABELS[d.stage]}</Badge>
                        {d.mode === 'fixture' && <Badge tone="violet">Fixture</Badge>}
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
      {config && <FixtureNote config={config} />}
    </div>
  );
}

function FixtureNote({ config }: { config: Config }) {
  return (
    <p className="text-[11px] text-faint">
      Planning uses {config.providers.reasoning}; the voice uses {config.providers.speech}. {config.providers.firecrawl ? 'Script-built pages are read with Firecrawl.' : 'Firecrawl is not configured, so script-built pages cannot be read.'}
      {config.fixturesAllowed ? ' ' : ''}
      {config.fixturesAllowed && <FixtureBadge doc={normalizeLinkAd({ mode: 'fixture' })} />}
    </p>
  );
}
