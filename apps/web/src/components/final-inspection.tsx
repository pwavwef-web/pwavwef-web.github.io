import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { toast } from 'sonner';
import { CircleCheck, Download, History, RefreshCw, ShieldAlert, ShieldCheck, ShieldX, Undo2, Wand2 } from 'lucide-react';
import {
  EXPORT_PRESETS,
  FINAL_CHECK_LABELS,
  formatTimecode,
  relativeTime,
  toMillis,
  type ExportPreset,
  type FinalFinding,
  type FinalInspectionDoc,
  type ProjectDoc,
  type RenderDoc,
} from '@az-studio/shared';
import { errorMessage } from '../lib/api';
import { finalInspectionAction, useProjectDoc } from '../lib/continuity';
import { useQuery, type WithId } from '../lib/data';
import { db } from '../lib/firebase';
import { openDownload, useMediaUrls } from '../lib/media';
import { useUid } from '../lib/session';
import { useJobSubmitter } from './jobs';
import { Badge, Button, Card, cx, EmptyState, Input, Notice, Select, Skeleton } from './ui';

type Render = WithId<RenderDoc>;

/** Export readiness of a render: inspecting, ready, overridden or blocked (with the error count). */
export function ReadinessBadge({ render, className }: { render: Pick<RenderDoc, 'finalInspection' | 'inspect' | 'quality' | 'status'>; className?: string }) {
  const fi = render.finalInspection;
  const inspected = render.inspect || render.quality === 'final';
  if (!inspected || render.status !== 'completed') return null;
  if (!fi || fi.status === 'queued' || fi.status === 'running') return <Badge tone="accent" className={className}>Inspecting…</Badge>;
  if (fi.status === 'failed') return <Badge tone="danger" icon={<ShieldX className="size-3" />} className={className}>Inspection failed</Badge>;
  if (fi.readiness === 'ready') return <Badge tone="success" icon={<ShieldCheck className="size-3" />} className={className}>Ready to export</Badge>;
  if (fi.readiness === 'overridden') return <Badge tone="warning" icon={<ShieldAlert className="size-3" />} className={className}>Export by override</Badge>;
  return <Badge tone="danger" icon={<ShieldX className="size-3" />} className={className}>Export blocked · {fi.errors} error{fi.errors === 1 ? '' : 's'}</Badge>;
}

const SEVERITY_TONE = { error: 'danger', warning: 'warning', info: 'neutral' } as const;

function findingState(f: FinalFinding): { label: string; tone: 'neutral' | 'success' | 'warning' | 'accent' } {
  if (f.overridden) return { label: 'accepted', tone: 'warning' };
  if (f.resolvedAt) return { label: 'resolved', tone: 'success' };
  if (f.fixedAt) return { label: `fixed in timeline v${f.fixedInTimelineVersion ?? '?'} — re-render to verify`, tone: 'accent' };
  return { label: 'open', tone: 'neutral' };
}

