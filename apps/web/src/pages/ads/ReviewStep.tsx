import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { toast } from 'sonner';
import { ArrowRight, CircleCheck, CircleX, Clapperboard, Eye, Hammer, ListChecks, Play, RefreshCw, TriangleAlert } from 'lucide-react';
import { AD_ASPECT_PRESETS, AD_SCENE_KIND_LABELS, formatTimecode, isGeneratedScene, validationSummary, type AssetDoc, type RenderDoc, type SongDoc, type TakeDoc } from '@az-studio/shared';
import { db } from '../../lib/firebase';
import { api, errorMessage } from '../../lib/api';
import { useDoc, useQuery, type WithId } from '../../lib/data';
import { buildAdTimeline, saveTranscriptEdit, useNarration, type AdScene } from '../../lib/ads';
import { useUid } from '../../lib/session';
import { updateSubDoc } from '../../lib/studio';
import { useJobSubmitter } from '../../components/jobs';
import { ImageView, VideoPlayer } from '../../components/media';
import { Badge, Button, Card, cx, EmptyState, Input, Notice, Toggle } from '../../components/ui';
import type { StepProps } from './AdStudio';

/** Platform interface over a vertical video (status/header, caption area, action buttons) — text must stay clear of it. */
function SafeAreaOverlay({ aspect }: { aspect: string }) {
  if (aspect !== '9:16') return null;
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <div className="absolute inset-x-0 top-0 h-[12%] bg-danger/25" />
      <div className="absolute inset-x-0 bottom-0 h-[20%] bg-danger/25" />
      <div className="absolute top-[38%] right-0 h-[42%] w-[14%] bg-danger/25" />
      <span className="absolute top-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">Platform UI zones</span>
    </div>
  );
}

function ScenePicture({ project, scene }: { project: StepProps['project']; scene: AdScene }) {
  const take = useDoc<TakeDoc>(scene.selectedTakeId ? `projects/${project.id}/shots/${scene.id}/takes/${scene.selectedTakeId}` : null);
  const assetId = isGeneratedScene(scene.ad.kind) ? take.data?.assetId ?? null : scene.ad.assetIds[0] ?? null;
  const asset = useDoc<AssetDoc>(assetId ? `assets/${assetId}` : null);
  if (!assetId) return <div className="grid aspect-[9/16] place-items-center rounded-xl border border-dashed border-line-strong text-xs text-faint">{scene.ad.kind === 'typography' || scene.ad.kind === 'end_card' ? 'Composed in the edit' : 'No picture yet'}</div>;
  if (asset.data?.kind === 'video') return <VideoPlayer assetId={assetId} controls loop className="aspect-[9/16] object-cover" />;
  return <ImageView assetId={assetId} className="aspect-[9/16] object-contain" />;
}

