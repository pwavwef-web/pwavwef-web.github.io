import { useEffect, useMemo, useState } from 'react';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { toast } from 'sonner';
import { Check, Copy, Link2, MessageSquare, Undo2, XCircle } from 'lucide-react';
import { formatTimecode, type ProjectDoc, type RenderDoc, type ReviewComment, type ReviewDecision, type ReviewStatus } from '@az-studio/shared';
import { db } from '../lib/firebase';
import { useQuery } from '../lib/data';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Field, Input, SectionHeader, Select, Skeleton } from '../components/ui';
import { DeliverablesCard } from '../components/deliverables';

interface LinkRow {
  token: string;
  projectId: string;
  projectTitle: string;
  renderId: string;
  title: string;
  versionLabel: string;
  durationSec: number;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  status: ReviewStatus;
  decisions: ReviewDecision[];
  commentCount: number;
  state: 'open' | 'expired' | 'revoked';
  url: string;
  comments: ReviewComment[];
}

const STATUS: Record<ReviewStatus, { label: string; tone: 'neutral' | 'success' | 'warning' }> = {
  open: { label: 'Waiting for review', tone: 'neutral' },
  approved: { label: 'Approved', tone: 'success' },
  changes_requested: { label: 'Changes requested', tone: 'warning' },
};

/** Studio → Client reviews & deliverables: the deliverables pack, and private expiring review links with the client's timed comments. */
export default function Reviews() {
  const uid = useSession((s) => s.user?.uid ?? '');
  const renders = useQuery<RenderDoc>(() => (uid ? query(collection(db, 'renders'), where('ownerUid', '==', uid), orderBy('createdAt', 'desc'), limit(40)) : null), [uid]);
  const projects = useQuery<ProjectDoc>(() => (uid ? query(collection(db, 'projects'), where('ownerUid', '==', uid)) : null), [uid]);
  const titles = useMemo(() => new Map(projects.data.map((p) => [p.id, p.title])), [projects.data]);
  const done = renders.data.filter((r) => r.status === 'completed' && r.outputAssetId);

  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [renderId, setRenderId] = useState('');
  const [title, setTitle] = useState('');
  const [versionLabel, setVersionLabel] = useState('');
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setLinks((await api<{ links: LinkRow[] }, 'reviewLinks'>('reviewLinks', { op: 'list' })).links);
    } catch (e) {
      toast.error('Could not load review links', { description: errorMessage(e) });
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const absolute = (url: string) => `${window.location.origin}${url}`;
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(absolute(url));
      toast.success('Review link copied');
    } catch {
      toast.message(absolute(url));
    }
  };
  const create = async () => {
    if (!renderId) return;
    setBusy(true);
    try {
      const r = await api<{ link: LinkRow }, 'reviewLinks'>('reviewLinks', { op: 'create', renderId, title: title || undefined, versionLabel: versionLabel || undefined, expiresInDays: days });
      await copy(r.link.url);
      setTitle('');
      setVersionLabel('');
      await reload();
    } catch (e) {
      toast.error('Could not create the link', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (token: string) => {
    try {
      await api('reviewLinks', { op: 'revoke', token });
      toast.success('Link withdrawn — it stops working at once');
      await reload();
    } catch (e) {
      toast.error('Could not withdraw the link', { description: errorMessage(e) });
    }
  };
  const resolve = async (token: string, commentId: string, resolved: boolean) => {
    try {
      await api('reviewLinks', { op: 'resolve', token, commentId, resolved });
      await reload();
    } catch (e) {
      toast.error('Could not update the comment', { description: errorMessage(e) });
    }
  };

  return (
    <div className="space-y-8">
      <SectionHeader eyebrow="Studio" title={<span className="text-5xl">Client reviews & deliverables</span>} />
      <DeliverablesCard projects={projects.data} />
      <Card className="space-y-4 p-6">
        <div>
          <p className="eyebrow flex items-center gap-1.5">
            <Link2 className="size-3.5" /> Share a render for review
          </p>
          <p className="mt-1 text-sm text-dim">The client gets a private link that plays this cut, takes comments pinned to a moment, and an approval or a change request. It expires on its own and can be withdrawn at any time.</p>
        </div>
        {renders.loading ? (
          <Skeleton className="h-16" />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Field label="Render" className="md:col-span-2">
              <Select value={renderId} onChange={(e) => setRenderId(e.target.value)}>
                <option value="">Choose a finished render…</option>
                {done.map((r) => (
                  <option key={r.id} value={r.id}>
                    {titles.get(r.projectId) ?? 'Project'} · {r.preset} · {r.quality} · {formatTimecode(r.durationSec, 0)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Title shown to the client (optional)">
              <Input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Version label (optional)">
              <Input value={versionLabel} maxLength={60} placeholder="Version 3" onChange={(e) => setVersionLabel(e.target.value)} />
            </Field>
            <Field label="Open for (days)">
              <Input type="number" min={1} max={30} value={days} onChange={(e) => setDays(Math.min(30, Math.max(1, Math.round(Number(e.target.value) || 14))))} />
            </Field>
          </div>
        )}
        <Button variant="primary" loading={busy} disabled={!renderId} icon={<Link2 className="size-4" />} onClick={() => void create()}>
          Create link and copy it
        </Button>
      </Card>

      {!links ? (
        <Skeleton className="h-40" />
      ) : links.length === 0 ? (
        <p className="text-sm text-faint">No review links yet.</p>
      ) : (
        <div className="space-y-4">
          {links.map((l) => (
            <Card key={l.token} className="space-y-3 p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-lg text-fg">
                    {l.title}
                    {l.versionLabel ? <span className="text-dim"> · {l.versionLabel}</span> : null}
                  </p>
                  <p className="text-xs text-faint">
                    {l.projectTitle} · created {new Date(l.createdAt).toLocaleDateString()} · {l.state === 'open' ? `open until ${new Date(l.expiresAt).toLocaleDateString()}` : l.state === 'expired' ? 'expired' : 'withdrawn'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Badge>
                  {l.state === 'open' && (
                    <>
                      <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copy(l.url)}>
                        Copy link
                      </Button>
                      <Button size="sm" variant="ghost" icon={<XCircle className="size-3.5" />} onClick={() => void revoke(l.token)}>
                        Withdraw
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {l.decisions.map((d) => (
                <p key={d.at} className={`text-sm ${d.decision === 'approved' ? 'text-success' : 'text-warning'}`}>
                  {d.decision === 'approved' ? 'Approved' : 'Changes requested'} by {d.name} · {new Date(d.at).toLocaleString()}
                  {d.note ? ` — ${d.note}` : ''}
                </p>
              ))}
              {l.comments.length > 0 ? (
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {l.comments.map((c) => (
                    <li key={c.id} className={`flex items-start gap-3 px-3.5 py-2.5 text-sm ${c.resolved ? 'opacity-55' : ''}`}>
                      <span className="timecode shrink-0 text-accent-2">{formatTimecode(c.atSec, 0)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="text-xs text-faint">{c.name}</span>
                        <span className="block whitespace-pre-wrap text-fg">{c.text}</span>
                      </span>
                      <Button size="sm" variant="ghost" icon={c.resolved ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />} onClick={() => void resolve(l.token, c.id, !c.resolved)}>
                        {c.resolved ? 'Reopen' : 'Done'}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-1.5 text-xs text-faint">
                  <MessageSquare className="size-3.5" /> No comments yet.
                </p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
