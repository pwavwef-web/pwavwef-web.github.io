import { useEffect, useMemo, useState } from 'react';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { ListChecks } from 'lucide-react';
import { ACTIVE_STATUSES, formatUsd, type JobDoc } from '@az-studio/shared';
import { api, errorMessage } from '../lib/api';
import { db } from '../lib/firebase';
import { useQuery } from '../lib/data';
import { useUid } from '../lib/session';
import { JobCard } from '../components/jobs';
import { Card, EmptyState, ErrorState, SectionHeader, Segmented, Skeleton, Tip } from '../components/ui';

interface UsageSummary {
  daily: { day: string; costUsd: number; jobs: number; byModel: Record<string, number> }[];
  month: { month: string; costUsd: number; jobs: number; byModel: Record<string, number> };
  byProject: { projectId: string; title: string; costUsd: number; jobs: number }[];
  recent: { id: string; jobId: string; modelId: string; kind: string; costUsd: number; createdAt: number | null }[];
  pricing: { version: string; source: string; retrievedAt: string };
}

function UsageHistory() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<UsageSummary, 'usageSummary'>('usageSummary', { days: 30 })
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const max = useMemo(() => Math.max(0.01, ...(data?.daily.map((d) => d.costUsd) ?? [0])), [data]);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Skeleton className="h-64" />;
  const models = Object.entries(data.month.byModel).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card className="p-5">
        <div className="flex items-end justify-between">
          <div>
            <p className="eyebrow">Last 30 days · estimated</p>
            <p className="display text-4xl">{formatUsd(data.daily.reduce((s, d) => s + d.costUsd, 0))}</p>
          </div>
          <p className="text-right text-xs text-faint">
            This month {formatUsd(data.month.costUsd)} · {data.month.jobs} jobs
          </p>
        </div>
        <div className="mt-5 flex h-40 items-end gap-1" role="img" aria-label="Daily estimated spend for the last 30 days">
          {data.daily.map((d) => (
            <Tip key={d.day} label={`${d.day}: ${formatUsd(d.costUsd, { precise: true })} · ${d.jobs} jobs`}>
              <div className="flex h-full flex-1 items-end">
                <div className="w-full rounded-t bg-gradient-to-t from-accent-deep to-accent-2 opacity-85 transition-opacity hover:opacity-100" style={{ height: `${Math.max(d.costUsd > 0 ? 3 : 1, (d.costUsd / max) * 100)}%` }} />
              </div>
            </Tip>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-faint">
          Recorded token usage × Google’s published list prices ({data.pricing.version}, retrieved {data.pricing.retrievedAt}). Render compute uses Cloud Run Tier 1 rates. Invoices come from Cloud Billing.
        </p>
      </Card>
      <div className="space-y-5">
        <Card className="p-5">
          <p className="eyebrow">By project</p>
          {data.byProject.length === 0 ? (
            <p className="mt-3 text-sm text-faint">No project usage yet.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {data.byProject.slice(0, 8).map((p) => (
                <li key={p.projectId} className="flex justify-between gap-3">
                  <span className="truncate text-dim">{p.title}</span>
                  <span className="timecode text-fg">{formatUsd(p.costUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-5">
          <p className="eyebrow">By model this month</p>
          {models.length === 0 ? (
            <p className="mt-3 text-sm text-faint">No usage this month.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {models.map(([m, usd]) => (
                <li key={m} className="flex justify-between gap-3">
                  <span className="truncate text-dim">{m}</span>
                  <span className="timecode text-fg">{formatUsd(usd)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function Jobs() {
  const uid = useUid();
  const [tab, setTab] = useState<'active' | 'all' | 'failed'>('active');
  const [max, setMax] = useState(60);
  const jobs = useQuery<JobDoc>(() => {
    if (!uid) return null;
    const base = collection(db, 'jobs');
    if (tab === 'active') return query(base, where('ownerUid', '==', uid), where('status', 'in', [...ACTIVE_STATUSES]), orderBy('createdAt', 'desc'), limit(max));
    if (tab === 'failed') return query(base, where('ownerUid', '==', uid), where('status', '==', 'failed'), orderBy('createdAt', 'desc'), limit(max));
    return query(base, where('ownerUid', '==', uid), orderBy('createdAt', 'desc'), limit(max));
  }, [uid, tab, max]);

  return (
    <div className="space-y-10">
      <SectionHeader eyebrow="Pipeline" title={<span className="text-5xl">Jobs</span>} sub="Durable generation and render jobs. They keep running if you close the tab or the app redeploys." />
      <section className="space-y-4">
        <Segmented
          label="Filter jobs"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'all', label: 'All' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
        {jobs.error ? (
          <ErrorState error={jobs.error} />
        ) : jobs.loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : jobs.data.length === 0 ? (
          <EmptyState icon={<ListChecks className="size-5" />} title={tab === 'active' ? 'Nothing running' : tab === 'failed' ? 'No failures' : 'No jobs yet'} body={tab === 'active' ? 'Queued and running generations appear here in real time.' : undefined} />
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {jobs.data.map((j) => (
              <JobCard key={j.id} job={j} showProject />
            ))}
          </div>
        )}
        {jobs.data.length >= max && (
          <button type="button" className="cursor-pointer text-sm text-accent-2 hover:underline" onClick={() => setMax((m) => m + 60)}>
            Load more
          </button>
        )}
      </section>
      <section className="space-y-4">
        <SectionHeader eyebrow="Costs" title="Usage history" />
        <UsageHistory />
      </section>
    </div>
  );
}
