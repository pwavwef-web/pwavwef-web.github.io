import { useState } from 'react';
import { toast } from 'sonner';
import { Eye, RefreshCw } from 'lucide-react';
import { wordCount, wordBudget, type AdDirection } from '@az-studio/shared';
import { linkAdCall, newRequestId } from '../../lib/linkad';
import { Badge, Button, cx, Modal, Notice } from '../../components/ui';
import { EstimateBlock, type EstimateReply, Panel, StoryboardPreview, Thumb, useEstimate } from './common';
import type { StepProps } from './LinkAdWorkspace';

const KIND: Record<AdDirection['kind'], string> = { experience: 'Experience or outcome', showcase: 'Product or service showcase', problem_solution: 'Problem and solution', other: 'Another angle' };

function DirectionCard({ d, p, onPreview }: { d: AdDirection; p: StepProps; onPreview: () => void }) {
  const { editor, project, act } = p;
  const doc = editor.server;
  const words = d.scenes.reduce((n, s) => n + wordCount(s.narration), 0);
  const budget = wordBudget(doc.brief.durationSec, d.scenes.length);
  const choose = () =>
    act('Could not use this direction', async () => {
      await linkAdCall({ op: 'selectDirection', projectId: project.id, directionId: d.id });
      p.go('edit');
    });
  const chosen = doc.ad.directionId === d.id;
  return (
    <article className={cx('card flex flex-col gap-3 p-4', chosen && 'border-accent/60')}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{KIND[d.kind]}</Badge>
        {d.origin === 'fixture' && <Badge tone="violet">Fixture</Badge>}
        {chosen && <Badge tone="success">In use</Badge>}
      </div>
      <h3 className="display text-2xl text-fg">{d.title}</h3>
      {d.summary && <p className="text-sm text-dim">{d.summary}</p>}
      <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-sm text-fg">
        <span className="text-[11px] tracking-wide text-faint uppercase">Hook · </span>“{d.hook}”
      </p>
      <ol className="space-y-2">
        {d.scenes.map((s, i) => {
          const ref = s.assetId ? doc.source.assets.find((a) => a.id === s.assetId) : undefined;
          return (
            <li key={s.id} className="flex gap-2.5">
              <div className="h-14 w-10 shrink-0 overflow-hidden rounded-md border border-line" style={{ background: doc.ad.brand.background }}>
                {ref && <Thumb asset={ref} />}
              </div>
              <div className="min-w-0 text-xs">
                <p className="text-faint">
                  {i + 1}. {s.role === 'hook' ? 'Hook' : s.role === 'cta' ? 'Call to action' : 'Scene'}
                  {s.overlay ? ` · on screen: “${s.overlay}”` : ''}
                </p>
                <p className="text-dim">{s.narration}</p>
                {s.review && <p className="text-warning">{s.review}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-faint">
        Closing: <span className="text-dim">{d.closing.headline}</span> · {d.closing.line || 'no destination'}
      </p>
      <p className="text-[11px] text-faint">
        {words} words of narration (about {Math.round(words / 2.5)} s of speech; this length fits {budget.min}–{budget.max}). {d.rationale}
      </p>
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        <Button icon={<Eye className="size-4" />} onClick={onPreview}>
          Rough preview
        </Button>
        <Button variant="primary" loading={p.busy} onClick={() => void choose()}>
          {chosen ? 'Keep editing this' : 'Use this direction'}
        </Button>
      </div>
    </article>
  );
}

export function DirectionsStep(p: StepProps) {
  const { editor, project, act, job } = p;
  const doc = editor.server;
  const [preview, setPreview] = useState<AdDirection | null>(null);
  const planning = doc.stage === 'planning';
  const est = useEstimate(planning || !doc.briefApprovedAt ? null : () => linkAdCall<EstimateReply>({ op: 'plan', projectId: project.id, requestId: 'estimate-only', estimateOnly: true }), `${doc.briefApprovedAt ?? 0}|${planning}`);

  const plan = () =>
    act('Could not plan', async () => {
      await linkAdCall({ op: 'plan', projectId: project.id, requestId: newRequestId() });
      toast.success('Planning three directions');
    });

  if (!doc.briefApprovedAt) {
    return (
      <Notice tone="accent">
        Approve the proposed ad first.{' '}
        <button type="button" className="cursor-pointer underline" onClick={() => p.go('brief')}>
          Go to the proposal
        </button>
      </Notice>
    );
  }
  return (
    <div className="space-y-6">
      <Panel
        title="Three directions"
        sub="Different ways to tell the same true story, from the facts you approved. The previews are rough: text, pictures and timing only. No video has been generated and nothing has been recorded."
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => void plan()} disabled={planning || p.busy}>
            {doc.directions.length ? 'Plan again' : 'Plan three directions'}
          </Button>
        }
      >
        {planning && (
          <Notice tone="accent">
            <span className="text-fg">{job?.stage ?? 'Planning…'}</span>
          </Notice>
        )}
        {!planning && <EstimateBlock state={est} doc={doc} />}
        {doc.lastError?.step === 'directions' && !planning && <Notice tone="warning">{doc.lastError.message}</Notice>}
        {doc.directions.length === 0 && !planning && <p className="text-sm text-faint">No directions yet.</p>}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {doc.directions.map((d) => (
            <DirectionCard key={d.id} d={d} p={p} onPreview={() => setPreview(d)} />
          ))}
        </div>
      </Panel>
      {preview && (
        <Modal open onOpenChange={(o) => !o && setPreview(null)} title={preview.title} description="A rough storyboard: the words and pictures in order, for their estimated length. There is no voice or music yet." size="md">
          <StoryboardPreview doc={doc} scenes={preview.scenes} />
        </Modal>
      )}
    </div>
  );
}
