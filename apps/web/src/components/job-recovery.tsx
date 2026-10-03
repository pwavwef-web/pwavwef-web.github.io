import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, CircleAlert, History, KeyRound, PlayCircle, RotateCcw, ShieldAlert, Wand2, Wifi } from 'lucide-react';
import { attemptSummary, ERROR_CATEGORY_LABELS, formatUsd, relativeTime, type ErrorCategory, type JobDoc, type PromptRevision } from '@az-studio/shared';
import { api, errorMessage } from '../lib/api';
import type { WithId } from '../lib/data';
import { Badge, Button, ConfirmDialog, cx, Field, Modal, Notice, Spinner, Textarea } from './ui';

type Job = WithId<JobDoc>;

const CATEGORY_TONE: Record<ErrorCategory, 'warning' | 'danger' | 'neutral' | 'violet' | 'accent'> = {
  transient: 'accent',
  invalid_request: 'danger',
  policy: 'warning',
  auth_quota: 'violet',
  unknown: 'neutral',
};

const CATEGORY_ICON: Record<ErrorCategory, typeof Wifi> = {
  transient: Wifi,
  invalid_request: CircleAlert,
  policy: ShieldAlert,
  auth_quota: KeyRound,
  unknown: CircleAlert,
};

export function CategoryBadge({ category }: { category: ErrorCategory | undefined }) {
  if (!category) return null;
  const Icon = CATEGORY_ICON[category];
  return (
    <Badge tone={CATEGORY_TONE[category]} icon={<Icon className="size-3" />}>
      {ERROR_CATEGORY_LABELS[category]}
    </Badge>
  );
}

/** The newest prompt revision of a kind (auto rewrite, proposal, director). */
export function latestRevision(prompts: PromptRevision[] | undefined, sources: PromptRevision['source'][]): PromptRevision | null {
  return [...(prompts ?? [])].filter((p) => sources.includes(p.source)).sort((a, b) => b.version - a.version)[0] ?? null;
}

/**
 * Shows the original prompt, a proposed compliant rewrite with its explanation, and an editable field. The
 * retry sends the edited prompt as a new job; both versions stay in the job history.
 */
