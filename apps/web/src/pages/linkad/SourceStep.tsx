import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Check, CircleAlert, ImagePlus, RefreshCw, Trash2 } from 'lucide-react';
import { allFacts, CONFIRM_KINDS, factHash, FACT_KINDS, isConfirmed, newId, type FactKind, type FactView, type LinkAdAsset } from '@az-studio/shared';
import { linkAdCall, newRequestId } from '../../lib/linkad';
import { uploadFile } from '../../lib/media';
import { Badge, Button, cx, Field, Input, Notice, Select, Textarea } from '../../components/ui';
import { Panel, SourceLink, Thumb, hostOf, useEstimate, EstimateBlock, type EstimateReply } from './common';
import type { StepProps } from './LinkAdWorkspace';

export const KIND_LABEL: Record<FactKind, string> = {
  business_name: 'Business',
  product_name: 'Offering',
  description: 'About',
  benefit: 'Benefit',
  price: 'Price',
  date: 'Date',
  offer: 'Offer',
  contact: 'Contact',
  destination: 'Where to send people',
  location: 'Place',
  rating: 'Rating',
  other: 'Other',
};

const PAGE_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  ok: { label: 'Read', tone: 'success' },
  empty: { label: 'Almost empty', tone: 'warning' },
  blocked: { label: 'Not read', tone: 'warning' },
  failed: { label: 'Could not be read', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

function FactRow({ f, p }: { f: FactView; p: StepProps }) {
  const { editor } = p;
  const doc = editor.server;
  const [text, setText] = useState(f.text);
  const confirmed = isConfirmed(doc, f);
  const needs = f.needsConfirmation;
  const save = async () => {
    if (text.trim() && text.trim() !== f.text) await editor.commit({ factEdits: { [f.id]: text.trim() } }).catch(() => undefined);
  };
  return (
    <li className="space-y-1.5 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={needs ? 'warning' : 'neutral'}>{KIND_LABEL[f.kind]}</Badge>
        {f.origin === 'user' && <Badge tone="violet">Yours</Badge>}
        {f.qualifier && <span className="text-[11px] text-faint">{f.qualifier}</span>}
        {needs && (
          <button
            type="button"
            className={cx('ml-auto inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium', confirmed ? 'border-success/40 bg-success/10 text-success' : 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/20')}
            aria-pressed={confirmed}
            onClick={() => void editor.commit(confirmed ? { unconfirm: [f.id] } : { confirm: [f.id] }).catch(() => undefined)}
          >
            {confirmed ? <Check className="size-3" /> : <CircleAlert className="size-3" />}
            {confirmed ? 'Confirmed as current' : 'Confirm this is current'}
          </button>
        )}
      </div>
      {f.origin === 'source' ? text.length > 100 ? <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => void save()} aria-label={`${KIND_LABEL[f.kind]} wording`} /> : <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => void save()} aria-label={`${KIND_LABEL[f.kind]} wording`} /> : <p className="text-sm text-fg">{f.text}</p>}
      <SourceLink url={f.sourceUrl} excerpt={f.excerpt} />
    </li>
  );
}

export function SourceStep(p: StepProps) {
  const { editor, project, act, job } = p;
  const doc = editor.doc;
  const server = editor.server;
  const fileRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState<{ kind: FactKind; text: string }>({ kind: 'benefit', text: '' });
  const facts = allFacts(server);
  const groups = FACT_KINDS.map((k) => ({ k, items: facts.filter((f) => f.kind === k) })).filter((g) => g.items.length);
  const analysing = server.stage === 'analysing' || Boolean(job && (job.params as { step?: string }).step === 'analyse' && ['queued', 'validating', 'generating', 'downloading'].includes(job.status));
  const est = useEstimate(analysing ? null : () => linkAdCall<EstimateReply>({ op: 'analyse', projectId: project.id, requestId: 'estimate-only', estimateOnly: true }), `${server.input.url}|${server.input.maxPages}|${analysing}`);

  const reread = () =>
    act('Could not read the website', async () => {
      await linkAdCall({ op: 'analyse', projectId: project.id, requestId: newRequestId(), manualOnly: !server.input.url.trim() });
      toast.success('Reading the website again', { description: 'Your edits to the wording and your confirmations are kept.' });
    });

  const upload = async (file: File | undefined, role: 'logo' | 'image') => {
    if (!file) return;
    await act('Could not add the picture', async () => {
      const assetId = await uploadFile(file, { kind: 'image', projectId: project.id, collections: ['linkad:upload'] });
      await linkAdCall({ op: 'addAsset', projectId: project.id, assetId, role, rightsConfirmed: doc.input.rightsConfirmed });
      toast.success(role === 'logo' ? 'Logo added' : 'Picture added', { description: doc.input.rightsConfirmed ? undefined : 'Tick the rights confirmation before it can appear in the ad.' });
    });
  };

  const setAsset = (a: LinkAdAsset, patch: { selected?: boolean; rights?: 'confirmed' | 'unconfirmed' }) => void editor.commit({ assets: [{ id: a.id, ...patch }] }).catch(() => undefined);
  const assets = server.source.assets;
  const usable = server.source.facts.length > 0 || server.userFacts.length > 0;

  return (
    <div className="space-y-6">
      <Panel
        title="What I found"
        sub={server.input.url ? `Read from ${hostOf(server.input.url)} · at most ${server.input.maxPages} page${server.input.maxPages === 1 ? '' : 's'} of that one site` : 'Built from the details you wrote'}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={<RefreshCw className="size-4" />} onClick={() => void reread()} disabled={analysing || p.busy}>
              Read again
            </Button>
            {usable && (
              <Button variant="primary" onClick={() => p.go('brief')}>
                Continue
              </Button>
            )}
          </div>
        }
      >
        {analysing && job && (
          <Notice tone="accent">
            <span className="text-fg">{job.stage}</span>
          </Notice>
        )}
        {!analysing && server.source.status === 'failed' && <Notice tone="danger">Nothing could be read from this website. Paste the details yourself below, upload pictures, and continue.</Notice>}
        {!analysing && server.source.status === 'partial' && <Notice tone="warning">Some pages could not be read, so this is partial. Check the list below and add anything missing.</Notice>}
        {!analysing && server.source.status === 'manual' && <Notice tone="accent">This ad is built from the details you wrote, not from a website.</Notice>}
        <EstimateBlock state={est} doc={server} />

        {server.source.pages.length > 0 && (
          <ul className="space-y-1.5">
            {server.source.pages.map((pg) => {
              const s = PAGE_STATUS[pg.status] ?? PAGE_STATUS.ok!;
              return (
                <li key={pg.url} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={s.tone}>{s.label}</Badge>
                  <a href={pg.finalUrl ?? pg.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-dim hover:text-fg hover:underline">
                    {pg.title || hostOf(pg.url)}
                  </a>
                  {pg.via === 'firecrawl' && <Badge tone="accent">Firecrawl</Badge>}
                  {pg.note && <span className="text-xs text-faint">{pg.note}</span>}
                </li>
              );
            })}
          </ul>
        )}
        {server.source.warnings.length > 0 && (
          <ul className="space-y-1 text-xs text-warning">
            {server.source.warnings.map((w, i) => (
              <li key={i} className="flex gap-1.5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {w}
              </li>
            ))}
          </ul>
        )}
        {server.source.ignoredInstructions.length > 0 && (
          <Notice tone="warning">
            The website contained text that talks to AI assistants. It was ignored and never used: “{server.source.ignoredInstructions[0]!.slice(0, 140)}”{server.source.ignoredInstructions.length > 1 ? ` (+${server.source.ignoredInstructions.length - 1} more)` : ''}
          </Notice>
        )}
        {server.source.conflicts.map((c) => (
          <Notice key={c.id} tone="warning">
            {c.message}
          </Notice>
        ))}
        {server.source.missing.length > 0 && (
          <ul className="space-y-1 text-xs text-dim">
            {server.source.missing.map((m, i) => (
              <li key={i}>• {m}</li>
            ))}
          </ul>
        )}
      </Panel>

      {groups.length > 0 && (
        <Panel title="Facts" sub="Each fact keeps the page it came from. Edit the wording if it is not right. Prices, dates and offers must be confirmed as current before they can appear in the ad — the time we read the page does not prove they still are.">
          <div className="space-y-5">
            {groups.map((g) => (
              <div key={g.k} className="space-y-2">
                <p className="eyebrow">{KIND_LABEL[g.k]}</p>
                <ul className="space-y-2">
                  {g.items.map((f) => (
                    <FactRow key={f.id} f={f} p={p} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Your own facts" sub="Things you know that the site does not say. They are kept apart from what was found, and marked as yours.">
        {doc.userFacts.length > 0 && (
          <ul className="space-y-2">
            {doc.userFacts.map((f) => (
              <li key={f.id} className="flex items-center gap-2 rounded-xl border border-line p-2.5">
                <Badge tone="violet">{KIND_LABEL[f.kind]}</Badge>
                <span className="min-w-0 flex-1 text-sm text-fg">{f.text}</span>
                {CONFIRM_KINDS.includes(f.kind) && (
                  <button type="button" className="cursor-pointer text-[11px] text-warning hover:underline" onClick={() => void editor.commit(isConfirmed(server, { ...f, value: null, currency: null, qualifier: null, origin: 'user', needsConfirmation: true, sourceUrl: null, excerpt: null }) ? { unconfirm: [f.id] } : { confirm: [f.id] }).catch(() => undefined)}>
                    {server.confirmations[f.id] === factHash({ text: f.text, value: null, currency: null, qualifier: null }) ? 'Confirmed' : 'Confirm'}
                  </button>
                )}
                <button type="button" aria-label="Remove this fact" className="cursor-pointer text-faint hover:text-danger" onClick={() => editor.update((d) => ({ ...d, userFacts: d.userFacts.filter((x) => x.id !== f.id) }))}>
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!adding.text.trim()) return;
            editor.update((d) => ({ ...d, userFacts: [...d.userFacts, { id: `uf_${newId('')}`, kind: adding.kind, text: adding.text.trim().slice(0, 400), at: Date.now() }].slice(0, 40) }));
            setAdding({ ...adding, text: '' });
          }}
        >
          <Field label="Kind" className="w-44">
            <Select value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value as FactKind })} aria-label="Kind of fact">
              {FACT_KINDS.filter((k) => !['business_name', 'rating', 'other'].includes(k)).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fact" className="min-w-[16rem] flex-1">
            <Input value={adding.text} maxLength={400} onChange={(e) => setAdding({ ...adding, text: e.target.value })} placeholder="e.g. Free airport pickup on request" />
          </Field>
          <Button type="submit" disabled={!adding.text.trim()}>
            Add
          </Button>
        </form>
        <Field label="Notes the planner may use" hint="Pasted details, if the website is blocked or thin. Each line becomes one of your facts the next time the site is read." htmlFor="linkad-notes-edit">
          <Textarea id="linkad-notes-edit" rows={3} value={doc.input.manualText} onChange={(e) => editor.update((d) => ({ ...d, input: { ...d.input, manualText: e.target.value } }))} />
        </Field>
      </Panel>

      <Panel title="Pictures and logo" sub="Public availability is not a licence. Only pictures you may use in an advert can appear in the video.">
        <label className="flex items-start gap-2 text-sm text-dim">
          <input type="checkbox" className="mt-1" checked={doc.input.rightsConfirmed} onChange={(e) => editor.update((d) => ({ ...d, input: { ...d.input, rightsConfirmed: e.target.checked } }))} />
          <span>
            <strong className="text-fg">I own these pictures or have permission to use them in an advert.</strong> This covers pictures taken from the website and anything I upload.
          </span>
        </label>
        {assets.length === 0 ? (
          <p className="text-sm text-faint">No pictures were found. You can upload your own, or make a text-led ad.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {assets.map((a) => (
              <li key={a.id} className={cx('space-y-1.5 rounded-xl border p-2', a.selected ? 'border-accent/50' : 'border-line')}>
                <div className="aspect-[4/3] overflow-hidden rounded-lg bg-black/30">
                  <Thumb asset={a} className={a.role === 'logo' ? 'object-contain p-2' : ''} />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Badge tone={a.role === 'logo' ? 'accent' : 'neutral'}>{a.role === 'logo' ? 'Logo' : 'Picture'}</Badge>
                  {a.origin === 'upload' && <Badge tone="violet">Uploaded</Badge>}
                  {a.origin === 'generated' && <Badge tone="warning">AI-made</Badge>}
                </div>
                {a.status === 'rejected' ? (
                  <p className="text-[11px] text-danger">{a.rejectReason ?? 'Not usable'}</p>
                ) : a.status === 'candidate' ? (
                  <p className="text-[11px] text-faint">Found; not downloaded</p>
                ) : (
                  <>
                    <p className="text-[11px] text-faint">{a.width && a.height ? `${a.width}×${a.height}` : ''}</p>
                    <label className="flex items-center gap-1.5 text-[11px] text-dim">
                      <input type="checkbox" checked={a.rights === 'confirmed'} onChange={(e) => setAsset(a, { rights: e.target.checked ? 'confirmed' : 'unconfirmed' })} /> I may use this
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-dim">
                      <input type="checkbox" checked={a.selected} onChange={(e) => setAsset(a, { selected: e.target.checked })} /> Use in the ad
                    </label>
                  </>
                )}
                {a.pageUrl && <SourceLink url={a.pageUrl} />}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void upload(e.target.files?.[0], 'image').finally(() => (e.target.value = ''))} />
          <input ref={logoRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void upload(e.target.files?.[0], 'logo').finally(() => (e.target.value = ''))} />
          <Button icon={<ImagePlus className="size-4" />} onClick={() => fileRef.current?.click()} disabled={p.busy}>
            Upload a picture
          </Button>
          <Button icon={<ImagePlus className="size-4" />} onClick={() => logoRef.current?.click()} disabled={p.busy}>
            Upload a logo
          </Button>
        </div>
        <p className="text-[11px] text-faint">JPEG, PNG or WebP. SVG logos cannot be used — export a PNG.</p>
      </Panel>
    </div>
  );
}
