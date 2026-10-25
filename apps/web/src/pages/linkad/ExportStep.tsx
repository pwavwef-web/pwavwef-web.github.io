import { useMemo } from 'react';
import { toast } from 'sonner';
import { CircleAlert, Download, FileJson, Film, Info } from 'lucide-react';
import { formatUsd, linkAdReadiness, linkAdStatus, relativeTime, type CostEstimate, type ExportRecord } from '@az-studio/shared';
import { linkAdCall, newRequestId } from '../../lib/linkad';
import { openDownload, useMediaUrls } from '../../lib/media';
import { Badge, Button, Notice } from '../../components/ui';
import { EstimateBlock, Panel, useEstimate } from './common';
import type { StepProps } from './LinkAdWorkspace';

const STATUS_TONE: Record<ExportRecord['status'], 'success' | 'warning' | 'danger' | 'neutral'> = { queued: 'neutral', rendering: 'warning', completed: 'success', failed: 'danger', cancelled: 'neutral' };

function ExportCard({ e, stale }: { e: ExportRecord; stale: boolean }) {
  const urls = useMediaUrls(e.status === 'completed' ? e.outputAssetId : null);
  return (
    <li className="grid grid-cols-1 gap-4 rounded-2xl border border-line p-4 md:grid-cols-[180px_1fr]">
      <div className="mx-auto aspect-[9/16] w-full max-w-[180px] overflow-hidden rounded-xl bg-black">
        {urls?.file ? <video src={urls.file} poster={urls.poster} controls playsInline preload="metadata" className="size-full object-contain" aria-label={`${e.quality} export`} /> : <div className="grid size-full place-items-center p-3 text-center text-xs text-faint">{e.status === 'completed' ? 'Loading…' : e.status === 'failed' ? 'No video' : 'Rendering…'}</div>}
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[e.status]}>{e.status === 'completed' ? 'Finished' : e.status === 'rendering' ? 'Rendering' : e.status === 'queued' ? 'Waiting to render' : e.status === 'failed' ? 'Failed' : 'Stopped'}</Badge>
          <Badge tone="accent">{e.quality === 'final' ? 'Final 1080 × 1920' : 'Draft preview 720 × 1280'}</Badge>
          {stale && <Badge tone="warning">Out of date — the ad changed since</Badge>}
          <span className="text-[11px] text-faint">{relativeTime(e.at)}</span>
        </div>
        {e.error && <Notice tone="danger">{e.error}</Notice>}
        {e.checks && (
          <div className="space-y-1">
            <p className="text-xs text-dim">
              Checked on the file: {e.checks.width}×{e.checks.height} · {e.checks.measuredSec?.toFixed(2)} s (planned {e.checks.expectedSec.toFixed(2)} s) · {e.checks.videoCodec ?? 'no picture'} / {e.checks.audioCodec ?? 'no sound'}
            </p>
            {e.checks.ok ? <Badge tone="success">Duration, picture, sound and codecs all match</Badge> : e.checks.notes.map((n, i) => <p key={i} className="text-xs text-danger">{n}</p>)}
          </div>
        )}
        {e.status === 'completed' && e.outputAssetId && (
          <Button icon={<Download className="size-4" />} onClick={() => void openDownload(e.outputAssetId!)} disabled={Boolean(urls?.blocked)}>
            Download MP4
          </Button>
        )}
      </div>
    </li>
  );
}

