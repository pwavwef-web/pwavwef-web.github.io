import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Check, ImagePlus, Palette, Plus, RefreshCw, Save, Trash2, Type } from 'lucide-react';
import {
  addDays,
  emptyBrandKit,
  KIT_CONTACT_KINDS,
  KIT_CONTACT_LABELS,
  KIT_REVIEW_DAYS,
  kitChanged,
  kitColourIssues,
  kitProblems,
  newId,
  offerText,
  RENDER_FONTS,
  reviewState,
  todayKey,
  type BrandKitInput,
  type KitContact,
  type KitFont,
  type KitOffer,
  type ReviewState,
} from '@az-studio/shared';
import { ApiError, errorMessage } from '../lib/api';
import { brandKitCall, useBrandKit, useBrandKits } from '../lib/brand-kits';
import { uploadFile, useMediaUrls } from '../lib/media';
import { KitWarningList } from '../components/brand-kit-picker';
import { Badge, Button, ConfirmDialog, cx, EmptyState, Field, Input, Notice, SectionHeader, Select, Skeleton, Textarea } from '../components/ui';

/**
 * Studio → Brand kits (`/studio/brands`): one kit per client — colours, fonts, logos, contacts, prices with the day
 * they were confirmed and must be confirmed again, real product photos and notes. The tools (Short Ads, Link to Ad,
 * Motion Poster Ad) fill themselves from a kit; anything past its review-by day is flagged wherever it is used.
 */

const STATE_BADGE: Record<ReviewState, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  current: { label: 'Current', tone: 'success' },
  due_soon: { label: 'Due soon', tone: 'warning' },
  overdue: { label: 'Re-confirm', tone: 'danger' },
};

function Thumb({ assetId, className }: { assetId: string; className?: string }) {
  const urls = useMediaUrls(assetId);
  const src = urls?.thumb ?? urls?.file;
  return src ? <img src={src} alt="" className={cx('size-full object-cover', className)} draggable={false} /> : <div className={cx('grid size-full place-items-center bg-white/[0.04] text-[10px] text-faint', className)}>…</div>;
}