function SceneReview({ project, scene, index }: { project: StepProps['project']; scene: AdScene; index: number }) {
  const takes = useQuery<TakeDoc>(() => query(collection(db, 'projects', project.id, 'shots', scene.id, 'takes'), orderBy('index', 'desc'), limit(8)), [project.id, scene.id]);
  const selected = takes.data.find((t) => t.id === scene.selectedTakeId) ?? null;
  const v = selected?.validation ?? null;
  const [busy, setBusy] = useState(false);
  const choose = async (takeId: string) => {
    // The scene shows the validation of the take it uses (none until that take has been checked).
    const chosen = takes.data.find((t) => t.id === takeId);
    await updateSubDoc(project.id, 'shots', scene.id, { selectedTakeId: takeId, 'ad.validation': validationSummary(takeId, chosen?.validation) });
  };
  const recheck = async () => {
    setBusy(true);
    try {
      await api('adValidateScene', { projectId: project.id, sceneId: scene.id });
      toast.success('Validating again');
    } catch (e) {
      toast.error('Could not validate', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="card grid grid-cols-[110px_minmax(0,1fr)] gap-3 p-3 sm:grid-cols-[140px_minmax(0,1fr)]">
      <ScenePicture project={project} scene={scene} />
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-fg">
            {index + 1}. {scene.title}
          </p>
          <Badge>{AD_SCENE_KIND_LABELS[scene.ad.kind]}</Badge>
          {v && <Badge tone={v.verdict === 'pass' ? 'success' : v.verdict === 'warn' ? 'warning' : 'danger'}>{v.verdict === 'pass' ? 'Validated' : v.verdict === 'warn' ? 'Warnings' : 'Failed'}</Badge>}
          {scene.ad.replaceNote && <Badge tone="violet">Placeholder</Badge>}
        </div>
        <p className="timecode text-xs text-faint">
          {formatTimecode(scene.timing?.start ?? 0, 2)}–{formatTimecode(scene.timing?.end ?? 0, 2)} · “{scene.ad.narration.slice(0, 140)}”
        </p>
        {scene.ad.replaceNote && <p className="text-xs text-violet">To replace later: {scene.ad.replaceNote}</p>}
        {v && (
          <ul className="space-y-0.5 text-xs">
            {v.checks.map((c) => (
              <li key={c.id} className={cx('flex items-start gap-1.5', c.ok ? 'text-dim' : c.severity === 'error' ? 'text-danger' : 'text-warning')}>
                {c.ok ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" /> : c.severity === 'error' ? <CircleX className="mt-0.5 size-3.5 shrink-0" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />}
                <span>
                  <span className="text-fg">{c.label}</span> — {c.detail}
                </span>
              </li>
            ))}
            {v.review?.summary && <li className="text-faint">Reviewer: {v.review.summary}</li>}
          </ul>
        )}
        <div className="flex flex-wrap gap-1.5">
          {takes.data.length > 1 &&
            takes.data
              .filter((t) => t.assetId && t.status === 'completed')
              .map((t) => (
                <Button key={t.id} size="sm" variant={t.id === scene.selectedTakeId ? 'subtle' : 'ghost'} onClick={() => void choose(t.id)}>
                  Take {t.index}
                  {t.validation ? ` · ${t.validation.verdict}` : ''}
                </Button>
              ))}
          {(scene.selectedTakeId || scene.ad.assetIds.length > 0) && (
            <Button size="sm" variant="ghost" loading={busy} icon={<ListChecks className="size-3.5" />} onClick={() => void recheck()}>
              Re-check
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function CaptionEditor({ project, song }: { project: StepProps['project']; song: WithId<SongDoc> }) {
  const sheet = song.lyricsSheet;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (!sheet) return null;
  const save = async (lineId: string) => {
    const text = drafts[lineId]?.trim();
    const line = sheet.lines.find((l) => l.id === lineId);
    if (!text || !line || text === line.text) return;
    try {
      await saveTranscriptEdit(project.id, song, sheet, lineId, text);
      toast.success('Caption corrected and re-timed', { description: 'Rebuild the edit to see it in the preview.' });
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    }
  };
  return (
    <ul className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
      {sheet.lines.map((l) => (
        <li key={l.id} className="grid grid-cols-[86px_minmax(0,1fr)] items-center gap-2">
          <span className="timecode text-[11px] text-faint">
            {l.start !== null ? formatTimecode(l.start, 1) : '—'}–{l.end !== null ? formatTimecode(l.end, 1) : '—'}
          </span>
          <Input value={drafts[l.id] ?? l.text} onChange={(e) => setDrafts({ ...drafts, [l.id]: e.target.value })} onBlur={() => void save(l.id)} className="!py-1.5 text-sm" aria-label={`Caption at ${l.start?.toFixed(1) ?? ''} s`} />
        </li>
      ))}
    </ul>
  );
}

export function ReviewStep({ project, ad, update, scenes, go }: StepProps) {
  const uid = useUid();
  const song = useNarration(project.id, ad.audio.songId);
  const { submit, busy, dialog } = useJobSubmitter();
  const [building, setBuilding] = useState(false);
  const [issues, setIssues] = useState<{ severity: string; message: string }[] | null>(null);
  const [safe, setSafe] = useState(true);
  const renders = useQuery<RenderDoc>(() => (uid ? query(collection(db, 'renders'), where('ownerUid', '==', uid), where('projectId', '==', project.id), orderBy('createdAt', 'desc'), limit(10)) : null), [uid, project.id]);
  const preview = useMemo(() => renders.data.find((r) => r.timelineId === ad.timelineId) ?? null, [renders.data, ad.timelineId]);
  useEffect(() => {
    if (preview?.status === 'completed' && preview.id !== ad.previewRenderId) update({ previewRenderId: preview.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.id, preview?.status]);

  const build = async () => {
    setBuilding(true);
    try {
      const r = await buildAdTimeline(uid, project, ad, scenes, song.data);
      update((a) => ({ ...a, timelineId: r.timelineId, captions: { ...a.captions, styleId: r.styleId } }));
      setIssues(r.issues);
      toast.success('Edit built from the storyboard', { description: r.issues.length ? `${r.issues.length} point(s) to check below.` : 'Scenes, captions, branding and the approved soundtrack are in place.' });
      return r.timelineId;
    } catch (e) {
      toast.error('Could not build the edit', { description: errorMessage(e) });
      return null;
    } finally {
      setBuilding(false);
    }
  };
  const renderPreview = async () => {
    const timelineId = (await build()) ?? ad.timelineId;
    if (!timelineId) return;
    await submit([{ type: 'render.timeline', projectId: project.id, timelineId, preset: AD_ASPECT_PRESETS[ad.aspect], quality: 'draft', inspect: false, acceptLyricSync: false, audioMaster: 'preserve', label: 'Advert preview' }], { label: 'Advert preview' });
  };
  const active = preview && !['completed', 'failed', 'cancelled'].includes(preview.status);
  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">Preview</p>
            <p className="mt-1 text-sm text-dim">The edit is rebuilt from the storyboard: scenes cut on the narration (never stretched), screens on the brand ground, typography and end card composed as text, captions from the transcript, and the approved soundtrack once, untouched.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={building} icon={<Hammer className="size-4" />} onClick={() => void build()} disabled={!scenes.length}>
              Build the edit
            </Button>
            <Button variant="primary" loading={busy || building} icon={<Play className="size-4" />} onClick={() => void renderPreview()} disabled={!scenes.length || Boolean(active)}>
              {preview ? 'Render a new preview' : 'Render preview'}
            </Button>
            {ad.timelineId && (
              <Link to={`/projects/${project.id}/timeline/${ad.timelineId}`}>
                <Button variant="ghost" icon={<Clapperboard className="size-4" />}>
                  Open in the editor
                </Button>
              </Link>
            )}
          </div>
        </div>
        {issues && issues.length > 0 && (
          <Notice tone={issues.some((i) => i.severity === 'error') ? 'danger' : 'warning'} icon={<TriangleAlert className="size-4" />}>
            <ul className="space-y-0.5">
              {issues.map((i, k) => (
                <li key={k}>{i.message}</li>
              ))}
            </ul>
          </Notice>
        )}
        {preview ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
            <div className="relative mx-auto w-full max-w-[320px]">
              {preview.status === 'completed' && preview.outputAssetId ? <VideoPlayer assetId={preview.outputAssetId} className="aspect-[9/16]" /> : <div className="grid aspect-[9/16] place-items-center rounded-xl border border-line bg-black/40 p-4 text-center text-xs text-dim">{preview.status === 'failed' ? preview.error?.message ?? 'The render failed.' : `${preview.stage} · ${Math.round(preview.progress * 100)}%`}</div>}
              {safe && preview.status === 'completed' && <SafeAreaOverlay aspect={ad.aspect} />}
            </div>
            <div className="space-y-3">
              <Toggle checked={safe} onChange={setSafe} label="Show platform UI zones" description="Captions, the tagline and the end card are placed outside these zones (top bar, caption area, right-hand buttons)." />
              <p className="text-xs text-faint">
                Preview: {preview.width}×{preview.height} draft · {preview.durationSec.toFixed(2)} s · the final export is 1080×1920 (9:16) with the same edit.
              </p>
              <Button size="sm" variant="ghost" icon={<Eye className="size-3.5" />} onClick={() => go('export')} disabled={preview.status !== 'completed'}>
                Looks right — go to export
              </Button>
            </div>
          </div>
        ) : (
          <EmptyState title="No preview yet" body="Build the edit and render a draft preview to review the whole advert with sound." />
        )}
      </Card>
      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card className="space-y-3 p-5">
          <p className="eyebrow">Scenes</p>
          {scenes.length === 0 ? (
            <p className="text-sm text-faint">Plan the storyboard first.</p>
          ) : (
            <ol className="space-y-3">
              {scenes.map((s, i) => (
                <SceneReview key={s.id} project={project} scene={s} index={i} />
              ))}
            </ol>
          )}
        </Card>
        <Card className="space-y-3 p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="eyebrow">Captions</p>
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={building} onClick={() => void build()}>
              Rebuild the edit
            </Button>
          </div>
          <p className="text-xs text-faint">Correct any word here; the line is re-timed against the recording at once. Captions show exactly this text.</p>
          {song.data ? <CaptionEditor project={project} song={song.data} /> : <p className="text-sm text-faint">No transcript yet.</p>}
        </Card>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" icon={<ArrowRight className="size-4" />} onClick={() => go('export')}>
          Export
        </Button>
      </div>
      {dialog}
    </div>
  );
}