function FindingRow({ projectId, inspectionId, f, onSeek }: { projectId: string; inspectionId: string; f: FinalFinding; onSeek: (t: number) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const st = findingState(f);
  const act = async (action: 'apply_fix' | 'resolve' | 'reopen') => {
    setBusy(action);
    try {
      const r = await finalInspectionAction(projectId, inspectionId, action, { findingId: f.id, note });
      if (action === 'apply_fix') toast.success('Fix applied to the timeline', { description: r.needsRerender ? 'Render again to verify it — this render still contains the problem.' : undefined });
      setNote('');
    } catch (e) {
      toast.error('Could not update the finding', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const open = !f.overridden && !f.resolvedAt;
  return (
    <li className={cx('rounded-lg border px-3 py-2 text-sm', !open ? 'border-line opacity-75' : f.severity === 'error' ? 'border-danger/35 bg-danger/[0.05]' : f.severity === 'warning' ? 'border-warning/30' : 'border-line')}>
      <div className="flex flex-wrap items-start gap-2">
        <Badge tone={SEVERITY_TONE[f.severity]}>{FINAL_CHECK_LABELS[f.check] ?? f.check}</Badge>
        <span className="min-w-0 flex-1 text-fg">{f.message}</span>
        {f.startSec !== null && (
          <button type="button" className="timecode shrink-0 cursor-pointer text-xs text-accent-2 hover:underline" onClick={() => onSeek(f.startSec!)}>
            {formatTimecode(f.startSec)}
            {f.endSec !== null && f.endSec > f.startSec ? `–${formatTimecode(f.endSec)}` : ''}
          </button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-faint">{f.source}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        {f.overridden?.note && <span className="text-faint">“{f.overridden.note}”</span>}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {open && f.fix && !f.fixedAt && (
            <Button size="sm" variant="subtle" loading={busy === 'apply_fix'} icon={<Wand2 className="size-3.5" />} onClick={() => void act('apply_fix')}>
              {f.fix.label}
            </Button>
          )}
          {open ? (
            <>
              <Input className="h-8 w-48 text-xs" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it is acceptable (optional)" aria-label="Acceptance note" />
              <Button size="sm" variant="ghost" loading={busy === 'resolve'} icon={<CircleCheck className="size-3.5" />} onClick={() => void act('resolve')}>
                Accept
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" loading={busy === 'reopen'} icon={<Undo2 className="size-3.5" />} onClick={() => void act('reopen')}>
              Reopen
            </Button>
          )}
        </span>
      </div>
      {f.manual && open && !f.fix && <p className="mt-1 text-[11px] text-faint">Needs the director: fix it in the editor or the shot, then render again.</p>}
    </li>
  );
}

function Inspection({ project, render }: { project: WithId<ProjectDoc>; render: Render }) {
  const insp = useProjectDoc<FinalInspectionDoc>(project.id, 'finalInspections', render.finalInspection?.id ?? null);
  const events = useQuery<{ at: number; action: string; note: string; readiness: string }>(() => (render.finalInspection?.id ? query(collection(db, 'projects', project.id, 'finalInspections', render.finalInspection.id, 'events'), orderBy('createdAt', 'desc'), limit(20)) : null), [project.id, render.finalInspection?.id]);
  const urls = useMediaUrls(render.outputAssetId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [overrideNote, setOverrideNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const { submit, busy: submitting, dialog } = useJobSubmitter();
  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, t - 0.5);
    void v.play();
  };
  const act = async (action: 'apply_all_fixes' | 'override' | 'clear_override') => {
    if (!insp.data) return;
    setBusy(action);
    try {
      const r = await finalInspectionAction(project.id, insp.data.id, action, action === 'override' ? { note: overrideNote } : {});
      if (action === 'apply_all_fixes') toast.success(`${r.applied.length} fix${r.applied.length === 1 ? '' : 'es'} applied to the timeline`, { description: 'Render again to verify them.' });
      if (action === 'override') toast.success('Override recorded', { description: 'The note is kept with the export.' });
      setOverrideNote('');
    } catch (e) {
      toast.error('Could not update the inspection', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const rerender = async () => {
    await submit([{ type: 'render.timeline', projectId: project.id, timelineId: render.timelineId, preset: render.preset as ExportPreset['id'], quality: render.quality, inspect: true, acceptLyricSync: false }], { label: `Re-render · ${EXPORT_PRESETS[render.preset as ExportPreset['id']]?.label ?? render.preset}`, alwaysConfirm: true });
  };
  const reinspect = async () => {
    await submit([{ type: 'final.inspect', projectId: project.id, renderId: render.id, label: 'Final inspection' }], { label: 'Final inspection', alwaysConfirm: true });
  };
  if (!render.finalInspection) {
    return (
      <Card className="space-y-3 p-4">
        <p className="text-sm text-dim">This render has not been inspected. Final renders are inspected automatically; drafts can be inspected on request.</p>
        <Button size="sm" variant="primary" loading={submitting} icon={<ShieldCheck className="size-4" />} onClick={() => void reinspect()}>
          Inspect this render
        </Button>
        {dialog}
      </Card>
    );
  }
  if (insp.loading) return <Skeleton className="h-80" />;
  const d = insp.data;
  const findings = d?.findings ?? [];
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity] || (a.startSec ?? 1e9) - (b.startSec ?? 1e9));
  const fixable = findings.filter((f) => f.fix && !f.fixedAt && !f.overridden && !f.resolvedAt).length;
  const m = (d?.measurements ?? {}) as { integratedLufs?: number | null; truePeakDb?: number | null; lra?: number | null; blackSegments?: unknown[]; frozen?: unknown[]; silences?: unknown[]; dialogueWords?: number; ocrFrames?: number };
  const duration = render.durationSec || 1;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card className="space-y-2 p-3">
          {urls?.file ? <video ref={videoRef} src={urls.file} poster={urls.poster} controls playsInline preload="metadata" className="aspect-video w-full rounded-lg bg-black" /> : <Skeleton className="aspect-video w-full" />}
          <div className="relative h-5 rounded bg-white/[0.04]" aria-label="Findings along the film">
            {findings.filter((f) => f.startSec !== null).map((f) => (
              <button
                key={f.id}
                type="button"
                title={`${FINAL_CHECK_LABELS[f.check]} · ${formatTimecode(f.startSec!)}`}
                onClick={() => seek(f.startSec!)}
                className={cx('absolute top-0 h-5 min-w-1 cursor-pointer rounded-sm', f.overridden || f.resolvedAt ? 'bg-white/20' : f.severity === 'error' ? 'bg-danger' : f.severity === 'warning' ? 'bg-warning' : 'bg-accent-2/60')}
                style={{ left: `${(Math.min(duration, f.startSec!) / duration) * 100}%`, width: `${Math.max(0.4, (((f.endSec ?? f.startSec!) - f.startSec!) / duration) * 100)}%` }}
              />
            ))}
          </div>
        </Card>
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ReadinessBadge render={render} />
            {d?.score !== null && d?.score !== undefined && <Badge tone={d.score >= 85 ? 'success' : d.score >= 60 ? 'warning' : 'danger'}>Score {d.score}</Badge>}
            {d && (
              <span className="text-xs text-faint">
                {d.errors} error{d.errors === 1 ? '' : 's'} · {d.warnings} warning{d.warnings === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {d?.status === 'running' && <Notice>Inspecting the render: measuring black and frozen frames, loudness and peaks, silences, transcribing dialogue, reading on-screen text and reviewing the cut.</Notice>}
          {d?.status === 'failed' && (
            <Notice tone="danger">
              The inspection could not finish{render.finalInspection.error ? `: ${render.finalInspection.error}` : '.'}{' '}
              <Button size="sm" variant="ghost" loading={submitting} onClick={() => void reinspect()}>
                Inspect again
              </Button>
            </Notice>
          )}
          {d?.summary && <p className="text-sm text-dim">{d.summary}</p>}
          {d?.needsRerender && (
            <Notice tone="accent" icon={<RefreshCw className="size-4" />}>
              Fixes were applied to the timeline after this render. Render again — the new render is inspected automatically to verify them.
              <span className="mt-2 block">
                <Button size="sm" variant="primary" loading={submitting} onClick={() => void rerender()}>
                  Render and inspect again
                </Button>
              </span>
            </Notice>
          )}
          {d?.status === 'completed' && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-faint">Loudness</dt>
              <dd className="text-fg">{m.integratedLufs !== null && m.integratedLufs !== undefined ? `${m.integratedLufs.toFixed(1)} LUFS` : '—'}</dd>
              <dt className="text-faint">True peak</dt>
              <dd className="text-fg">{m.truePeakDb !== null && m.truePeakDb !== undefined ? `${m.truePeakDb.toFixed(1)} dBTP` : '—'}</dd>
              <dt className="text-faint">Black / frozen spans</dt>
              <dd className="text-fg">
                {m.blackSegments?.length ?? 0} / {m.frozen?.length ?? 0}
              </dd>
              <dt className="text-faint">Silences · words heard · frames read</dt>
              <dd className="text-fg">
                {m.silences?.length ?? 0} · {m.dialogueWords ?? 0} · {m.ocrFrames ?? 0}
              </dd>
            </dl>
          )}
          {d?.status === 'completed' && (
            <div className="space-y-2 border-t border-line pt-3">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="subtle" disabled={!fixable} loading={busy === 'apply_all_fixes'} icon={<Wand2 className="size-3.5" />} onClick={() => void act('apply_all_fixes')}>
                  Apply {fixable} automatic fix{fixable === 1 ? '' : 'es'}
                </Button>
                <Button size="sm" variant="secondary" icon={<Download className="size-3.5" />} disabled={!render.outputAssetId} onClick={() => render.outputAssetId && void openDownload(render.outputAssetId)}>
                  Export MP4
                </Button>
              </div>
              {d.override ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="warning">Overridden {relativeTime(d.override.at)}</Badge>
                  <span className="text-dim">“{d.override.note}”</span>
                  <Button size="sm" variant="ghost" loading={busy === 'clear_override'} onClick={() => void act('clear_override')}>
                    Withdraw override
                  </Button>
                </div>
              ) : (
                d.readiness === 'blocked' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input className="h-8 min-w-56 flex-1 text-xs" value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} placeholder="Why this film may be exported with open errors (recorded)" aria-label="Override note" />
                    <Button size="sm" variant="danger" disabled={!overrideNote.trim()} loading={busy === 'override'} icon={<ShieldAlert className="size-3.5" />} onClick={() => void act('override')}>
                      Override and allow export
                    </Button>
                  </div>
                )
              )}
            </div>
          )}
        </Card>
      </div>
      {d?.status === 'completed' && (
        <Card className="space-y-2 p-4">
          <p className="eyebrow">Findings ({findings.length})</p>
          {sorted.length === 0 ? (
            <p className="text-sm text-success">No problems found — the film is ready to export.</p>
          ) : (
            <ul className="space-y-1.5">
              {sorted.map((f) => (
                <FindingRow key={f.id} projectId={project.id} inspectionId={d.id} f={f} onSeek={seek} />
              ))}
            </ul>
          )}
        </Card>
      )}
      {events.data.length > 0 && (
        <Card className="space-y-1.5 p-4">
          <p className="eyebrow flex items-center gap-1.5">
            <History className="size-3.5" /> Decisions
          </p>
          <ul className="space-y-0.5 text-xs text-dim">
            {events.data.map((e) => (
              <li key={e.id}>
                {relativeTime(e.at)} · {e.action.replace(/_/g, ' ')}
                {e.note ? ` — “${e.note}”` : ''} · {e.readiness}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {dialog}
    </div>
  );
}

/**
 * Final inspection: every inspected render with its export readiness, the findings measured on the real
 * film (black and frozen frames, peaks and loudness, silences, music restarts, drowned dialogue, lyric and
 * credit problems, cropped text, aspect and resolution, private information, continuity between shots),
 * automatic fixes applied to the timeline and verified by the next render, and a recorded override.
 */
export function FinalInspectionWorkspace({ project }: { project: WithId<ProjectDoc> }) {
  const uid = useUid();
  const renders = useQuery<RenderDoc>(() => (uid ? query(collection(db, 'renders'), where('ownerUid', '==', uid), where('projectId', '==', project.id), orderBy('createdAt', 'desc'), limit(30)) : null), [uid, project.id]);
  const done = useMemo(() => renders.data.filter((r) => r.status === 'completed'), [renders.data]);
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!id && done.length) setId((done.find((r) => r.finalInspection) ?? done[0]!).id);
  }, [id, done]);
  const render = done.find((r) => r.id === id) ?? null;
  if (renders.loading) return <Skeleton className="h-96" />;
  if (!done.length) return <EmptyState icon={<ShieldCheck className="size-5" />} title="No finished renders yet" body="Render the timeline at Final quality: the film is inspected automatically and export stays blocked until it passes or you override it." />;
  return (
    <div className="space-y-4">
      <Select className="h-9 max-w-xl" value={id ?? ''} onChange={(e) => setId(e.target.value)} aria-label="Render">
        {done.map((r) => (
          <option key={r.id} value={r.id}>
            {EXPORT_PRESETS[r.preset as ExportPreset['id']]?.label ?? r.preset} · {r.quality} · {relativeTime(toMillis(r.createdAt))}
            {r.finalInspection ? ` · ${r.finalInspection.status === 'completed' ? r.finalInspection.readiness : r.finalInspection.status}` : ' · not inspected'}
          </option>
        ))}
      </Select>
      {render && <Inspection key={render.id} project={project} render={render} />}
    </div>
  );
}