function Section({ title, sub, action, children }: { title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="display text-xl text-fg">{title}</h2>
          {sub && <p className="mt-0.5 text-xs text-dim">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function FontEditor({ label, font, onChange, onUpload }: { label: string; font: KitFont; onChange: (f: KitFont) => void; onUpload: (file: File) => Promise<void> }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      <p className="text-xs font-medium text-fg">{label}</p>
      <Field label="Video font" hint="The renderer has these four; the motion ad's text always uses one of them.">
        <Select value={font.family} onChange={(e) => onChange({ ...font, family: e.target.value as KitFont['family'] })} aria-label={`${label} video font`}>
          {RENDER_FONTS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={ref} type="file" accept=".ttf,.otf,font/ttf,font/otf" hidden onChange={(e) => void (e.target.files?.[0] ? onUpload(e.target.files[0]) : Promise.resolve()).finally(() => (e.target.value = ''))} />
        <Button size="sm" variant="subtle" icon={<Type className="size-3.5" />} onClick={() => ref.current?.click()}>
          {font.uploadAssetId ? 'Replace brand font file' : 'Upload the brand font (.ttf/.otf)'}
        </Button>
        {font.uploadAssetId && (
          <>
            <span className="text-xs text-dim">{font.uploadFamily || 'Uploaded font'}</span>
            <Button size="sm" variant="ghost" onClick={() => onChange({ ...font, uploadAssetId: null, uploadFamily: '', licenceConfirmed: false })}>
              Remove
            </Button>
          </>
        )}
      </div>
      {font.uploadAssetId && (
        <label className="flex items-start gap-2 text-xs text-dim">
          <input type="checkbox" className="mt-0.5" checked={font.licenceConfirmed} onChange={(e) => onChange({ ...font, licenceConfirmed: e.target.checked })} />
          <span>The client's licence allows this font on their adverts. Posters use it once confirmed (the video keeps the font above).</span>
        </label>
      )}
    </div>
  );
}

function ReviewCell({ reviewBy, confirmedOn, onReviewBy, onReconfirm, today }: { reviewBy: string; confirmedOn: string; onReviewBy: (d: string) => void; onReconfirm: () => void; today: string }) {
  const st = reviewState(reviewBy, today);
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
      <Badge tone={STATE_BADGE[st].tone}>{STATE_BADGE[st].label}</Badge>
      <span>Confirmed {confirmedOn}</span>
      <label className="inline-flex items-center gap-1">
        Review by
        <input type="date" value={reviewBy} min={confirmedOn} onChange={(e) => e.target.value && onReviewBy(e.target.value)} className="rounded-md border border-line bg-transparent px-1.5 py-0.5 text-fg" aria-label="Review by" />
      </label>
      <button type="button" className="inline-flex cursor-pointer items-center gap-1 text-accent-2 hover:underline" onClick={onReconfirm}>
        <RefreshCw className="size-3" /> Still right today
      </button>
    </div>
  );
}

function Editor({ kitId }: { kitId: string | null }) {
  const navigate = useNavigate();
  const stored = useBrandKit(kitId);
  const [draft, setDraft] = useState<BrandKitInput>(() => emptyBrandKit());
  const [revision, setRevision] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [del, setDel] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const today = todayKey();
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!kitId) {
      if (loadedFor.current !== 'new') setDraft(emptyBrandKit());
      loadedFor.current = 'new';
      setRevision(null);
      return;
    }
    if (stored.data && loadedFor.current !== `${kitId}:${stored.data.revision}`) {
      setDraft(stored.data.kit);
      setRevision(stored.data.revision);
      loadedFor.current = `${kitId}:${stored.data.revision}`;
    }
  }, [kitId, stored.data]);

  const dirty = !stored.data || kitChanged(stored.data.kit, draft);
  const problems = useMemo(() => [...kitProblems(draft), ...kitColourIssues(draft)], [draft]);
  const set = (fn: (k: BrandKitInput) => BrandKitInput) => setDraft((k) => fn(k));
  const patchOffer = (id: string, patch: Partial<KitOffer>) => set((k) => ({ ...k, offers: k.offers.map((o) => (o.id === id ? { ...o, ...patch } : o)) }));
  const patchContact = (id: string, patch: Partial<KitContact>) => set((k) => ({ ...k, contacts: k.contacts.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));

  const save = async (): Promise<string | null> => {
    setSaving(true);
    try {
      const r = await brandKitCall<{ kitId: string; revision: number }>({ op: 'save', kitId, revision, kit: draft });
      setRevision(r.revision);
      toast.success('Brand kit saved', { description: 'Prices and contacts you changed are confirmed as of today.' });
      if (!kitId) navigate(`/studio/brands/${r.kitId}`, { replace: true });
      return r.kitId;
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as { reason?: string } | null) : null;
      toast.error(d?.reason === 'revision_conflict' ? 'Changed in another tab' : 'Could not save', { description: errorMessage(e) });
      return null;
    } finally {
      setSaving(false);
    }
  };

  const reconfirm = async (entryIds: string[]) => {
    if (!kitId || dirty) {
      toast.message('Save the kit first', { description: 'Re-confirming applies to the saved kit.' });
      return;
    }
    try {
      await brandKitCall({ op: 'reconfirm', kitId, entryIds });
      toast.success(entryIds.length === 1 ? 'Re-confirmed as of today' : `${entryIds.length} entries re-confirmed as of today`);
    } catch (e) {
      toast.error('Could not re-confirm', { description: errorMessage(e) });
    }
  };

  const upload = async (file: File, kind: 'image' | 'document', what: string): Promise<string | null> => {
    setUploading(what);
    try {
      return await uploadFile(file, { kind, title: `${draft.name} · ${file.name}`.slice(0, 160), collections: ['brand-kit'] });
    } catch (e) {
      toast.error('Upload failed', { description: errorMessage(e) });
      return null;
    } finally {
      setUploading(null);
    }
  };

  const remove = async () => {
    if (!kitId) return;
    try {
      await brandKitCall({ op: 'delete', kitId });
      toast.success('Brand kit deleted', { description: 'Ads that used it keep their copies.' });
      navigate('/studio/brands');
    } catch (e) {
      toast.error('Could not delete', { description: errorMessage(e) });
    }
  };

  if (kitId && stored.loading) return <Skeleton className="h-96" />;
  if (kitId && !stored.data) return <EmptyState title="Brand kit not found" body="It may have been deleted." />;
  const overdueIds = [...draft.offers, ...draft.contacts].filter((x) => reviewState(x.reviewBy, today) !== 'current').map((x) => x.id);

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Client or brand" className="min-w-[16rem] flex-1">
          <Input value={draft.name} maxLength={120} onChange={(e) => set((k) => ({ ...k, name: e.target.value }))} placeholder="e.g. Bright Consult" />
        </Field>
        <div className="flex flex-wrap gap-2">
          {kitId && (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDel(true)}>
              Delete
            </Button>
          )}
          <Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={!dirty || !draft.name.trim() || kitProblems(draft).length > 0 || Boolean(uploading)} onClick={() => void save()}>
            {dirty ? 'Save kit' : 'Saved'}
          </Button>
        </div>
      </div>
      {stored.data && <KitWarningList kit={stored.data.kit} />}
      {overdueIds.length > 0 && kitId && !dirty && (
        <Button size="sm" icon={<Check className="size-3.5" />} onClick={() => void reconfirm(overdueIds)}>
          I checked all {overdueIds.length} with the client — still right today
        </Button>
      )}
      {problems.map((p) => (
        <Notice key={p} tone="warning">
          {p}
        </Notice>
      ))}

      <Section title="Colours" sub="Used for the poster, the ad's text-led scenes, captions and the closing card.">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {(['primary', 'background', 'accent', 'text'] as const).map((c) => (
            <label key={c} className="space-y-1 text-xs text-dim">
              <span className="capitalize">{c}</span>
              <span className="flex items-center gap-2">
                <input type="color" value={draft.colours[c]} onChange={(e) => set((k) => ({ ...k, colours: { ...k.colours, [c]: e.target.value.toUpperCase() } }))} className="size-9 cursor-pointer rounded-lg border border-line bg-transparent" aria-label={`${c} colour`} />
                <Input value={draft.colours[c]} onChange={(e) => set((k) => ({ ...k, colours: { ...k.colours, [c]: e.target.value } }))} className="font-mono" aria-label={`${c} colour code`} />
              </span>
            </label>
          ))}
        </div>
        <div className="flex gap-3 rounded-xl p-4" style={{ background: draft.colours.background }}>
          <span className="text-lg font-bold" style={{ color: draft.colours.text }}>
            {draft.name || 'Brand'}
          </span>
          <span className="rounded-full px-3 py-1 text-sm font-semibold" style={{ background: draft.colours.accent, color: draft.colours.background }}>
            GH₵ 450
          </span>
          <span className="ml-auto h-6 w-16 rounded" style={{ background: draft.colours.primary }} aria-hidden />
        </div>
      </Section>

      <Section title="Fonts">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {(['heading', 'body'] as const).map((which) => (
            <FontEditor
              key={which}
              label={which === 'heading' ? 'Headings' : 'Body text'}
              font={draft.fonts[which]}
              onChange={(f) => set((k) => ({ ...k, fonts: { ...k.fonts, [which]: f } }))}
              onUpload={async (file) => {
                const id = await upload(file, 'document', 'font');
                if (id) set((k) => ({ ...k, fonts: { ...k.fonts, [which]: { ...k.fonts[which], uploadAssetId: id, uploadFamily: file.name.replace(/\.[^.]+$/, '').slice(0, 80), licenceConfirmed: false } } }));
              }}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Logos"
        sub="The first logo is used on posters and closing cards."
        action={
          <>
            <input ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file, 'image', 'logo').then((id) => id && set((k) => ({ ...k, logos: [...k.logos, { assetId: id, label: file.name.replace(/\.[^.]+$/, '').slice(0, 80), variant: 'full' as const }].slice(0, 6) })));
            }} />
            <Button size="sm" variant="subtle" icon={<ImagePlus className="size-3.5" />} loading={uploading === 'logo'} onClick={() => logoRef.current?.click()} disabled={draft.logos.length >= 6}>
              Add logo
            </Button>
          </>
        }
      >
        {draft.logos.length === 0 ? (
          <p className="text-xs text-faint">No logo yet. A transparent PNG works best.</p>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {draft.logos.map((l, i) => (
              <li key={l.assetId} className="w-36 space-y-1.5">
                <div className="aspect-[3/2] overflow-hidden rounded-xl border border-line bg-white/[0.06] p-2">
                  <Thumb assetId={l.assetId} className="object-contain" />
                </div>
                <Input value={l.label} onChange={(e) => set((k) => ({ ...k, logos: k.logos.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }))} aria-label="Logo label" />
                <div className="flex items-center justify-between text-[11px]">
                  {i === 0 ? <Badge tone="success">Main</Badge> : <button type="button" className="cursor-pointer text-accent-2 hover:underline" onClick={() => set((k) => ({ ...k, logos: [k.logos[i]!, ...k.logos.filter((_, j) => j !== i)] }))}>Make main</button>}
                  <button type="button" className="cursor-pointer text-faint hover:text-danger" onClick={() => set((k) => ({ ...k, logos: k.logos.filter((_, j) => j !== i) }))}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Prices and offers"
        sub={`Each price is confirmed on the day it is typed or re-checked and must be confirmed again after ${KIT_REVIEW_DAYS.offer} days (change the day if the client says otherwise). Renamed items keep their old names, so a stale script is easy to spot.`}
        action={
          <Button size="sm" variant="subtle" icon={<Plus className="size-3.5" />} disabled={draft.offers.length >= 40} onClick={() => set((k) => ({ ...k, offers: [...k.offers, { id: newId('o'), item: '', price: '0', currency: k.offers[k.offers.length - 1]?.currency ?? 'GH₵', unit: '', note: '', confirmedOn: today, reviewBy: addDays(today, KIT_REVIEW_DAYS.offer), previousNames: [] }] }))}>
            Add price
          </Button>
        }
      >
        {draft.offers.length === 0 ? (
          <p className="text-xs text-faint">No prices yet.</p>
        ) : (
          <ul className="space-y-2">
            {draft.offers.map((o) => (
              <li key={o.id} className="space-y-2 rounded-xl border border-line p-3">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_6rem_7rem_minmax(0,10rem)_auto]">
                  <Input value={o.item} placeholder="Item (e.g. Regular passport)" maxLength={80} onChange={(e) => patchOffer(o.id, { item: e.target.value })} aria-label="Item" />
                  <Input value={o.currency} maxLength={8} onChange={(e) => patchOffer(o.id, { currency: e.target.value })} aria-label="Currency" />
                  <Input value={o.price} inputMode="decimal" onChange={(e) => patchOffer(o.id, { price: e.target.value.replace(/[^\d.,]/g, '') })} aria-label="Price" />
                  <Input value={o.unit} placeholder="per jar, from…" maxLength={40} onChange={(e) => patchOffer(o.id, { unit: e.target.value })} aria-label="Unit" />
                  <button type="button" aria-label="Remove price" className="grid size-9 cursor-pointer place-items-center rounded-lg text-faint hover:bg-white/10 hover:text-danger" onClick={() => set((k) => ({ ...k, offers: k.offers.filter((x) => x.id !== o.id) }))}>
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <ReviewCell today={today} reviewBy={o.reviewBy} confirmedOn={o.confirmedOn} onReviewBy={(d) => patchOffer(o.id, { reviewBy: d })} onReconfirm={() => void reconfirm([o.id])} />
                {o.previousNames.length > 0 && <p className="text-[11px] text-faint">Previously called: {o.previousNames.join(', ')}</p>}
                <p className="text-[11px] text-dim">Shown as “{offerText(o)}”</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Contacts"
        sub={`Phone and WhatsApp numbers, email, website, address and socials. Re-confirmed every ${KIT_REVIEW_DAYS.contact} days.`}
        action={
          <Button size="sm" variant="subtle" icon={<Plus className="size-3.5" />} disabled={draft.contacts.length >= 16} onClick={() => set((k) => ({ ...k, contacts: [...k.contacts, { id: newId('c'), kind: 'phone', label: '', value: '', confirmedOn: today, reviewBy: addDays(today, KIT_REVIEW_DAYS.contact) }] }))}>
            Add contact
          </Button>
        }
      >
        {draft.contacts.length === 0 ? (
          <p className="text-xs text-faint">No contacts yet.</p>
        ) : (
          <ul className="space-y-2">
            {draft.contacts.map((c) => (
              <li key={c.id} className="space-y-2 rounded-xl border border-line p-3">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-[9rem_minmax(0,10rem)_minmax(0,1fr)_auto]">
                  <Select value={c.kind} onChange={(e) => patchContact(c.id, { kind: e.target.value as KitContact['kind'] })} aria-label="Kind">
                    {KIT_CONTACT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIT_CONTACT_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                  <Input value={c.label} placeholder="Label (optional)" maxLength={80} onChange={(e) => patchContact(c.id, { label: e.target.value })} aria-label="Label" />
                  <Input value={c.value} placeholder={c.kind === 'phone' || c.kind === 'whatsapp' ? '054 216 1486' : c.kind === 'website' ? 'brightconsult.com' : ''} maxLength={200} onChange={(e) => patchContact(c.id, { value: e.target.value })} aria-label="Value" />
                  <button type="button" aria-label="Remove contact" className="grid size-9 cursor-pointer place-items-center rounded-lg text-faint hover:bg-white/10 hover:text-danger" onClick={() => set((k) => ({ ...k, contacts: k.contacts.filter((x) => x.id !== c.id) }))}>
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <ReviewCell today={today} reviewBy={c.reviewBy} confirmedOn={c.confirmedOn} onReviewBy={(d) => patchContact(c.id, { reviewBy: d })} onReconfirm={() => void reconfirm([c.id])} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Real product photos"
        sub="Photos of the real product, place or people. Every tool offers these before generating a picture — real photos beat generated ones."
        action={
          <>
            <input ref={photoRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => {
              const files = [...(e.target.files ?? [])].slice(0, 24 - draft.photos.length);
              e.target.value = '';
              void (async () => {
                for (const file of files) {
                  const id = await upload(file, 'image', 'photo');
                  if (id) set((k) => ({ ...k, photos: [...k.photos, { assetId: id, label: file.name.replace(/\.[^.]+$/, '').slice(0, 120), product: '', real: true }].slice(0, 24) }));
                }
              })();
            }} />
            <Button size="sm" variant="subtle" icon={<ImagePlus className="size-3.5" />} loading={uploading === 'photo'} onClick={() => photoRef.current?.click()} disabled={draft.photos.length >= 24}>
              Add photos
            </Button>
          </>
        }
      >
        {draft.photos.length === 0 ? (
          <p className="text-xs text-faint">No photos yet.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {draft.photos.map((ph, i) => (
              <li key={ph.assetId} className="space-y-1.5">
                <div className="aspect-square overflow-hidden rounded-xl border border-line">
                  <Thumb assetId={ph.assetId} />
                </div>
                <Input value={ph.product} placeholder="Product" maxLength={80} onChange={(e) => set((k) => ({ ...k, photos: k.photos.map((x, j) => (j === i ? { ...x, product: e.target.value } : x)) }))} aria-label="Product shown" />
                <div className="flex items-center justify-between text-[11px]">
                  <label className="inline-flex items-center gap-1 text-dim">
                    <input type="checkbox" checked={ph.real} onChange={(e) => set((k) => ({ ...k, photos: k.photos.map((x, j) => (j === i ? { ...x, real: e.target.checked } : x)) }))} /> Real photo
                  </label>
                  <button type="button" className="cursor-pointer text-faint hover:text-danger" onClick={() => set((k) => ({ ...k, photos: k.photos.filter((_, j) => j !== i) }))}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Notes" sub="Anything the next ad must respect: how the name is said, words to avoid, who approves.">
        <Textarea rows={4} maxLength={3000} value={draft.notes} onChange={(e) => set((k) => ({ ...k, notes: e.target.value }))} aria-label="Notes" />
      </Section>

      <ConfirmDialog open={del} onOpenChange={setDel} title="Delete this brand kit?" body="Ads that used it keep the colours, photos and facts they were given." confirmLabel="Delete" danger onConfirm={() => void remove()} />
    </div>
  );
}

export default function BrandKits() {
  const { kitId } = useParams();
  const navigate = useNavigate();
  const kits = useBrandKits();
  const today = todayKey();
  const creating = kitId === 'new';
  return (
    <div className="space-y-6">
      <SectionHeader eyebrow="Studio" title={<span className="text-5xl">Brand kits</span>} sub="One kit per client. Every ad tool fills its brand, facts and photos from it." />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
        <aside className="space-y-3">
          <Button variant={creating ? 'primary' : 'secondary'} className="w-full" icon={<Plus className="size-4" />} onClick={() => navigate('/studio/brands/new')}>
            New brand kit
          </Button>
          {kits.loading ? (
            <Skeleton className="h-40" />
          ) : kits.data.length === 0 ? (
            <p className="text-xs text-faint">No kits yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {kits.data.map((k) => {
                const stale = [...k.kit.offers, ...k.kit.contacts].filter((x) => reviewState(x.reviewBy, today) === 'overdue').length;
                return (
                  <li key={k.id}>
                    <Link to={`/studio/brands/${k.id}`} className={cx('flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors', k.id === kitId ? 'border-accent/60 bg-accent/10' : 'border-line hover:border-line-strong')}>
                      <span className="flex shrink-0 overflow-hidden rounded-md" aria-hidden>
                        <span className="size-4" style={{ background: k.kit.colours.primary }} />
                        <span className="size-4" style={{ background: k.kit.colours.accent }} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{k.kit.name}</span>
                      {stale > 0 && <Badge tone="danger">{stale} to re-confirm</Badge>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
        {kitId ? (
          <Editor key={kitId} kitId={creating ? null : kitId} />
        ) : (
          <EmptyState icon={<Palette className="size-6" />} title="Choose a kit, or make a new one" body="Colours, fonts, logos, contacts, dated prices and real photos — kept once, used by every ad." />
        )}
      </div>
    </div>
  );
}
