import { useEffect, useMemo } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { Check, CircleAlert, CloudOff, LoaderCircle, Save } from 'lucide-react';
import { AD_MODE_LABELS, AD_STEP_LABELS, AD_STEPS, adReadiness, formatDuration, formatUsd, isGeneratedScene, type AdSpec, type AdStep, type ProjectDoc } from '@az-studio/shared';
import type { WithId } from '../../lib/data';
import { useAdDraft, useAdScenes, useNarration, type AdScene, type DraftStatus } from '../../lib/ads';
import { useProject } from '../../lib/studio';
import { ProjectHeader } from '../../components/project-header';
import { Badge, Card, cx, EmptyState, ErrorState, Notice, Skeleton } from '../../components/ui';
import { BriefStep } from './BriefStep';
import { AssetsStep } from './AssetsStep';
import { StoryboardStep } from './StoryboardStep';
import { GenerateStep } from './GenerateStep';
import { ReviewStep } from './ReviewStep';
import { ExportStep } from './ExportStep';

export interface StepProps {
  project: WithId<ProjectDoc>;
  ad: AdSpec;
  update: (patch: Partial<AdSpec> | ((a: AdSpec) => AdSpec)) => void;
  scenes: AdScene[];
  go: (step: AdStep) => void;
}

function DraftBadge({ status }: { status: DraftStatus }) {
  if (status === 'saving') return <Badge icon={<LoaderCircle className="size-3 animate-spin" />}>Saving draft…</Badge>;
  if (status === 'unsaved') return <Badge icon={<Save className="size-3" />}>Unsaved changes</Badge>;
  if (status === 'error') return <Badge tone="danger" icon={<CloudOff className="size-3" />}>Draft not saved — retrying on next edit</Badge>;
  return <Badge tone="success" icon={<Check className="size-3" />}>Draft saved</Badge>;
}

