import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, CircleAlert, ImagePlus, Plus, Sparkles, Trash2 } from 'lucide-react';
import {
  allFacts,
  isConfirmed,
  KIT_CONTACT_KINDS,
  KIT_CONTACT_LABELS,
  POSTER_TEMPLATE_INFO,
  POSTER_TEMPLATES,
  posterFormHash,
  posterReadiness,
  posterRowId,
  priceLine,
  reviewState,
  todayKey,
  type PosterContact,
  type PosterForm,
  type PosterPrice,
} from '@az-studio/shared';
import { linkAdCall } from '../../lib/linkad';
import { uploadFile } from '../../lib/media';
import { KitPicker } from '../../components/brand-kit-picker';
import { Badge, Button, cx, Field, Input, Notice, Select, Textarea } from '../../components/ui';
import { Panel, Thumb } from '../linkad/common';
import type { StepProps } from '../linkad/LinkAdWorkspace';

/**
 * Motion Poster Ad, step 1: the template, the facts (headline, offer, prices, contacts, date and place, call to
 * action) and the real photos. Every field is one of the ad's facts: prices, dates and offers need a tick saying
 * they are current (a brand kit's current confirmation counts), and anything past its kit review day blocks export.
 */
export function FactsStep(p: StepProps & { goPoster: () => void; goEdit: () => void }) {
  const { editor, project, act } = p;
  const doc = editor.doc;
  const server = editor.server;
  const poster = doc.poster;
  const photoRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const [rights, setRights] = useState(true);
  const today = todayKey();
  const issues = useMemo(() => posterReadiness(doc), [doc]);
  if (!poster) return <Notice tone="warning">This ad has no facts form.</Notice>;

  const setPoster = (fn: (f: PosterForm) => PosterForm) => editor.update((d) => (d.poster ? { ...d, poster: fn(d.poster) } : d));
  const field = <K extends keyof PosterForm>(k: K, v: PosterForm[K]) => setPoster((f) => ({ ...f, [k]: v }));
  const patchPrice = (id: string, patch: Partial<PosterPrice>) => setPoster((f) => ({ ...f, prices: f.prices.map((x) => (x.id === id ? { ...x, ...patch, ...(patch.price !== undefined || patch.item !== undefined || patch.currency !== undefined ? { kitEntryId: null, reviewBy: null } : {}) } : x)) }));
  const patchContact = (id: string, patch: Partial<PosterContact>) => setPoster((f) => ({ ...f, contacts: f.contacts.map((x) => (x.id === id ? { ...x, ...patch, ...(patch.value !== undefined ? { kitEntryId: null, reviewBy: null } : {}) } : x)) }));

  const images = server.source.assets.filter((a) => a.status === 'stored' && a.role === 'image');
  const logos = server.source.assets.filter((a) => a.status === 'stored' && a.role === 'logo');
  const togglePhoto = (id: string) => setPoster((f) => ({ ...f, photoIds: f.photoIds.includes(id) ? f.photoIds.filter((x) => x !== id) : [...f.photoIds, id].slice(0, 4) }));
  const upload = (file: File | undefined, role: 'image' | 'logo') => {
    if (!file) return;
    void act('Could not add the picture', async () => {
      const assetId = await uploadFile(file, { kind: 'image', projectId: project.id, collections: ['poster:upload'] });
      await linkAdCall({ op: 'addAsset', projectId: project.id, assetId, role, rightsConfirmed: rights });
      toast.success(role === 'logo' ? 'Logo added' : 'Photo added');
    });
  };

  // Facts that need a tick: the form's prices, dates and offers (server wording, so the tick matches what is stored).
  const facts = allFacts(server).filter((f) => f.id.startsWith('pf_') && f.needsConfirmation);
  const unsaved = editor.status !== 'saved';
  const built = Boolean(server.poster?.scriptFor);
  const changedSinceScript = built && server.poster && server.poster.scriptFor !== posterFormHash(server.poster);
  const write = () =>
    act('Could not write the ad', async () => {
      await linkAdCall({ op: 'buildScript', projectId: project.id, revision: editor.revision() });
      toast.success('The motion ad is written', { description: 'One scene per fact, real photos first. Check the words, then make the voice.' });
      p.goEdit();
    });

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
      <div className="min-w-0 space-y-6">
        <Panel title="Template" sub={POSTER_TEMPLATE_INFO[poster.template].body}>
          <div className="flex flex-wrap gap-2">
            {POSTER_TEMPLATES.map((t) => (
              <button key={t} type="button" aria-pressed={t === poster.template} onClick={() => field('template', t)} className={cx('cursor-pointer rounded-full border px-3.5 py-1.5 text-xs font-medium', t === poster.template ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim hover:text-fg')}>
                {POSTER_TEMPLATE_INFO[t].label}
              </button>
            ))}
          </div>
          <KitPicker
            appliedKitId={server.brandKit?.kitId ?? null}
            busy={p.busy}
            hint="Fills colours, fonts, logo, real photos, prices and contacts. Rows from the kit follow it when you apply it again."
            onApply={(k) =>
              void act('Could not apply the brand kit', async () => {
                await linkAdCall({ op: 'applyKit', projectId: project.id, kitId: k.id });
                toast.success(`Applied “${k.kit.name}”`);
              })
            }
          />
        </Panel>

        <Panel title="The facts" sub="Exactly as they should read. The voice says the figures in words; the poster shows them in figures — both are checked against these.">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Headline" htmlFor="pf-h" className="md:col-span-2">
              <Input id="pf-h" value={poster.headline} maxLength={80} onChange={(e) => field('headline', e.target.value)} placeholder={poster.template === 'event' ? 'GTHRC 2026 — Call for abstracts' : 'Pure Obaapaz honey'} />
            </Field>
            <Field label="Subhead" htmlFor="pf-s" className="md:col-span-2">
              <Textarea id="pf-s" rows={2} value={poster.subhead} maxLength={160} onChange={(e) => field('subhead', e.target.value)} placeholder="Raw, unfiltered, from the Volta region" />
            </Field>
            <Field label="Offer line (optional)" htmlFor="pf-o">
              <Input id="pf-o" value={poster.offer} maxLength={100} onChange={(e) => field('offer', e.target.value)} placeholder="Free delivery in Accra" />
            </Field>
            <Field label="Call to action" htmlFor="pf-c">
              <Input id="pf-c" value={poster.cta} maxLength={60} onChange={(e) => field('cta', e.target.value)} placeholder={poster.template === 'event' ? 'Register today' : 'Order now'} />
            </Field>
            {(poster.template === 'event' || poster.date || poster.time) && (
              <>
                <Field label="Date" htmlFor="pf-d">
                  <Input id="pf-d" value={poster.date} maxLength={60} onChange={(e) => field('date', e.target.value)} placeholder="Saturday 14 November 2026" />
                </Field>
                <Field label="Time" htmlFor="pf-t">
                  <Input id="pf-t" value={poster.time} maxLength={40} onChange={(e) => field('time', e.target.value)} placeholder="9 am" />
                </Field>
              </>
            )}
            <Field label="Place" htmlFor="pf-p" className="md:col-span-2">
              <Input id="pf-p" value={poster.place} maxLength={120} onChange={(e) => field('place', e.target.value)} placeholder="University of Cape Coast, Main Auditorium" />
            </Field>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-fg">Prices</p>
              <Button size="sm" variant="subtle" icon={<Plus className="size-3.5" />} disabled={poster.prices.length >= 8} onClick={() => setPoster((f) => ({ ...f, prices: [...f.prices, { id: posterRowId('p'), item: '', price: '0', currency: f.prices[f.prices.length - 1]?.currency ?? 'GH₵', unit: '', kitEntryId: null, reviewBy: null }] }))}>
                Add price
              </Button>
            </div>
            {poster.prices.length === 0 && <p className="text-xs text-faint">No prices. {poster.template === 'price_list' ? 'A price list needs at least one.' : 'Optional.'}</p>}
            {poster.prices.map((r) => (
              <div key={r.id} className="space-y-1">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_5.5rem_7rem_minmax(0,8rem)_auto]">
                  <Input value={r.item} maxLength={60} placeholder="Item" onChange={(e) => patchPrice(r.id, { item: e.target.value })} aria-label="Item" />
                  <Input value={r.currency} maxLength={8} onChange={(e) => patchPrice(r.id, { currency: e.target.value })} aria-label="Currency" />
                  <Input value={r.price} inputMode="decimal" onChange={(e) => patchPrice(r.id, { price: e.target.value.replace(/[^\d.,]/g, '') || '0' })} aria-label="Price" />
                  <Input value={r.unit} maxLength={40} placeholder="per jar" onChange={(e) => patchPrice(r.id, { unit: e.target.value })} aria-label="Unit" />
                  <button type="button" aria-label="Remove price" className="grid size-9 cursor-pointer place-items-center rounded-lg text-faint hover:bg-white/10 hover:text-danger" onClick={() => setPoster((f) => ({ ...f, prices: f.prices.filter((x) => x.id !== r.id) }))}>
                    <Trash2 className="size-4" />
                  </button>
                </div>
                {r.kitEntryId && r.reviewBy && <p className={cx('text-[11px]', reviewState(r.reviewBy, today) === 'overdue' ? 'text-danger' : 'text-faint')}>From the brand kit · review by {r.reviewBy}{reviewState(r.reviewBy, today) === 'overdue' ? ' — overdue: re-confirm it in the kit' : ''}</p>}
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-fg">Contacts</p>
              <Button size="sm" variant="subtle" icon={<Plus className="size-3.5" />} disabled={poster.contacts.length >= 4} onClick={() => setPoster((f) => ({ ...f, contacts: [...f.contacts, { id: posterRowId('c'), kind: 'phone', value: '', kitEntryId: null, reviewBy: null }] }))}>
                Add contact
              </Button>
            </div>
            {poster.contacts.map((c) => (
              <div key={c.id} className="space-y-1">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-[9rem_minmax(0,1fr)_auto]">
                  <Select value={c.kind} onChange={(e) => patchContact(c.id, { kind: e.target.value as PosterContact['kind'] })} aria-label="Kind">
                    {KIT_CONTACT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIT_CONTACT_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                  <Input value={c.value} maxLength={160} onChange={(e) => patchContact(c.id, { value: e.target.value })} aria-label="Contact" placeholder={c.kind === 'phone' || c.kind === 'whatsapp' ? '054 216 1486' : ''} />
                  <button type="button" aria-label="Remove contact" className="grid size-9 cursor-pointer place-items-center rounded-lg text-faint hover:bg-white/10 hover:text-danger" onClick={() => setPoster((f) => ({ ...f, contacts: f.contacts.filter((x) => x.id !== c.id) }))}>
                    <Trash2 className="size-4" />
                  </button>
                </div>
                {c.kitEntryId && c.reviewBy && reviewState(c.reviewBy, today) === 'overdue' && <p className="text-[11px] text-danger">From the brand kit · overdue since {c.reviewBy}: re-confirm it in the kit</p>}
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Real photos"
          sub="Choose up to four, in order (the first is the hero). Real photos of the real product beat generated ones."
          action={
            <div className="flex flex-wrap gap-2">
              <input ref={photoRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => (upload(e.target.files?.[0], 'image'), (e.target.value = ''))} />
              <input ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => (upload(e.target.files?.[0], 'logo'), (e.target.value = ''))} />
              <Button size="sm" variant="subtle" icon={<ImagePlus className="size-3.5" />} onClick={() => photoRef.current?.click()} disabled={p.busy}>
                Upload photo
              </Button>
              <Button size="sm" variant="subtle" icon={<ImagePlus className="size-3.5" />} onClick={() => logoRef.current?.click()} disabled={p.busy}>
                Upload logo
              </Button>
            </div>
          }
        >
          <label className="flex items-start gap-2 text-xs text-dim">
            <input type="checkbox" className="mt-0.5" checked={rights} onChange={(e) => setRights(e.target.checked)} />
            <span>I own the photos I upload here, or the client has given permission to use them in this advert.</span>
          </label>
          {images.length === 0 ? (
            <p className="text-xs text-faint">No photos yet. Apply a brand kit with real photos, or upload them.</p>
          ) : (
            <ul className="grid grid-cols-3 gap-3 md:grid-cols-5">
              {images.map((a) => {
                const at = poster.photoIds.indexOf(a.id);
                return (
                  <li key={a.id}>
                    <button type="button" aria-pressed={at >= 0} onClick={() => togglePhoto(a.id)} className={cx('relative block aspect-square w-full cursor-pointer overflow-hidden rounded-xl border-2', at >= 0 ? 'border-accent' : 'border-transparent opacity-70 hover:opacity-100')}>
                      <Thumb asset={a} />
                      {at >= 0 && <span className="absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-accent text-[11px] font-semibold text-white">{at + 1}</span>}
                      {a.real && <span className="absolute right-1.5 bottom-1.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] text-white">Real</span>}
                      {a.origin === 'generated' && <span className="absolute right-1.5 bottom-1.5 rounded-full bg-violet/80 px-1.5 py-0.5 text-[10px] text-white">AI</span>}
                    </button>
                    {a.rights !== 'confirmed' && (
                      <button type="button" className="mt-1 text-[11px] text-warning underline" onClick={() => void editor.commit({ assets: [{ id: a.id, rights: 'confirmed' }] }).catch(() => undefined)}>
                        Confirm I may use it
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {logos.length > 0 && (
            <Field label="Logo">
              <Select value={doc.brief.logoId ?? ''} onChange={(e) => editor.update((d) => ({ ...d, brief: { ...d.brief, logoId: e.target.value || null } }))} aria-label="Logo">
                <option value="">No logo</option>
                {logos.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.alt || 'Logo'}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </Panel>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
        <div className="card space-y-3 p-4">
          <p className="eyebrow">Confirm what is current</p>
          {facts.length === 0 ? (
            <p className="text-xs text-faint">{unsaved ? 'Saving…' : 'No prices, dates or offers to confirm.'}</p>
          ) : (
            <ul className="space-y-1.5">
              {facts.map((f) => {
                const ok = isConfirmed(server, f);
                return (
                  <li key={f.id}>
                    <button type="button" aria-pressed={ok} disabled={unsaved} onClick={() => void editor.commit(ok ? { unconfirm: [f.id] } : { confirm: [f.id] }).catch(() => undefined)} className={cx('flex w-full cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs disabled:opacity-60', ok ? 'border-success/40 bg-success/10 text-success' : 'border-warning/40 bg-warning/10 text-warning')}>
                      {ok ? <Check className="mt-0.5 size-3.5 shrink-0" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
                      <span>
                        {f.text}
                        {f.reviewBy && <span className="block text-[10px] opacity-80">Brand kit · review by {f.reviewBy}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-[11px] text-faint">Confirm only what the client has said is right today. Changing the wording takes the tick away.</p>
        </div>
        <div className="card space-y-2 p-4">
          <p className="eyebrow">Before the poster</p>
          {issues.length === 0 ? (
            <Notice tone="success">The facts are ready.</Notice>
          ) : (
            <ul className="space-y-1.5">
              {issues.slice(0, 10).map((i, k) => (
                <li key={k} className="flex gap-1.5 text-xs text-dim">
                  <CircleAlert className={cx('mt-0.5 size-3.5 shrink-0', i.severity === 'error' ? 'text-danger' : 'text-warning')} aria-hidden />
                  {i.message}
                </li>
              ))}
            </ul>
          )}
          {poster.prices.length > 0 && <p className="text-[11px] text-faint">On the poster: {poster.prices.slice(0, 3).map(priceLine).join(' · ')}</p>}
          <Button className="w-full" onClick={p.goPoster} disabled={!poster.headline.trim()}>
            See the poster
          </Button>
          <Button variant="primary" className="w-full" icon={<Sparkles className="size-4" />} onClick={() => void write()} disabled={p.busy || !poster.headline.trim()}>
            {built ? 'Write the ad again from the facts' : 'Write the ad from the facts'}
          </Button>
          {changedSinceScript && <Badge tone="warning">The facts changed since the ad was written</Badge>}
          <p className="text-[11px] text-faint">Free and instant — no model call. Scenes whose words do not change keep their recordings.</p>
        </div>
      </aside>
    </div>
  );
}