export function PromptFixDialog({ job, open, onOpenChange, onRetried }: { job: Job; open: boolean; onOpenChange: (o: boolean) => void; onRetried?: (jobId: string, prompt: string) => void }) {
  const original = latestRevision(job.prompts, ['original'])?.prompt ?? String((job.params as { promptBody?: string; prompt?: string }).promptBody ?? (job.params as { prompt?: string }).prompt ?? '');
  const tried = latestRevision(job.prompts, ['auto_rewrite']);
  const known = latestRevision(job.prompts, ['proposal', 'auto_rewrite']);
  const [proposal, setProposal] = useState<{ text: string; explanation: string; changes: string[]; usable: boolean; reason: string } | null>(known ? { text: known.prompt, explanation: known.explanation ?? '', changes: known.changes ?? [], usable: true, reason: '' } : null);
  const [text, setText] = useState(known?.prompt ?? original);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open || proposal) return;
    let alive = true;
    setLoading(true);
    api<{ original: string; proposal: string; explanation: string; changes: string[]; usable: boolean; reason: string }, 'proposePromptFix'>('proposePromptFix', { jobId: job.id })
      .then((r) => {
        if (!alive) return;
        setProposal({ text: r.proposal, explanation: r.explanation, changes: r.changes, usable: r.usable, reason: r.reason });
        if (r.proposal) setText(r.proposal);
      })
      .catch((e) => alive && toast.error('Could not propose a revision', { description: errorMessage(e) }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, proposal, job.id]);

  const retry = async () => {
    setSending(true);
    try {
      const r = await api<{ jobIds: string[] }, 'retryJob'>('retryJob', { jobId: job.id, acknowledgeCharge: true, prompt: text.trim(), resume: false, ...(proposal?.explanation && text.trim() === proposal.text.trim() ? { explanation: proposal.explanation.slice(0, 600) } : {}) });
      toast.success('Retrying with the revised prompt', { description: 'The original and the revision are kept in the job history.' });
      onRetried?.(r.jobIds[0]!, text.trim());
      onOpenChange(false);
    } catch (e) {
      toast.error('Could not retry', { description: errorMessage(e) });
    } finally {
      setSending(false);
    }
  };

  const unchanged = text.trim() === original.trim();
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Fix prompt & retry"
      description={job.error?.message}
      footer={
        <>
          <span className="mr-auto text-xs text-faint">A retry is a new request (≈ {formatUsd(job.estimate?.usd ?? 0)} est.).</span>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button variant="primary" loading={sending} disabled={!text.trim() || unchanged} onClick={() => void retry()} icon={<RotateCcw className="size-4" />}>
            Retry with this prompt
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {tried && <Notice tone="warning">An automatic rewrite was already tried once and was blocked too. AZ Studio will not rewrite it again — revise it yourself below.</Notice>}
        <div>
          <p className="eyebrow mb-1.5">Original prompt</p>
          <pre className="max-h-40 overflow-auto rounded-xl border border-line bg-black/30 p-3 text-xs leading-relaxed whitespace-pre-wrap text-dim">{original}</pre>
        </div>
        <div>
          <p className="eyebrow mb-1.5 flex items-center gap-1.5">
            <Wand2 className="size-3.5" /> Proposed revision
          </p>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-dim">
              <Spinner className="size-4" /> Asking for a compliant rewrite that keeps the creative intent…
            </div>
          ) : proposal ? (
            <div className="space-y-2">
              {proposal.text ? <pre className="max-h-40 overflow-auto rounded-xl border border-accent/25 bg-accent/[0.06] p-3 text-xs leading-relaxed whitespace-pre-wrap text-fg">{proposal.text}</pre> : <p className="text-sm text-dim">No rewrite was proposed.</p>}
              {proposal.explanation && <p className="text-sm text-dim">{proposal.explanation}</p>}
              {proposal.changes.length > 0 && (
                <ul className="space-y-0.5 text-xs text-faint">
                  {proposal.changes.map((c) => (
                    <li key={c}>· {c}</li>
                  ))}
                </ul>
              )}
              {!proposal.usable && proposal.reason && <p className="text-xs text-warning">{proposal.reason}</p>}
            </div>
          ) : (
            <p className="text-sm text-faint">No proposal available.</p>
          )}
        </div>
        <Field label="Prompt to send" hint="Edit freely. Describe what should be seen in plain, literal words; keep tags such as <IMAGE_REF_0> exactly.">
          <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} aria-label="Prompt to send" />
        </Field>
        {unchanged && <p className="text-xs text-faint">The prompt is unchanged — a blocked or rejected prompt is never resent as it was.</p>}
      </div>
    </Modal>
  );
}

