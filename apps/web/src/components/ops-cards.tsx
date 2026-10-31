import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Activity, GitCommitHorizontal, Gauge, ListTree, Play, Check } from 'lucide-react';
import { BUDGET_ROLE_LABELS, BUDGET_ROLES, formatUsd, type BudgetRole, type CanaryChange, type CanaryRun, type StudioSettings } from '@az-studio/shared';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { releaseMismatch, WEB_RELEASE } from '../lib/release';
import { Badge, Button, Card, Field, Input, Skeleton } from './ui';

/** Settings → Release: which release the page, the functions and (through them) the renderer run. */
export function ReleaseCard() {
  const boot = useSession((s) => s.boot);
  const server = boot?.release;
  const mismatch = releaseMismatch(server);
  return (
    <Card className="space-y-3 p-6">
      <p className="eyebrow flex items-center gap-1.5">
        <GitCommitHorizontal className="size-3.5" /> Release
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-faint">This page</dt>
        <dd className="timecode text-fg">
          {WEB_RELEASE.version}
          {WEB_RELEASE.commit ? ` · ${WEB_RELEASE.commit}` : ''}
        </dd>
        <dt className="text-faint">Server</dt>
        <dd className="timecode text-fg">{server ? `${server.version}${server.commit ? ` · ${server.commit}` : ''}` : '—'}</dd>
      </dl>
      {mismatch ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warning">Different releases</Badge>
          <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
            Reload to update this page
          </Button>
        </div>
      ) : (
        <p className="text-xs text-faint">Deploys ship only tagged commits (scripts/release.mjs) that passed the checks; every part carries the same tag.</p>
      )}
    </Card>
  );
}

interface CanaryState {
  latest: CanaryRun | null;
  previous: CanaryRun | null;
  changes: CanaryChange[];
  acknowledgedAt: number | null;
}

