import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Ban, CircleCheck, CircleX, Coins, KeyRound, ListChecks, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react';
import { AD_SCENE_KIND_LABELS, formatUsd, isGeneratedScene, isTerminal, JOB_PHASE_LABELS, jobPhase, type CostEstimate, type JobDoc, type StudioSettings, type TakeDoc } from '@az-studio/shared';
import { api, errorMessage, type SpendSnapshot } from '../../lib/api';
import { useDoc } from '../../lib/data';
import { useSession } from '../../lib/session';
import { updateScene, type AdScene } from '../../lib/ads';
import { JobErrorPanel } from '../../components/job-recovery';
import { AssetThumb, useAsset, type Asset } from '../../components/media';
import { Badge, Button, Card, cx, EmptyState, Modal, Notice, ProgressBar } from '../../components/ui';
import type { StepProps } from './AdStudio';

interface AdEstimate {
  jobIds: string[];
  skipped: { sceneId: string; reason: string }[];
  estimate: CostEstimate | null;
  validationEstimate?: CostEstimate;
  perScene: { sceneId: string; title?: string; kind?: string; estimate?: CostEstimate; jobId?: string }[];
  confirmation?: { required: boolean; reasons: string[] };
  limitProblem?: string | null;
  spend?: SpendSnapshot;
  settings?: StudioSettings;
  notes?: string[];
  message?: string;
}

/** What a scene is doing now: planned, generating, validating, ready, needs attention or failed. */
export function sceneStatus(scene: AdScene, job: JobDoc | null, validation: JobDoc | null): { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' } {
  if (!isGeneratedScene(scene.ad.kind)) return scene.ad.kind === 'typography' || scene.ad.kind === 'end_card' || scene.ad.assetIds.length ? { label: 'Composed in the edit', tone: 'success' } : { label: 'Needs material', tone: 'warning' };
  if (job && !isTerminal(job.status)) return { label: job.lastError ? `${JOB_PHASE_LABELS[jobPhase(job)]} · recovering` : JOB_PHASE_LABELS[jobPhase(job)], tone: 'accent' };
  if (validation && !isTerminal(validation.status)) return { label: 'Validating', tone: 'accent' };
  if (scene.selectedTakeId && scene.ad.validation?.verdict === 'pass') return { label: 'Ready', tone: 'success' };
  if (scene.selectedTakeId && scene.ad.validation?.verdict === 'warn') return { label: 'Ready · warnings', tone: 'warning' };
  if (scene.selectedTakeId && scene.ad.validation?.verdict === 'fail') return { label: 'Failed validation', tone: 'danger' };
  if (job?.status === 'failed') return { label: 'Failed', tone: 'danger' };
  if (job?.status === 'cancelled') return { label: 'Cancelled', tone: 'neutral' };
  if (scene.selectedTakeId) return { label: 'Generated · not validated', tone: 'warning' };
  return { label: 'Not generated', tone: 'neutral' };
}

