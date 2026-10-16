import { useState } from 'react';
import { toast } from 'sonner';
import { Check } from 'lucide-react';
import { formatUsd, MV_STAGE_LABELS, MV_STAGES, type LiteAspect, type MvLiteSpec, type MvSong, type MvStage, type ProjectDoc, type SongDoc } from '@az-studio/shared';
import type { WithId } from '../../lib/data';
import { errorMessage } from '../../lib/api';
import { mvliteGenerate, type Job, type LiteGenerateResponse, type useMvComposition } from '../../lib/mvlite';
import { useSession } from '../../lib/session';
import { cx } from '../../components/ui';
import { WorkDialog } from '../lite/common';

export { DraftBadge, fmtSec, LabeledSlider, Section } from '../lite/common';

export interface MvFocus {
  sectionId: string | null;
  shotId: string | null;
}

export interface MvStageProps {
  project: WithId<ProjectDoc>;
  spec: MvLiteSpec;
  update: (patch: Partial<MvLiteSpec> | ((s: MvLiteSpec) => MvLiteSpec), label?: string) => void;
  flush: () => Promise<void>;
  jobs: Job[];
  /** The song document (live) and its derived view. */
  songDoc: WithId<SongDoc> | null;
  song: MvSong | null;
  comp: ReturnType<typeof useMvComposition>;
  aspect: LiteAspect;
  setAspect: (a: LiteAspect) => void;
  go: (stage: MvStage, focus?: Partial<MvFocus>) => void;
  focus: MvFocus;
  setFocus: (f: Partial<MvFocus>) => void;
  work: ReturnType<typeof useMvWork>;
}

export const SECTION_COLORS: Record<string, string> = {
  intro: 'rgba(120,140,180,0.16)',
  verse: 'rgba(76,141,255,0.14)',
  'pre-chorus': 'rgba(155,140,255,0.16)',
  chorus: 'rgba(244,184,74,0.16)',
  'post-chorus': 'rgba(244,184,74,0.1)',
  bridge: 'rgba(62,214,144,0.14)',
  breakdown: 'rgba(255,107,107,0.12)',
  drop: 'rgba(255,107,107,0.18)',
  instrumental: 'rgba(138,182,255,0.1)',
  hook: 'rgba(244,184,74,0.2)',
  outro: 'rgba(120,140,180,0.16)',
  other: 'rgba(255,255,255,0.06)',
};

/** Solid lane colours per section label (timeline and storyboard). */
export const SECTION_LANE: Record<string, string> = {
  intro: '#5b6f94',
  verse: '#4c8dff',
  'pre-chorus': '#9b8cff',
  chorus: '#d79a2b',
  'post-chorus': '#b98a3a',
  bridge: '#2fae73',
  breakdown: '#d65a5a',
  drop: '#e0605f',
  instrumental: '#6f8fc4',
  hook: '#e3a93a',
  outro: '#5b6f94',
  other: '#6a7280',
};

export function MvStepper({ current, onChange, attention, done }: { current: MvStage; onChange: (s: MvStage) => void; attention: Set<MvStage>; done: Set<MvStage> }) {
  return (
    <nav aria-label="Music video workflow" className="scroll-x">
      <ol className="flex min-w-max items-center gap-1.5">
        {MV_STAGES.map((s, i) => {
          const active = s === current;
          const ok = done.has(s) && !attention.has(s);
          return (
            <li key={s} className="flex items-center gap-1.5">
              <button type="button" aria-current={active ? 'step' : undefined} onClick={() => onChange(s)} className={cx('inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors', active ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim hover:text-fg')}>
                <span className={cx('grid size-5 place-items-center rounded-full text-[10px]', ok ? 'bg-success/20 text-success' : active ? 'bg-accent text-white' : 'bg-white/10 text-dim')}>{ok ? <Check className="size-3" /> : i + 1}</span>
                {MV_STAGE_LABELS[s]}
                {attention.has(s) && <span className="size-1.5 rounded-full bg-warning" aria-label="needs attention" />}
              </button>
              {i < MV_STAGES.length - 1 && <span className="h-px w-4 bg-line-strong" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

interface Pending {
  opts: { targetIds?: string[]; force?: boolean };
  estimate: LiteGenerateResponse;
  resolve: (ok: boolean) => void;
}

/**
 * Paid images for the video go through one path: the server works out what is still needed (reusing
 * finished results), prices it, and nothing starts until it is reviewed here.
 */
export function useMvWork(projectId: string, flush: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirming, setConfirming] = useState(false);
  const refresh = useSession((s) => s.refresh);

  const run = async (opts: { targetIds?: string[]; force?: boolean } = {}): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      await flush();
      const est = await mvliteGenerate(projectId, { ...opts, estimateOnly: true });
      if (!est.perTarget.length) {
        toast.message(est.message ?? 'Nothing new to request.', { description: est.skipped.slice(0, 3).map((s) => s.reason).join(' · ') || undefined });
        return false;
      }
      if (est.limitProblem) throw new Error(est.limitProblem);
      return await new Promise<boolean>((resolve) => setPending({ opts, estimate: est, resolve }));
    } catch (e) {
      toast.error('Could not prepare the images', { description: errorMessage(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setConfirming(true);
    try {
      const res = await mvliteGenerate(projectId, { ...pending.opts, confirmedUsd: pending.estimate.estimate?.usd ?? 0 });
      toast.success(res.jobIds.length ? `${res.jobIds.length} image${res.jobIds.length === 1 ? '' : 's'} queued` : res.message ?? 'Nothing new to request', res.estimate ? { description: `Estimated ${formatUsd(res.estimate.usd)}` } : undefined);
      pending.resolve(true);
      setPending(null);
      void refresh();
    } catch (e) {
      toast.error('Could not start', { description: errorMessage(e) });
    } finally {
      setConfirming(false);
    }
  };

  const dialog = pending ? (
    <WorkDialog
      estimate={pending.estimate}
      kind="images"
      loading={confirming}
      onCancel={() => {
        pending.resolve(false);
        setPending(null);
      }}
      onConfirm={() => void confirm()}
    />
  ) : null;
  return { run, busy, dialog };
}
