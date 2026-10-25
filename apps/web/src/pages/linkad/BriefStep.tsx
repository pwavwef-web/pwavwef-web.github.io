import { toast } from 'sonner';
import { Check, CircleAlert, Sparkles } from 'lucide-react';
import { allFacts, isConfirmed, LINKAD_LANGUAGES, LINKAD_LIMITS, LINKAD_TONES, LINKAD_VOICES, linkAdReadiness, type FactView } from '@az-studio/shared';
import { linkAdCall, newRequestId } from '../../lib/linkad';
import { Badge, Button, cx, Field, Input, Notice, Segmented, Select } from '../../components/ui';
import { EstimateBlock, type EstimateReply, Panel, SourceLink, Thumb, useEstimate } from './common';
import { KIND_LABEL } from './SourceStep';
import type { StepProps } from './LinkAdWorkspace';

export function BriefStep(p: StepProps) {
  const { editor, project, act } = p;
  const doc = editor.doc;
  const server = editor.server;
  const b = doc.brief;
  const set = (patch: Partial<typeof b>) => editor.update((d) => ({ ...d, brief: { ...d.brief, ...patch } }));
  const facts = allFacts(doc);
  const byId = new Map(facts.map((f) => [f.id, f]));
  const used = b.usedFactIds.map((id) => byId.get(id)).filter((f): f is FactView => Boolean(f));
  const needConfirm = used.filter((f) => f.needsConfirmation);
  const pictures = doc.source.assets.filter((a) => a.status === 'stored');
  const approved = Boolean(server.briefApprovedAt);
  const est = useEstimate(server.stage === 'reviewing' || server.stage === 'awaiting_selection' ? () => linkAdCall<EstimateReply>({ op: 'plan', projectId: project.id, requestId: 'estimate-only', estimateOnly: true }) : null, `${server.briefApprovedAt ?? 0}|${server.stage}|${b.usedFactIds.length}`);
  const problems = linkAdReadiness(doc, { final: false }).filter((i) => i.area === 'brief');

  const toggleFact = (id: string) => set({ usedFactIds: b.usedFactIds.includes(id) ? b.usedFactIds.filter((x) => x !== id) : [...b.usedFactIds, id].slice(0, 40) });
  const toggleImage = (id: string) => set({ imageIds: b.imageIds.includes(id) ? b.imageIds.filter((x) => x !== id) : [...b.imageIds, id].slice(0, LINKAD_LIMITS.maxImages) });

  const approveAndPlan = () =>
    act('Could not plan the directions', async () => {
      await editor.flush();
      await linkAdCall({ op: 'approveBrief', projectId: project.id, revision: editor.revision() });
      await linkAdCall({ op: 'plan', projectId: project.id, requestId: newRequestId() });
      toast.success('Planning three directions', { description: 'This takes about a minute. You can leave this page; the result is saved.' });
      p.go('directions');
    });

  if (!server.source.facts.length && !server.userFacts.length && !b.focus) {
    return (
      <Notice tone="warning">
        There is nothing to build an ad from yet.{' '}
        <button type="button" className="cursor-pointer underline" onClick={() => p.go('source')}>
          Go back to the website step
        </button>{' '}
        and add details of your own.
      </Notice>
    );
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Here is the ad I propose:"
        sub={b.origin === 'manual' ? 'You have edited this brief.' : b.origin === 'fixture' ? 'Fixture planner — a demo, not a live recommendation.' : 'Written by the planner from the facts on the previous step. Change anything.'}
      >
        {server.lastError?.step === 'analyse' && <Notice tone="warning">{server.lastError.message}</Notice>}

        <Field label="What is being promoted" htmlFor="brief-focus">
          <Input id="brief-focus" value={b.focus} maxLength={240} onChange={(e) => set({ focus: e.target.value })} placeholder="e.g. Sea-view rooms at Harbour Light Guesthouse" />
        </Field>
        {b.offerings.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-faint">The site also offers:</span>
            {b.offerings.map((o) => (
              <button key={o.id} type="button" className="cursor-pointer rounded-full border border-line px-3 py-1 text-xs text-dim hover:border-accent/50 hover:text-fg" onClick={() => set({ focus: o.name, usedFactIds: [...new Set([...b.usedFactIds, ...o.factIds])] })}>
                Focus on {o.name}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label={<span className="inline-flex items-center gap-2">Suggested audience {b.audience.origin === 'ai' && <Badge tone="violet" icon={<Sparkles className="size-3" />}>AI recommendation</Badge>}</span>} htmlFor="brief-aud">
            <Input id="brief-aud" value={b.audience.text} maxLength={240} onChange={(e) => set({ audience: { text: e.target.value, origin: 'user' } })} />
          </Field>
          <Field label="One viewer action" htmlFor="brief-action">
            <Input id="brief-action" value={b.action} maxLength={120} onChange={(e) => set({ action: e.target.value })} placeholder="e.g. Call to book" />
          </Field>
          <Field label="Central message" htmlFor="brief-msg">
            <Input id="brief-msg" value={b.message} maxLength={240} onChange={(e) => set({ message: e.target.value })} />
          </Field>
          <Field label="Supported benefit" htmlFor="brief-ben" hint={b.benefit.factId && byId.get(b.benefit.factId) ? 'Backed by a fact from the site.' : b.benefit.text ? 'Not tied to a fact — check it.' : undefined}>
            <Input id="brief-ben" value={b.benefit.text} maxLength={240} onChange={(e) => set({ benefit: { text: e.target.value, factId: b.benefit.factId } })} />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-[10rem_1fr]">
          <Field label="Destination" htmlFor="brief-dk">
            <Select id="brief-dk" value={b.destination.kind} onChange={(e) => set({ destination: { ...b.destination, kind: e.target.value as typeof b.destination.kind } })}>
              <option value="url">Website</option>
              <option value="phone">Phone</option>
              <option value="email">Email</option>
              <option value="text">Other text</option>
            </Select>
          </Field>
          <Field label="Where people should go" htmlFor="brief-dv" hint={b.destination.factId ? 'Taken from the site.' : 'Not found on the site — make sure it is right.'}>
            <Input id="brief-dv" value={b.destination.value} maxLength={300} onChange={(e) => set({ destination: { ...b.destination, value: e.target.value, factId: null } })} />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Tone" htmlFor="brief-tone">
            <Select id="brief-tone" value={b.tone} onChange={(e) => set({ tone: e.target.value as typeof b.tone })}>
              {LINKAD_TONES.map((t) => (
                <option key={t} value={t}>
                  {t[0]!.toUpperCase() + t.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Language" htmlFor="brief-lang" hint="More languages need a speech model and caption check for each; not built yet.">
            <Select id="brief-lang" value="en" onChange={() => undefined}>
              {LINKAD_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`Length: ${b.durationSec} s`} hint="15–30 seconds. The real length follows the recorded voice.">
            <input type="range" min={LINKAD_LIMITS.durationMin} max={LINKAD_LIMITS.durationMax} step={1} value={b.durationSec} onChange={(e) => set({ durationSec: Number(e.target.value) })} aria-label="Length in seconds" className="w-full accent-[var(--color-accent)]" />
          </Field>
          <Field label="Format" hint="Vertical 1080 × 1920. Other shapes later.">
            <Segmented label="Format" value="9:16" onChange={() => undefined} options={[{ value: '9:16', label: '9:16 vertical' }, { value: '1:1', label: '1:1', disabled: true, title: 'Coming later' }, { value: '16:9', label: '16:9', disabled: true, title: 'Coming later' }]} />
          </Field>
          <Field label="Voice" htmlFor="brief-voice">
            <Select id="brief-voice" value={b.voice} onChange={(e) => set({ voice: e.target.value as typeof b.voice })}>
              {LINKAD_VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="How it is read" htmlFor="brief-vd" className="xl:col-span-3">
            <Input id="brief-vd" value={b.voiceDirection} maxLength={160} onChange={(e) => set({ voiceDirection: e.target.value })} />
          </Field>
        </div>

        <div className="space-y-2">
          <p className="eyebrow">Pictures and logo in the ad</p>
          {pictures.length === 0 ? (
            <p className="text-sm text-faint">No pictures yet — the ad will be text-led. Add some on the Website step.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {pictures.map((a) => {
                const on = a.role === 'logo' ? b.logoId === a.id : b.imageIds.includes(a.id);
                return (
                  <li key={a.id}>
                    <button type="button" aria-pressed={on} title={a.role === 'logo' ? 'Logo' : a.alt || 'Picture'} onClick={() => (a.role === 'logo' ? set({ logoId: on ? null : a.id }) : toggleImage(a.id))} className={cx('relative h-16 w-20 cursor-pointer overflow-hidden rounded-lg border bg-black/30', on ? 'border-accent ring-1 ring-accent/50' : 'border-line opacity-60 hover:opacity-100')}>
                      <Thumb asset={a} className={a.role === 'logo' ? 'object-contain p-1' : ''} />
                      {on && <Check className="absolute top-1 right-1 size-4 rounded-full bg-accent p-0.5 text-white" aria-hidden />}
                      {a.role === 'logo' && <span className="absolute bottom-0 inset-x-0 bg-black/60 text-center text-[9px] text-white">Logo</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Panel>

      <Panel title="Facts this ad will lean on" sub="Untick anything you do not want said. Details that can go out of date must be confirmed before the final export.">
        <ul className="space-y-2">
          {facts
            .filter((f) => ['business_name', 'product_name', 'description', 'benefit', 'price', 'date', 'offer', 'contact', 'destination', 'location', 'rating'].includes(f.kind))
            .map((f) => {
              const on = b.usedFactIds.includes(f.id);
              const ok = isConfirmed(server, f);
              return (
                <li key={f.id} className={cx('flex items-start gap-3 rounded-xl border p-2.5', on ? 'border-accent/35' : 'border-line opacity-70')}>
                  <input type="checkbox" className="mt-1" checked={on} onChange={() => toggleFact(f.id)} aria-label={`Use: ${f.text}`} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={f.needsConfirmation ? 'warning' : 'neutral'}>{KIND_LABEL[f.kind]}</Badge>
                      {f.origin === 'user' && <Badge tone="violet">Yours</Badge>}
                      {f.needsConfirmation && on && (
                        <button type="button" className={cx('inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium', ok ? 'border-success/40 bg-success/10 text-success' : 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/20')} aria-pressed={ok} onClick={() => void editor.commit(ok ? { unconfirm: [f.id] } : { confirm: [f.id] }).catch(() => undefined)}>
                          {ok ? <Check className="size-3" /> : <CircleAlert className="size-3" />}
                          {ok ? 'Confirmed as current' : 'Confirm this is current'}
                        </button>
                      )}
                    </div>
                    <p className="text-sm text-fg">{f.text}</p>
                    <SourceLink url={f.sourceUrl} excerpt={f.excerpt} />
                  </div>
                </li>
              );
            })}
        </ul>
        {b.confirmNotes.length > 0 && (
          <div className="space-y-1">
            <p className="eyebrow">The planner suggests double-checking</p>
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-dim">
              {b.confirmNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        )}
        {needConfirm.some((f) => !isConfirmed(server, f)) && <Notice tone="warning">{needConfirm.filter((f) => !isConfirmed(server, f)).length} detail(s) still need confirming. You can plan now, but the final export will not run until they are confirmed or unticked.</Notice>}
        {problems.length > 0 && <Notice tone="warning">{problems[0]!.message}</Notice>}
      </Panel>

      <Panel title="Next" sub="The planner writes three different directions from the approved facts. Nothing is recorded or rendered yet.">
        <Field label="Spending cap for this ad" htmlFor="brief-cap" hint="Every paid step is checked against this before it starts. Estimates are shown first.">
          <Input id="brief-cap" type="number" min={0} max={25} step={0.25} value={doc.spend.capUsd} onChange={(e) => editor.update((d) => ({ ...d, spend: { ...d.spend, capUsd: Math.max(0, Math.min(25, Number(e.target.value) || 0)) } }))} className="w-32" />
        </Field>
        <EstimateBlock state={est} doc={server} />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" loading={p.busy} disabled={!b.focus.trim() || server.stage === 'planning' || server.stage === 'analysing'} onClick={() => void approveAndPlan()}>
            {approved ? 'Plan three directions again' : 'Approve and plan three directions'}
          </Button>
          {approved && server.directions.length > 0 && (
            <Button variant="ghost" onClick={() => p.go('directions')}>
              See the directions
            </Button>
          )}
        </div>
        {server.briefApprovedAt && (
          <p className="text-[11px] text-faint">
            Approved facts are saved separately from the planner&apos;s suggestions. If you change a fact later, the scenes that rely on it are flagged for review.
          </p>
        )}
      </Panel>
    </div>
  );
}
