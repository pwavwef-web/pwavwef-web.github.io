import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { CircleAlert, CircleCheck, Copy, ExternalLink, RefreshCw, TriangleAlert, CloudUpload } from 'lucide-react';
import { fmtClock, type EmbedProblem, type PublicationExportState } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { nar } from '../../lib/narrator';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Skeleton } from '../../components/ui';

type PostCheck =
  | { status: 'current' | 'outdated' | 'missing'; url: string; problems: EmbedProblem[] }
  | { status: 'unreachable' | 'unchecked'; url: string | null; message: string };

interface Row {
  publicId: string;
  editionId: string;
  title: string;
  revision: number;
  liveExportVersion: number | null;
  publishedAt: number | null;
  consistent: boolean;
  exports: PublicationExportState;
  post: PostCheck;
  listenUrl: string;
  markup: string;
}

const POST_BADGE: Record<PostCheck['status'], { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  current: { tone: 'success', label: 'Post uses current markup' },
  outdated: { tone: 'warning', label: 'Post markup out of date' },
  missing: { tone: 'danger', label: 'Player not found in post' },
  unreachable: { tone: 'warning', label: 'Post could not be read' },
  unchecked: { tone: 'neutral', label: 'Post not checked' },
};

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Current markup copied. Paste it in the post’s HTML view, replacing the old player block.');
  } catch {
    toast.error('Copy failed — open the edition and copy the markup there.');
  }
}

/**
 * Narrator → Publications: every published paper, the export it plays, newer exports waiting, and whether the live
 * post still carries today's player markup (the server reads the post with the article importer's protections).
 */
export default function PublicationHealth() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState<Row | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (checkPosts = true) => {
    setLoading(true);
    setError(null);
    try {
      const r = await nar<{ checkedAt: number; rows: Row[] }>('publicationHealth', { checkPosts });
      setRows(r.rows);
      setCheckedAt(r.checkedAt);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(true);
  }, [load]);

  const publish = async () => {
    const row = publishing;
    if (!row?.exports.newer) return;
    setBusy(true);
    try {
      const r = await nar<{ revision: number; unchanged: boolean }>('publish', { editionId: row.editionId, exportId: row.exports.newer.exportId, reviewed: true });
      toast.success(r.unchanged ? 'That export is already the published version.' : `Published — revision ${r.revision}. The link and embed stay the same.`);
      setPublishing(null);
      setReviewed(false);
      await load(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !rows) return <ErrorState error={error} onRetry={() => void load(true)} />;
  if (!rows) return <Skeleton className="h-72" />;
  const attention = rows.filter((r) => r.exports.waiting === 'ready' || r.post.status !== 'current' || !r.consistent).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="display text-3xl text-fg">Publications</h2>
          <p className="text-sm text-dim">
            {rows.length} published {rows.length === 1 ? 'paper' : 'papers'} · {attention ? `${attention} need${attention === 1 ? 's' : ''} attention` : 'all current'}
            {checkedAt ? ` · checked ${new Date(checkedAt).toLocaleTimeString()}` : ''}
          </p>
        </div>
        <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load(true)}>
          Check again
        </Button>
      </div>
      {!rows.length ? (
        <EmptyState title="Nothing published yet" body="Publish an edition from its editor; it will appear here with its live revision and post check." />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const pb = POST_BADGE[r.post.status];
            const problems = 'problems' in r.post ? r.post.problems : [];
            return (
              <li key={r.publicId}>
                <Card className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link to={`/narrator/e/${r.editionId}`} className="display text-xl text-fg hover:underline">
                        {r.title}
                      </Link>
                      <p className="text-xs text-faint">
                        Revision {r.revision} · plays export v{r.liveExportVersion ?? '—'}
                        {r.publishedAt ? ` · published ${new Date(r.publishedAt).toLocaleString()}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone={pb.tone} icon={r.post.status === 'current' ? <CircleCheck className="size-3" /> : <TriangleAlert className="size-3" />}>
                        {pb.label}
                      </Badge>
                      {r.exports.waiting === 'ready' && <Badge tone="accent">Export v{r.exports.newer!.version} waiting</Badge>}
                      {r.exports.waiting === 'rendering' && <Badge>Export v{r.exports.newer!.version} rendering</Badge>}
                      {r.exports.waiting === 'failed' && <Badge tone="danger">Newest export failed</Badge>}
                      {!r.consistent && <Badge tone="danger">Edition record differs</Badge>}
                    </div>
                  </div>
                  {r.exports.waiting === 'ready' && (
                    <p className="text-[13px] text-dim">
                      Export v{r.exports.newer!.version}
                      {r.exports.newer!.durationSec ? ` (${fmtClock(r.exports.newer!.durationSec)})` : ''} is finished and newer than the published v{r.liveExportVersion}. Exports record no listening review — listen to it in the edition before publishing.
                    </p>
                  )}
                  {problems.length > 0 && (
                    <ul className="space-y-0.5 text-xs text-warning">
                      {problems.map((p, i) => (
                        <li key={i} className="flex gap-1.5">
                          <CircleAlert className="mt-0.5 size-3 shrink-0" />
                          {p.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {'message' in r.post && <p className="text-xs text-faint">{r.post.message}</p>}
                  <div className="flex flex-wrap gap-2">
                    {r.exports.waiting === 'ready' && (
                      <Button size="sm" variant="primary" icon={<CloudUpload className="size-3.5" />} onClick={() => setPublishing(r)}>
                        Publish newer export
                      </Button>
                    )}
                    <Button size="sm" variant={r.post.status === 'current' ? 'ghost' : 'secondary'} icon={<Copy className="size-3.5" />} onClick={() => void copy(r.markup)}>
                      Copy current markup
                    </Button>
                    <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} onClick={() => window.open(r.listenUrl, '_blank', 'noopener')}>
                      Listen
                    </Button>
                    {r.post.url && (
                      <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} onClick={() => window.open(r.post.url!, '_blank', 'noopener')}>
                        Open post
                      </Button>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={Boolean(publishing)}
        onOpenChange={(o) => {
          if (!o) {
            setPublishing(null);
            setReviewed(false);
          }
        }}
        title="Publish this update?"
        confirmLabel="Publish update"
        loading={busy}
        confirmDisabled={!reviewed}
        onConfirm={() => void publish()}
        body={`Export v${publishing?.exports.newer?.version ?? ''} replaces the public version of “${publishing?.title ?? ''}” at the same link; the replaced revision keeps playing for listeners mid-play for 15 minutes. The post markup does not change.`}
      >
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-dim">
          <input type="checkbox" className="mt-1 accent-[#4c8dff]" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />I have listened to export v{publishing?.exports.newer?.version} and approve it for publication.
        </label>
      </ConfirmDialog>
    </div>
  );
}
