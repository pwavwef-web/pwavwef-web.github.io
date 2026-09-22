import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { AudioWaveform, Ban, CircleAlert, Clapperboard, Coins, Film, Image as ImageIcon, NotebookPen, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react';
import {
  formatDuration,
  formatUsd,
  isTerminal,
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  relativeTime,
  toMillis,
  type CostEstimate,
  type JobDoc,
  type JobRequest,
  type JobType,
} from '@az-studio/shared';
import { api, errorMessage, estimateJobs, submitJobsRaw, type EstimateResponse } from '../lib/api';
import type { WithId } from '../lib/data';
import { useSession } from '../lib/session';
import { Badge, Button, ConfirmDialog, cx, Modal, Notice, ProgressBar, Tip } from './ui';
import { AssetThumb, useAsset } from './media';

export type Job = WithId<JobDoc>;

const TYPE_ICON: Record<JobType, ReactNode> = {
  'image.generate': <ImageIcon className="size-4" />,
  'video.generate': <Film className="size-4" />,
  'text.assist': <NotebookPen className="size-4" />,
  'audio.analyze': <AudioWaveform className="size-4" />,
  'render.timeline': <Clapperboard className="size-4" />,
};

export function statusTone(status: JobDoc['status']) {
  if (status === 'completed') return 'success' as const;
  if (status === 'failed') return 'danger' as const;
  if (status === 'cancelled') return 'neutral' as const;
  if (status === 'queued') return 'neutral' as const;
  return 'accent' as const;
}

export function EstimateText({ estimate, className }: { estimate: CostEstimate | null | undefined; className?: string }) {
  if (!estimate) return null;
  if (estimate.basis === 'none') return <span className={cx('text-xs text-faint', className)}>No published price for this option</span>;
  return (
    <Tip
      label={
        <span>
          {estimate.basis === 'compute' ? 'Cloud Run compute estimate.' : 'Estimated from Google’s published Vertex AI list prices.'} Confidence: {estimate.confidence}.
          {estimate.notes.length ? ` ${estimate.notes.join(' ')}` : ''}
        </span>
      }
    >
      <span className={cx('inline-flex items-center gap-1 text-xs text-dim', className)}>
        <Coins className="size-3.5 text-warning" aria-hidden />≈ {formatUsd(estimate.usd, { precise: estimate.usd < 0.01 })}
        <span className="text-faint">est.</span>
      </span>
    </Tip>
  );
}

// ---------------------------------------------------------------------------
// Submission with cost confirmation
// ---------------------------------------------------------------------------

interface Pending {
  jobs: JobRequest[];
  estimate: EstimateResponse;
  label?: string;
  resolve: (ids: string[] | null) => void;
}

export function useJobSubmitter() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const refreshSession = useSession((s) => s.refresh);
  const inFlight = useRef(false);

  const submit = useCallback(
    async (jobs: JobRequest[], opts: { label?: string; alwaysConfirm?: boolean } = {}): Promise<string[] | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setBusy(true);
      try {
        const estimate = await estimateJobs(jobs);
        if (estimate.batchTooLarge) throw new Error(`Batches are limited to ${estimate.settings.maxBatchSize} jobs (change this in Settings).`);
        if (estimate.limitProblem) throw new Error(estimate.limitProblem);
        if (estimate.confirmation.required || opts.alwaysConfirm) {
          const ids = await new Promise<string[] | null>((resolve) => setPending({ jobs, estimate, ...(opts.label ? { label: opts.label } : {}), resolve }));
          return ids;
        }
        const res = await submitJobsRaw(jobs, null, opts.label);
        toast.success(jobs.length > 1 ? `${jobs.length} jobs queued` : 'Job queued', { description: `Estimated ${formatUsd(res.estimate.usd)}` });
        void refreshSession();
        return res.jobIds;
      } catch (e) {
        toast.error('Could not submit', { description: errorMessage(e) });
        return null;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [refreshSession],
  );

  const confirm = async () => {
    if (!pending) return;
    setConfirming(true);
    try {
      const res = await submitJobsRaw(pending.jobs, pending.estimate.estimate.usd, pending.label);
      toast.success(`${pending.jobs.length} job${pending.jobs.length > 1 ? 's' : ''} queued`, { description: `Estimated ${formatUsd(res.estimate.usd)}` });
      pending.resolve(res.jobIds);
      setPending(null);
      void refreshSession();
    } catch (e) {
      toast.error('Could not submit', { description: errorMessage(e) });
    } finally {
      setConfirming(false);
    }
  };

  const dialog = pending ? (
    <CostDialog
      estimate={pending.estimate}
      count={pending.jobs.length}
      loading={confirming}
      onCancel={() => {
        pending.resolve(null);
        setPending(null);
      }}
      onConfirm={() => void confirm()}
    />
  ) : null;

  return { submit, busy, dialog };
}

function CostDialog({ estimate, count, loading, onCancel, onConfirm }: { estimate: EstimateResponse; count: number; loading: boolean; onCancel: () => void; onConfirm: () => void }) {
  const e = estimate.estimate;
  const s = estimate.spend;
  const st = estimate.settings;
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? estimate.perJob : estimate.perJob.slice(0, 6);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onCancel()}
      title="Confirm generation cost"
      description={`${count} job${count > 1 ? 's' : ''} · estimated from Google’s published list prices`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" loading={loading} onClick={onConfirm} icon={<Coins className="size-4" />}>
            Generate · ≈ {formatUsd(e.usd)}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Estimated total</p>
          <p className="display text-5xl text-fg">{formatUsd(e.usd)}</p>
          <p className="mt-1 text-xs text-faint">
            Confidence: <span className="text-dim">{e.confidence}</span> · pricing {e.pricingVersion}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-right text-xs">
          <Spend label="Today" value={s.today.costUsd} limit={st.dailyLimitUsd} />
          <Spend label="This month" value={s.month.costUsd} limit={st.monthlyLimitUsd} />
          <div>
            <p className="text-faint">In progress</p>
            <p className="timecode text-sm text-fg">{formatUsd(s.pendingUsd)}</p>
          </div>
        </div>
      </div>
      {estimate.confirmation.reasons.length > 0 && (
        <Notice tone="warning" icon={<TriangleAlert className="size-4" />} className="mt-4">
          {estimate.confirmation.reasons.join(' · ')}
        </Notice>
      )}
      <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
        {rows.map((j, i) => (
          <li key={i} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm">
            <span className="min-w-0 truncate text-dim">{j.label}</span>
            <span className="timecode shrink-0 text-fg">{formatUsd(j.estimate.usd, { precise: true })}</span>
          </li>
        ))}
      </ul>
      {estimate.perJob.length > 6 && (
        <button type="button" className="mt-2 cursor-pointer text-xs text-accent-2 hover:underline" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${estimate.perJob.length}`}
        </button>
      )}
      {e.notes.length > 0 && (
        <ul className="mt-4 space-y-1 text-xs text-faint">
          {e.notes.map((n) => (
            <li key={n}>· {n}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-faint">Actual charges appear in Google Cloud Billing and can differ from this estimate. Requests that fail with an error are not billed by Vertex AI.</p>
    </Modal>
  );
}

function Spend({ label, value, limit }: { label: string; value: number; limit: number }) {
  const pct = limit > 0 ? value / limit : 0;
  return (
    <div>
      <p className="text-faint">{label}</p>
      <p className={cx('timecode text-sm', pct > 0.9 ? 'text-warning' : 'text-fg')}>
        {formatUsd(value)} <span className="text-faint">/ {formatUsd(limit)}</span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Job card
// ---------------------------------------------------------------------------

function elapsed(job: Job): string {
  const start = toMillis(job.startedAt) ?? toMillis(job.createdAt);
  const end = isTerminal(job.status) ? toMillis(job.completedAt) ?? Date.now() : Date.now();
  if (!start) return '';
  return formatDuration((end - start) / 1000);
}

export function JobCard({ job, compact, showProject }: { job: Job; compact?: boolean; showProject?: boolean }) {
  const [retryOpen, setRetryOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const active = !isTerminal(job.status);
  const assetId = job.result?.assetIds?.[0] ?? null;
  const asset = useAsset(job.status === 'completed' ? assetId : null);

  const cancel = async () => {
    setWorking(true);
    try {
      const r = await api<{ status: string; message: string }, 'cancelJob'>('cancelJob', { jobId: job.id });
      toast(r.message);
    } catch (e) {
      toast.error('Cancel failed', { description: errorMessage(e) });
    } finally {
      setWorking(false);
    }
  };
  const retry = async () => {
    setWorking(true);
    try {
      await api('retryJob', { jobId: job.id, acknowledgeCharge: true });
      toast.success('Retry queued');
      setRetryOpen(false);
    } catch (e) {
      toast.error('Retry failed', { description: errorMessage(e) });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className={cx('card flex gap-3 p-3.5 animate-rise', job.error?.safety && 'border-warning/30')}>
      {asset.data && !compact ? (
        <div className="w-28 shrink-0 sm:w-36">
          <AssetThumb asset={asset.data} showMeta={false} />
        </div>
      ) : (
        <div className={cx('grid size-10 shrink-0 place-items-center rounded-xl', active ? 'bg-accent/15 text-accent-2' : 'bg-white/[0.05] text-dim')}>{TYPE_ICON[job.type]}</div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 truncate text-sm font-medium text-fg">{job.label}</p>
          <Badge tone={statusTone(job.status)}>{JOB_STATUS_LABELS[job.status]}</Badge>
          {job.error?.safety && (
            <Badge tone="warning" icon={<ShieldCheck className="size-3" />}>
              Safety filter
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-dim">
          {JOB_TYPE_LABELS[job.type]} · {job.stage}
          {job.modelId ? <span className="text-faint"> · {job.modelId}</span> : null}
        </p>
        {active && <ProgressBar value={job.status === 'queued' ? 0.02 : job.progress} className="mt-2" label={`${job.label} progress`} />}
        {job.error && (
          <p className={cx('mt-2 flex items-start gap-1.5 text-xs', job.error.safety ? 'text-warning' : 'text-[#ff9b9b]')}>
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{job.error.message}</span>
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
          <span>{relativeTime(toMillis(job.createdAt))}</span>
          <span>{elapsed(job)}</span>
          <EstimateText estimate={job.estimate} />
          {job.usageUsd !== null && job.usageUsd !== undefined && <span data-private>recorded {formatUsd(job.usageUsd, { precise: true })}</span>}
          {showProject && job.projectId && (
            <Link to={`/projects/${job.projectId}`} className="text-accent-2 hover:underline">
              Open project
            </Link>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        {active && (
          <Button size="sm" variant="ghost" onClick={() => void cancel()} loading={working} icon={<Ban className="size-3.5" />}>
            Cancel
          </Button>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <Button size="sm" variant="secondary" onClick={() => setRetryOpen(true)} icon={<RotateCcw className="size-3.5" />}>
            Retry
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={retryOpen}
        onOpenChange={setRetryOpen}
        title="Retry this job?"
        confirmLabel={`Retry · ≈ ${formatUsd(job.estimate?.usd ?? 0)}`}
        loading={working}
        onConfirm={() => void retry()}
        body={
          <>
            Retrying sends a new request to {job.modelId ?? 'the service'}. <strong className="text-fg">This may incur another charge</strong> of roughly {formatUsd(job.estimate?.usd ?? 0)}
            {job.error?.safety ? '. The previous attempt was blocked by safety filters — the same prompt will likely be blocked again.' : '.'}
          </>
        }
      />
    </div>
  );
}