function SceneRow({ project, scene, index, onRegenerate }: { project: StepProps['project']; scene: AdScene; index: number; onRegenerate: () => void }) {
  const job = useDoc<JobDoc>(scene.ad.jobId ? `jobs/${scene.ad.jobId}` : null);
  const validation = useDoc<JobDoc>(scene.ad.validationJobId ? `jobs/${scene.ad.validationJobId}` : null);
  const take = useDoc<TakeDoc>(scene.selectedTakeId ? `projects/${project.id}/shots/${scene.id}/takes/${scene.selectedTakeId}` : null);
  const asset = useAsset(take.data?.assetId ?? null);
  const status = sceneStatus(scene, job.data, validation.data);
  const active = job.data && !isTerminal(job.data.status);
  const [busy, setBusy] = useState(false);
  const recheck = async () => {
    setBusy(true);
    try {
      await api('adValidateScene', { projectId: project.id, sceneId: scene.id });
      toast.success('Validating the scene again');
    } catch (e) {
      toast.error('Could not validate', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="card flex gap-3 p-3.5">
      <div className="w-20 shrink-0 sm:w-24">{asset.data ? <AssetThumb asset={asset.data as Asset} aspect="aspect-[9/16]" showMeta={false} /> : <div className="grid aspect-[9/16] place-items-center rounded-xl border border-line bg-black/30 text-xs text-faint">{index + 1}</div>}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-fg">
            {index + 1}. {scene.title}
          </p>
          <Badge>{AD_SCENE_KIND_LABELS[scene.ad.kind]}</Badge>
          <Badge tone={status.tone}>{status.label}</Badge>
          {scene.ad.qualityRepairs > 0 && <Badge tone="violet">{scene.ad.qualityRepairs} automatic regeneration</Badge>}
        </div>
        <p className="timecode mt-0.5 text-xs text-faint">
          {(scene.timing?.start ?? 0).toFixed(2)}–{(scene.timing?.end ?? 0).toFixed(2)} s · {scene.ad.narration.slice(0, 120)}
        </p>
        {active && (
          <div className="mt-2 space-y-1">
            <p className="text-xs text-dim">{job.data!.stage}</p>
            <ProgressBar value={job.data!.status === 'queued' ? 0.02 : job.data!.progress} label={`${scene.title} progress`} />
          </div>
        )}
        {validation.data && !isTerminal(validation.data.status) && <p className="mt-2 text-xs text-dim">{validation.data.stage}</p>}
        {scene.ad.validation && !active && (
          <p className={cx('mt-2 flex items-center gap-1.5 text-xs', scene.ad.validation.verdict === 'fail' ? 'text-danger' : scene.ad.validation.verdict === 'warn' ? 'text-warning' : 'text-success')}>
            {scene.ad.validation.verdict === 'fail' ? <CircleX className="size-3.5" /> : <CircleCheck className="size-3.5" />}
            {scene.ad.validation.verdict === 'pass' ? 'Passed every check' : scene.ad.validation.verdict === 'warn' ? 'Passed with warnings (see Review)' : `Failed: ${scene.ad.validation.failed.join(', ')}`}
          </p>
        )}
        {job.data?.status === 'failed' && <JobErrorPanel job={job.data} onPromptRevised={(prompt) => void updateScene(project.id, scene, { promptOverride: prompt })} />}
      </div>
      {isGeneratedScene(scene.ad.kind) && (
        <div className="flex shrink-0 flex-col gap-1.5">
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} disabled={Boolean(active)} onClick={onRegenerate}>
            Regenerate
          </Button>
          {scene.selectedTakeId && (
            <Button size="sm" variant="ghost" loading={busy} icon={<ListChecks className="size-3.5" />} onClick={() => void recheck()}>
              Re-check
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function ProviderPause() {
  const boot = useSession((s) => s.boot);
  const refresh = useSession((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  const blocks = (boot?.providerBlocks ?? []).filter((b) => b.until > Date.now());
  if (!blocks.length) return null;
  const resume = async () => {
    setBusy(true);
    try {
      await api('providerHealth', { clear: blocks.map((b) => b.key) });
      await refresh();
      toast.success('Automatic generation resumed');
    } catch (e) {
      toast.error('Could not resume', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice tone="violet" icon={<KeyRound className="size-4" />}>
      <p className="text-fg">Automatic generation is paused: {blocks[0]!.message}</p>
      {blocks[0]!.action && <p className="mt-0.5">What to do: {blocks[0]!.action}</p>}
      <p className="mt-0.5 text-xs">Paused until {new Date(blocks[0]!.until).toLocaleString()} or until you confirm it is fixed.</p>
      <Button size="sm" variant="secondary" className="mt-2" loading={busy} onClick={() => void resume()}>
        It’s fixed — resume
      </Button>
    </Notice>
  );
}

export function GenerateStep({ project, scenes, go }: StepProps) {
  const refreshSession = useSession((s) => s.refresh);
  const [pending, setPending] = useState<{ sceneIds?: string[]; force: boolean; est: AdEstimate } | null>(null);
  const [busy, setBusy] = useState(false);
  const generated = scenes.filter((s) => isGeneratedScene(s.ad.kind));
  const failedIds = generated.filter((s) => s.status === 'failed' || s.ad.validation?.verdict === 'fail').map((s) => s.id);
  const missing = generated.filter((s) => !s.selectedTakeId && s.status !== 'generating' && s.status !== 'queued');

  const estimate = async (sceneIds?: string[], force = false) => {
    setBusy(true);
    try {
      const est = await api<AdEstimate, 'adGenerate'>('adGenerate', { projectId: project.id, ...(sceneIds ? { sceneIds } : {}), force, estimateOnly: true });
      if (!est.estimate) {
        toast(est.message ?? 'Nothing to generate.');
        return;
      }
      setPending({ sceneIds, force, est });
    } catch (e) {
      toast.error('Could not estimate', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!pending?.est.estimate) return;
    setBusy(true);
    try {
      const res = await api<AdEstimate, 'adGenerate'>('adGenerate', { projectId: project.id, ...(pending.sceneIds ? { sceneIds: pending.sceneIds } : {}), force: pending.force, estimateOnly: false, confirmedUsd: pending.est.estimate.usd + (pending.est.validationEstimate?.usd ?? 0) });
      toast.success(`${res.jobIds.length} scene${res.jobIds.length === 1 ? '' : 's'} queued`, { description: res.skipped.length ? `${res.skipped.length} skipped (already done or running).` : undefined });
      setPending(null);
      void refreshSession();
    } catch (e) {
      toast.error('Could not start the generations', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const cancelAll = async () => {
    try {
      const r = await api<{ cancelled: number }, 'adCancel'>('adCancel', { projectId: project.id });
      toast(`${r.cancelled} generation${r.cancelled === 1 ? '' : 's'} cancelled`);
    } catch (e) {
      toast.error('Could not cancel', { description: errorMessage(e) });
    }
  };
  const est = pending?.est;
  return (
    <div className="space-y-5">
      <ProviderPause />
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Generated scenes</p>
            <p className="mt-1 text-sm text-dim">
              {generated.length} of {scenes.length} scenes are generated; the rest come from supplied material and typography. Completed scenes are never regenerated unless you ask; each scene is locked while it is being started, so it is never generated twice by accident.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={busy} disabled={!missing.length} icon={<Sparkles className="size-4" />} onClick={() => void estimate()}>
              Generate {missing.length ? `${missing.length} scene${missing.length === 1 ? '' : 's'}` : 'scenes'}
            </Button>
            <Button variant="secondary" loading={busy} disabled={!failedIds.length} icon={<RefreshCw className="size-4" />} onClick={() => void estimate(failedIds, true)}>
              Regenerate failed ({failedIds.length})
            </Button>
            <Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => void cancelAll()}>
              Cancel running
            </Button>
          </div>
        </div>
        <p className="text-xs text-faint">Temporary Google errors are retried with backoff (respecting Retry-After); a status check that fails resumes the same accepted job; a blocked prompt is rewritten at most once, then waits for you. Every attempt is kept in the scene’s history.</p>
      </Card>
      {scenes.length === 0 ? (
        <EmptyState title="Plan the storyboard first" body="Scenes are generated from the storyboard." />
      ) : (
        <ol className="space-y-3">
          {scenes.map((s, i) => (
            <SceneRow key={s.id} project={project} scene={s} index={i} onRegenerate={() => void estimate([s.id], true)} />
          ))}
        </ol>
      )}
      <div className="flex justify-end">
        <Button variant="primary" icon={<ArrowRight className="size-4" />} onClick={() => go('review')}>
          Review
        </Button>
      </div>
      {pending && est?.estimate && (
        <Modal
          open
          onOpenChange={(o) => !o && setPending(null)}
          title="Confirm generation cost"
          description={`${est.perScene.length} scene${est.perScene.length === 1 ? '' : 's'} · estimated from Google’s published list prices`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy} disabled={Boolean(est.limitProblem)} onClick={() => void confirm()} icon={<Coins className="size-4" />}>
                Generate · ≈ {formatUsd(est.estimate.usd + (est.validationEstimate?.usd ?? 0))}
              </Button>
            </>
          }
        >
          <p className="display text-5xl text-fg">{formatUsd(est.estimate.usd + (est.validationEstimate?.usd ?? 0))}</p>
          <p className="mt-1 text-xs text-faint">
            Generation ≈ {formatUsd(est.estimate.usd)} · validation ≈ {formatUsd(est.validationEstimate?.usd ?? 0, { precise: true })}
            {est.spend && est.settings ? ` · today ${formatUsd(est.spend.today.costUsd)} of ${formatUsd(est.settings.dailyLimitUsd)}` : ''}
          </p>
          {est.limitProblem && (
            <Notice tone="danger" icon={<TriangleAlert className="size-4" />} className="mt-3">
              {est.limitProblem}
            </Notice>
          )}
          <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
            {est.perScene.map((p) => (
              <li key={p.sceneId} className="flex items-center justify-between gap-3 px-3.5 py-2 text-sm">
                <span className="min-w-0 truncate text-dim">{p.title}</span>
                <span className="timecode shrink-0 text-fg">{formatUsd(p.estimate?.usd ?? 0, { precise: true })}</span>
              </li>
            ))}
          </ul>
          {est.skipped.length > 0 && <p className="mt-2 text-xs text-faint">Skipped: {est.skipped.map((s) => `${scenes.find((x) => x.id === s.sceneId)?.title ?? s.sceneId} (${s.reason})`).join(', ')}</p>}
          <ul className="mt-3 space-y-1 text-xs text-faint">
            {(est.notes ?? []).map((n) => (
              <li key={n}>· {n}</li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
