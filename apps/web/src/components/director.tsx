import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCheck, CircleCheck, CircleX, Columns2, Crosshair, GitBranch, Hammer, History, Images, Mic, Palette, Play, RefreshCw, ScanText, Scissors, ShieldCheck, Sparkles, SplitSquareHorizontal, Trophy, Wand2 } from 'lucide-react';
import {
  alignWords,
  CATEGORY_KEYS,
  CATEGORY_LABELS,
  estimateSpeechSeconds,
  formatUsd,
  PROBLEM_GROUPS,
  type RepairAttemptDoc,
  planSceneDuration,
  PRODUCTION_STAGES,
  PRODUCTION_STAGE_LABELS,
  PRODUCTION_STATUS_LABELS,
  qualitySettings,
  REPAIR_LABELS,
  SCORE_KEYS,
  SCORE_LABELS,
  tokenize,
  type DurationPlan,
  type ProductionStatus,
  type ProductionSummary,
  type ProjectDoc,
  type QualityProblem,
  type QualitySettings,
  type ShotDoc,
  type TakeDoc,
  type VideoJobRequest,
} from '@az-studio/shared';
import { ApiError, errorMessage } from '../lib/api';
import type { WithId } from '../lib/data';
import { useBoot } from '../lib/session';
import { updateProject } from '../lib/studio';
import { estimateProduction, productionAction, startProduction, useEvents, useProduction, useProjectProductions, useReport, useShotProductions, useVersions, type Production, type ProductionEstimate, type Report, type Version } from '../lib/production';
import { useProjectCollection } from '../lib/continuity';
import { WarningItem } from './continuity-ui';
import { EstimateText } from './jobs';
import { VideoPlayer } from './media';
import { Badge, Button, Card, cx, EmptyState, Field, Input, Modal, Notice, ProgressBar, Select, Skeleton, Textarea, Toggle } from './ui';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'violet';

export function statusTone(s: ProductionStatus): Tone {
  if (s === 'approved') return 'success';
  if (s === 'failed_review') return 'danger';
  if (s === 'awaiting_review') return 'warning';
  if (s === 'cancelled') return 'neutral';
  return 'accent';
}