/** A failed job's classified error with what can be done next (retry, fix prompt, resume, fix settings). */
export function JobErrorPanel({ job, compact, onRetried, onPromptRevised }: { job: Job; compact?: boolean; onRetried?: (jobId: string) => void; onPromptRevised?: (prompt: string) => void }) {
  const [fixOpen, setFixOpen] = useState(false);
  const [confirm, setConfirm] = useState<'retry' | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const err = job.error;
  if (!err) return null;
  const remedy = err.remedy ?? (err.safety ? 'fix_prompt' : 'retry');
  const run = async (resume: boolean) => {
    setBusy(true);
    try {
      const r = await api<{ jobIds: string[] }, 'retryJob'>('retryJob', { jobId: job.id, acknowledgeCharge: true, resume });
      toast.success(resume ? 'Checking the accepted generation again (no new charge)' : 'Retry queued');
      setConfirm(null);
      if (r.jobIds[0]) onRetried?.(r.jobIds[0]);
    } catch (e) {
      toast.error(resume ? 'Could not resume' : 'Retry failed', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const history = job.attempts ?? [];
  return (
    <div className={cx('mt-2 rounded-xl border p-3 text-xs', err.category === 'policy' ? 'border-warning/30 bg-warning/[0.05]' : err.category === 'auth_quota' ? 'border-violet/30 bg-violet/[0.05]' : 'border-danger/25 bg-danger/[0.05]')}>
      <div className="flex flex-wrap items-center gap-2">
        <CategoryBadge category={err.category} />
        {err.httpStatus ? <span className="timecode text-faint">HTTP {err.httpStatus}</span> : null}
        {err.providerStatus ? <span className="timecode text-faint">{err.providerStatus}</span> : null}
        {job.retry && <span className="text-faint">{attemptSummary(job.retry)}</span>}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg">{err.message}</p>
      {err.action && <p className="mt-1 text-dim">What to do: {err.action}</p>}
      {!compact && (
        <button type="button" className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-faint hover:text-dim" onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails}>
          <History className="size-3" /> Details & history <ChevronDown className={cx('size-3 transition-transform', showDetails && 'rotate-180')} />
        </button>
      )}
      {showDetails && (
        <div className="mt-2 space-y-2">
          {err.details && <p className="timecode break-words text-faint">{err.details}</p>}
          {history.length > 0 && (
            <ol className="space-y-0.5 text-faint">
              {history.map((a) => (
                <li key={`${a.n}-${a.at}`}>
                  {a.n}. {a.kind} · {a.outcome}
                  {a.category ? ` · ${ERROR_CATEGORY_LABELS[a.category]}` : ''}
                  {a.code ? ` (${a.code})` : ''}
                  {a.delaySec ? ` · waited ${a.delaySec}s` : ''}
                  {a.note ? ` — ${a.note}` : ''} · {relativeTime(a.at)}
                </li>
              ))}
            </ol>
          )}
          {(job.prompts?.length ?? 0) > 1 && (
            <div className="space-y-1">
              {job.prompts!.map((p) => (
                <details key={p.version} className="rounded-lg border border-line p-2">
                  <summary className="cursor-pointer text-dim">
                    v{p.version} · {p.source.replace('_', ' ')}
                    {p.explanation ? ` — ${p.explanation.slice(0, 120)}` : ''}
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap text-faint">{p.prompt}</pre>
                </details>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {remedy === 'fix_prompt' && (
          <Button size="sm" variant="subtle" icon={<Wand2 className="size-3.5" />} onClick={() => setFixOpen(true)}>
            Fix prompt & retry
          </Button>
        )}
        {remedy === 'resume' && (
          <Button size="sm" variant="subtle" loading={busy} icon={<PlayCircle className="size-3.5" />} onClick={() => void run(true)}>
            Resume checking
          </Button>
        )}
        {(remedy === 'retry' || remedy === 'fix_settings' || remedy === 'resume') && (
          <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} onClick={() => setConfirm('retry')}>
            {remedy === 'fix_settings' ? 'Retry after fixing' : remedy === 'resume' ? 'Generate again' : 'Retry'}
          </Button>
        )}
      </div>
      {fixOpen && <PromptFixDialog job={job} open={fixOpen} onOpenChange={setFixOpen} onRetried={(id, prompt) => { onPromptRevised?.(prompt); onRetried?.(id); }} />}
      <ConfirmDialog
        open={confirm === 'retry'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={remedy === 'resume' ? 'Generate a new version?' : 'Retry this job?'}
        confirmLabel={`Retry · ≈ ${formatUsd(job.estimate?.usd ?? 0)}`}
        loading={busy}
        onConfirm={() => void run(false)}
        body={
          <>
            Retrying sends a new request to {job.modelId ?? 'the service'}. <strong className="text-fg">This may incur another charge</strong> of roughly {formatUsd(job.estimate?.usd ?? 0)}.
            {remedy === 'resume' ? ' Resume checking instead continues the accepted generation without a new charge.' : ''}
            {err.category === 'auth_quota' ? ' Retrying tells AZ Studio the access, billing or quota problem is fixed; automatic generation resumes.' : ''}
          </>
        }
      />
    </div>
  );
}
