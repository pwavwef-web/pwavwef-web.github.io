import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Copy, MessageSquare, RefreshCw, Ticket, Users } from 'lucide-react';
import { BETA_WAVES, CREDIT_USD, EARLY_ACCESS_INTERESTS, formatUsd, type BetaAdminRequest, type BetaFeedbackDoc, type BetaLimits, type EarlyAccessRecord, type MemberDay, type MemberDoc } from '@az-studio/shared';
import { api, errorMessage } from '../lib/api';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Notice, Select, Skeleton } from '../components/ui';

interface Overview {
  state: { enabled: boolean; reason: string | null; limits: BetaLimits; project: string; separate: boolean };
  spendToday: { usd: number; reservedUsd: number; ceilingUsd: number };
  invites: { id: string; code: string; email: string; wave: string; credits: number; status: 'open' | 'redeemed' | 'revoked' | 'expired'; createdAt: number; expiresAt: number; redeemedAt: number | null; earlyAccessId: string | null }[];
  members: { uid: string; email: string; wave: string; status: MemberDoc['status']; joinedAt: number; credits: MemberDoc['credits']; today: MemberDay; totals: MemberDoc['totals']; activeJob: MemberDoc['activeJob']; editions: number; ready: number; failed: number }[];
  feedback: (BetaFeedbackDoc & { id: string })[];
}

const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const interestLabel = (v: EarlyAccessRecord['interest']) => EARLY_ACCESS_INTERESTS.find((i) => i.value === v)?.label ?? '—';
const beta = <T,>(payload: BetaAdminRequest) => api<T, 'beta'>('beta', payload);

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error('Copy failed — select the text and copy it manually.');
  }
}

/**
 * Studio → Beta (owner only): invitations for chosen early-access entries, members, usage, credits and feedback.
 * Nothing here sends email or switches the beta on — codes are passed on by hand, and the switch is the
 * `runtime/features` flag (docs/OPERATIONS.md → Public beta).
 */
