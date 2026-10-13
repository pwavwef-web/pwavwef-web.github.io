import { useMemo, useState } from 'react';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { toast } from 'sonner';
import { CircleAlert, Clapperboard, Download, Eye, Film, Info, Lightbulb, Sparkles } from 'lucide-react';
import { EXPORT_PRESETS, LITE_STAGE_LABELS, estimateRender, formatSrt, formatVtt, shotImageId, type LiteAspect, type LiteFinding, type RenderDoc } from '@az-studio/shared';
import { waitForJobOutput } from '../../lib/ai';
import { db } from '../../lib/firebase';
import { useQuery } from '../../lib/data';
import { ASPECT_PRESET, saveComposition } from '../../lib/lite';
import { getMediaUrls } from '../../lib/media';
import { useBoot, useUid } from '../../lib/session';
import { RenderRow } from '../../components/assembly';
import { FinalInspectionWorkspace } from '../../components/final-inspection';
import { EstimateText, useJobSubmitter } from '../../components/jobs';
import { Badge, Button, cx, Notice, Segmented } from '../../components/ui';
import { fmtSec, Section, type StageProps } from './common';

interface ReviewOut {
  findings?: { shotIndex?: number; kind?: string; severity?: string; message?: string }[];
  summary?: string;
}

function FindingRow({ f, onGo }: { f: LiteFinding; onGo: () => void }) {
  const Icon = f.basis === 'heuristic' ? Lightbulb : f.basis === 'model' ? Eye : f.severity === 'info' ? Info : CircleAlert;
  return (
    <li>
      <button type="button" onClick={onGo} className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.04]">
        <Icon className={cx('mt-0.5 size-4 shrink-0', f.severity === 'error' ? 'text-danger' : f.severity === 'warning' ? 'text-warning' : 'text-faint')} aria-hidden />
        <span className="min-w-0 flex-1 text-dim">{f.message}</span>
        <span className="shrink-0 text-[11px] text-faint">
          {LITE_STAGE_LABELS[f.stage]}
          {f.at !== null ? ` · ${fmtSec(f.at)}` : ''}
        </span>
      </button>
    </li>
  );
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function ExportStage(props: StageProps) {
  const { project, spec, update, flush, comp, aspect, setAspect, go } = props;
  const uid = useUid();
  const boot = useBoot();
  const [reviewing, setReviewing] = useState(false);
  const { submit, busy, dialog } = useJobSubmitter();
  const [review, setReview] = useState<LiteFinding[] | null>(null);
  const [reviewSummary, setReviewSummary] = useState('');
  const [showInspection, setShowInspection] = useState(false);
  const formats: LiteAspect[] = [spec.setup.aspect, ...spec.setup.extraAspects];
  const renders = useQuery<RenderDoc>(() => (uid ? query(collection(db, 'renders'), where('ownerUid', '==', uid), where('projectId', '==', project.id), orderBy('createdAt', 'desc'), limit(30)) : null), [uid, project.id]);
  const timelineIds = new Set(Object.values(spec.timelines));
  const myRenders = renders.data.filter((r) => timelineIds.has(r.timelineId));

  const findings = comp.findings;
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning' && f.basis === 'deterministic');
  const suggestions = findings.filter((f) => f.basis === 'heuristic' || (f.severity === 'info' && f.basis === 'deterministic'));
  const D = comp.assembly.durationSec;
  const preset = ASPECT_PRESET[aspect];

  const render = async (quality: 'draft' | 'final') => {
    try {
      await flush();
      const { timelineId, created } = await saveComposition(uid, project, spec, aspect, comp.assembly.state);
      if (created) update((s) => ({ ...s, timelines: { ...s.timelines, [aspect]: timelineId } }), 'composition');
      const ids = await submit([{ type: 'render.timeline', projectId: project.id, timelineId, preset, quality, inspect: quality === 'final', acceptLyricSync: false, audioMaster: 'normalize', label: `${project.title} · ${aspect} · ${quality === 'final' ? 'final' : 'draft preview'}` }], { label: `${aspect} ${quality}`, alwaysConfirm: quality === 'final' });
      if (ids?.[0]) {
        update((s) => ({ ...s, renders: [{ renderId: ids[0]!, aspect, quality, at: Date.now() }, ...s.renders].slice(0, 30) }), 'render');
        toast.success(quality === 'final' ? 'Final export started' : 'Draft preview started', { description: 'It renders on the studio’s FFmpeg renderer from exactly this composition.' });
      }
    } catch (e) {
      toast.error('Could not start the render', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  // The review sends the approved images with the text, so the model judges what is actually on screen.
  const runReviewWithImages = async () => {
    const shots = spec.scenes.flatMap((s) => s.shots.map((sh) => ({ scene: s.title, narration: s.narration.slice(0, 220), brief: sh.brief, characters: sh.characterIds.map((id) => spec.bible.characters.find((c) => c.id === id)?.name).filter(Boolean) as string[], image: shotImageId(spec, sh), shotId: sh.id, sceneId: s.id })));
    const withImages = shots.filter((s) => s.image).filter((s, i, all) => all.findIndex((x) => x.image === s.image) === i).slice(0, 16);
    if (!withImages.length) return toast.error('Approve some images first.');
    const ids = await submit([{ type: 'text.assist', projectId: project.id, task: 'lite.review', input: { shots: withImages.map(({ scene, narration, brief, characters }) => ({ scene, narration, brief, characters })), characters: spec.bible.characters.map((c) => ({ name: c.name, description: c.description, clothing: c.clothing })) }, imageAssetIds: withImages.map((s) => s.image!), label: 'Continuity review' }], { label: 'Continuity review', alwaysConfirm: true });
    if (!ids?.[0]) return;
    setReviewing(true);
    try {
      const out = await waitForJobOutput<ReviewOut>(ids[0], project.id);
      const list: LiteFinding[] = (out.findings ?? [])
        .filter((f) => f.message && typeof f.shotIndex === 'number' && withImages[f.shotIndex])
        .map((f, i) => ({ id: `m${i}`, severity: f.severity === 'warning' ? 'warning' : 'info', basis: 'model', kind: f.kind ?? 'other', message: `${withImages[f.shotIndex!]!.scene || 'Scene'}: ${f.message}`, stage: 'scenes', sceneId: withImages[f.shotIndex!]!.sceneId, shotId: withImages[f.shotIndex!]!.shotId, at: null }));
      setReview(list);
      setReviewSummary(out.summary ?? '');
    } catch (e) {
      toast.error('The review did not finish', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setReviewing(false);
    }
  };

  const cues = comp.assembly.cues;
  const latestFinal = myRenders.find((r) => r.quality === 'final' && r.status === 'completed' && r.preset === preset);
  const poster = async () => {
    if (!latestFinal?.outputAssetId) return;
    const u = await getMediaUrls(latestFinal.outputAssetId);
    if (u.poster) window.open(u.poster, '_blank', 'noopener');
  };
  const pricing = boot?.pricing;
  const draftEstimate = useMemo(() => (pricing ? estimateRender({ durationSec: D, quality: 'draft' }, pricing) : null), [pricing, D]);
  const finalEstimate = useMemo(() => (pricing ? estimateRender({ durationSec: D, quality: 'final' }, pricing) : null), [pricing, D]);

  return (
    <>
      <Section
        title="Checks before export"
        sub="Measured facts about the composition first, then editorial suggestions. Each item opens the scene it concerns."
        action={formats.length > 1 ? <Segmented size="sm" label="Format" value={aspect} onChange={setAspect} options={formats.map((f) => ({ value: f, label: f }))} /> : undefined}
      >
        {errors.length === 0 ? <Notice tone="success">No blocking problems for {aspect}.</Notice> : <Notice tone="danger">{errors.length} problem{errors.length === 1 ? '' : 's'} must be fixed before the final export.</Notice>}
        {errors.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {errors.map((f) => (
              <FindingRow key={f.id} f={f} onGo={() => go(f.stage, { sceneId: f.sceneId, shotId: f.shotId })} />
            ))}
          </ul>
        )}
        {warnings.length > 0 && (
          <>
            <p className="eyebrow mt-4">Warnings</p>
            <ul className="mt-1 space-y-0.5">
              {warnings.map((f) => (
                <FindingRow key={f.id} f={f} onGo={() => go(f.stage, { sceneId: f.sceneId, shotId: f.shotId })} />
              ))}
            </ul>
          </>
        )}
        {suggestions.length > 0 && (
          <>
            <p className="eyebrow mt-4">Suggestions (heuristic — your call)</p>
            <ul className="mt-1 space-y-0.5">
              {suggestions.map((f) => (
                <FindingRow key={f.id} f={f} onGo={() => go(f.stage, { sceneId: f.sceneId, shotId: f.shotId })} />
              ))}
            </ul>
          </>
        )}
        <div className="mt-5 rounded-xl border border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Eye className="size-4 text-accent-2" />
            <p className="text-sm text-fg">Continuity review</p>
            <Badge>model suggestions · billable</Badge>
            <span className="flex-1" />
            <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" />} loading={busy || reviewing} onClick={() => void runReviewWithImages()}>
              Review the images
            </Button>
          </div>
          <p className="mt-1 text-xs text-faint">The reasoning model looks at up to 16 approved images for faces that drift between shots, images that do not fit their narration, style breaks, visible text and artefacts. It suggests; it does not change or regenerate anything.</p>
          {review && (
            <div className="mt-2">
              {reviewSummary && <p className="text-xs text-dim">{reviewSummary}</p>}
              {review.length === 0 ? (
                <p className="mt-1 text-xs text-success">No continuity problems reported.</p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {review.map((f) => (
                    <FindingRow key={f.id} f={f} onGo={() => go('scenes', { sceneId: f.sceneId, shotId: f.shotId })} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section title={`Render · ${aspect}`} sub={`${fmtSec(D)} · ${EXPORT_PRESETS[preset].final.width}×${EXPORT_PRESETS[preset].final.height} · ${spec.setup.fps} fps · H.264 + AAC MP4. 1080p is the highest export (no upscaling is applied or claimed).`}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-line p-4">
            <p className="flex items-center gap-2 text-sm text-fg">
              <Film className="size-4 text-accent-2" /> Draft preview (proxy)
            </p>
            <p className="mt-1 text-xs text-dim">
              {EXPORT_PRESETS[preset].draft.width}×{EXPORT_PRESETS[preset].draft.height}, fast encode — the exact pixels, motion and mix of the export, for checking long films.
            </p>
            {draftEstimate && <EstimateText estimate={draftEstimate} className="mt-2" />}
            <Button className="mt-3" variant="secondary" loading={busy} disabled={!spec.scenes.length} onClick={() => void render('draft')}>
              Render draft preview
            </Button>
          </div>
          <div className="rounded-xl border border-line p-4">
            <p className="flex items-center gap-2 text-sm text-fg">
              <Clapperboard className="size-4 text-accent-2" /> Final export
            </p>
            <p className="mt-1 text-xs text-dim">Full quality with loudness normalisation; the finished file is inspected (black frames, peaks, loudness, text) before download.</p>
            {finalEstimate && <EstimateText estimate={finalEstimate} className="mt-2" />}
            <Button className="mt-3" variant="primary" loading={busy} disabled={errors.length > 0 || !spec.scenes.length} onClick={() => void render('final')}>
              {errors.length ? `Fix ${errors.length} problem${errors.length === 1 ? '' : 's'} first` : 'Export final film'}
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-faint">Also download:</span>
          <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} disabled={!cues.length} onClick={() => download(`${project.title}-${aspect.replace(':', 'x')}.srt`, formatSrt(cues), 'application/x-subrip')}>
            Subtitles (SRT)
          </Button>
          <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} disabled={!cues.length} onClick={() => download(`${project.title}-${aspect.replace(':', 'x')}.vtt`, formatVtt(cues), 'text/vtt')}>
            Subtitles (VTT)
          </Button>
          <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} disabled={!latestFinal} onClick={() => void poster()}>
            Poster frame
          </Button>
        </div>
      </Section>

      <Section title="Saved exports" sub="Every render stays here — reopen, play or download any time. Project data and source media stay available for future edits.">
        {myRenders.length === 0 ? (
          <p className="text-sm text-faint">No renders yet.</p>
        ) : (
          <ul className="space-y-2">
            {myRenders.map((r) => (
              <RenderRow key={r.id} render={r} inspectionHref={null} />
            ))}
          </ul>
        )}
        {myRenders.some((r) => r.finalInspection) && (
          <Button className="mt-3" size="sm" variant="ghost" onClick={() => setShowInspection((v) => !v)}>
            {showInspection ? 'Hide final inspection' : 'Show final inspection'}
          </Button>
        )}
        {showInspection && (
          <div className="mt-4">
            <FinalInspectionWorkspace project={project} />
          </div>
        )}
      </Section>
      {dialog}
    </>
  );
}
