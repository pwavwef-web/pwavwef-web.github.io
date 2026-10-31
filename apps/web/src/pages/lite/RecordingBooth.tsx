import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ArrowLeft, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Mic, Square, Trash2, TriangleAlert, Wand2 } from 'lucide-react';
import { BOOTH_LIMITS, boothJoinPlan, formatUsd, mapScene, takeMatchesLine, type BoothJoined, type BoothSceneDoc, type BoothTake, type NoiseReduction, type ProjectDoc } from '@az-studio/shared';
import type { WithId } from '../../lib/data';
import { errorMessage } from '../../lib/api';
import { booth, uploadTake, useBoothScene, useMicTake } from '../../lib/booth';
import { useLiteDraft } from '../../lib/lite';
import { useMediaUrls } from '../../lib/media';
import { useProject, useProjects } from '../../lib/studio';
import { ClipPlayer } from '../../components/narrator/audio';
import { Meter } from '../../components/narrator/Recorder';
import { Badge, Button, Card, cx, EmptyState, ErrorState, Kbd, Notice, Select, Skeleton } from '../../components/ui';
import { LabeledSlider, Section, fmtSec, useLiteWork } from './common';

const VERDICT: Record<BoothTake['check']['verdict'], { tone: 'success' | 'warning' | 'danger'; label: string }> = {
  good: { tone: 'success', label: 'Good' },
  check: { tone: 'warning', label: 'Check' },
  redo: { tone: 'danger', label: 'Record again' },
};