export default function Beta() {
  const [data, setData] = useState<Overview | null>(null);
  const [list, setList] = useState<EarlyAccessRecord[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [wave, setWave] = useState<string>(BETA_WAVES[0].id);
  const [interest, setInterest] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ email: string; code: string; expiresAt: number }[]>([]);
  const [revoking, setRevoking] = useState<{ kind: 'invite' | 'member'; id: string; label: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [o, ea] = await Promise.all([beta<Overview>({ op: 'overview' }), api<{ records: EarlyAccessRecord[] }, 'earlyAccess'>('earlyAccess', { op: 'list' })]);
      setData(o);
      setList(ea.records);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const taken = useMemo(() => new Set([...(data?.invites.filter((i) => i.status === 'open' || i.status === 'redeemed').map((i) => i.email) ?? []), ...(data?.members.map((m) => m.email) ?? [])]), [data]);
  const candidates = list.filter((r) => !taken.has(r.email.toLowerCase()) && (!interest || r.interest === interest));
  const waveSize = BETA_WAVES.find((w) => w.id === wave)?.size ?? null;

  const invite = async () => {
    setCreating(true);
    try {
      const r = await beta<{ created: { email: string; code: string; expiresAt: number }[]; skipped: { reason: string }[] }>({ op: 'invite', earlyAccessIds: [...chosen], wave });
      setCreated(r.created);
      setChosen(new Set());
      toast.success(`${r.created.length} invitation${r.created.length === 1 ? '' : 's'} created`, { description: r.skipped.length ? `${r.skipped.length} skipped: ${r.skipped[0]!.reason}` : 'Pass each code to its person yourself — AZ Studio sends no email.' });
      await load();
    } catch (e) {
      toast.error('Could not create invitations', { description: errorMessage(e) });
    } finally {
      setCreating(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    try {
      if (revoking.kind === 'invite') await beta({ op: 'revokeInvite', inviteId: revoking.id });
      else await beta({ op: 'revokeMember', uid: revoking.id });
      toast.success(revoking.kind === 'invite' ? 'Invitation revoked' : 'Member access ended');
      setRevoking(null);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const grant = async (uid: string, credits: number) => {
    try {
      await beta({ op: 'grantCredits', uid, credits, note: '' });
      toast.success(`${credits > 0 ? 'Added' : 'Removed'} ${Math.abs(credits)} credits`);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (error && !data) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!data) return <Skeleton className="h-96" />;
  const { state, spendToday } = data;

  return (
    <div className="mx-auto max-w-[1180px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-5">
        <div>
          <p className="eyebrow">AZ Studio · public beta</p>
          <h1 className="display mt-1 text-[44px] leading-none text-fg">Beta</h1>
          <p className="mt-2 max-w-2xl text-sm text-dim">Invite-only audio editions with Google’s prebuilt voices, for people on the early-access list. Members use /app; they never reach the studio.</p>
        </div>
        <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
          Refresh
        </Button>
      </header>

      <Card className="grid gap-4 p-5 sm:grid-cols-3">
        <div>
          <p className="eyebrow">State</p>
          {state.enabled ? <Badge tone="success">Open to members</Badge> : <Badge tone="warning">Switched off</Badge>}
          <p className="mt-1.5 text-xs text-faint">{state.reason ?? 'runtime/features.beta.enabled is true.'}</p>
          <p className="mt-1 text-xs text-faint">Data: {state.separate ? `separate project ${state.project}` : 'this project, members/…'}.</p>
        </div>
        <div>
          <p className="eyebrow">All members today</p>
          <p className="display text-3xl text-fg">{formatUsd(spendToday.usd)}</p>
          <p className="text-xs text-faint">
            + {formatUsd(spendToday.reservedUsd)} held · circuit breaker at {formatUsd(spendToday.ceilingUsd)}
          </p>
        </div>
        <div>
          <p className="eyebrow">Per member</p>
          <p className="text-xs text-dim">
            {state.limits.dailyChars.toLocaleString()} characters and {state.limits.dailyMinutes} min a day · {state.limits.maxEditionChars.toLocaleString()} characters per job · ceiling {formatUsd(state.limits.jobCeilingUsd)} per job · {state.limits.inviteCredits} credits per invitation (1 credit = {formatUsd(CREDIT_USD, { precise: true })} of recorded cost)
          </p>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-medium text-fg">
            <Ticket className="size-5 text-accent-2" /> Invite from the early-access list
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Interest" value={interest} onChange={(e) => setInterest(e.target.value)} className="w-auto py-1.5 text-xs">
              <option value="">Any interest</option>
              {EARLY_ACCESS_INTERESTS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </Select>
            <Select aria-label="Wave" value={wave} onChange={(e) => setWave(e.target.value)} className="w-auto py-1.5 text-xs">
              {BETA_WAVES.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label} · up to {w.size}
                </option>
              ))}
            </Select>
            <Button variant="primary" disabled={!chosen.size || creating} loading={creating} onClick={() => void invite()}>
              Create {chosen.size || ''} invitation{chosen.size === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
        {waveSize !== null && chosen.size > waveSize && <Notice tone="warning">{chosen.size} chosen — more than this wave’s planned {waveSize}.</Notice>}
        {created.length > 0 && (
          <Notice tone="accent">
            <p className="mb-1 font-medium">New codes — pass each one to its person yourself (each works only for that email, once):</p>
            <ul className="space-y-0.5 font-mono text-xs">
              {created.map((c) => (
                <li key={c.code}>
                  {c.email} · {c.code} · until {day(c.expiresAt)}
                </li>
              ))}
            </ul>
            <Button size="sm" variant="ghost" className="mt-2" icon={<Copy className="size-3.5" />} onClick={() => void copy(created.map((c) => `${c.email}\t${c.code}`).join('\n'), 'Codes')}>
              Copy all
            </Button>
          </Notice>
        )}
        <div className="max-h-80 overflow-y-auto rounded-xl border border-line">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-[#0b1220] text-faint">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Interest</th>
                <th className="px-3 py-2">Joined list</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {candidates.map((r) => (
                <tr key={r.id} className="text-dim">
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Invite ${r.email}`}
                      className="accent-[#4c8dff]"
                      checked={chosen.has(r.id)}
                      onChange={(e) =>
                        setChosen((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(r.id);
                          else n.delete(r.id);
                          return n;
                        })
                      }
                    />
                  </td>
                  <td className="px-3 py-1.5 text-fg">{r.email}</td>
                  <td className="px-3 py-1.5">{r.name ?? '—'}</td>
                  <td className="px-3 py-1.5">{interestLabel(r.interest)}</td>
                  <td className="px-3 py-1.5">{day(r.createdAt)}</td>
                </tr>
              ))}
              {!candidates.length && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-faint">
                    No one left to invite{interest ? ' with this interest' : ''}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-lg font-medium text-fg">Invitations ({data.invites.length})</h2>
        <ul className="divide-y divide-line text-xs">
          {data.invites.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-2 py-2 text-dim">
              <span className="min-w-48 text-fg">{i.email}</span>
              <Badge tone={i.status === 'redeemed' ? 'success' : i.status === 'open' ? 'accent' : 'neutral'}>{i.status}</Badge>
              <span>{i.wave}</span>
              <span className="text-faint">until {day(i.expiresAt)}</span>
              <span className="flex-1" />
              {i.status === 'open' && (
                <>
                  <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copy(i.code, 'Code')}>
                    {i.code}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRevoking({ kind: 'invite', id: i.id, label: i.email })}>
                    Revoke
                  </Button>
                </>
              )}
            </li>
          ))}
          {!data.invites.length && <li className="py-3 text-faint">No invitations yet.</li>}
        </ul>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-lg font-medium text-fg">
          <Users className="size-5 text-accent-2" /> Members ({data.members.length})
        </h2>
        <ul className="divide-y divide-line text-xs">
          {data.members.map((m) => (
            <li key={m.uid} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-dim">
              <span className="min-w-48 text-fg">{m.email}</span>
              <Badge tone={m.status === 'active' ? 'success' : 'neutral'}>{m.status}</Badge>
              <span>{m.wave}</span>
              <span>
                {m.credits.balance} credits{m.credits.reserved ? ` (${m.credits.reserved} held)` : ''}
              </span>
              <span>
                today {m.today.chars.toLocaleString()} chars · {(m.today.seconds / 60).toFixed(1)} min
              </span>
              <span>
                {m.totals.jobs} jobs · {formatUsd(m.totals.usd, { precise: true })} · {m.ready}/{m.editions} editions ready
              </span>
              <span className="flex-1" />
              {m.status === 'active' && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void grant(m.uid, 100)}>
                    +100 credits
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRevoking({ kind: 'member', id: m.uid, label: m.email })}>
                    Revoke
                  </Button>
                </>
              )}
            </li>
          ))}
          {!data.members.length && <li className="py-3 text-faint">No members yet.</li>}
        </ul>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-lg font-medium text-fg">
          <MessageSquare className="size-5 text-accent-2" /> Feedback ({data.feedback.length})
        </h2>
        <ul className="space-y-2 text-sm">
          {data.feedback.map((f) => (
            <li key={f.id} className="rounded-xl border border-line p-3">
              <p className="text-xs text-faint">
                {f.email} · {new Date(f.at).toLocaleString()}
                {f.rating ? ` · ${f.rating}/5` : ''}
                {f.page ? ` · ${f.page}` : ''}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-dim">{f.message}</p>
            </li>
          ))}
          {!data.feedback.length && <li className="text-faint">No feedback yet.</li>}
        </ul>
      </Card>

      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(o) => !o && setRevoking(null)}
        danger
        title={revoking?.kind === 'invite' ? 'Revoke this invitation?' : 'End this member’s access?'}
        confirmLabel="Revoke"
        onConfirm={() => void revoke()}
        body={revoking?.kind === 'invite' ? `The code for ${revoking.label} stops working at once.` : `${revoking?.label ?? ''} can no longer use the beta; a running job stops before its next request. Their editions are kept.`}
      />
    </div>
  );
}