/** Settings → Model health: the daily canary (one tiny probe per model role, compared with the day before). */
export function ModelHealthCard() {
  const refresh = useSession((s) => s.refresh);
  const [state, setState] = useState<CanaryState | null>(null);
  const [busy, setBusy] = useState<'run' | 'acknowledge' | null>(null);
  useEffect(() => {
    api<CanaryState, 'canary'>('canary', { op: 'status' })
      .then(setState)
      .catch((e) => toast.error('Could not read model health', { description: errorMessage(e) }));
  }, []);
  const act = async (op: 'run' | 'acknowledge') => {
    setBusy(op);
    try {
      setState(await api<CanaryState, 'canary'>('canary', { op }));
      await refresh();
    } catch (e) {
      toast.error(op === 'run' ? 'Could not run the check' : 'Could not acknowledge', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="space-y-4 p-6">
      <div>
        <p className="eyebrow flex items-center gap-1.5">
          <Activity className="size-3.5" /> Model health (daily canary)
        </p>
        <p className="mt-1 text-sm text-dim">Every morning at 06:30 a tiny probe per model role (≈ $0.002) is compared with the day before. Changes in availability, refusal wording or response shape show here and as a banner.</p>
      </div>
      {!state ? (
        <Skeleton className="h-24" />
      ) : (
        <>
          {state.changes.length > 0 && (
            <ul className="space-y-2">
              {state.changes.map((c) => (
                <li key={`${c.role}-${c.kind}`} className={`rounded-xl border p-3 text-sm ${c.worse ? 'border-[#ff9b9b]/50 text-[#ffb4b4]' : 'border-line text-dim'}`}>
                  {c.message}
                </li>
              ))}
            </ul>
          )}
          {state.latest ? (
            <ul className="space-y-1.5">
              {state.latest.probes.map((p) => (
                <li key={p.role} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-fg">
                    {p.role} <span className="timecode text-xs text-faint">{p.modelId}</span>
                  </span>
                  <Badge tone={p.outcome === 'ok' ? 'success' : p.outcome === 'skipped' ? 'neutral' : p.outcome === 'unavailable' && p.role === 'music:vertex' ? 'neutral' : 'danger'}>{p.outcome}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-faint">No check has run yet.</p>
          )}
          <p className="text-xs text-faint">
            {state.latest ? `Last run ${new Date(state.latest.at).toLocaleString()} · ${formatUsd(state.latest.costUsd)}` : ''}
            {state.acknowledgedAt && state.changes.length ? ` · acknowledged ${new Date(state.acknowledgedAt).toLocaleString()}` : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" loading={busy === 'run'} icon={<Play className="size-3.5" />} onClick={() => void act('run')}>
              Run the check now
            </Button>
            {state.changes.length > 0 && !state.acknowledgedAt && (
              <Button size="sm" variant="ghost" loading={busy === 'acknowledge'} icon={<Check className="size-3.5" />} onClick={() => void act('acknowledge')}>
                Acknowledge changes
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

/** Settings → Model budgets: a monthly budget per model role, enforced by the worker before a job starts. */
export function RoleBudgetsCard({ draft, onChange, onSave, saving }: { draft: StudioSettings; onChange: (b: StudioSettings['roleBudgetsUsd']) => void; onSave: () => void; saving: boolean }) {
  const spent = useSession((s) => s.boot?.roleSpendUsd);
  const budgets = draft.roleBudgetsUsd ?? {};
  return (
    <Card className="space-y-5 p-6">
      <div>
        <p className="eyebrow flex items-center gap-1.5">
          <Gauge className="size-3.5" /> Model budgets (monthly)
        </p>
        <p className="mt-1 text-sm text-dim">When a role reaches its budget, new jobs that use it stop before anything is sent; other roles keep working. 0 = no budget.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {BUDGET_ROLES.map((role: BudgetRole) => (
          <Field key={role} label={BUDGET_ROLE_LABELS[role]} hint={<span data-private>This month ≈ {formatUsd(spent?.[role] ?? 0)}</span>}>
            <Input type="number" min={0} step={1} value={budgets[role] ?? 0} onChange={(e) => onChange({ ...budgets, [role]: e.target.value === '' ? 0 : Math.max(0, Number(e.target.value)) })} />
          </Field>
        ))}
      </div>
      <Button variant="primary" loading={saving} onClick={onSave}>
        Save budgets
      </Button>
    </Card>
  );
}

interface SpendByTask {
  month: string;
  rows: { role: string; modelId: string; task: string; costUsd: number; calls: number; standardRateUsd: number | null }[];
  reasoning: { costUsd: number; standardRateUsd: number; standardFrom: string };
}

/** Settings → Spend by task: which tasks spend on which model, and Argon at its December rate. */
export function SpendByTaskCard() {
  const [data, setData] = useState<SpendByTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<SpendByTask, 'spendByTask'>('spendByTask', {})
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  return (
    <Card className="space-y-4 p-6">
      <div>
        <p className="eyebrow flex items-center gap-1.5">
          <ListTree className="size-3.5" /> Spend by task
        </p>
        <p className="mt-1 text-sm text-dim">This month’s recorded usage by model and task, to see which tasks really need the reasoning model.</p>
      </div>
      {error && <p className="text-sm text-[#ff9b9b]">{error}</p>}
      {!data && !error && <Skeleton className="h-24" />}
      {data && (
        <>
          <p className="text-sm text-dim" data-private>
            Reasoning this month ≈ <span className="text-fg">{formatUsd(data.reasoning.costUsd)}</span>; at Gemini 4 Argon’s standard rate (from 1 December 2026) the same calls would cost ≈{' '}
            <span className="text-fg">{formatUsd(data.reasoning.standardRateUsd)}</span>.
          </p>
          {data.rows.length === 0 ? (
            <p className="text-sm text-faint">No usage recorded this month yet.</p>
          ) : (
            <table className="w-full text-left text-xs" data-private>
              <thead className="text-faint">
                <tr>
                  <th className="py-1 font-normal">Task</th>
                  <th className="py-1 font-normal">Model</th>
                  <th className="py-1 text-right font-normal">Calls</th>
                  <th className="py-1 text-right font-normal">Spent</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.slice(0, 25).map((r) => (
                  <tr key={`${r.modelId}|${r.task}`} className="border-t border-line">
                    <td className="py-1 text-fg">{r.task}</td>
                    <td className="timecode py-1 text-dim">{r.modelId}</td>
                    <td className="py-1 text-right text-dim">{r.calls}</td>
                    <td className="py-1 text-right text-fg">
                      {formatUsd(r.costUsd)}
                      {r.standardRateUsd !== null && <span className="block text-faint">Dec ≈ {formatUsd(r.standardRateUsd)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Card>
  );
}