function TakeItem({ take, picked, n, onPick, onDelete, outdated }: { take: BoothTake; picked: boolean; n: number; onPick: () => void; onDelete: () => void; outdated: boolean }) {
  const urls = useMediaUrls(take.assetId);
  const v = VERDICT[take.check.verdict];
  const a = take.analysis;
  return (
    <li className={cx('rounded-xl border p-3', picked ? 'border-accent/60 bg-accent/[0.06]' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="timecode text-xs text-faint">Take {n}</span>
        <Badge tone={v.tone}>{v.label}</Badge>
        {outdated && <Badge tone="warning">Line changed since</Badge>}
        <span className="timecode text-[11px] text-faint">
          {a.speechSec.toFixed(1)} s speech / est. {take.check.expectedSec.toFixed(1)} s · peak {a.peakDbfs} dBFS · floor {a.noiseFloorDbfs} dBFS
        </span>
        <span className="flex-1" />
        <Button size="sm" variant={picked ? 'primary' : 'secondary'} icon={picked ? <CircleCheck className="size-3.5" /> : undefined} onClick={onPick} disabled={outdated}>
          {picked ? 'Picked' : 'Pick'}
        </Button>
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={onDelete} aria-label={`Remove take ${n}`} />
      </div>
      <ClipPlayer src={urls?.file ?? null} label={`take ${n}`} className="mt-2" />
      {take.check.issues.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs">
          {take.check.issues.map((i, k) => (
            <li key={k} className={cx('flex gap-1.5', i.severity === 'error' ? 'text-[#ff9b9b]' : 'text-warning')}>
              {i.severity === 'error' ? <CircleAlert className="mt-0.5 size-3 shrink-0" /> : <TriangleAlert className="mt-0.5 size-3 shrink-0" />}
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Booth({ project, sceneId }: { project: WithId<ProjectDoc>; sceneId: string }) {
  const navigate = useNavigate();
  const draft = useLiteDraft(project);
  const { spec, update, flush } = draft;
  const work = useLiteWork(project.id, flush);
  const scene = spec.scenes.find((s) => s.id === sceneId) ?? null;
  const live = useBoothScene(project.id, sceneId);
  const [opening, setOpening] = useState(true);
  const [openError, setOpenError] = useState<unknown>(null);
  const [at, setAt] = useState(0);
  const [uploading, setUploading] = useState(0);
  const [noise, setNoise] = useState<NoiseReduction>('off');
  const [pause, setPause] = useState<number>(BOOTH_LIMITS.pauseSec.default);
  const [joining, setJoining] = useState(false);

  // Opening the booth makes the scene's lines from its saved narration (takes of unchanged lines are kept).
  useEffect(() => {
    let cancelled = false;
    setOpening(true);
    setOpenError(null);
    void (async () => {
      try {
        await flush();
        await booth<BoothSceneDoc, 'open'>('open', { projectId: project.id, sceneId });
      } catch (e) {
        if (!cancelled) setOpenError(e);
      } finally {
        if (!cancelled) setOpening(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, sceneId, scene?.narration]);

  const doc = live.data;
  const lines = doc?.lines ?? [];
  const line = lines[Math.min(at, Math.max(0, lines.length - 1))] ?? null;
  const takes = useMemo(() => (doc?.takes ?? []).filter((t) => t.lineId === line?.id).sort((a, b) => a.createdAt - b.createdAt), [doc?.takes, line?.id]);
  const plan = useMemo(() => (doc ? boothJoinPlan(doc, { noiseReduction: noise, pauseSec: pause }) : null), [doc, noise, pause]);

  const onTake = useCallback(
    async (blob: Blob, seconds: number) => {
      if (!line) return;
      if (seconds < 0.4) return void toast.message('That take was too short to keep.');
      setUploading((n) => n + 1);
      try {
        const assetId = await uploadTake(blob, { projectId: project.id, sceneId, lineId: line.id, label: `${project.title} · ${scene?.title || 'Scene'} · line ${line.index + 1}` });
        const res = await booth<{ take: BoothTake }, 'takeAdd'>('takeAdd', { projectId: project.id, sceneId, lineId: line.id, assetId });
        const v = VERDICT[res.take.check.verdict];
        if (res.take.check.verdict === 'good') toast.success(`Line ${line.index + 1}: ${v.label.toLowerCase()} take`);
        else toast.warning(`Line ${line.index + 1}: ${v.label.toLowerCase()}`, { description: res.take.check.issues[0]?.message });
      } catch (e) {
        toast.error('The take could not be kept', { description: errorMessage(e) });
      } finally {
        setUploading((n) => n - 1);
      }
    },
    [line, project.id, project.title, scene?.title, sceneId],
  );
  const mic = useMicTake((b, s) => void onTake(b, s), BOOTH_LIMITS.takeMaxSec);
  const recording = mic.phase === 'recording';

  const go = useCallback((d: number) => setAt((i) => Math.max(0, Math.min(lines.length - 1, i + d))), [lines.length]);

  // Keyboard: Space / R record and stop, ← → or J / K move between lines, P plays the newest take.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'r') {
        e.preventDefault();
        if (recording) mic.stop();
        else if (mic.phase === 'idle' && line) void mic.start();
      } else if (!recording && (k === 'arrowright' || k === 'k')) {
        e.preventDefault();
        go(1);
      } else if (!recording && (k === 'arrowleft' || k === 'j')) {
        e.preventDefault();
        go(-1);
      } else if (k === 'p') {
        const btn = document.querySelectorAll<HTMLButtonElement>('[data-booth-takes] button[aria-label^="Play"]');
        btn[btn.length - 1]?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, line, mic, recording]);

  const pick = async (lineId: string, takeId: string | null) => {
    try {
      await booth('pick', { projectId: project.id, sceneId, lineId, takeId });
    } catch (e) {
      toast.error('Could not pick the take', { description: errorMessage(e) });
    }
  };
  const remove = async (takeId: string) => {
    try {
      await booth('takeDelete', { projectId: project.id, sceneId, takeId });
    } catch (e) {
      toast.error('Could not remove the take', { description: errorMessage(e) });
    }
  };

  /** Joins the picks, makes the result the scene's recording, then prices the timing step (nothing starts unconfirmed). */
  const joinForScene = async () => {
    if (!scene) return;
    setJoining(true);
    try {
      const res = await booth<BoothJoined & { reused: boolean }, 'useForScene'>('useForScene', { projectId: project.id, sceneId, noiseReduction: noise, pauseSec: pause });
      update((s) => mapScene(s, scene.id, (x) => ({ ...x, voiceUploadAssetId: res.assetId, voiceJobId: null })), 'booth recording');
      await flush();
      toast.success(res.reused ? 'Using the joined recording' : `Joined ${res.lines} lines · ${fmtSec(res.durationSec)}`, { description: 'Next: time it against the text (Kasem). The estimate is shown first.' });
      await work.run('narration', { targetIds: [scene.id] });
    } catch (e) {
      toast.error('Could not use the takes', { description: errorMessage(e) });
    } finally {
      setJoining(false);
    }
  };

  if (!scene) return <EmptyState title="Scene not found" body="It may have been removed from the film." action={<Button onClick={() => navigate(`/lite/booth/${project.id}`)}>Choose another scene</Button>} />;
  if (openError) return <ErrorState error={openError} title="The booth could not open this scene" />;
  if (opening && !doc) return <Skeleton className="h-96" />;
  const pickedCount = lines.filter((l) => doc?.picks[l.id]).length;
  const joinedCurrent = Boolean(doc?.joined && plan?.ready && doc.joined.picksHash === plan.picksHash && scene.voiceUploadAssetId === doc.joined.assetId);

  return (
    <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-6">
        {spec.voice.mode === 'upload_whole' && (
          <Notice tone="warning" icon={<TriangleAlert className="size-4" />}>
            This film is set to one recording of the whole narration, so per-scene booth recordings are not used.{' '}
            <button type="button" className="cursor-pointer text-accent-2 hover:underline" onClick={() => update((s) => ({ ...s, voice: { ...s.voice, mode: 'upload_scenes' } }), 'voice mode')}>
              Switch to a recording per scene
            </button>
          </Notice>
        )}
        <Card className="space-y-5 p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-faint">
            <span>
              Line <span className="timecode text-fg">{line ? line.index + 1 : 0}</span> of {lines.length} · {pickedCount} picked
            </span>
            <span className="hidden sm:inline">
              <Kbd>Space</Kbd> record / stop · <Kbd>←</Kbd> <Kbd>→</Kbd> lines · <Kbd>P</Kbd> play newest take
            </span>
          </div>
          <p className="display min-h-[7rem] text-3xl leading-snug text-fg sm:text-4xl" lang="xsm" aria-live="polite">
            {line?.text ?? 'This scene has no narration.'}
          </p>
          {line && line.notes.length > 0 && (
            <ul className="space-y-1 rounded-xl border border-line bg-white/[0.02] p-3 text-sm">
              {line.notes.map((n) => (
                <li key={n.term} className="text-dim">
                  <span className="font-medium text-fg">{n.term}</span>
                  {n.sayAs && <> — say “{n.sayAs}”</>}
                  {n.note && <span className="text-faint"> · {n.note}</span>}
                </li>
              ))}
            </ul>
          )}
          {line && <p className="text-xs text-faint">About {line.expectedSec.toFixed(1)} s at the film’s pace.</p>}
          {recording && <Meter level={mic.level} clipped={mic.clipped} />}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" icon={<ChevronLeft className="size-4" />} disabled={recording || at === 0} onClick={() => go(-1)}>
              Previous
            </Button>
            {recording ? (
              <Button variant="danger" icon={<Square className="size-4" />} onClick={mic.stop}>
                Stop · {mic.elapsed.toFixed(1)} s
              </Button>
            ) : (
              <Button variant="primary" icon={<Mic className="size-4" />} loading={mic.phase === 'requesting'} disabled={!line} onClick={() => void mic.start()}>
                Record take {takes.length + 1}
              </Button>
            )}
            <Button variant="ghost" icon={<ChevronRight className="size-4" />} disabled={recording || at >= lines.length - 1} onClick={() => go(1)}>
              Next
            </Button>
            {mic.devices.length > 1 && (
              <Select aria-label="Microphone" value={mic.deviceId} onChange={(e) => mic.setDeviceId(e.target.value)} className="w-auto max-w-56 py-1.5 text-xs">
                <option value="">Default microphone</option>
                {mic.devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Microphone'}
                  </option>
                ))}
              </Select>
            )}
            {uploading > 0 && <span className="text-xs text-dim" role="status">Checking {uploading} take{uploading === 1 ? '' : 's'}…</span>}
          </div>
          {mic.error && (
            <p className="flex items-start gap-1.5 text-[13px] text-[#ff9b9b]" role="alert">
              <CircleAlert className="mt-0.5 size-4 shrink-0" /> {mic.error}
            </p>
          )}
        </Card>

        <Section title="Takes for this line" sub="Each take is checked for length against the line, level and clipping, background noise and silence at either end. Listen before you pick.">
          {takes.length ? (
            <ul className="space-y-2" data-booth-takes>
              {takes.map((t, i) => (
                <TakeItem key={t.id} take={t} n={i + 1} picked={doc?.picks[t.lineId] === t.id} outdated={Boolean(line && !takeMatchesLine(t, line))} onPick={() => void pick(t.lineId, doc?.picks[t.lineId] === t.id ? null : t.id)} onDelete={() => void remove(t.id)} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-faint">No takes yet. Record the line above — as many takes as you like.</p>
          )}
        </Section>
      </div>

      <aside className="space-y-4">
        <Card className="space-y-3 p-4">
          <p className="eyebrow">Lines</p>
          <ol className="max-h-80 space-y-0.5 overflow-y-auto pr-1">
            {lines.map((l, i) => {
              const n = (doc?.takes ?? []).filter((t) => t.lineId === l.id).length;
              const picked = doc?.picks[l.id];
              return (
                <li key={l.id}>
                  <button type="button" onClick={() => setAt(i)} className={cx('flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-white/[0.04]', i === at && 'bg-accent/10')}>
                    <span className={cx('mt-0.5 size-2 shrink-0 rounded-full', picked ? 'bg-success' : n ? 'bg-warning' : 'bg-white/20')} aria-label={picked ? 'picked' : n ? 'takes, none picked' : 'not recorded'} />
                    <span className="min-w-0 flex-1 truncate text-dim">{l.text}</span>
                    <span className="timecode text-faint">{n}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </Card>
        <Card className="space-y-3 p-4">
          <p className="eyebrow">Use for scene</p>
          <p className="text-xs text-dim">Joins the picked take of every line, in order, with a short pause between lines. The joined recording replaces this scene’s narration and is then timed against the text (Kasem, protected words as vocabulary) — the only paid step, priced first.</p>
          <Select aria-label="Noise reduction" value={noise} onChange={(e) => setNoise(e.target.value as NoiseReduction)} className="text-xs">
            <option value="off">No noise reduction</option>
            <option value="standard">Standard noise reduction</option>
            <option value="strong">Strong noise reduction</option>
          </Select>
          <LabeledSlider label="Pause between lines" value={pause} display={`${pause.toFixed(2)} s`} min={BOOTH_LIMITS.pauseSec.min} max={BOOTH_LIMITS.pauseSec.max} step={0.05} onChange={setPause} />
          {plan && !plan.ready && (
            <p className="text-xs text-warning">
              {plan.missing.length ? `${plan.missing.length} line${plan.missing.length === 1 ? '' : 's'} without a picked take. ` : ''}
              {plan.outdated.length ? `${plan.outdated.length} picked take${plan.outdated.length === 1 ? '' : 's'} recorded before the line changed.` : ''}
            </p>
          )}
          {joinedCurrent && <Notice tone="success">This scene already uses these picks ({fmtSec(doc!.joined!.durationSec)}).</Notice>}
          <Button variant="primary" className="w-full" icon={<Wand2 className="size-4" />} loading={joining || work.busy === 'narration'} disabled={!plan?.ready || recording} onClick={() => void joinForScene()}>
            {joinedCurrent ? 'Time it again' : 'Use for scene'}
          </Button>
          <p className="text-[11px] text-faint">Joining runs in the studio (FFmpeg), with no model call. Timing a scene of about a minute costs roughly {formatUsd(0.002)}.</p>
        </Card>
      </aside>
      {work.dialog}
    </div>
  );
}

/** The recording booth for Kasem narration: `/lite/booth/:projectId?/:sceneId?` (pick a film, then a scene). */
export default function RecordingBooth() {
  const { projectId, sceneId } = useParams();
  const navigate = useNavigate();
  const films = useProjects({ type: 'film_lite', status: 'active' });
  const project = useProject(projectId);
  const scenes = useMemo(() => ((project.data?.lite as { scenes?: { id: string; title: string; narration: string }[] } | undefined)?.scenes ?? []).filter((s) => s.narration?.trim()), [project.data]);
  useEffect(() => {
    if (project.data && !sceneId && scenes[0]) navigate(`/lite/booth/${project.data.id}/${scenes[0].id}`, { replace: true });
  }, [navigate, project.data, sceneId, scenes]);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Film Studio Lite · Recording booth</p>
          <h1 className="display text-4xl text-fg">Record the narration</h1>
          <p className="mt-1 max-w-2xl text-sm text-dim">For Kasem and other languages the studio voices cannot speak: read each line, keep the best take, and the scene is joined and timed for subtitles.</p>
        </div>
        {projectId && (
          <Link to={`/lite/${projectId}/sound`} className="inline-flex items-center gap-1.5 text-sm text-accent-2 hover:underline">
            <ArrowLeft className="size-4" /> Back to Voice & Sound
          </Link>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Film" value={projectId ?? ''} onChange={(e) => navigate(e.target.value ? `/lite/booth/${e.target.value}` : '/lite/booth')} className="w-auto min-w-56">
          <option value="">Choose a film…</option>
          {films.data.map((f) => (
            <option key={f.id} value={f.id}>
              {f.title}
            </option>
          ))}
        </Select>
        {projectId && (
          <Select aria-label="Scene" value={sceneId ?? ''} onChange={(e) => navigate(`/lite/booth/${projectId}/${e.target.value}`)} className="w-auto min-w-56">
            {scenes.map((s, i) => (
              <option key={s.id} value={s.id}>
                {s.title || `Scene ${i + 1}`}
              </option>
            ))}
          </Select>
        )}
      </div>
      {!projectId ? (
        <EmptyState icon={<Mic className="size-5" />} title="Choose a film" body="The booth records one scene at a time; every scene’s narration is split into lines." />
      ) : project.loading ? (
        <Skeleton className="h-96" />
      ) : !project.data || project.data.type !== 'film_lite' ? (
        <EmptyState title="Film not found" body="Choose a Film Studio Lite film." />
      ) : !scenes.length ? (
        <EmptyState title="No narration yet" body="Write the narration and plan the scenes first." action={<Button onClick={() => navigate(`/lite/${projectId}/story`)}>Open the story</Button>} />
      ) : sceneId ? (
        <Booth project={project.data} sceneId={sceneId} key={`${project.data.id}:${sceneId}`} />
      ) : null}
    </div>
  );
}
