import { useCallback, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Check, Copy, LoaderCircle, Square } from 'lucide-react';
import { LINKAD_STAGE_LABELS, linkAdReadiness, linkAdStatus, POSTER_TEMPLATE_INFO, posterInputHash, posterReadiness, type ProjectDoc } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import type { WithId } from '../../lib/data';
import { linkAdCall, newRequestId, useActiveJob, useLinkAdDoc, useLinkAdEditor, useRefreshWhileBusy } from '../../lib/linkad';
import { useSession } from '../../lib/session';
import { useProject } from '../../lib/studio';
import { ProjectHeader } from '../../components/project-header';
import { Button, cx, EmptyState, ErrorState, Notice, Skeleton } from '../../components/ui';
import { FixtureBadge, SaveBadge, type LinkAdStepId } from '../linkad/common';
import { EditStep } from '../linkad/EditStep';
import { ExportStep } from '../linkad/ExportStep';
import type { StepProps } from '../linkad/LinkAdWorkspace';
import { FactsStep } from './FactsStep';
import { PosterStep } from './PosterStep';

/**
 * Motion Poster Ad workspace (`/poster/:id/:step`): Facts → Poster → Motion ad → Export. The document, API, voice,
 * timing, assembly, caps and export checks are Link to Ad's; the motion-ad and export steps are Link to Ad's own
 * components, so both tools behave the same from the script onwards.
 */

export const POSTER_STEPS = ['facts', 'poster', 'edit', 'export'] as const;
export type PosterStepId = (typeof POSTER_STEPS)[number];
const LABELS: Record<PosterStepId, string> = { facts: 'Facts & photos', poster: 'Poster', edit: 'Motion ad', export: 'Export' };

/** Link to Ad's steps mapped onto this workspace (its components link to "source", "brief" or "directions"). */
const fromLinkAd = (s: LinkAdStepId): PosterStepId => (s === 'edit' ? 'edit' : s === 'export' ? 'export' : 'facts');

