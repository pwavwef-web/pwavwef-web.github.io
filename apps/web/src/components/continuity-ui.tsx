import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, ArrowDown, ArrowUp, CircleCheck, CircleDashed, CircleX, Eye, Hammer, Lock, RefreshCw, ShieldAlert, ShieldCheck, TriangleAlert, Undo2, Wrench } from 'lucide-react';
import {
  CONSTRAINT_LEVEL_LABELS,
  CONTINUITY_STATUS_LABELS,
  formatUsd,
  WARNING_LABELS,
  type ContinuityConstraint,
  type ContinuityState,
  type ContinuityStatus,
  type ContinuityWarning,
  type ScreenDirection,
  type ShotDoc,
} from '@az-studio/shared';
import { errorMessage } from '../lib/api';
import type { WithId } from '../lib/data';
import { checkContinuity, insertNeutralShot, useProjectDoc, warningAction, type ContinuityCheck, type Snapshot } from '../lib/continuity';
import { Badge, Button, Card, cx, Input, Modal, Notice, Skeleton, Tip } from './ui';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'violet';

const STATUS_TONE: Record<ContinuityStatus, Tone> = {
  planned: 'neutral',
  locked: 'success',
  consistent: 'success',
  warning: 'warning',
  failed: 'danger',
  repaired: 'violet',
  needs_review: 'accent',
  overridden: 'neutral',
};

const STATUS_ICON: Record<ContinuityStatus, ReactNode> = {
  planned: <CircleDashed className="size-3" />,
  locked: <Lock className="size-3" />,
  consistent: <CircleCheck className="size-3" />,
  warning: <TriangleAlert className="size-3" />,
  failed: <CircleX className="size-3" />,
  repaired: <Wrench className="size-3" />,
  needs_review: <Eye className="size-3" />,
  overridden: <ShieldAlert className="size-3" />,
};

/** Compact continuity status: Locked, Consistent, Warning, Failed, Repaired, Needs review, Manually overridden. */
export function ContinuityBadge({ status, openWarnings, className, onClick }: { status: ContinuityStatus | null | undefined; openWarnings?: number; className?: string; onClick?: () => void }) {
  if (!status) return null;
  const badge = (
    <Badge tone={STATUS_TONE[status]} icon={STATUS_ICON[status]} className={className}>
      {status === 'overridden' ? 'Manually overridden' : CONTINUITY_STATUS_LABELS[status]}
      {openWarnings ? ` · ${openWarnings}` : ''}
    </Badge>
  );
  if (!onClick) return badge;
  return (
    <button type="button" onClick={onClick} className="cursor-pointer" aria-label={`Continuity: ${CONTINUITY_STATUS_LABELS[status]}${openWarnings ? `, ${openWarnings} open warnings` : ''}`}>
      {badge}
    </button>
  );
}

const DIRECTION_ICON: Partial<Record<ScreenDirection, ReactNode>> = {
  left_to_right: <ArrowRight className="size-3.5" />,
  right_to_left: <ArrowLeft className="size-3.5" />,
  toward_camera: <ArrowDown className="size-3.5" />,
  away_from_camera: <ArrowUp className="size-3.5" />,
};

