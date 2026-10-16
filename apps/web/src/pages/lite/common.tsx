import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Check, CloudOff, Coins, LoaderCircle, Save, TriangleAlert } from 'lucide-react';
import { formatUsd, LITE_STAGE_LABELS, LITE_STAGES, type LiteAspect, type LiteSpec, type LiteStage, type ProjectDoc, type ScoreDoc } from '@az-studio/shared';
import type { WithId } from '../../lib/data';
import { errorMessage } from '../../lib/api';
import { liteGenerate, type DraftStatus, type Job, type LiteGenerateResponse, type LiteWorkKind, type useComposition } from '../../lib/lite';
import { useSession } from '../../lib/session';
import { Badge, Button, cx, Modal, Notice, Slider } from '../../components/ui';

export interface Focus {
  sceneId: string | null;
  shotId: string | null;
}

export interface StageProps {
  project: WithId<ProjectDoc>;
  spec: LiteSpec;
  update: (patch: Partial<LiteSpec> | ((s: LiteSpec) => LiteSpec), label?: string) => void;
  flush: () => Promise<void>;
  jobs: Job[];
  score: WithId<ScoreDoc> | null;
  comp: ReturnType<typeof useComposition>;
  aspect: LiteAspect;
  setAspect: (a: LiteAspect) => void;
  go: (stage: LiteStage, focus?: Partial<Focus>) => void;
  focus: Focus;
  setFocus: (f: Partial<Focus>) => void;
  work: ReturnType<typeof useLiteWork>;
}

export function DraftBadge({ status }: { status: DraftStatus }) {
  if (status === 'saving') return <Badge icon={<LoaderCircle className="size-3 animate-spin" />}>Saving…</Badge>;
  if (status === 'unsaved') return <Badge icon={<Save className="size-3" />}>Unsaved changes</Badge>;
  if (status === 'error') return <Badge tone="danger" icon={<CloudOff className="size-3" />}>Not saved — retrying on next edit</Badge>;
  return <Badge tone="success" icon={<Check className="size-3" />}>Saved</Badge>;
}

