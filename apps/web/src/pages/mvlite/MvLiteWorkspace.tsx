import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { CircleAlert, Copy, LoaderCircle, Redo2, Square, Undo2 } from 'lucide-react';
import { MV_DIRECTION_PRESETS, MV_STAGE_LABELS, MV_STAGES, allMvShots, formatUsd, mapMvShot, mvShotImageId, type LiteAspect, type MvStage, type ProjectDoc } from '@az-studio/shared';
import type { WithId } from '../../lib/data';
import { duplicateMvLiteProject, jobIndex, mvliteCancel, mvSongFrom, useMvComposition, useMvDraft, useMvJobs, useMvSongDoc } from '../../lib/mvlite';
import { useUid } from '../../lib/session';
import { useProject } from '../../lib/studio';
import { ProjectHeader } from '../../components/project-header';
import { Button, Card, cx, EmptyState, ErrorState, IconButton, Notice, Skeleton } from '../../components/ui';
import { DraftBadge, fmtSec, MvStepper, useMvWork, type MvFocus, type MvStageProps } from './common';
import { SongStage } from './SongStage';
import { ConceptStage } from './ConceptStage';
import { ShotsStage } from './ShotsStage';
import { EditStage } from './EditStage';
import { ExportStage } from './ExportStage';

function Workspace({ project }: { project: WithId<ProjectDoc> }) {
  const uid = useUid();
  const { stage = 'song' } = useParams();
  const navigate = useNavigate();
  const { spec, update, status, flush, undo, redo, canUndo, canRedo } = useMvDraft(project);
  const jobs = useMvJobs(project.id, spec.importedFrom?.projectId ?? null);
  const songDoc = useMvSongDoc(project.id, spec.song.songId);
  const song = useMemo(() => mvSongFrom(songDoc.data), [songDoc.data]);
  const [aspect, setAspect] = useState<LiteAspect>(spec.setup.aspect);
  const [focus, setFocusState] = useState<MvFocus>({ sectionId: null, shotId: null });
  const comp = useMvComposition(spec, song, aspect);
  const work = useMvWork(project.id, flush);
  const current = (MV_STAGES as readonly string[]).includes(stage) ? (stage as MvStage) : 'song';
  const setFocus = useCallback((f: Partial<MvFocus>) => setFocusState((cur) => ({ ...cur, ...f })), []);
  const go = useCallback(
    (s: MvStage, f?: Partial<MvFocus>) => {
      if (f) setFocus(f);
      navigate(`/mvlite/${project.id}/${s}`);
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
    const adopt = allMvShots(spec)
      .filter(({ shot }) => !shot.image.approvedAssetId && !shot.image.reuseOfShotId)
      .map(({ shot }) => ({ shot, c: index.imageCandidates(shot.id)[0] }))
      .filter((x) => x.c);
    if (!adopt.length) return;
    update((s) => adopt.reduce((acc, { shot, c }) => mapMvShot(acc, shot.id, (x) => (x.image.approvedAssetId ? x : { ...x, image: { ...x.image, approvedAssetId: c!.assetId } })), s), 'auto-approve');
  }, [index, spec, update]);

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
  const shots = allMvShots(spec);
  const imaged = shots.filter(({ shot }) => mvShotImageId(spec, shot)).length;
  const done = new Set<MvStage>();
  if (song?.analysis && (song.instrumental || !spec.lyrics.enabled || song.sheet?.lines.some((l) => l.start !== null))) done.add('song');
  if (spec.concept.treatment || spec.bible.characters.length) done.add('concept');
  if (shots.length && imaged === shots.length) done.add('shots');
  if (Object.keys(spec.timelines).length) done.add('edit');
  if (spec.renders.some((r) => r.quality === 'final')) done.add('export');

  const props: MvStageProps = { project, spec, update, flush, jobs: jobs.data, songDoc: songDoc.data ?? null, song, comp, aspect, setAspect, go, focus, setFocus, work };
  const d = MV_DIRECTION_PRESETS[spec.setup.direction];
  const duplicate = async () => {
    try {
      await flush();
      const id = await duplicateMvLiteProject(uid, project);
      toast.success('Video duplicated', { description: 'The copy shares the song, lyrics and approved images; nothing was regenerated.' });
      navigate(`/mvlite/${id}/${current}`);
    } catch (e) {
      toast.error('Could not duplicate', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const running = jobs.data.filter((j) => j.projectId === project.id && ['queued', 'validating', 'generating', 'downloading'].includes(j.status) && j.type !== 'render.timeline' && j.type !== 'final.inspect');
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    try {
      const r = await mvliteCancel(project.id);
      toast.success(`Stopped ${r.cancelled} request${r.cancelled === 1 ? '' : 's'}`, { description: 'Work Google had already finished is kept; nothing is charged for requests that had not started.' });
    } catch (e) {
      toast.error('Could not stop', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setStopping(false);
    }
  };
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const sheet = song?.sheet;

  return (
    <div className="space-y-6">
      <ProjectHeader
        project={project}
        eyebrow={`Music Video Lite · ${d.label}`}
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
      <MvStepper current={current} onChange={(s) => go(s)} attention={attention} done={done} />
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          {current === 'song' && <SongStage {...props} />}
          {current === 'concept' && <ConceptStage {...props} />}
          {current === 'shots' && <ShotsStage {...props} />}
          {current === 'edit' && <EditStage {...props} />}
          {current === 'export' && <ExportStage {...props} />}
        </div>
        <aside className="space-y-4">
          <Card className="space-y-3 p-4">
            <p className="eyebrow">This video</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-faint">Song</dt>
              <dd className="truncate text-dim">{song ? `${song.title}${song.analysis ? ` · ${Math.round(song.analysis.bpm)} BPM` : ''}` : '—'}</dd>
              <dt className="text-faint">Format</dt>
              <dd className="text-dim">{[spec.setup.aspect, ...spec.setup.extraAspects].join(' · ')} · {spec.setup.fps} fps</dd>
              <dt className="text-faint">Runtime</dt>
              <dd className="timecode text-fg">{song ? fmtSec(comp.timing.totalSec) : '—'}</dd>
              <dt className="text-faint">Sections</dt>
              <dd className="text-dim">{spec.sections.length} · {shots.length} shots</dd>
              <dt className="text-faint">Images</dt>
              <dd className="text-dim">{imaged}/{shots.length} approved</dd>
              <dt className="text-faint">Lyrics</dt>
              <dd className="text-dim">{song?.instrumental ? 'instrumental' : sheet ? `${sheet.lines.filter((l) => l.start !== null).length}/${sheet.lines.length} lines timed` : 'none yet'}</dd>
              <dt className="text-faint">Spent</dt>
              <dd className="text-dim" data-private>{formatUsd(project.usage?.costUsd ?? 0)} est.</dd>
            </dl>
          </Card>
          <Card className="space-y-2 p-4">
            <p className="eyebrow">Before export</p>
            {!spec.sections.length ? (
              <p className="text-xs text-faint">Plan the shots to see what still needs attention.</p>
            ) : errors.length + warnings.length === 0 ? (
              <Notice tone="success">Everything needed for the final export is in place.</Notice>
            ) : (
              <ul className="space-y-1">
                {[...errors, ...warnings].slice(0, 9).map((f) => (
                  <li key={f.id}>
                    <button type="button" onClick={() => go(f.stage, { sectionId: f.sectionId, shotId: f.shotId })} className="flex w-full cursor-pointer items-start gap-1.5 rounded-lg px-1.5 py-1 text-left text-xs hover:bg-white/[0.04]">
                      <CircleAlert className={cx('mt-0.5 size-3.5 shrink-0', f.severity === 'error' ? 'text-danger' : 'text-warning')} aria-hidden />
                      <span className="min-w-0 text-dim">
                        <span className="text-faint">{MV_STAGE_LABELS[f.stage]} · </span>
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

export default function MvLiteWorkspace() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  if (project.loading) return <Skeleton className="h-96" />;
  if (project.error) return <ErrorState error={project.error} />;
  if (!project.data) return <EmptyState title="Video not found" body="It may have been deleted." />;
  if (project.data.type !== 'mv_lite') return <Navigate to={`/projects/${project.data.id}`} replace />;
  return <Workspace project={project.data} key={project.data.id} />;
}