/** Numbered workflow steps; each shows whether something still needs attention there. */
function Stepper({ current, onChange, attention, done }: { current: AdStep; onChange: (s: AdStep) => void; attention: Set<AdStep>; done: Set<AdStep> }) {
  return (
    <nav aria-label="Advert workflow" className="scroll-x">
      <ol className="flex min-w-max items-center gap-1.5">
        {AD_STEPS.map((s, i) => {
          const active = s === current;
          return (
            <li key={s} className="flex items-center gap-1.5">
              <button
                type="button"
                aria-current={active ? 'step' : undefined}
                onClick={() => onChange(s)}
                className={cx(
                  'inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  active ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim hover:text-fg',
                )}
              >
                <span className={cx('grid size-5 place-items-center rounded-full text-[10px]', done.has(s) && !attention.has(s) ? 'bg-success/20 text-success' : active ? 'bg-accent text-white' : 'bg-white/10 text-dim')}>
                  {done.has(s) && !attention.has(s) ? <Check className="size-3" /> : i + 1}
                </span>
                {AD_STEP_LABELS[s]}
                {attention.has(s) && <span className="size-1.5 rounded-full bg-warning" aria-label="needs attention" />}
              </button>
              {i < AD_STEPS.length - 1 && <span className="h-px w-3 bg-line-strong" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Workspace({ project }: { project: WithId<ProjectDoc> }) {
  const { step = 'brief' } = useParams();
  const navigate = useNavigate();
  const { ad, update, status } = useAdDraft(project);
  const scenes = useAdScenes(project.id);
  const narration = useNarration(project.id, ad.audio.songId);
  const current = (AD_STEPS as readonly string[]).includes(step) ? (step as AdStep) : 'brief';
  const go = (s: AdStep) => navigate(`/ads/${project.id}/${s}`);
  // The last visited step is part of the draft (reopening the advert continues where you left off).
  useEffect(() => {
    if (ad.step !== current) update({ step: current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const readiness = useMemo(
    () =>
      adReadiness({
        ad,
        sheet: narration.data?.lyricsSheet ?? null,
        scenes: scenes.data.map((s) => ({ id: s.id, title: s.title, kind: s.ad.kind, start: s.timing?.start ?? 0, end: s.timing?.end ?? 0, hasMedia: isGeneratedScene(s.ad.kind) ? Boolean(s.selectedTakeId) : s.ad.kind === 'typography' || s.ad.kind === 'end_card' || s.ad.assetIds.length > 0, validation: s.ad.validation, generating: s.status === 'queued' || s.status === 'generating' })),
      }),
    [ad, narration.data?.lyricsSheet, scenes.data],
  );
  const attention = new Set(readiness.map((r) => r.step));
  const done = new Set<AdStep>();
  if (ad.brief.brand.trim() && (ad.brief.keyMessage.trim() || ad.mode === 'audio_first')) done.add('brief');
  if (!readiness.some((r) => r.step === 'assets' && r.severity === 'error') && ad.audio.assetId) done.add('assets');
  if (scenes.data.length && !readiness.some((r) => r.step === 'storyboard')) done.add('storyboard');
  if (scenes.data.length && !readiness.some((r) => r.step === 'generate')) done.add('generate');
  if (ad.previewRenderId) done.add('review');
  if (Object.keys(ad.finalRenderIds).length) done.add('export');
  const props: StepProps = { project, ad, update, scenes: scenes.data, go };
  const generated = scenes.data.filter((s) => isGeneratedScene(s.ad.kind));
  const ready = generated.filter((s) => s.selectedTakeId && s.ad.validation?.verdict !== 'fail').length;

  return (
    <div className="space-y-6">
      <ProjectHeader project={project} eyebrow={`Short Ad · ${AD_MODE_LABELS[ad.mode]}`} actions={<DraftBadge status={status} />} />
      <Stepper current={current} onChange={go} attention={attention} done={done} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {current === 'brief' && <BriefStep {...props} />}
          {current === 'assets' && <AssetsStep {...props} />}
          {current === 'storyboard' && <StoryboardStep {...props} />}
          {current === 'generate' && <GenerateStep {...props} />}
          {current === 'review' && <ReviewStep {...props} />}
          {current === 'export' && <ExportStep {...props} />}
        </div>
        <aside className="space-y-4">
          <Card className="space-y-3 p-4">
            <p className="eyebrow">This advert</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-faint">Format</dt>
              <dd className="text-dim">{ad.aspect} · {project.format.fps} fps</dd>
              <dt className="text-faint">Length</dt>
              <dd className="timecode text-fg">{ad.audio.durationSec ? `${formatDuration(ad.audio.durationSec)} (${ad.audio.durationSec.toFixed(2)} s)` : ad.mode === 'brief_first' ? `${ad.brief.durationSec} s planned` : 'Not measured'}</dd>
              <dt className="text-faint">Timeline authority</dt>
              <dd className="text-dim">{ad.audio.durationSec ? 'Measured audio' : '—'}</dd>
              <dt className="text-faint">Scenes</dt>
              <dd className="text-dim">{scenes.data.length ? `${scenes.data.length} · ${ready}/${generated.length} generated ready` : 'Not planned'}</dd>
              <dt className="text-faint">Spent</dt>
              <dd className="text-dim" data-private>{formatUsd(project.usage?.costUsd ?? 0)} est.</dd>
            </dl>
          </Card>
          <Card className="space-y-2 p-4">
            <p className="eyebrow">Before export</p>
            {readiness.length === 0 ? (
              <Notice tone="success" icon={<Check className="size-4" />}>Everything needed for the final render is in place.</Notice>
            ) : (
              <ul className="space-y-1.5">
                {readiness.slice(0, 10).map((r, i) => (
                  <li key={i}>
                    <button type="button" onClick={() => go(r.step)} className="flex w-full cursor-pointer items-start gap-1.5 rounded-lg px-1.5 py-1 text-left text-xs hover:bg-white/[0.04]">
                      <CircleAlert className={cx('mt-0.5 size-3.5 shrink-0', r.severity === 'error' ? 'text-danger' : 'text-warning')} aria-hidden />
                      <span className="min-w-0">
                        <span className="text-faint">{AD_STEP_LABELS[r.step]} · </span>
                        <span className="text-dim">{r.message}</span>
                      </span>
                    </button>
                  </li>
                ))}
                {readiness.length > 10 && <li className="px-1.5 text-xs text-faint">+{readiness.length - 10} more</li>}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

export default function AdStudio() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  if (project.loading) return <Skeleton className="h-96" />;
  if (project.error) return <ErrorState error={project.error} />;
  if (!project.data) return <EmptyState title="Advert not found" body="It may have been deleted." />;
  if (project.data.type !== 'short_ad') return <Navigate to={`/projects/${project.data.id}`} replace />;
  return <Workspace project={project.data} key={project.data.id} />;
}