export function ExportStep(p: StepProps) {
  const { editor, project, act } = p;
  const doc = editor.server;
  const status = useMemo(() => linkAdStatus(doc), [doc]);
  const finalIssues = useMemo(() => linkAdReadiness(doc, { final: true }), [doc]);
  const errors = finalIssues.filter((i) => i.severity === 'error');
  const warnings = finalIssues.filter((i) => i.severity === 'warning');
  const exporting = doc.stage === 'composing' || doc.exports.some((e) => e.status === 'queued' || e.status === 'rendering');
  const key = `${status.compositionHash}|${errors.length}`;
  const finalEst = useEstimate(errors.length ? null : () => linkAdCall<{ estimate: CostEstimate; durationSec: number }>({ op: 'export', projectId: project.id, requestId: 'estimate-only', quality: 'final', estimateOnly: true }), `f|${key}`);

  const start = (quality: 'draft' | 'final') =>
    act('Could not start the export', async () => {
      const e = await linkAdCall<{ estimate: CostEstimate }>({ op: 'export', projectId: project.id, requestId: 'estimate-only', quality, estimateOnly: true });
      const r = await linkAdCall<{ started: boolean }>({ op: 'export', projectId: project.id, requestId: newRequestId(), quality, confirmedUsd: e.estimate.usd });
      toast.success(r.started ? (quality === 'final' ? 'Final export started' : 'Draft preview started') : 'This exact version is already rendering', { description: 'It renders on the studio’s FFmpeg renderer from the saved timeline.' });
    });

  const download = () => {
    const name = `${project.title.replace(/[^\p{L}\p{N}\- _]+/gu, '').trim() || 'link-to-ad'}.link-to-ad.json`;
    const blob = new Blob([JSON.stringify({ format: 'az-studio-link-to-ad', version: 1, title: project.title, savedAt: new Date().toISOString(), note: 'Facts are kept apart from the planner’s suggestions. Media is referenced by library id; it is not inside this file.', ad: { ...doc, voiceInFlight: {}, activeJobId: null } }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const total = doc.spend.ledger.reduce((s, e) => s + (e.actualUsd ?? e.estimateUsd), 0);
  const actual = doc.spend.ledger.reduce((s, e) => s + (e.actualUsd ?? 0), 0);

  return (
    <div className="space-y-6">
      <Panel title="Export" sub="A real MP4, 1080 × 1920 with sound and captions, made by the studio's renderer from the saved timeline.">
        {errors.length > 0 ? (
          <div className="space-y-2">
            <Notice tone="danger">{errors.length} thing{errors.length === 1 ? '' : 's'} must be fixed before the final export.</Notice>
            <ul className="space-y-1.5">
              {errors.map((i, k) => (
                <li key={k} className="flex gap-2 text-sm text-dim">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                  <span>
                    {i.message}{' '}
                    <button type="button" className="cursor-pointer text-accent-2 underline" onClick={() => p.go(i.area === 'brief' || i.area === 'rights' ? 'source' : 'edit')}>
                      Fix
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Notice tone="success">Nothing blocks the final export.</Notice>
        )}
        {warnings.length > 0 && (
          <ul className="space-y-1">
            {warnings.slice(0, 8).map((i, k) => (
              <li key={k} className="flex gap-2 text-xs text-warning">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {i.message}
              </li>
            ))}
          </ul>
        )}
        {!errors.length && <EstimateBlock state={finalEst} doc={doc} />}
        <p className="text-xs text-dim">
          The video will run <strong className="text-fg">{status.totalSec.toFixed(1)} s</strong>.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button size="lg" icon={<Film className="size-4" />} loading={p.busy} disabled={exporting || (!status.voiceComplete)} onClick={() => void start('draft')}>
            Quick preview (draft)
          </Button>
          <Button variant="primary" size="lg" icon={<Film className="size-4" />} loading={p.busy} disabled={exporting || errors.length > 0} onClick={() => void start('final')}>
            Export final MP4
          </Button>
        </div>
        {exporting && <Notice tone="accent">Rendering — the status below updates by itself. You can leave this page.</Notice>}
      </Panel>

      {doc.exports.length > 0 && (
        <Panel title="Your exports" sub="Every export is kept so you can compare. An export is marked out of date when the ad changes after it.">
          <ul className="space-y-3">
            {doc.exports.map((e) => (
              <ExportCard key={e.renderId} e={e} stale={e.timelineHash !== status.compositionHash} />
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Save the project" sub="The ad is saved as you edit and reopens exactly as you left it. You can also keep a copy of it as a file, or duplicate it from the top of the page.">
        <Button icon={<FileJson className="size-4" />} onClick={download}>
          Download the project file (.json)
        </Button>
      </Panel>

      <Panel title="What this ad has cost" sub="Estimates are made before each step; actual usage is the provider's own token count at published list prices. Rendering is Cloud Run compute and is billed separately by Google Cloud.">
        <p className="text-sm text-dim">
          Estimated {formatUsd(doc.spend.ledger.reduce((s, e) => s + e.estimateUsd, 0), { precise: true })} · reported so far {formatUsd(actual, { precise: true })} · counted against the cap {formatUsd(total, { precise: true })} of {formatUsd(doc.spend.capUsd)}
        </p>
        {doc.spend.ledger.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-faint">
                <tr>
                  <th className="py-1 pr-3 font-medium">When</th>
                  <th className="py-1 pr-3 font-medium">Step</th>
                  <th className="py-1 pr-3 font-medium">What</th>
                  <th className="py-1 pr-3 text-right font-medium">Estimate</th>
                  <th className="py-1 text-right font-medium">Reported</th>
                </tr>
              </thead>
              <tbody className="text-dim">
                {[...doc.spend.ledger].reverse().slice(0, 30).map((e, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="py-1 pr-3">{relativeTime(e.at)}</td>
                    <td className="py-1 pr-3">{e.step}</td>
                    <td className="py-1 pr-3">
                      {e.kind}
                      {e.units ? ` · ${e.units}` : ''}
                      {e.basis === 'fixture' ? ' · fixture' : ''}
                    </td>
                    <td className="py-1 pr-3 text-right">{formatUsd(e.estimateUsd, { precise: true })}</td>
                    <td className="py-1 text-right">{e.actualUsd === null ? 'not yet' : formatUsd(e.actualUsd, { precise: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
