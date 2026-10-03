import { useEffect, useMemo } from 'react';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { CircleAlert, Clapperboard, FileVideo, Monitor, ShieldCheck, Smartphone, Square } from 'lucide-react';
import { AD_ASPECT_PRESETS, AD_ASPECT_SIZES, AD_ASPECTS, adReadiness, EXPORT_PRESETS, estimateRender, isGeneratedScene, type AdAspect, type RenderDoc } from '@az-studio/shared';
import { db } from '../../lib/firebase';
import { useQuery } from '../../lib/data';
import { useNarration } from '../../lib/ads';
import { useBoot, useUid } from '../../lib/session';
import { RenderRow } from '../../components/assembly';
import { FinalInspectionWorkspace } from '../../components/final-inspection';
import { EstimateText, useJobSubmitter } from '../../components/jobs';
import { Badge, Button, Card, cx, Notice } from '../../components/ui';
import type { StepProps } from './AdStudio';

const ICON: Record<AdAspect, typeof Smartphone> = { '9:16': Smartphone, '16:9': Monitor, '1:1': Square };

export function ExportStep({ project, ad, update, scenes, go }: StepProps) {
  const uid = useUid();
  const boot = useBoot();
  const song = useNarration(project.id, ad.audio.songId);
  const { submit, busy, dialog } = useJobSubmitter();
  const renders = useQuery<RenderDoc>(() => (uid ? query(collection(db, 'renders'), where('ownerUid', '==', uid), where('projectId', '==', project.id), orderBy('createdAt', 'desc'), limit(20)) : null), [uid, project.id]);
  const finals = useMemo(() => renders.data.filter((r) => r.quality === 'final'), [renders.data]);
  const readiness = adReadiness({
    ad,
    sheet: song.data?.lyricsSheet ?? null,
    scenes: scenes.map((s) => ({ id: s.id, title: s.title, kind: s.ad.kind, start: s.timing?.start ?? 0, end: s.timing?.end ?? 0, hasMedia: isGeneratedScene(s.ad.kind) ? Boolean(s.selectedTakeId) : s.ad.kind === 'typography' || s.ad.kind === 'end_card' || s.ad.assetIds.length > 0, validation: s.ad.validation, generating: s.status === 'queued' || s.status === 'generating' })),
  });
  const blocking = readiness.filter((r) => r.severity === 'error');
  useEffect(() => {
    const latest = finals.find((r) => r.status === 'completed' && r.timelineId === ad.timelineId);
    if (latest) {
      const aspect = EXPORT_PRESETS[latest.preset as keyof typeof EXPORT_PRESETS]?.aspect as AdAspect | undefined;
      if (aspect && ad.finalRenderIds[aspect] !== latest.id) update((a) => ({ ...a, finalRenderIds: { ...a.finalRenderIds, [aspect]: latest.id } }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finals]);
  const renderFinal = async () => {
    if (!ad.timelineId) return;
    await submit([{ type: 'render.timeline', projectId: project.id, timelineId: ad.timelineId, preset: AD_ASPECT_PRESETS[ad.aspect], quality: 'final', inspect: true, acceptLyricSync: false, audioMaster: 'preserve', label: `Advert final · ${ad.aspect}` }], { label: `Advert final · ${ad.aspect}`, alwaysConfirm: true });
  };
  const size = AD_ASPECT_SIZES[ad.aspect];
  const Icon = ICON[ad.aspect];
  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow flex items-center gap-1.5">
              <FileVideo className="size-3.5" /> Final export
            </p>
            <p className="mt-1 text-sm text-dim">
              <Icon className="mr-1 inline size-4 align-[-3px] text-accent-2" />
              {size.width}×{size.height} ({ad.aspect}) · {project.format.fps} fps · H.264 High (yuv420p) · AAC 48 kHz stereo · fast-start MP4 — plays on every phone and platform.
            </p>
            <p className="mt-1 text-xs text-faint">The approved soundtrack is passed through without loudness normalisation; the length is exactly the measured audio ({ad.audio.durationSec?.toFixed(3) ?? '—'} s). The finished file is inspected (picture, sound, text) before it can be downloaded.</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Button variant="primary" loading={busy} disabled={!ad.timelineId || blocking.length > 0} onClick={() => void renderFinal()} icon={<Clapperboard className="size-4" />}>
              Render final {ad.aspect}
            </Button>
            {boot && ad.audio.durationSec ? <EstimateText estimate={estimateRender({ durationSec: ad.audio.durationSec, quality: 'final' }, boot.pricing)} /> : null}
          </div>
        </div>
        {!ad.timelineId && <Notice tone="warning">Build the edit on the Review step first.</Notice>}
        {blocking.length > 0 && (
          <Notice tone="danger" icon={<CircleAlert className="size-4" />}>
            <p className="text-fg">Resolve these before the final render:</p>
            <ul className="mt-1 space-y-0.5">
              {blocking.map((b, i) => (
                <li key={i}>
                  <button type="button" className="cursor-pointer text-left hover:underline" onClick={() => go(b.step)}>
                    {b.message}
                  </button>
                </li>
              ))}
            </ul>
          </Notice>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-faint">Other formats from the same storyboard:</span>
          {AD_ASPECTS.filter((a) => a !== ad.aspect).map((a) => (
            <Button key={a} size="sm" variant="ghost" onClick={() => { update({ aspect: a }); go('review'); }}>
              Prepare {a}
            </Button>
          ))}
          {Object.entries(ad.finalRenderIds).map(([a]) => (
            <Badge key={a} tone="success" icon={<ShieldCheck className="size-3" />}>
              {a} rendered
            </Badge>
          ))}
        </div>
      </Card>
      <Card className="space-y-3 p-5">
        <p className="eyebrow">Renders</p>
        {renders.data.length === 0 ? <p className="text-sm text-faint">Renders appear here with live progress.</p> : <ul className={cx('space-y-2')}>{renders.data.map((r) => <RenderRow key={r.id} render={r} inspectionHref={null} />)}</ul>}
      </Card>
      <FinalInspectionWorkspace project={project} />
      {dialog}
    </div>
  );
}