export function Stepper({ current, onChange, attention, done }: { current: LiteStage; onChange: (s: LiteStage) => void; attention: Set<LiteStage>; done: Set<LiteStage> }) {
  return (
    <nav aria-label="Film workflow" className="scroll-x">
      <ol className="flex min-w-max items-center gap-1.5">
        {LITE_STAGES.map((s, i) => {
          const active = s === current;
          const ok = done.has(s) && !attention.has(s);
          return (
            <li key={s} className="flex items-center gap-1.5">
              <button type="button" aria-current={active ? 'step' : undefined} onClick={() => onChange(s)} className={cx('inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors', active ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim hover:text-fg')}>
                <span className={cx('grid size-5 place-items-center rounded-full text-[10px]', ok ? 'bg-success/20 text-success' : active ? 'bg-accent text-white' : 'bg-white/10 text-dim')}>{ok ? <Check className="size-3" /> : i + 1}</span>
                {LITE_STAGE_LABELS[s]}
                {attention.has(s) && <span className="size-1.5 rounded-full bg-warning" aria-label="needs attention" />}
              </button>
              {i < LITE_STAGES.length - 1 && <span className="h-px w-4 bg-line-strong" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

interface Pending {
  kind: LiteWorkKind;
  opts: { targetIds?: string[]; force?: boolean };
  estimate: LiteGenerateResponse;
  resolve: (ok: boolean) => void;
}

const KIND_LABEL: Record<LiteWorkKind, string> = { images: 'images', narration: 'narration', music: 'score', ambience: 'ambience' };

/**
 * Paid work for the film goes through one path: the server works out what is still needed (reusing
 * finished results), prices it from published rates, and nothing starts until it is reviewed here.
 */
export function useLiteWork(projectId: string, flush: () => Promise<void>) {
  const [busy, setBusy] = useState<LiteWorkKind | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirming, setConfirming] = useState(false);
  const refresh = useSession((s) => s.refresh);

  const run = async (kind: LiteWorkKind, opts: { targetIds?: string[]; force?: boolean } = {}): Promise<boolean> => {
    if (busy) return false;
    setBusy(kind);
    try {
      await flush();
      const est = await liteGenerate(projectId, kind, { ...opts, estimateOnly: true });
      if (!est.perTarget.length) {
        toast.message(est.message ?? 'Nothing new to request.', { description: est.skipped.slice(0, 3).map((s) => s.reason).join(' · ') || undefined });
        return false;
      }
      if (est.limitProblem) throw new Error(est.limitProblem);
      const free = (est.estimate?.usd ?? 0) === 0 && kind === 'ambience';
      if (free) {
        const res = await liteGenerate(projectId, kind, { ...opts, confirmedUsd: 0 });
        toast.success(`${res.jobIds.length} ambience bed${res.jobIds.length === 1 ? '' : 's'} queued`, { description: 'Synthesised locally — no AI generation.' });
        return true;
      }
      return await new Promise<boolean>((resolve) => setPending({ kind, opts, estimate: est, resolve }));
    } catch (e) {
      toast.error(`Could not prepare the ${KIND_LABEL[kind]}`, { description: errorMessage(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setConfirming(true);
    try {
      const res = await liteGenerate(projectId, pending.kind, { ...pending.opts, confirmedUsd: pending.estimate.estimate?.usd ?? 0 });
      toast.success(res.jobIds.length ? `${res.jobIds.length} request${res.jobIds.length === 1 ? '' : 's'} queued` : res.message ?? 'Nothing new to request', res.estimate ? { description: `Estimated ${formatUsd(res.estimate.usd)}` } : undefined);
      pending.resolve(true);
      setPending(null);
      void refresh();
    } catch (e) {
      toast.error('Could not start', { description: errorMessage(e) });
    } finally {
      setConfirming(false);
    }
  };

  const dialog = pending ? (
    <WorkDialog
      estimate={pending.estimate}
      kind={pending.kind}
      loading={confirming}
      onCancel={() => {
        pending.resolve(false);
        setPending(null);
      }}
      onConfirm={() => void confirm()}
    />
  ) : null;
  return { run, busy, dialog };
}

export function WorkDialog({ estimate, kind, loading, onCancel, onConfirm }: { estimate: LiteGenerateResponse; kind: LiteWorkKind; loading: boolean; onCancel: () => void; onConfirm: () => void }) {
  const e = estimate.estimate;
  const [all, setAll] = useState(false);
  const rows = all ? estimate.perTarget : estimate.perTarget.slice(0, 8);
  const priced = e && e.basis !== 'none';
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onCancel()}
      title={`Review before generating ${KIND_LABEL[kind]}`}
      description={`${estimate.perTarget.length} new request${estimate.perTarget.length === 1 ? '' : 's'} · ${estimate.skipped.length} reused or already in progress`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" loading={loading} onClick={onConfirm} icon={<Coins className="size-4" />}>
            Start · {priced ? `≈ ${formatUsd(e!.usd)}` : 'price unavailable'}
          </Button>
        </>
      }
    >
      <div>
        <p className="eyebrow">Estimated cost</p>
        {priced ? <p className="display text-5xl text-fg">{formatUsd(e!.usd)}</p> : <p className="text-sm text-warning">Pricing for this model is not configured, so no estimate is shown.</p>}
        {priced && <p className="mt-1 text-xs text-faint">From Google’s published list prices · confidence {e!.confidence} · pricing {e!.pricingVersion}. Rendering and storage are billed separately by Google Cloud.</p>}
      </div>
      <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center justify-between gap-3 px-3.5 py-2 text-sm">
            <span className="min-w-0 truncate text-dim">{r.title}</span>
            <span className="timecode shrink-0 text-fg">{r.estimate ? formatUsd(r.estimate.usd, { precise: true }) : '—'}</span>
          </li>
        ))}
      </ul>
      {estimate.perTarget.length > 8 && (
        <button type="button" className="mt-2 cursor-pointer text-xs text-accent-2 hover:underline" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${estimate.perTarget.length}`}
        </button>
      )}
      {estimate.skipped.length > 0 && (
        <details className="mt-3 text-xs text-faint">
          <summary className="cursor-pointer text-dim">Not requested again ({estimate.skipped.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {estimate.skipped.slice(0, 30).map((s) => (
              <li key={s.key}>· {s.reason}</li>
            ))}
          </ul>
        </details>
      )}
      {estimate.confirmation?.reasons.length ? (
        <Notice tone="warning" icon={<TriangleAlert className="size-4" />} className="mt-3">
          {estimate.confirmation.reasons.join(' · ')}
        </Notice>
      ) : null}
      {e?.notes.length ? (
        <ul className="mt-3 space-y-1 text-xs text-faint">
          {e.notes.map((n) => (
            <li key={n}>· {n}</li>
          ))}
        </ul>
      ) : null}
    </Modal>
  );
}

export function Section({ title, sub, action, children, className }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('card p-5', className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="display text-2xl text-fg">{title}</h2>
          {sub && <p className="mt-0.5 text-xs text-dim">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function LabeledSlider({ label, value, display, min, max, step, onChange, className }: { label: string; value: number; display?: string; min: number; max: number; step: number; onChange: (v: number) => void; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="text-dim">{label}</span>
        <span className="timecode text-fg">{display ?? value}</span>
      </div>
      <Slider label={label} value={value} min={min} max={max} step={step} onChange={onChange} />
    </div>
  );
}

export const fmtSec =(s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s.toFixed(1)} s`);