function Workspace({ project }: { project: WithId<ProjectDoc> }) {
  const navigate = useNavigate();
  const { step } = useParams();
  const serverDoc = useLinkAdDoc(project);
  const refresh = useSession((s) => s.refresh);
  const onError = useCallback((m: string) => toast.error('Could not save', { description: m }), []);
  const editor = useLinkAdEditor(project.id, serverDoc, onError);
  const doc = editor.doc;
  const job = useActiveJob(serverDoc);
  useRefreshWhileBusy(project.id, serverDoc);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);

  const natural: PosterStepId = serverDoc.ad.scenes.length ? (serverDoc.stage === 'composing' || serverDoc.stage === 'ready' ? 'export' : 'edit') : 'facts';
  const current: PosterStepId = (POSTER_STEPS as readonly string[]).includes(step ?? '') ? (step as PosterStepId) : natural;
  const go = useCallback((s: PosterStepId) => navigate(`/poster/${project.id}/${s}`), [navigate, project.id]);

  const act = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      try {
        await editor.flush();
        const r = await fn();
        void refresh();
        return r;
      } catch (e) {
        toast.error(label, { description: errorMessage(e) });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [editor, refresh],
  );

  const stop = async () => {
    setStopping(true);
    try {
      const r = await linkAdCall<{ stopped: number }>({ op: 'cancel', projectId: project.id });
      toast.success(r.stopped ? `Stopped ${r.stopped} running step${r.stopped === 1 ? '' : 's'}` : 'Nothing was running', { description: 'Work that had already finished is kept.' });
    } catch (e) {
      toast.error('Could not stop', { description: errorMessage(e) });
    } finally {
      setStopping(false);
    }
  };

  const duplicate = async () => {
    const r = await act('Could not duplicate', () => linkAdCall<{ projectId: string }>({ op: 'duplicate', projectId: project.id, requestId: newRequestId() }));
    if (r) navigate(`/poster/${r.projectId}`);
  };

  const status = useMemo(() => linkAdStatus(doc), [doc]);
  const issues = useMemo(() => linkAdReadiness(doc, { final: true }), [doc]);
  const posterIssues = useMemo(() => posterReadiness(doc), [doc]);
  const attention = new Set<PosterStepId>();
  if (posterIssues.some((i) => i.severity === 'error')) attention.add('facts');
  if (doc.poster && doc.poster.formats.some((f) => doc.poster!.exports[f] && doc.poster!.exports[f]!.hash !== posterInputHash(doc, f))) attention.add('poster');
  if (doc.ad.scenes.length && issues.some((i) => i.severity === 'error')) attention.add('edit');
  const done = new Set<PosterStepId>();
  if (serverDoc.ad.scenes.length) done.add('facts');
  if (serverDoc.poster && serverDoc.poster.formats.every((f) => serverDoc.poster!.exports[f]?.hash === posterInputHash(serverDoc, f))) done.add('poster');
  if (status.voiceComplete) done.add('edit');
  if (serverDoc.exports.some((e) => e.status === 'completed' && e.checks?.ok && e.quality === 'final')) done.add('export');

  const running = Boolean(serverDoc.activeJobId) && job.data && ['queued', 'validating', 'generating', 'downloading'].includes(job.data.status);
  const props: StepProps = { project, editor, job: job.data ?? null, go: (s) => go(fromLinkAd(s)), act, busy };

  return (
    <div className="space-y-6">
      <ProjectHeader
        project={project}
        eyebrow={`Motion Poster Ad${doc.poster ? ` · ${POSTER_TEMPLATE_INFO[doc.poster.template].label}` : ''}`}
        actions={
          <>
            <SaveBadge status={editor.status} />
            {running && (
              <Button variant="ghost" icon={stopping ? <LoaderCircle className="size-4 animate-spin" /> : <Square className="size-3.5" />} onClick={() => void stop()} disabled={stopping}>
                Stop
              </Button>
            )}
            <Button variant="ghost" icon={<Copy className="size-4" />} onClick={() => void duplicate()} disabled={busy}>
              Duplicate
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <FixtureBadge doc={serverDoc} />
        <span className="text-xs text-faint">{LINKAD_STAGE_LABELS[serverDoc.stage]}</span>
        {serverDoc.brandKit && <span className="text-xs text-faint">· Brand kit “{serverDoc.brandKit.name}”</span>}
      </div>

      <nav aria-label="Motion Poster Ad steps" className="scroll-x">
        <ol className="flex min-w-max items-center gap-1.5">
          {POSTER_STEPS.map((s, i) => {
            const active = s === current;
            const ok = done.has(s) && !attention.has(s);
            const locked = (s === 'edit' || s === 'export') && !serverDoc.ad.scenes.length;
            return (
              <li key={s} className="flex items-center gap-1.5">
                <button type="button" aria-current={active ? 'step' : undefined} disabled={locked} onClick={() => go(s)} className={cx('inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50', active ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim hover:text-fg')}>
                  <span className={cx('grid size-5 place-items-center rounded-full text-[10px]', ok ? 'bg-success/20 text-success' : active ? 'bg-accent text-white' : 'bg-white/10 text-dim')}>{ok ? <Check className="size-3" /> : i + 1}</span>
                  {LABELS[s]}
                  {attention.has(s) && <span className="size-1.5 rounded-full bg-warning" aria-label="needs attention" />}
                </button>
                {i < POSTER_STEPS.length - 1 && <span className="h-px w-4 bg-line-strong" aria-hidden />}
              </li>
            );
          })}
        </ol>
      </nav>

      {serverDoc.lastError && !running && (
        <Notice tone="warning">
          <strong className="font-medium">The last step stopped:</strong> {serverDoc.lastError.message} Your work so far is kept.
        </Notice>
      )}
      {running && job.data && (
        <Notice tone="accent" icon={<LoaderCircle className="size-4 animate-spin" />}>
          <span className="text-fg">{job.data.label}</span> — {job.data.stage}
        </Notice>
      )}

      {current === 'facts' && <FactsStep {...props} goPoster={() => go('poster')} goEdit={() => go('edit')} />}
      {current === 'poster' && <PosterStep {...props} goFacts={() => go('facts')} />}
      {current === 'edit' && <EditStep {...props} />}
      {current === 'export' && <ExportStep {...props} />}
    </div>
  );
}

export default function PosterWorkspace() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  if (project.loading) return <Skeleton className="h-96" />;
  if (project.error) return <ErrorState error={project.error} />;
  if (!project.data) return <EmptyState title="Poster ad not found" body="It may have been deleted." />;
  if (project.data.type !== 'poster_ad') return <Navigate to={`/projects/${project.data.id}`} replace />;
  return <Workspace project={project.data} key={project.data.id} />;
}
