import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { CircleAlert, Copy, LoaderCircle, Redo2, Square, Undo2 } from 'lucide-react';
import { LITE_DIRECTION_PRESETS, LITE_STAGE_LABELS, LITE_STAGES, allShots, formatUsd, mapShot, shotImageId, type LiteAspect, type LiteStage, type ProjectDoc } from '@az-studio/shared';
import type { WithId } from '../../lib/data';
import { duplicateLiteProject, jobIndex, liteCancel, useComposition, useLiteDraft, useLiteJobs, useLiteScore } from '../../lib/lite';
import { useUid } from '../../lib/session';
import { useProject } from '../../lib/studio';
import { ProjectHeader } from '../../components/project-header';
import { Button, Card, cx, EmptyState, ErrorState, IconButton, Notice, Skeleton } from '../../components/ui';
import { DraftBadge, fmtSec, Stepper, useLiteWork, type Focus, type StageProps } from './common';
import { StoryStage } from './StoryStage';
import { ScenesStage } from './ScenesStage';
import { SoundStage } from './SoundStage';
import { EditStage } from './EditStage';
import { ExportStage } from './ExportStage';

function Workspace({ project }: { project: WithId<ProjectDoc> }) {
  const uid = useUid();
  const { stage = 'story' } = useParams();
  const navigate = useNavigate();
  const draft = useLiteDraft(project);
  const { spec, update, status, flush, undo, redo, canUndo, canRedo } = draft;
  const jobs = useLiteJobs(project.id, spec.importedFrom?.projectId ?? null);
  const score = useLiteScore(project.id);
  const [aspect, setAspect] = useState<LiteAspect>(spec.setup.aspect);
  const [focus, setFocusState] = useState<Focus>({ sceneId: null, shotId: null });
  const comp = useComposition(spec, jobs.data, score.data ?? null, aspect);
  const work = useLiteWork(project.id, flush);
  const current = (LITE_STAGES as readonly string[]).includes(stage) ? (stage as LiteStage) : 'story';
  const setFocus = useCallback((f: Partial<Focus>) => setFocusState((cur) => ({ ...cur, ...f })), []);
  const go = useCallback(
    (s: LiteStage, f?: Partial<Focus>) => {
      if (f) setFocus(f);
      navigate(`/lite/${project.id}/${s}`);
    },
    [navigate, project.id, setFocus],
  );

  // Reopening continues where the director left off.
  useEffect(() => {
    if (spec.stage !== current) update({ stage: current }, 'stage');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  useEffect(() => {
    if (aspect !== spec.setup.aspect && !spec.setup.extraAspects.includes(aspect)) setAspect(spec.setup.aspect);
  }, [aspect, spec.setup.aspect, spec.setup.extraAspects]);

  // A finished image becomes the shot's approved image when it has none (later results never replace a choice).
  const index = useMemo(() => jobIndex(jobs.data), [jobs.data]);
  useEffect(() => {
    const adopt = allShots(spec).filter(({ shot }) => !shot.image.approvedAssetId && !shot.image.reuseOfShotId).map(({ shot }) => ({ shot, c: index.imageCandidates(shot.id)[0] })).filter((x) => x.c);
    if (!adopt.length) return;
    update((s) => adopt.reduce((acc, { shot, c }) => mapShot(acc, shot.id, (x) => (x.image.approvedAssetId ? x : { ...x, image: { ...x.image, approvedAssetId: c!.assetId } })), s), 'auto-approve');
  }, [index, spec, update]);

  // Undo / redo from the keyboard (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const findings = comp.findings;
  const attention = new Set(findings.filter((f) => f.severity === 'error').map((f) => f.stage));
  const done = new Set<LiteStage>();
  if (spec.story.script.trim()) done.add('story');
  const shots = allShots(spec);
  const imaged = shots.filter(({ shot }) => shotImageId(spec, shot)).length;
  if (shots.length && imaged === shots.length) done.add('scenes');
  const voiced = spec.scenes.filter((s) => !s.narration.trim() || comp.voices[s.id]?.take).length;
  if (spec.scenes.length && voiced === spec.scenes.length) done.add('sound');
  if (spec.timing.acknowledgedAt && !comp.reconciliation.changes.length) done.add('edit');
  if (spec.renders.some((r) => r.quality === 'final')) done.add('export');

  const props: StageProps = { project, spec, update, flush, jobs: jobs.data, score: score.data ?? null, comp, aspect, setAspect, go, focus, setFocus, work };
  const d = LITE_DIRECTION_PRESETS[spec.setup.direction];
  const duplicate = async () => {
    try {
      await flush();
      const id = await duplicateLiteProject(uid, project);
      toast.success('Film duplicated', { description: 'The copy shares the approved images and narration; nothing was regenerated.' });
      navigate(`/lite/${id}/${current}`);
    } catch (e) {
      toast.error('Could not duplicate', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const running = jobs.data.filter((j) => j.projectId === project.id && ['queued', 'validating', 'generating', 'downloading'].includes(j.status) && j.type !== 'render.timeline' && j.type !== 'final.inspect');
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    try {
      const r = await liteCancel(project.id);
      toast.success(`Stopped ${r.cancelled} request${r.cancelled === 1 ? '' : 's'}`, { description: 'Work Google had already finished is kept; nothing is charged for requests that had not started.' });
    } catch (e) {
      toast.error('Could not stop', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setStopping(false);
    }
  };
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');

  return (
    <div className="space-y-6">
      <ProjectHeader
        project={project}
        eyebrow={`Film Studio Lite · ${d.label}`}
        actions={
          <>
            <DraftBadge status={status} />
            <IconButton label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
              <Undo2 className="size-4" />
            </IconButton>
            <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
              <Redo2 className="size-4" />
            </IconButton>
            {running.length > 0 && (
              <Button variant="ghost" icon={stopping ? <LoaderCircle className="size-4 animate-spin" /> : <Square className="size-3.5" />} onClick={() => void stop()} disabled={stopping}>
                Stop {running.length} running
              </Button>
            )}
            <Button variant="ghost" icon={<Copy className="size-4" />} onClick={() => void duplicate()}>
              Duplicate
            </Button>
          </>
        }
      />
      <Stepper current={current} onChange={(s) => go(s)} attention={attention} done={done} />
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          {current === 'story' && <StoryStage {...props} />}
          {current === 'scenes' && <ScenesStage {...props} />}
          {current === 'sound' && <SoundStage {...props} />}
          {current === 'edit' && <EditStage {...props} />}
          {current === 'export' && <ExportStage {...props} />}
        </div>
        <aside className="space-y-4">
          <Card className="space-y-3 p-4">
            <p className="eyebrow">This film</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-faint">Format</dt>
              <dd className="text-dim">{[spec.setup.aspect, ...spec.setup.extraAspects].join(' · ')} · {spec.setup.fps} fps</dd>
              <dt className="text-faint">Target</dt>
              <dd className="text-dim">{fmtSec(spec.setup.targetSec)}</dd>
              <dt className="text-faint">Runtime</dt>
              <dd className="timecode text-fg">
                {spec.scenes.length ? fmtSec(comp.timing.totalSec) : '—'} <span className="text-faint">{comp.timing.estimated ? 'estimated' : 'measured'}</span>
              </dd>
              <dt className="text-faint">Scenes</dt>
              <dd className="text-dim">{spec.scenes.length} · {shots.length} shots</dd>
              <dt className="text-faint">Images</dt>
              <dd className="text-dim">{imaged}/{shots.length} approved</dd>
              <dt className="text-faint">Narration</dt>
              <dd className="text-dim">{voiced}/{spec.scenes.length} scenes</dd>
              <dt className="text-faint">Spent</dt>
              <dd className="text-dim" data-private>{formatUsd(project.usage?.costUsd ?? 0)} est.</dd>
            </dl>
          </Card>
          <Card className="space-y-2 p-4">
            <p className="eyebrow">Before export</p>
            {!spec.scenes.length ? (
              <p className="text-xs text-faint">Plan the scenes to see what still needs attention.</p>
            ) : errors.length + warnings.length === 0 ? (
              <Notice tone="success">Everything needed for the final export is in place.</Notice>
            ) : (
              <ul className="space-y-1">
                {[...errors, ...warnings].slice(0, 9).map((f) => (
                  <li key={f.id}>
                    <button type="button" onClick={() => go(f.stage, { sceneId: f.sceneId, shotId: f.shotId })} className="flex w-full cursor-pointer items-start gap-1.5 rounded-lg px-1.5 py-1 text-left text-xs hover:bg-white/[0.04]">
                      <CircleAlert className={cx('mt-0.5 size-3.5 shrink-0', f.severity === 'error' ? 'text-danger' : 'text-warning')} aria-hidden />
                      <span className="min-w-0 text-dim">
                        <span className="text-faint">{LITE_STAGE_LABELS[f.stage]} · </span>
                        {f.message}
                      </span>
                    </button>
                  </li>
                ))}
                {errors.length + warnings.length > 9 && <li className="px-1.5 text-xs text-faint">+{errors.length + warnings.length - 9} more on the Export stage</li>}
              </ul>
            )}
          </Card>
        </aside>
      </div>
      {work.dialog}
    </div>
  );
}

export default function LiteWorkspace() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  if (project.loading) return <Skeleton className="h-96" />;
  if (project.error) return <ErrorState error={project.error} />;
  if (!project.data) return <EmptyState title="Film not found" body="It may have been deleted." />;
  if (project.data.type !== 'film_lite') return <Navigate to={`/projects/${project.data.id}`} replace />;
  return <Workspace project={project.data} key={project.data.id} />;
}