/** Screen-direction arrows (storyboard and timeline): who travels which way on screen. */
export function DirectionArrows({ travel, names, className }: { travel: Record<string, ScreenDirection> | null | undefined; names?: Record<string, string>; className?: string }) {
  const moves = Object.entries(travel ?? {}).filter(([, d]) => DIRECTION_ICON[d]);
  if (!moves.length) return null;
  return (
    <span className={cx('inline-flex items-center gap-1', className)}>
      {moves.map(([id, d]) => (
        <Tip key={id} label={`${names?.[id] ?? 'Character'} travels ${d.replace(/_/g, ' ')}`}>
          <span className="inline-flex items-center gap-0.5 rounded-md bg-black/55 px-1 py-0.5 text-[10px] text-fg">
            {DIRECTION_ICON[d]}
            {names?.[id] ? names[id]!.slice(0, 8) : ''}
          </span>
        </Tip>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

const SEVERITY_TONE = { info: 'neutral', warning: 'warning', critical: 'danger' } as const;

/** One continuity warning with its expected vs detected state, proposed repair, cost and affected shots. */
export function WarningItem({ projectId, shotId, warning, shotTitle, defaultOpen }: { projectId: string; shotId: string; warning: ContinuityWarning; shotTitle: (id: string | null) => string | null; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (action: 'override' | 'reopen' | 'resolve') => {
    setBusy(action);
    try {
      await warningAction(projectId, shotId, warning.id, action, note);
      toast.success(action === 'override' ? 'Override recorded' : action === 'resolve' ? 'Marked resolved' : 'Warning reopened');
      setNote('');
    } catch (e) {
      toast.error('Could not update the warning', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const neutral = async (kind: 'head_on' | 'tail_away' | 'cutaway') => {
    if (!warning.affects.previousShotId) return;
    setBusy(kind);
    try {
      await insertNeutralShot(projectId, warning.affects.previousShotId, kind);
      toast.success('Neutral shot inserted', { description: 'It sits between the two shots on the line of action; produce it like any other shot.' });
    } catch (e) {
      toast.error('Could not insert the shot', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const bridgeable = warning.status === 'open' && Boolean(warning.affects.previousShotId) && (warning.kind === 'screen_direction' || warning.kind === 'entry_exit' || warning.kind === 'axis_crossing' || warning.proposedRepair?.type === 'neutral_shot');
  const prev = shotTitle(warning.affects.previousShotId);
  const next = shotTitle(warning.affects.nextShotId);
  return (
    <li className={cx('rounded-lg border px-3 py-2 text-sm', warning.status !== 'open' ? 'border-line opacity-75' : warning.severity === 'critical' ? 'border-danger/35 bg-danger/[0.05]' : warning.severity === 'warning' ? 'border-warning/30' : 'border-line')}>
      <button type="button" className="flex w-full cursor-pointer items-start gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Badge tone={SEVERITY_TONE[warning.severity]}>{warning.severity}</Badge>
        <span className="min-w-0 flex-1">
          <span className="text-fg">{warning.message}</span>
          <span className="block text-[11px] text-faint">
            {WARNING_LABELS[warning.kind] ?? warning.kind} · {warning.source === 'plan' ? 'from the plan' : warning.source === 'compare' ? 'cross-shot comparison' : warning.source === 'final' ? 'final film' : 'inspection'}
            {warning.status !== 'open' ? ` · ${warning.status}` : ''}
          </span>
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 border-t border-line pt-2 text-xs">
          <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-faint">Expected</dt>
            <dd className="text-fg">{warning.expected || '—'}</dd>
            <dt className="text-faint">Detected</dt>
            <dd className="text-fg">{warning.detected ?? '— (plan-time check)'}</dd>
            <dt className="text-faint">Difference</dt>
            <dd className="text-dim">{warning.difference ?? '—'}</dd>
            <dt className="text-faint">Proposed repair</dt>
            <dd className="text-dim">{warning.proposedRepair ? `${warning.proposedRepair.label}${warning.proposedRepair.estimateUsd !== null ? ` · ≈ ${formatUsd(warning.proposedRepair.estimateUsd)}` : ''}` : warning.source === 'plan' ? 'Fix the plan (blocking, props, axis) before generating — nothing is spent yet.' : 'Chosen by the AI Director Review when the shot is produced.'}</dd>
            <dt className="text-faint">Shots affected</dt>
            <dd className="text-dim">{[prev ? `previous: ${prev}` : '', next ? `next: ${next}` : ''].filter(Boolean).join(' · ') || 'this shot only'}</dd>
            {warning.note ? (
              <>
                <dt className="text-faint">Director note</dt>
                <dd className="text-dim">{warning.note}</dd>
              </>
            ) : null}
          </dl>
          {bridgeable && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-faint">Bridge the cut with a neutral shot:</span>
              {(['head_on', 'tail_away', 'cutaway'] as const).map((k) => (
                <Button key={k} size="sm" variant="ghost" loading={busy === k} onClick={() => void neutral(k)}>
                  {k === 'head_on' ? 'Head-on' : k === 'tail_away' ? 'Tail-away' : 'Cutaway'}
                </Button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {warning.status === 'open' ? (
              <>
                <Input className="h-8 min-w-48 flex-1 text-xs" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this is intended (recorded with the override)" aria-label="Override note" />
                <Button size="sm" variant="ghost" loading={busy === 'override'} disabled={!note.trim()} onClick={() => void act('override')} icon={<ShieldAlert className="size-3.5" />}>
                  Override
                </Button>
                <Button size="sm" variant="ghost" loading={busy === 'resolve'} onClick={() => void act('resolve')} icon={<CircleCheck className="size-3.5" />}>
                  Resolved
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" loading={busy === 'reopen'} onClick={() => void act('reopen')} icon={<Undo2 className="size-3.5" />}>
                Reopen
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// State summaries
// ---------------------------------------------------------------------------

function propLabel(v: string | null, names: Record<string, string>): string {
  return v ? names[v] ?? v : 'empty';
}

/** Readable summary of a continuity state (characters, props, environment, camera). */
export function StateSummary({ state, names, className }: { state: ContinuityState | null | undefined; names: { characters: Record<string, string>; props: Record<string, string> }; className?: string }) {
  if (!state) return <p className={cx('text-xs text-faint', className)}>—</p>;
  const chars = Object.entries(state.characters);
  const props = Object.entries(state.props);
  return (
    <div className={cx('space-y-1.5 text-xs', className)}>
      {chars.map(([id, c]) => (
        <p key={id} className={cx(!c.present && 'text-faint line-through')}>
          <span className="text-fg">{names.characters[id] ?? id}</span>
          <span className="text-dim">
            {c.costume ? ` · ${c.costume}` : ''} · L: {propLabel(c.leftHand, names.props)} · R: {propLabel(c.rightHand, names.props)} · {c.posture}
            {c.emotion ? ` · ${c.emotion}` : ''}
            {c.physical ? ` · ${c.physical}` : ''}
            {c.entry !== 'none' ? ` · enters ${c.entry}` : ''}
            {c.exit !== 'none' ? ` · exits ${c.exit}` : ''}
          </span>
        </p>
      ))}
      {props.map(([id, pr]) => (
        <p key={id} className={cx(!pr.present && 'text-faint')}>
          <span className="text-fg">{names.props[id] ?? id}</span>
          <span className="text-dim">
            {' '}
            · {pr.holderId ? `${names.characters[pr.holderId] ?? 'someone'}${pr.hand ? ` (${pr.hand} hand)` : ''}` : pr.location || 'set down'} · {pr.status}
            {pr.condition ? ` · ${pr.condition}` : ''}
          </span>
        </p>
      ))}
      <p className="text-dim">
        {[state.environment.timeOfDay, state.environment.weather, state.environment.lightDirection && `light ${state.environment.lightDirection}`].filter(Boolean).join(' · ') || 'Environment not set'}
        {state.camera.side ? ` · camera ${state.camera.side} of the line` : ''}
      </p>
      <DirectionArrows travel={state.camera.travel} names={names.characters} />
    </div>
  );
}

function Constraints({ items, title }: { items: ContinuityConstraint[]; title: string }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="eyebrow mb-1">{title}</p>
      <ul className="space-y-0.5 text-xs text-dim">
        {items.slice(0, 40).map((c) => (
          <li key={c.id}>
            <Badge tone={c.level === 'locked' ? 'success' : c.level === 'preferred' ? 'accent' : 'neutral'} className="mr-1">
              {CONSTRAINT_LEVEL_LABELS[c.level]}
            </Badge>
            {c.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-shot panel
// ---------------------------------------------------------------------------

/**
 * The shot's continuity lifecycle: continuityBefore → plannedState → continuityAfter → approvedState,
 * with warnings, protected constraints and preferences, and a plan check that shows exactly what
 * direction and references the next generation will carry.
 */
export function ShotContinuityPanel({ projectId, shot, shots, names }: { projectId: string; shot: WithId<ShotDoc>; shots: WithId<ShotDoc>[]; names: { characters: Record<string, string>; props: Record<string, string> } }) {
  const snap = useProjectDoc<Snapshot>(projectId, 'continuitySnapshots', shot.id);
  const [check, setCheck] = useState<ContinuityCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useState(false);
  const title = (id: string | null) => (id ? shots.find((s) => s.id === id)?.title ?? null : null);
  const run = async () => {
    setBusy(true);
    try {
      setCheck(await checkContinuity(projectId, shot.id, true));
    } catch (e) {
      toast.error('Continuity check failed', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const s = snap.data;
  const warnings = s?.continuityWarnings ?? check?.warnings ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ContinuityBadge status={shot.continuityStatus?.status ?? s?.status ?? null} openWarnings={shot.continuityStatus?.openWarnings} />
        <Button size="sm" variant="subtle" loading={busy} onClick={() => void run()} icon={<RefreshCw className="size-3.5" />}>
          Check continuity
        </Button>
        {s?.approvedAt && <span className="text-[11px] text-faint">Canonical since {new Date(s.approvedAt).toLocaleString()}</span>}
      </div>
      {snap.loading ? (
        <Skeleton className="h-24" />
      ) : !s && !check ? (
        <p className="text-xs text-faint">No continuity plan yet. Check continuity to plan this shot from the approved bibles, the blocking and the previous approved shot — it runs automatically when the shot is produced.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Card className="space-y-1 p-3">
            <p className="eyebrow">Before this shot</p>
            <StateSummary state={s?.continuityBefore ?? check?.before ?? null} names={names} />
          </Card>
          <Card className="space-y-1 p-3">
            <p className="eyebrow">Planned</p>
            <StateSummary state={s?.plannedState ?? check?.planned ?? null} names={names} />
          </Card>
          <Card className="space-y-1 p-3">
            <p className="eyebrow">Detected in the latest take</p>
            <StateSummary state={s?.continuityAfter ?? null} names={names} />
          </Card>
          <Card className={cx('space-y-1 p-3', s?.approvedState && 'border-success/30')}>
            <p className="eyebrow flex items-center gap-1">
              <ShieldCheck className="size-3.5" /> Approved (canonical)
            </p>
            {s?.approvedState ? <StateSummary state={s.approvedState} names={names} /> : <p className="text-xs text-faint">Updated only when a take of this shot is approved.</p>}
          </Card>
        </div>
      )}
      {warnings.length > 0 && (
        <div>
          <p className="eyebrow mb-1.5 flex items-center gap-1.5">
            <TriangleAlert className="size-3.5" /> Continuity warnings
          </p>
          <ul className="space-y-1.5">
            {warnings.map((w) => (
              <WarningItem key={w.id} projectId={projectId} shotId={shot.id} warning={w} shotTitle={title} />
            ))}
          </ul>
        </div>
      )}
      {(s || check) && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Constraints title="Protected constraints" items={s?.protectedConstraints ?? check?.protectedConstraints ?? []} />
          <Constraints title="Optional preferences" items={s?.optionalPreferences ?? check?.optionalPreferences ?? []} />
        </div>
      )}
      {check && (
        <Card className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="eyebrow flex items-center gap-1">
              <Hammer className="size-3.5" /> What the next generation carries
            </p>
            {check.setView && <Badge>set view: {check.setView}</Badge>}
            <Badge tone="accent">{check.added.length} reference{check.added.length === 1 ? '' : 's'} added</Badge>
            {check.dropped.length > 0 && <Badge tone="warning">{check.dropped.length} left out (image limit)</Badge>}
          </div>
          {check.added.length > 0 && (
            <ul className="text-xs text-dim">
              {check.added.map((a) => (
                <li key={a.assetId}>
                  + {a.role.replace('_', ' ')} — {a.why}
                </li>
              ))}
              {check.dropped.map((d) => (
                <li key={d.assetId} className="text-warning">
                  − {d.why}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="cursor-pointer text-xs text-accent-2 hover:underline" onClick={() => setShowText((v) => !v)}>
            {showText ? 'Hide' : 'Show'} the structured continuity direction
          </button>
          {showText && <pre className="max-h-72 overflow-auto rounded-lg bg-black/30 p-2 text-[11px] whitespace-pre-wrap text-dim">{check.text || '(no continuity direction — nothing approved to inherit yet)'}</pre>}
        </Card>
      )}
    </div>
  );
}

/** Modal wrapper used from badges (click a warning to see the detail). */
export function ContinuityModal({ projectId, shot, shots, names, onClose }: { projectId: string; shot: WithId<ShotDoc>; shots: WithId<ShotDoc>[]; names: { characters: Record<string, string>; props: Record<string, string> }; onClose: () => void }) {
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="xl" title={`Continuity · ${shot.title}`} description="Only an approved take updates the canonical state; failed or rejected generations never change it.">
      <ShotContinuityPanel projectId={projectId} shot={shot} shots={shots} names={names} />
      {shot.continuityStatus?.status === 'failed' && (
        <Notice tone="danger" className="mt-3" icon={<CircleX className="size-4" />}>
          The latest inspection found continuity breaks. Open the AI Director Review to repair them — repairs are re-inspected before approval.
        </Notice>
      )}
    </Modal>
  );
}
