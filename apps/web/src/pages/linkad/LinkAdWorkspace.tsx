import { useCallback, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Check, Copy, LoaderCircle, Square } from 'lucide-react';
import { LINKAD_STAGE_LABELS, linkAdReadiness, linkAdStatus, type JobDoc, type ProjectDoc } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import type { WithId } from '../../lib/data';
import { linkAdCall, newRequestId, useActiveJob, useLinkAdDoc, useLinkAdEditor, useRefreshWhileBusy, type LinkAdEditor } from '../../lib/linkad';
import { useSession } from '../../lib/session';
import { useProject } from '../../lib/studio';
import { ProjectHeader } from '../../components/project-header';
import { Button, cx, EmptyState, ErrorState, Notice, Skeleton } from '../../components/ui';
import { FixtureBadge, SaveBadge, STEP_LABELS, STEPS, stepForStage, type LinkAdStepId } from './common';
import { SourceStep } from './SourceStep';
import { BriefStep } from './BriefStep';
import { DirectionsStep } from './DirectionsStep';
import { EditStep } from './EditStep';
import { ExportStep } from './ExportStep';

export interface StepProps {
  project: WithId<ProjectDoc>;
  editor: LinkAdEditor;
  job: WithId<JobDoc> | null;
  go: (s: LinkAdStepId) => void;
  /** Runs a server step, with one error path and a refresh afterwards. */
  act: <T>(label: string, fn: () => Promise<T>) => Promise<T | null>;
  busy: boolean;
}

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

  const natural = stepForStage(serverDoc.stage, serverDoc.ad.scenes.length > 0);
  const current: LinkAdStepId = (STEPS as readonly string[]).includes(step ?? '') ? (step as LinkAdStepId) : natural;
  const go = useCallback((s: LinkAdStepId) => navigate(`/linkad/${project.id}/${s}`), [navigate, project.id]);

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
      toast.success(r.stopped ? `Stopped ${r.stopped} running step${r.stopped === 1 ? '' : 's'}` : 'Nothing was running', { description: 'Work that had already finished is kept. A request already sent to a provider cannot be withdrawn.' });
    } catch (e) {
      toast.error('Could not stop', { description: errorMessage(e) });
    } finally {
      setStopping(false);
    }
  };

  const duplicate = async () => {
    const r = await act('Could not duplicate', () => linkAdCall<{ projectId: string }>({ op: 'duplicate', projectId: project.id, requestId: newRequestId() }));
    if (r) {
      toast.success('Ad duplicated', { description: 'The copy keeps the facts, script and recordings. Exports start fresh.' });
      navigate(`/linkad/${r.projectId}`);
    }
  };

  const status = useMemo(() => linkAdStatus(doc), [doc]);
  const issues = useMemo(() => linkAdReadiness(doc, { final: true }), [doc]);
  const attention = new Set<LinkAdStepId>();
  if (doc.source.status === 'failed' || doc.source.conflicts.length) attention.add('source');
  if (issues.some((i) => i.area === 'brief')) attention.add('brief');
  if (issues.some((i) => i.severity === 'error' && ['script', 'pictures', 'voice', 'captions', 'music', 'rights'].includes(i.area))) attention.add('edit');
  const done = new Set<LinkAdStepId>();
  if (serverDoc.source.facts.length || serverDoc.userFacts.length) done.add('source');
  if (serverDoc.briefApprovedAt) done.add('brief');
  if (serverDoc.ad.scenes.length) done.add('directions');
  if (status.voiceComplete) done.add('edit');
  if (serverDoc.exports.some((e) => e.status === 'completed' && e.checks?.ok && e.quality === 'final')) done.add('export');

  const running = Boolean(serverDoc.activeJobId) && job.data && ['queued', 'validating', 'generating', 'downloading'].includes(job.data.status);
  const props: StepProps = { project, editor, job: job.data ?? null, go, act, busy };

  return (
    <div className="space-y-6">
      <ProjectHeader
        project={project}
        eyebrow="Link to Ad"
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
      </div>

      <nav aria-label="Link to Ad steps" className="scroll-x">
        <ol className="flex min-w-max items-center gap-1.5">
          {STEPS.map((s, i) => {
            const active = s === current;
            const ok = done.has(s) && !attention.has(s);
            return (
              <li key={s} className="flex items-center gap-1.5">
                <button type="button" aria-current={active ? 'step' : undefined} onClick={() => go(s)} className={cx('inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors', active ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim hover:text-fg')}>
                  <span className={cx('grid size-5 place-items-center rounded-full text-[10px]', ok ? 'bg-success/20 text-success' : active ? 'bg-accent text-white' : 'bg-white/10 text-dim')}>{ok ? <Check className="size-3" /> : i + 1}</span>
                  {STEP_LABELS[s]}
                  {attention.has(s) && <span className="size-1.5 rounded-full bg-warning" aria-label="needs attention" />}
                </button>
                {i < STEPS.length - 1 && <span className="h-px w-4 bg-line-strong" aria-hidden />}
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

      {current === 'source' && <SourceStep {...props} />}
      {current === 'brief' && <BriefStep {...props} />}
      {current === 'directions' && <DirectionsStep {...props} />}
      {current === 'edit' && <EditStep {...props} />}
      {current === 'export' && <ExportStep {...props} />}
    </div>
  );
}

export default function LinkAdWorkspace() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  if (project.loading) return <Skeleton className="h-96" />;
  if (project.error) return <ErrorState error={project.error} />;
  if (!project.data) return <EmptyState title="Ad not found" body="It may have been deleted." />;
  if (project.data.type !== 'link_ad') return <Navigate to={`/projects/${project.data.id}`} replace />;
  return <Workspace project={project.data} key={project.data.id} />;
}