export function ProductionBadge({ summary, className }: { summary: Pick<ProductionSummary, 'status' | 'overall'> | null | undefined; className?: string }) {
  if (!summary) return null;
  return (
    <Badge tone={statusTone(summary.status)} className={className} icon={summary.status === 'approved' ? <CheckCheck className="size-3" /> : summary.status === 'failed_review' ? <CircleX className="size-3" /> : <ShieldCheck className="size-3" />}>
      {PRODUCTION_STATUS_LABELS[summary.status]}
      {summary.overall !== null && summary.overall !== undefined ? ` · ${summary.overall}` : ''}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Scene-duration preview (before generation)
// ---------------------------------------------------------------------------

/** Plans from the shot's own dialogue and action with text estimates (the server refines with measured audio). */
export function previewPlan(shot: Pick<ShotDoc, 'directions' | 'description' | 'durationSec'>, settings: QualitySettings, caps: { min: number; max: number; chain: number }): DurationPlan {
  const lines = shot.directions.dialogue
    .filter((l) => l.line.trim())
    .map((l, index) => ({ index, character: l.character, text: l.line, seconds: estimateSpeechSeconds(l.line), measured: false }));
  return planSceneDuration({
    lines,
    action: shot.directions.action,
    description: shot.description,
    requestedSec: shot.durationSec,
    openingSec: settings.openingAllowanceSec,
    closingSec: settings.closingAllowanceSec,
    ensureCompleteDialogue: settings.ensureCompleteDialogue,
    ensureCompleteAction: settings.ensureCompleteAction,
    caps: { minSec: caps.min, maxSec: caps.max, maxChainSec: caps.chain },
  });
}

export function DurationPreview({ plan, measured, className }: { plan: DurationPlan; measured?: boolean; className?: string }) {
  const tone = plan.blocked ? 'danger' : plan.strategy === 'single' ? 'success' : 'warning';
  const b = plan.breakdown;
  return (
    <div className={cx('rounded-xl border p-3 text-sm', tone === 'danger' ? 'border-danger/40 bg-danger/5' : tone === 'warning' ? 'border-warning/35 bg-warning/[0.05]' : 'border-line', className)}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span className="text-dim">Requested duration</span>
        <span className="timecode text-right text-fg">{plan.requestedSec} seconds</span>
        <span className="text-dim">Required duration</span>
        <span className="timecode text-right text-fg">
          {plan.requiredSec} seconds{measured === false && !plan.measured ? ' (est.)' : ''}
        </span>
      </div>
      <p className={cx('mt-2', tone === 'danger' ? 'text-[#ff9b9b]' : tone === 'warning' ? 'text-warning' : 'text-dim')}>{plan.blocked ?? plan.message}</p>
      {plan.segments.length > 1 && !plan.blocked && (
        <p className="mt-1 text-xs text-faint">
          {plan.segments.map((s) => `${s.durationSec} s`).join(' + ')} · cut only between whole sentences; the dialogue audio runs continuously across the join.
        </p>
      )}
      <p className="mt-1 text-[11px] text-faint">
        Opening {b.openingSec} s · dialogue {b.dialogueSec} s · pauses {b.pausesSec} s{b.actionTailSec ? ` · action after speech ${b.actionTailSec} s` : ''} · closing {b.closingSec} s
      </p>
      {plan.warnings.map((w) => (
        <p key={w} className="mt-1 text-[11px] text-warning">
          {w}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Start a production (plan + cost confirmation)
// ---------------------------------------------------------------------------

export function ProduceDialog({ projectId, shot, job, reviewTake, takes = 1, onClose, onStarted }: { projectId: string; shot: WithId<ShotDoc>; job: VideoJobRequest; reviewTake?: WithId<TakeDoc> | null; takes?: number; onClose: () => void; onStarted?: (productionId: string) => void }) {
  const [est, setEst] = useState<ProductionEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    estimateProduction(projectId, shot.id, job, { requestedSec: shot.durationSec, reviewTakeId: reviewTake?.id ?? null, takes })
      .then((r) => alive && setEst(r))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
    // The estimate is for the shot as it was when the dialog opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const start = async () => {
    if (!est) return;
    setBusy(true);
    try {
      const r = await startProduction(projectId, shot.id, job, { requestedSec: shot.durationSec, reviewTakeId: reviewTake?.id ?? null, takes: est.takes }, est.estimate.usd);
      toast.success(reviewTake ? 'Quality review started' : 'Production started', { description: reviewTake ? `Inspecting ${reviewTake.label}; problems are repaired automatically within your limits.` : r.plan.message });
      onStarted?.(r.productionId);
      onClose();
    } catch (e) {
      toast.error('Could not start', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={reviewTake ? `Review & repair ${reviewTake.label}` : 'Produce with quality control'}
      description={reviewTake ? 'Inspect → repair → re-inspect → approve. The take is checked against the screenplay; nothing is approved until it passes review.' : 'Plan → generate → inspect → repair → re-inspect → approve. Nothing is marked complete until the scene passes review.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!est || Boolean(est.plan.blocked) || Boolean(est.limitProblem)} onClick={() => void start()} icon={<Sparkles className="size-4" />}>
            {reviewTake ? 'Review' : 'Start'} · ≈ {formatUsd(est?.estimate.usd ?? 0)}
          </Button>
        </>
      }
    >
      {error ? (
        <Notice tone="danger">{error}</Notice>
      ) : !est ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="space-y-4">
          {est.review && (
            <Notice icon={<ShieldCheck className="size-4" />}>
              {est.review.label}{est.review.durationSec ? ` runs ${est.review.durationSec} s` : ''}; the scene needs about {est.plan.requiredSec} s. The inspection transcribes its dialogue and reviews the picture before any repair is chosen.
            </Notice>
          )}
          <DurationPreview plan={est.plan} measured={false} />
          {est.audioMode === 'generated' && <Notice icon={<Mic className="size-4" />}>Each line is first spoken as guide audio and measured, so the final plan uses real line lengths (it may lengthen or split the scene further).</Notice>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Card className="space-y-1 p-3">
              <p className="eyebrow">This run</p>
              <EstimateText estimate={est.estimate} />
              <p className="text-xs text-faint">{est.review ? 'One full inspection of the existing take.' : est.takes > 1 ? `Guide audio, ${est.takes} independent takes and ${est.takes} full inspections; the strongest take is recommended.` : `Guide audio, generation${est.plan.segments.length > 1 ? 's' : ''} and one full inspection.`}</p>
            </Card>
            <Card className="space-y-1 p-3">
              <p className="eyebrow">Automatic repairs</p>
              <p className="text-sm text-fg">
                Up to {est.quality.maxRepairAttempts} · ceiling {formatUsd(est.quality.repairCostCeilingUsd)}
              </p>
              <p className="text-xs text-faint">
                Approval needed above {formatUsd(est.quality.expensiveRetryUsd)} per repair · passes at {est.quality.minApprovalScore}/100.
              </p>
            </Card>
          </div>
          <Card className="space-y-1.5 p-3">
            <p className="eyebrow flex items-center gap-1.5">
              <GitBranch className="size-3.5" /> Continuity
            </p>
            <p className="text-sm text-fg">
              {est.continuity.constraints} protected constraint{est.continuity.constraints === 1 ? '' : 's'} · {est.continuity.added} reference image{est.continuity.added === 1 ? '' : 's'} added from the bibles and the previous shot
              {est.continuity.screens ? ` · ${est.continuity.screens} protected screen${est.continuity.screens === 1 ? '' : 's'} checked with OCR` : ''}
            </p>
            {est.continuity.dropped > 0 && <p className="text-xs text-warning">{est.continuity.dropped} reference{est.continuity.dropped === 1 ? '' : 's'} left out (the model accepts a limited number of images).</p>}
            {est.continuity.warnings.map((w, i) => (
              <p key={i} className={cx('text-xs', w.severity === 'critical' ? 'text-[#ff9b9b]' : 'text-warning')}>
                {w.severity === 'critical' ? 'Blocks generation: ' : ''}
                {w.message}
              </p>
            ))}
            {est.continuity.warnings.some((w) => w.severity === 'critical') && <p className="text-[11px] text-faint">The production stops before anything is generated while a critical plan warning is open — fix the plan or override the warning in the Continuity panel.</p>}
          </Card>
          {est.limitProblem && <Notice tone="danger">{est.limitProblem}</Notice>}
        </div>
      )}
    </Modal>
  );
}

/** Plans and prices several shots, then starts one quality-controlled production per shot. */
export function BatchProduceDialog({ projectId, items, onClose, onStarted }: { projectId: string; items: { shot: WithId<ShotDoc>; job: VideoJobRequest }[]; onClose: () => void; onStarted?: () => void }) {
  const [rows, setRows] = useState<{ est?: ProductionEstimate; error?: string; started?: boolean }[]>(() => items.map(() => ({})));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const [i, it] of items.entries()) {
        try {
          const est = await estimateProduction(projectId, it.shot.id, it.job, { requestedSec: it.shot.durationSec });
          if (alive) setRows((r) => r.map((x, k) => (k === i ? { est } : x)));
        } catch (e) {
          if (alive) setRows((r) => r.map((x, k) => (k === i ? { error: errorMessage(e) } : x)));
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ready = rows.filter((r) => r.est && !r.est.plan.blocked);
  const total = ready.reduce((s, r) => s + (r.est?.estimate.usd ?? 0), 0);
  const start = async () => {
    setBusy(true);
    let ok = 0;
    for (const [i, it] of items.entries()) {
      const est = rows[i]?.est;
      if (!est || est.plan.blocked) continue;
      try {
        await startProduction(projectId, it.shot.id, it.job, { requestedSec: it.shot.durationSec }, est.estimate.usd);
        ok++;
        setRows((r) => r.map((x, k) => (k === i ? { ...x, started: true } : x)));
      } catch (e) {
        setRows((r) => r.map((x, k) => (k === i ? { ...x, error: errorMessage(e) } : x)));
      }
    }
    setBusy(false);
    toast.success(`${ok} production${ok === 1 ? '' : 's'} started`);
    onStarted?.();
    if (ok === ready.length) onClose();
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Produce ${items.length} shots`}
      description="Each shot is planned from its dialogue and action, generated, inspected and repaired before approval."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={busy} disabled={!ready.length || rows.some((r) => !r.est && !r.error)} onClick={() => void start()} icon={<ShieldCheck className="size-4" />}>
            Start {ready.length} · ≈ {formatUsd(total)}
          </Button>
        </>
      }
    >
      <ul className="space-y-2">
        {items.map((it, i) => {
          const r = rows[i]!;
          return (
            <li key={it.shot.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-fg">{it.shot.title}</p>
                {r.started ? <Badge tone="success">Started</Badge> : r.est ? <EstimateText estimate={r.est.estimate} /> : r.error ? <Badge tone="danger">Error</Badge> : <Skeleton className="h-4 w-16" />}
              </div>
              {r.est && (
                <p className={cx('mt-1 text-xs', r.est.plan.blocked ? 'text-[#ff9b9b]' : 'text-dim')}>
                  Requested {r.est.plan.requestedSec} s · required {r.est.plan.requiredSec} s — {r.est.plan.blocked ?? r.est.plan.message}
                </p>
              )}
              {r.error && <p className="mt-1 text-xs text-[#ff9b9b]">{r.error}</p>}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Quality settings (project level)
// ---------------------------------------------------------------------------

export function QualitySettingsCard({ project }: { project: WithId<ProjectDoc> }) {
  const current = qualitySettings(project.quality);
  const [draft, setDraft] = useState<QualitySettings>(current);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof QualitySettings>(k: K, v: QualitySettings[K]) => setDraft({ ...draft, [k]: v });
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);
  const save = async () => {
    setSaving(true);
    try {
      await updateProject(project.id, { quality: draft });
      toast.success('Quality settings saved');
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };
  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Number(v) || 0));
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="eyebrow flex items-center gap-1.5">
            <ShieldCheck className="size-3.5" /> Quality control
          </p>
          <p className="mt-1 text-sm text-dim">Every generated scene is transcribed, reviewed and repaired before it can be approved.</p>
        </div>
        <Button variant="primary" size="sm" disabled={!dirty} loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Toggle checked={draft.autoQualityReview} onChange={(v) => set('autoQualityReview', v)} label="Auto quality review" description="Inspect every generated scene." />
        <Toggle checked={draft.autoFixIncomplete} onChange={(v) => set('autoFixIncomplete', v)} label="Auto-fix incomplete scenes" description="Repair automatically within the limits below." />
        <Toggle checked={draft.ensureCompleteDialogue} onChange={(v) => set('ensureCompleteDialogue', v)} label="Ensure complete dialogue" description="Never cut a character off; lengthen or split instead." />
        <Toggle checked={draft.ensureCompleteAction} onChange={(v) => set('ensureCompleteAction', v)} label="Ensure complete action" description="Allow time for movement to finish." />
        <Toggle checked={draft.checkContinuity} onChange={(v) => set('checkContinuity', v)} label="Check continuity" description="Identity, costume, props, location, previous shot." />
        <Toggle checked={draft.requireApprovalForExpensiveRetries} onChange={(v) => set('requireApprovalForExpensiveRetries', v)} label="Approve expensive retries" description={`Ask before a repair above ${formatUsd(draft.expensiveRetryUsd)}.`} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Max repair attempts">
          <Input type="number" min={0} max={6} value={draft.maxRepairAttempts} onChange={(e) => set('maxRepairAttempts', num(e.target.value, 0, 6))} />
        </Field>
        <Field label="Min approval score">
          <Input type="number" min={0} max={100} value={draft.minApprovalScore} onChange={(e) => set('minApprovalScore', num(e.target.value, 0, 100))} />
        </Field>
        <Field label="Repair cost ceiling ($)">
          <Input type="number" min={0} step={0.5} value={draft.repairCostCeilingUsd} onChange={(e) => set('repairCostCeilingUsd', num(e.target.value, 0, 200))} />
        </Field>
        <Field label="Expensive retry ($)">
          <Input type="number" min={0} step={0.25} value={draft.expensiveRetryUsd} onChange={(e) => set('expensiveRetryUsd', num(e.target.value, 0, 100))} />
        </Field>
        <Field label="Max takes per shot">
          <Input type="number" min={1} max={4} value={draft.maxTakesPerShot} onChange={(e) => set('maxTakesPerShot', num(e.target.value, 1, 4))} />
        </Field>
        <Field label="Line lengths from">
          <Select value={draft.dialogueAudio} onChange={(e) => set('dialogueAudio', e.target.value as QualitySettings['dialogueAudio'])}>
            <option value="generate">Spoken guide audio</option>
            <option value="estimate">Text estimate</option>
          </Select>
        </Field>
        <Field label="Opening (s)">
          <Input type="number" min={0.4} max={1} step={0.1} value={draft.openingAllowanceSec} onChange={(e) => set('openingAllowanceSec', num(e.target.value, 0.4, 1))} />
        </Field>
        <Field label="Closing (s)">
          <Input type="number" min={0.8} max={1.5} step={0.1} value={draft.closingAllowanceSec} onChange={(e) => set('closingAllowanceSec', num(e.target.value, 0.8, 1.5))} />
        </Field>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AI Director Review
// ---------------------------------------------------------------------------

function ScoreBars({ report }: { report: Report }) {
  return (
    <ul className="space-y-1.5">
      {SCORE_KEYS.map((k) => {
        const v = report.scores[k];
        return (
          <li key={k} className="grid grid-cols-[150px_minmax(0,1fr)_36px] items-center gap-2 text-xs">
            <span className={cx(k === 'overallUsability' ? 'text-fg' : 'text-dim')}>{SCORE_LABELS[k]}</span>
            {v === null ? <span className="text-faint">not applicable</span> : <ProgressBar value={v / 100} tone={v >= report.threshold ? 'success' : v >= 60 ? 'accent' : 'danger'} label={SCORE_LABELS[k]} />}
            <span className="timecode text-right text-fg">{v ?? '—'}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Expected screenplay words coloured by what was actually heard. */
function DialogueDiff({ report }: { report: Report }) {
  const d = report.dialogue;
  const expected = useMemo(() => d.lines.flatMap((l) => tokenize(l.expected).map((t) => ({ ...t, line: l.index, character: l.character }))), [d.lines]);
  const heard = useMemo(() => report.transcript.words.map((w) => ({ ...w, norm: tokenize(w.text)[0]?.norm ?? '' })).filter((w) => w.norm), [report.transcript.words]);
  const ops = useMemo(() => alignWords(expected.map((e) => e.norm), heard.map((h) => h.norm)), [expected, heard]);
  if (!d.applicable) return <p className="text-sm text-faint">No dialogue scripted for this shot{heard.length ? ` — but ${heard.length} spoken words were heard: “${report.transcript.text.slice(0, 160)}”` : '.'}</p>;
  const byLine = new Map<number, { text: string; kind: 'ok' | 'changed' | 'missing' | 'extra'; heard?: string; at?: number }[]>();
  let lastLine = expected[0]?.line ?? 0;
  for (const op of ops) {
    if (op.op === 'insert') {
      const w = heard[op.d]!;
      byLine.set(lastLine, [...(byLine.get(lastLine) ?? []), { text: w.text, kind: 'extra', at: w.start }]);
      continue;
    }
    const e = expected[op.e]!;
    lastLine = e.line;
    const entry = op.op === 'match' ? { text: e.raw, kind: 'ok' as const, at: heard[op.d]!.start } : op.op === 'substitute' ? { text: e.raw, kind: 'changed' as const, heard: heard[op.d]!.text, at: heard[op.d]!.start } : { text: e.raw, kind: 'missing' as const };
    byLine.set(e.line, [...(byLine.get(e.line) ?? []), entry]);
  }
  return (
    <div className="space-y-2">
      {d.lines.map((l) => (
        <div key={l.index} className="rounded-lg border border-line px-3 py-2">
          <p className="text-[11px] tracking-wide text-faint uppercase">
            {l.character || 'Speaker'} {l.start !== null ? `· ${l.start.toFixed(2)}–${(l.end ?? l.start).toFixed(2)} s` : ''} {l.complete ? '' : '· incomplete'}
          </p>
          <p className="mt-1 text-sm leading-relaxed">
            {(byLine.get(l.index) ?? []).map((w, i) => (
              <span key={i} title={w.kind === 'changed' ? `Heard “${w.heard}”` : w.kind === 'missing' ? 'Not heard' : w.kind === 'extra' ? 'Not in the script' : w.at !== undefined ? `${w.at.toFixed(2)} s` : undefined} className={cx('mr-1', w.kind === 'missing' && 'text-[#ff8a8a] line-through decoration-2', w.kind === 'changed' && 'rounded bg-warning/15 px-0.5 text-warning', w.kind === 'extra' && 'text-faint italic', w.kind === 'ok' && 'text-fg')}>
                {w.kind === 'changed' ? `${w.text} → ${w.heard}` : w.text}
              </span>
            ))}
          </p>
        </div>
      ))}
      <p className="text-xs text-faint">
        Heard {Math.round(d.wordCoverage * 100)}% of scripted words · first word {d.firstWordStart?.toFixed(2) ?? '—'} s · last word ends {d.lastWordEnd?.toFixed(2) ?? '—'} s · room after it {d.trailingRoomSec?.toFixed(2) ?? '—'} s{d.cutoffTime !== null ? ` · cut off at ${d.cutoffTime} s` : ''}
      </p>
    </div>
  );
}

const GROUPS: { title: string; icon: React.ReactNode; match: (p: QualityProblem) => boolean }[] = [
  ...PROBLEM_GROUPS.map((g) => ({ title: g.title, icon: g.key === 'dialogue' ? <Mic className="size-3.5" /> : <ShieldCheck className="size-3.5" />, match: (p: QualityProblem) => g.categories.includes(p.category) })),
  { title: 'Sound & other', icon: <Mic className="size-3.5" />, match: () => true },
];

function Problems({ report, production, onWaive }: { report: Report; production: Production; onWaive: (cats: string[], waive: boolean) => void }) {
  if (!report.problems.length) return <p className="text-sm text-success">No problems found.</p>;
  const used = new Set<string>();
  return (
    <div className="space-y-3">
      {GROUPS.map((g) => {
        const items = report.problems.filter((p) => !used.has(p.id) && g.match(p));
        items.forEach((p) => used.add(p.id));
        if (!items.length) return null;
        return (
          <div key={g.title}>
            <p className="eyebrow mb-1.5 flex items-center gap-1.5">
              {g.icon} {g.title}
            </p>
            <ul className="space-y-1.5">
              {items.map((p) => {
                const waived = production.waivedCategories.includes(p.category);
                return (
                  <li key={p.id} className={cx('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', waived ? 'border-line opacity-70' : p.blocking ? 'border-danger/35 bg-danger/[0.05]' : 'border-line')}>
                    <Badge tone={p.severity === 'critical' ? 'danger' : p.severity === 'major' ? 'warning' : 'neutral'}>{p.severity}</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-fg">{p.description}</p>
                      <p className="text-[11px] text-faint">
                        {p.category.replace(/_/g, ' ')} · {p.source === 'measured' ? 'measured' : 'reviewed'}
                        {p.startSec !== null ? ` · ${p.startSec.toFixed(1)}${p.endSec !== null ? `–${p.endSec.toFixed(1)}` : ''} s` : ''}
                        {p.blocking && !waived ? ' · blocks approval' : ''}
                      </p>
                    </div>
                    {p.severity !== 'minor' && (
                      <Button size="sm" variant={waived ? 'subtle' : 'ghost'} onClick={() => onWaive([p.category], !waived)}>
                        {waived ? 'Accepted' : 'Mark acceptable'}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function VersionCompare({ versions, onClose }: { versions: WithId<Version>[]; onClose: () => void }) {
  const ready = versions.filter((v) => v.assetId);
  const [left, setLeft] = useState(ready[0]?.id ?? '');
  const [right, setRight] = useState(ready[ready.length - 1]?.id ?? '');
  const side = (id: string, set: (v: string) => void) => {
    const v = ready.find((x) => x.id === id);
    return (
      <div className="min-w-0 space-y-2">
        <Select value={id} onChange={(e) => set(e.target.value)} aria-label="Version">
          {ready.map((x) => (
            <option key={x.id} value={x.id}>
              v{x.index} · {x.label} · {x.verdict}
              {x.overall !== null ? ` ${x.overall}` : ''}
            </option>
          ))}
        </Select>
        {v?.assetId ? <VideoPlayer key={v.assetId} assetId={v.assetId} /> : <Skeleton className="aspect-video" />}
      </div>
    );
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="xl" title="Compare versions" description="Original and repaired versions stay available side by side.">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {side(left, setLeft)}
        {side(right, setRight)}
      </div>
    </Modal>
  );
}

const STAGE_INDEX = new Map(PRODUCTION_STAGES.map((s, i) => [s, i]));

const COST_ACTIONS = ['repair', 'approve_pending_repair', 'extend', 'regenerate', 'split', 'color_match', 'screen_composite', 'correct_blocking', 'regenerate_with_references'] as const;
type CostAction = (typeof COST_ACTIONS)[number];

/** The fifteen take-evaluation categories (not applicable ones are shown as such). */
function CategoryScores({ scores, threshold }: { scores: NonNullable<Report['categoryScores']>; threshold: number }) {
  return (
    <details className="rounded-lg border border-line px-3 py-2">
      <summary className="cursor-pointer text-xs text-dim">Take evaluation · 15 categories</summary>
      <ul className="mt-2 space-y-1">
        {CATEGORY_KEYS.map((k) => {
          const v = scores[k];
          return (
            <li key={k} className="grid grid-cols-[150px_minmax(0,1fr)_36px] items-center gap-2 text-xs">
              <span className="text-dim">{CATEGORY_LABELS[k]}</span>
              {v === null ? <span className="text-faint">not applicable</span> : <ProgressBar value={v / 100} tone={v >= threshold ? 'success' : v >= 60 ? 'accent' : 'danger'} label={CATEGORY_LABELS[k]} />}
              <span className="timecode text-right text-fg">{v ?? '—'}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function DirectorReview({ productionId, compact }: { productionId: string; compact?: boolean }) {
  const prod = useProduction(productionId);
  const p = prod.data;
  const versions = useVersions(productionId);
  const current = versions.data.find((v) => v.id === p?.currentVersionId) ?? versions.data[versions.data.length - 1] ?? null;
  const [viewId, setViewId] = useState<string | null>(null);
  const shown = versions.data.find((v) => v.id === viewId) ?? current;
  const report = useReport(productionId, shown?.reportId ?? null);
  const events = useEvents(productionId);
  const [busy, setBusy] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [direction, setDirection] = useState('');
  const [extendSec, setExtendSec] = useState(4);
  const [showLog, setShowLog] = useState(false);
  const [confirm, setConfirm] = useState<{ action: CostAction; usd: number; message: string } | null>(null);
  const attempts = useProjectCollection<RepairAttemptDoc>(p?.projectId ?? null, 'repairAttempts', { where: [['shotId', '==', p?.shotId ?? '_']], order: 'at', dir: 'desc' });
  if (prod.loading) return <Skeleton className="h-64" />;
  if (!p) return <EmptyState title="Production not found" />;
  const active = ['planning', 'generating', 'inspecting', 'repairing'].includes(p.status);
  const run = async (action: Parameters<typeof productionAction>[1], extra: Parameters<typeof productionAction>[2] = {}) => {
    setBusy(action);
    try {
      const r = await productionAction(p.id, action, { versionId: shown?.id ?? null, ...extra });
      if (action === 'approve' || action === 'keep_original') toast.success('Approved', { description: 'The take is now the shot’s approved take.' });
      else if (r.status) toast.success(`${String(r.status).replace(/_/g, ' ')}`);
    } catch (e) {
      const details = e instanceof ApiError ? (e.details as { reason?: string; estimate?: { usd: number } } | null) : null;
      if (details?.reason === 'confirmation_required' && (COST_ACTIONS as readonly string[]).includes(action)) {
        setConfirm({ action: action as CostAction, usd: details.estimate?.usd ?? 0, message: errorMessage(e) });
      } else toast.error('Action failed', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const waive = (cats: string[], on: boolean) => void run(on ? 'waive' : 'unwaive', { categories: cats });
  const nextCost = p.pendingRepair?.estimateUsd ?? p.failure?.nextAttemptUsd ?? null;
  const stageIdx = STAGE_INDEX.get(p.stage) ?? 0;
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="eyebrow flex items-center gap-1.5">
            <ShieldCheck className="size-3.5" /> AI Director Review
          </p>
          <ProductionBadge summary={{ status: p.status, overall: shown?.overall ?? null }} />
          <span className="text-xs text-faint">
            {p.versionCount} version{p.versionCount === 1 ? '' : 's'} · {p.repairCount} repair{p.repairCount === 1 ? '' : 's'} · spent ≈ {formatUsd(p.spentUsd)}
          </span>
        </div>
        <p className={cx('text-sm', p.status === 'failed_review' ? 'text-[#ff9b9b]' : 'text-dim')}>{p.stageMessage}</p>
        {!compact && (
          <ol className="scroll-x flex gap-1 text-[11px]">
            {PRODUCTION_STAGES.map((s, i) => (
              <li key={s} className={cx('shrink-0 rounded-full border px-2 py-0.5', i < stageIdx ? 'border-success/30 text-success' : i === stageIdx ? 'border-accent/50 bg-accent/10 text-fg' : 'border-line text-faint')}>
                {PRODUCTION_STAGE_LABELS[s]}
              </li>
            ))}
          </ol>
        )}
        {active && <ProgressBar value={Math.min(0.95, (stageIdx + 0.5) / PRODUCTION_STAGES.length)} label="Production progress" />}
        {p.plan && (
          <p className="text-xs text-faint">
            Planned {p.plan.plannedSec} s (requested {p.plan.requestedSec} s, required {p.plan.requiredSec} s{p.plan.measured ? ', measured' : ', estimated'}) · actual {shown?.durationSec ? `${shown.durationSec.toFixed(1)} s` : '—'} · {p.dialogueAudio.note}
          </p>
        )}
      </Card>

      {p.pendingRepair && !active && (
        <Notice tone="warning" icon={<Hammer className="size-4" />}>
          <p>
            Proposed repair: <strong className="text-fg">{REPAIR_LABELS[p.pendingRepair.type]}</strong> — {p.pendingRepair.reason} Estimated {formatUsd(p.pendingRepair.estimateUsd)}.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" loading={busy === 'approve_pending_repair'} onClick={() => void run('approve_pending_repair', { confirmedUsd: p.pendingRepair!.estimateUsd })}>
              Approve repair · {formatUsd(p.pendingRepair.estimateUsd)}
            </Button>
            <Button size="sm" variant="ghost" loading={busy === 'dismiss_pending_repair'} onClick={() => void run('dismiss_pending_repair')}>
              Decline
            </Button>
          </div>
        </Notice>
      )}

      {p.failure && p.status === 'failed_review' && (
        <Notice tone="danger" icon={<AlertTriangle className="size-4" />}>
          <p className="text-fg">{p.failure.summary}</p>
          {p.failure.failed.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {p.failure.failed.slice(0, 6).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {p.failure.attempted.length > 0 && <p className="mt-1 text-xs">Repairs attempted: {p.failure.attempted.join(' · ')}</p>}
          <p className="mt-1 text-xs">
            Strongest version: {versions.data.find((v) => v.id === p.failure!.strongestVersionId) ? `v${versions.data.find((v) => v.id === p.failure!.strongestVersionId)!.index}` : '—'} · another attempt ≈ {nextCost !== null ? formatUsd(nextCost) : '—'}
          </p>
          {p.failure.options.length > 0 && <p className="mt-1 text-xs">Options: {p.failure.options.join(' · ')}</p>}
        </Notice>
      )}

      {p.comparison && p.comparison.ranked.length > 1 && (
        <Card className="space-y-2 p-4">
          <p className="eyebrow flex items-center gap-1.5">
            <Trophy className="size-3.5" /> Take comparison
          </p>
          <p className="text-sm text-dim">{p.comparison.reason}</p>
          <ul className="divide-y divide-line">
            {p.comparison.ranked.map((r, i) => (
              <li key={r.versionId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className={cx('w-6 text-center', i === 0 ? 'text-warning' : 'text-faint')}>{i + 1}</span>
                <span className="text-fg">Take {r.take}</span>
                <Badge tone={r.passed ? 'success' : 'danger'}>{r.passed ? 'passes' : 'fails'} · {r.overall ?? '—'}</Badge>
                {r.weakest && <span className="text-xs text-faint">weakest: {r.weakest} {r.weakestScore ?? ''}</span>}
                {p.comparison!.recommendedVersionId === r.versionId && <Badge tone="warning">recommended</Badge>}
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setViewId(r.versionId)}>
                    View
                  </Button>
                  <Button size="sm" variant={p.currentVersionId === r.versionId ? 'subtle' : 'secondary'} loading={busy === 'choose_version'} disabled={active || p.currentVersionId === r.versionId} onClick={() => void run('choose_version', { versionId: r.versionId })}>
                    {p.currentVersionId === r.versionId ? 'Current' : 'Choose'}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" icon={<Columns2 className="size-3.5" />} onClick={() => setComparing(true)}>
            Side-by-side preview
          </Button>
        </Card>
      )}
      {p.continuity && (
        <p className="text-xs text-faint">
          Continuity established {new Date(p.continuity.plannedAt).toLocaleString()} · {p.continuity.constraints} protected constraints · {p.continuity.refs.length} reference{p.continuity.refs.length === 1 ? '' : 's'} checked by the reviewer{p.continuity.openWarnings ? ` · ${p.continuity.openWarnings} plan warning${p.continuity.openWarnings === 1 ? '' : 's'}` : ''}
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {shown?.assetId ? <VideoPlayer key={shown.assetId} assetId={shown.assetId} /> : <div className="grid aspect-video place-items-center rounded-xl bg-black/30 text-xs text-dim">{active ? 'Working…' : 'No version yet'}</div>}
          {versions.data.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {versions.data.map((v) => (
                <button key={v.id} type="button" onClick={() => setViewId(v.id)} className={cx('cursor-pointer rounded-lg border px-2 py-1 text-xs', shown?.id === v.id ? 'border-accent/60 bg-accent/10 text-fg' : 'border-line text-dim hover:text-fg')}>
                  v{v.index} · {v.label} · {v.verdict === 'passed' ? '✓' : v.verdict === 'failed' ? '✗' : '…'}
                  {v.overall !== null ? ` ${v.overall}` : ''}
                </button>
              ))}
              {versions.data.filter((v) => v.assetId).length >= 2 && (
                <Button size="sm" variant="ghost" icon={<Columns2 className="size-3.5" />} onClick={() => setComparing(true)}>
                  Compare versions
                </Button>
              )}
            </div>
          )}
          <Card className="space-y-2 p-3">
            <p className="eyebrow">Director controls</p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="primary" icon={<CircleCheck className="size-3.5" />} loading={busy === 'approve'} disabled={active || !shown || shown.verdict !== 'passed'} onClick={() => void run('approve')}>
                Approve
              </Button>
              <Button size="sm" icon={<Wand2 className="size-3.5" />} loading={busy === 'repair'} disabled={active || !shown?.reportId} onClick={() => void run('repair')}>
                Repair automatically
              </Button>
              <Button size="sm" icon={<Play className="size-3.5" />} loading={busy === 'extend'} disabled={active || !shown?.interactionId} onClick={() => void run('extend', { extendSec, ...(direction.trim() ? { instruction: direction.trim() } : {}) })}>
                Extend scene +{extendSec} s
              </Button>
              <Button size="sm" icon={<SplitSquareHorizontal className="size-3.5" />} loading={busy === 'split'} disabled={active} onClick={() => void run('split')}>
                Split into shots
              </Button>
              <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={busy === 'regenerate'} disabled={active} onClick={() => void run('regenerate', direction.trim() ? { instruction: direction.trim() } : {})}>
                Regenerate
              </Button>
              <Button size="sm" variant="ghost" icon={<History className="size-3.5" />} loading={busy === 'keep_original'} disabled={active || versions.data.length === 0} onClick={() => void run('keep_original')}>
                Keep original
              </Button>
              <Button size="sm" variant="ghost" icon={<Scissors className="size-3.5" />} loading={busy === 'reinspect'} disabled={active || !shown?.assetId} onClick={() => void run('reinspect')}>
                Re-inspect
              </Button>
            </div>
            <p className="eyebrow pt-1">Continuity repairs</p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" icon={<Images className="size-3.5" />} loading={busy === 'regenerate_with_references'} disabled={active} onClick={() => void run('regenerate_with_references', direction.trim() ? { instruction: direction.trim() } : {})}>
                Regenerate with stronger references
              </Button>
              <Button size="sm" icon={<Crosshair className="size-3.5" />} loading={busy === 'correct_blocking'} disabled={active || !shown} onClick={() => void run('correct_blocking', direction.trim() ? { instruction: direction.trim() } : {})}>
                Correct blocking (blocking frame)
              </Button>
              <Button size="sm" icon={<ScanText className="size-3.5" />} loading={busy === 'screen_composite'} disabled={active || !shown?.assetId || !p.continuity?.compositeScreenIds.length} title={p.continuity?.compositeScreenIds.length ? undefined : 'No protected screen with approved content in this shot'} onClick={() => void run('screen_composite')}>
                Composite screen content
              </Button>
              <Button size="sm" icon={<Palette className="size-3.5" />} loading={busy === 'color_match'} disabled={active || !shown?.assetId || !p.continuity?.colourRefAssetId} title={p.continuity?.colourRefAssetId ? undefined : 'Approve the previous shot of the scene first — it is the colour reference'} onClick={() => void run('color_match')}>
                Colour-match to the previous shot
              </Button>
              {active && (
                <Button size="sm" variant="danger" loading={busy === 'cancel'} onClick={() => void run('cancel')}>
                  Cancel
                </Button>
              )}
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-2">
              <Textarea rows={2} value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="Optional direction for Extend / Regenerate (e.g. hold on Ama’s reaction a beat longer)" aria-label="Director direction" />
              <Field label="Extend (s)">
                <Input type="number" min={3} max={10} value={extendSec} onChange={(e) => setExtendSec(Math.max(3, Math.min(10, Number(e.target.value) || 4)))} />
              </Field>
            </div>
            {shown && shown.verdict === 'failed' && <p className="text-xs text-faint">Approval stays locked until this version passes — or you mark its issues as acceptable (recorded on the scene).</p>}
            {nextCost !== null && <p className="text-xs text-dim">Estimated additional repair cost ≈ {formatUsd(nextCost)} (scene ceiling {formatUsd(p.settings.repairCostCeilingUsd)}).</p>}
          </Card>
        </div>
        <div className="space-y-4">
          {report.data ? (
            <>
              <Card className="space-y-2 p-3">
                <div className="flex items-center justify-between">
                  <p className="eyebrow">Quality score</p>
                  <Badge tone={report.data.passed ? 'success' : 'danger'}>
                    {report.data.passed ? 'Passed' : 'Failed'} · {report.data.overall}/{report.data.threshold}
                  </Badge>
                </div>
                <ScoreBars report={report.data} />
                {report.data.categoryScores && <CategoryScores scores={report.data.categoryScores} threshold={report.data.threshold} />}
                {report.data.summary && <p className="text-xs text-dim">{report.data.summary}</p>}
                <p className="text-[11px] text-faint">
                  Reviewed by {report.data.modelIds.review} · transcript by {report.data.modelIds.transcription}
                  {report.data.modelIds.vision ? ` · frames read by ${report.data.modelIds.vision}` : ''} · {formatUsd(report.data.costUsd, { precise: true })}
                </p>
              </Card>
              {report.data.continuity && report.data.continuity.warnings.length > 0 && (
                <Card className="space-y-2 p-3">
                  <p className="eyebrow flex items-center gap-1.5">
                    <GitBranch className="size-3.5" /> Continuity: expected vs detected
                  </p>
                  <ul className="space-y-1.5">
                    {report.data.continuity.warnings.map((w) => (
                      <WarningItem key={w.id} projectId={p.projectId} shotId={p.shotId} warning={w} shotTitle={() => null} />
                    ))}
                  </ul>
                </Card>
              )}
              <Card className="space-y-2 p-3">
                <p className="eyebrow">Expected vs detected dialogue</p>
                <DialogueDiff report={report.data} />
              </Card>
              {report.data.review.actions.length > 0 && (
                <Card className="space-y-1.5 p-3">
                  <p className="eyebrow">Action beats</p>
                  {report.data.review.actions.map((a, i) => (
                    <p key={i} className={cx('text-sm', a.completed ? 'text-dim' : 'text-warning')}>
                      {a.completed ? '✓' : '✗'} {a.beat}
                      {a.endSec !== null ? ` (by ${a.endSec.toFixed(1)} s)` : ''}
                      {a.note ? ` — ${a.note}` : ''}
                    </p>
                  ))}
                </Card>
              )}
              <Card className="space-y-2 p-3">
                <p className="eyebrow">Problems</p>
                <Problems report={report.data} production={p} onWaive={waive} />
              </Card>
            </>
          ) : shown?.reportId ? (
            <Skeleton className="h-64" />
          ) : (
            <p className="text-sm text-faint">{active ? 'The inspection report appears here as soon as the scene has been reviewed.' : 'Not inspected yet.'}</p>
          )}
          {attempts.data.filter((a) => a.productionId === p.id).length > 0 && (
            <Card className="space-y-1.5 p-3">
              <p className="eyebrow">Repair attempts (every original is kept)</p>
              {attempts.data
                .filter((a) => a.productionId === p.id)
                .map((a) => (
                  <div key={a.id} className="rounded-lg border border-line px-2.5 py-1.5 text-xs">
                    <p className="text-fg">
                      {a.label} <span className={a.outcome === 'fixed' ? 'text-success' : a.outcome === 'pending' ? 'text-accent-2' : 'text-warning'}>· {a.outcome.replace('_', ' ')}</span>
                      {a.resultOverall !== null ? ` · ${a.resultOverall}/100` : ''}
                    </p>
                    <p className="text-dim">{a.reason}</p>
                    <p className="text-faint">
                      Instruction: “{a.instruction.slice(0, 220)}{a.instruction.length > 220 ? '…' : ''}” · est. {formatUsd(a.estimateUsd)}{a.costUsd !== null ? ` · recorded ${formatUsd(a.costUsd, { precise: true })}` : ''}{a.directorRequested ? ' · requested by the director' : ''}
                    </p>
                  </div>
                ))}
            </Card>
          )}
          {p.repairs.length > 0 && (
            <Card className="space-y-1.5 p-3">
              <p className="eyebrow">Repair history</p>
              {p.repairs.map((r, i) => (
                <p key={i} className="text-xs text-dim">
                  {i + 1}. <span className="text-fg">{REPAIR_LABELS[r.type]}</span> — {r.reason} · est. {formatUsd(r.estimateUsd)} · <span className={r.outcome === 'fixed' ? 'text-success' : r.outcome === 'pending' ? 'text-accent-2' : 'text-warning'}>{r.outcome.replace('_', ' ')}</span>
                </p>
              ))}
            </Card>
          )}
          <button type="button" className="cursor-pointer text-xs text-accent-2 hover:underline" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'Hide' : 'Show'} production log ({events.data.length})
          </button>
          {showLog && (
            <ul className="max-h-64 space-y-1 overflow-y-auto text-[11px] text-dim">
              {events.data.map((e) => (
                <li key={e.id}>
                  <span className="timecode text-faint">{new Date(e.at).toLocaleTimeString()}</span> · {PRODUCTION_STAGE_LABELS[e.stage] ?? e.stage} · {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {comparing && <VersionCompare versions={versions.data} onClose={() => setComparing(false)} />}
      {confirm && (
        <Modal
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          size="sm"
          title="Above the scene’s cost ceiling"
          description={confirm.message}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  void run(c.action, { confirmedUsd: c.usd, extendSec, ...(direction.trim() ? { instruction: direction.trim() } : {}) });
                }}
              >
                Spend ≈ {formatUsd(confirm.usd)}
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

/** The latest production of a shot, in a compact card with a link into the full review. */
export function ShotProductionPanel({ projectId, shotId }: { projectId: string; shotId: string }) {
  const list = useShotProductions(projectId, shotId);
  const latest = list.data[0] ?? null;
  if (list.loading) return <Skeleton className="h-24" />;
  if (!latest) return null;
  return <DirectorReview productionId={latest.id} compact />;
}

/** Project dashboard: every production with its state. */
export function ProductionsBoard({ project, onOpen }: { project: WithId<ProjectDoc>; onOpen: (id: string) => void }) {
  const list = useProjectProductions(project.id);
  const boot = useBoot();
  if (list.loading) return <Skeleton className="h-40" />;
  if (!list.data.length) return <EmptyState icon={<ShieldCheck className="size-5" />} title="No quality-controlled scenes yet" body="Generate a shot from the Storyboard & shots tab — it is planned, generated, inspected and repaired here before approval." />;
  const counts = list.data.reduce<Record<string, number>>((m, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {});
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="eyebrow">Scenes in production</p>
        {Object.entries(counts).map(([s, n]) => (
          <Badge key={s} tone={statusTone(s as ProductionStatus)}>
            {PRODUCTION_STATUS_LABELS[s as ProductionStatus]} {n}
          </Badge>
        ))}
      </div>
      <ul className="divide-y divide-line">
        {list.data.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-fg">{x.title}</p>
              <p className="truncate text-xs text-faint">{x.stageMessage}</p>
            </div>
            <ProductionBadge summary={{ status: x.status, overall: null }} />
            <span className="text-xs text-faint">{formatUsd(x.spentUsd)}</span>
            <Button size="sm" onClick={() => onOpen(x.id)}>
              Review
            </Button>
          </li>
        ))}
      </ul>
      {boot && <p className="text-[11px] text-faint">Inspection uses {boot.capabilities.reasoning.displayName} (picture, performance, continuity) and {boot.capabilities.transcription.displayName} (word-timed dialogue).</p>}
    </Card>
  );
}

/** Quality-control tab: project settings and every scene's production state. */
export function QualityTab({ project }: { project: WithId<ProjectDoc> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <QualitySettingsCard project={project} />
      <ProductionsBoard project={project} onOpen={setOpen} />
      {open && (
        <Modal open onOpenChange={(o) => !o && setOpen(null)} size="xl" title="AI Director Review">
          <DirectorReview productionId={open} />
        </Modal>
      )}
    </div>
  );
}
