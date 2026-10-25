import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Download, RefreshCw, Trash2, Users } from 'lucide-react';
import { EARLY_ACCESS_INTERESTS, earlyAccessCsv, type EarlyAccessRecord } from '@az-studio/shared';
import { api, errorMessage } from '../lib/api';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Skeleton, Toggle } from './ui';

interface ListResult {
  records: EarlyAccessRecord[];
  paused: boolean;
}

const interestLabel = (v: EarlyAccessRecord['interest']) => EARLY_ACCESS_INTERESTS.find((i) => i.value === v)?.label ?? '—';
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/**
 * Settings → Early access: the public website's interest list. Read through the owner-only API (the rules deny
 * every client read), exported as CSV in the browser, deleted one registration at a time.
 */
export function EarlyAccessCard() {
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [removing, setRemoving] = useState<EarlyAccessRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<ListResult, 'earlyAccess'>('earlyAccess', { op: 'list' }));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([earlyAccessCsv(data.records)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `az-studio-early-access-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const setPaused = async (paused: boolean) => {
    setPausing(true);
    try {
      await api<{ paused: boolean }, 'earlyAccess'>('earlyAccess', { op: 'pause', paused });
      setData((d) => (d ? { ...d, paused } : d));
      toast.success(paused ? 'New registrations paused' : 'Registrations open again');
    } catch (e) {
      toast.error('Could not change registrations', { description: errorMessage(e) });
    } finally {
      setPausing(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setDeleting(true);
    try {
      await api<{ deleted: boolean }, 'earlyAccess'>('earlyAccess', { op: 'delete', id: removing.id });
      setData((d) => (d ? { ...d, records: d.records.filter((r) => r.id !== removing.id) } : d));
      toast.success('Registration deleted');
      setRemoving(null);
    } catch (e) {
      toast.error('Could not delete', { description: errorMessage(e) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow flex items-center gap-1.5">
            <Users className="size-3.5" /> Early access (public website)
          </p>
          <p className="mt-1 text-sm text-dim">Interest registrations from the website’s form. Visible only to you; no emails are sent automatically.</p>
        </div>
        {data && <Badge tone={data.paused ? 'warning' : 'success'}>{data.paused ? 'Paused' : 'Open'}</Badge>}
      </div>
      {error ? <ErrorState title="Could not load registrations" error={error} onRetry={() => void load()} /> : null}
      {!data && !error ? <Skeleton className="h-24" /> : null}
      {data && (
        <>
          <Toggle checked={data.paused} disabled={pausing} onChange={(v) => void setPaused(v)} label="Pause new registrations" description="The form tells visitors registrations are paused; existing entries are kept." />
          <p className="text-sm text-fg" data-private>
            {data.records.length} {data.records.length === 1 ? 'registration' : 'registrations'}
          </p>
          {data.records.length > 0 && (
            <div className="max-h-80 overflow-auto rounded-xl border border-line" data-private>
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-panel-2 text-faint">
                  <tr>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Interest</th>
                    <th className="px-3 py-2 font-medium">Joined</th>
                    <th className="px-3 py-2">
                      <span className="sr-only">Delete</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.records.map((r) => (
                    <tr key={r.id} className="border-t border-line">
                      <td className="px-3 py-2 break-all text-fg">{r.email}</td>
                      <td className="px-3 py-2 text-dim">{r.name ?? '—'}</td>
                      <td className="px-3 py-2 text-dim">{interestLabel(r.interest)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-dim">{day(r.createdAt)}</td>
                      <td className="px-2 py-1 text-right">
                        <button type="button" onClick={() => setRemoving(r)} aria-label={`Delete the registration for ${r.email}`} className="grid size-7 cursor-pointer place-items-center rounded-lg text-faint hover:bg-danger/10 hover:text-danger">
                          <Trash2 className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={exportCsv} disabled={!data.records.length} icon={<Download className="size-3.5" />}>
              Export CSV
            </Button>
            <Button size="sm" variant="ghost" loading={loading} onClick={() => void load()} icon={<RefreshCw className="size-3.5" />}>
              Refresh
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Delete this registration?"
        danger
        confirmLabel="Delete permanently"
        loading={deleting}
        onConfirm={() => void remove()}
        body={
          <>
            <span data-private>{removing?.email}</span> is removed from the list for good, with its consent record. Use this for removal requests; a copy already exported to CSV is not affected.
          </>
        }
      />
    </Card>
  );
}
