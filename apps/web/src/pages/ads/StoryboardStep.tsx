import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, ChevronDown, Combine, LayoutList, Scissors, Sparkles, TriangleAlert } from 'lucide-react';
import {
  AD_GENERATION_ASPECT,
  AD_SCENE_KIND_LABELS,
  AD_SCENE_KINDS,
  compileAdImagePrompt,
  compileAdVideoPrompt,
  formatTimecode,
  isGeneratedScene,
  linesInWindow,
  planSceneWindows,
  sceneGenerationSeconds,
  sceneWindowProblems,
  type AdAssetRole,
  type AdSceneKind,
  type AdSpec,
} from '@az-studio/shared';
import { useAiRun } from '../../lib/ai';
import { updateScene, useNarration, writeStoryboard, type AdScene } from '../../lib/ads';
import { addShots, deleteSubDoc, newShot } from '../../lib/studio';
import { Badge, Button, Card, ConfirmDialog, cx, EmptyState, Field, IconButton, Input, Notice, Select, Textarea, Toggle } from '../../components/ui';
import type { StepProps } from './AdStudio';

const KIND_COLOUR: Record<AdSceneKind, string> = {
  generated_video: 'bg-accent/70',
  generated_image: 'bg-accent/45',
  product_screen: 'bg-success/70',
  footage: 'bg-violet/70',
  photo: 'bg-violet/45',
  typography: 'bg-white/40',
  end_card: 'bg-warning/70',
};

const ROLES_FOR: Partial<Record<AdSceneKind, AdAssetRole[]>> = { product_screen: ['screenshot', 'recording'], footage: ['footage', 'recording'], photo: ['photo'] };

/** The scenes over the advert's length, coloured by kind (gaps or overlaps would show here). */
function CoverageBar({ scenes, duration }: { scenes: AdScene[]; duration: number }) {
  if (!duration) return null;
  return (
    <div className="space-y-1.5">
      <div className="relative h-7 overflow-hidden rounded-lg border border-line bg-black/40" role="img" aria-label="Scenes over the advert's length">
        {scenes.map((s) => {
          const start = s.timing?.start ?? 0;
          const end = s.timing?.end ?? 0;
          return <div key={s.id} title={`${s.title} · ${AD_SCENE_KIND_LABELS[s.ad.kind]} · ${start.toFixed(2)}–${end.toFixed(2)} s`} className={cx('absolute inset-y-0 border-r border-black/50', KIND_COLOUR[s.ad.kind])} style={{ left: `${(start / duration) * 100}%`, width: `${((end - start) / duration) * 100}%` }} />;
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-faint">
        {AD_SCENE_KINDS.filter((k) => scenes.some((s) => s.ad.kind === k)).map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className={cx('size-2 rounded-sm', KIND_COLOUR[k])} /> {AD_SCENE_KIND_LABELS[k]}
          </span>
        ))}
      </div>
    </div>
  );
}

function SceneEditor({ project, ad, scene, index, next, onMerge, onSplit }: { project: StepProps['project']; ad: AdSpec; scene: AdScene; index: number; next: AdScene | null; onMerge: () => void; onSplit: () => void }) {
  const [title, setTitle] = useState(scene.title);
  const [visual, setVisual] = useState(scene.description);
  const [text, setText] = useState(scene.ad.onScreenText);
  const [sub, setSub] = useState(scene.ad.subText);
  const [note, setNote] = useState(scene.ad.replaceNote);
  const [dir, setDir] = useState(scene.directions);
  const [override, setOverride] = useState(scene.promptOverride ?? '');
  const [showDirection, setShowDirection] = useState(false);
  useEffect(() => {
    setTitle(scene.title);
    setVisual(scene.description);
    setText(scene.ad.onScreenText);
    setSub(scene.ad.subText);
    setNote(scene.ad.replaceNote);
    setDir(scene.directions);
    setOverride(scene.promptOverride ?? '');
  }, [scene.title, scene.description, scene.ad.onScreenText, scene.ad.subText, scene.ad.replaceNote, scene.directions, scene.promptOverride]);
  const save = (patch: Parameters<typeof updateScene>[2]) => void updateScene(project.id, scene, patch).catch((e) => toast.error('Could not save the scene', { description: String(e) }));
  const start = scene.timing?.start ?? 0;
  const end = scene.timing?.end ?? 0;
  const len = end - start;
  const generated = isGeneratedScene(scene.ad.kind);
  const roles = ROLES_FOR[scene.ad.kind];
  const options = roles ? ad.assets.filter((a) => roles.includes(a.role)) : [];
  const genAspect = AD_GENERATION_ASPECT[ad.aspect];
  const promptPreview = useMemo(() => {
    if (!generated) return '';
    const input = { kind: scene.ad.kind, visual: visual || title, directions: dir, narration: scene.ad.narration, durationSec: sceneGenerationSeconds(len), aspect: genAspect };
    return scene.ad.kind === 'generated_image' ? compileAdImagePrompt(input, ad.brief) : compileAdVideoPrompt(input, ad.brief);
  }, [generated, scene.ad.kind, scene.ad.narration, visual, title, dir, len, genAspect, ad.brief]);

  return (
    <li className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-xs text-dim">{index + 1}</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== scene.title && save({ title })} className="!w-56 !py-1.5 text-sm" aria-label="Scene title" />
          <span className="timecode text-xs text-faint">
            {formatTimecode(start, 2)}–{formatTimecode(end, 2)} · {len.toFixed(2)} s
          </span>
          {generated && len > 10 && <Badge tone="danger">Longer than one generation — split it</Badge>}
        </div>
        <div className="flex items-center gap-1.5">
          <Select value={scene.ad.kind} onChange={(e) => save({ ad: { kind: e.target.value as AdSceneKind } })} className="!w-44 !py-1.5 text-xs" aria-label="Scene kind">
            {AD_SCENE_KINDS.map((k) => (
              <option key={k} value={k}>
                {AD_SCENE_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
          <IconButton label="Split this scene at a pause" size="sm" onClick={onSplit} disabled={scene.ad.lineIds.length < 2}>
            <Scissors className="size-3.5" />
          </IconButton>
          <IconButton label="Merge with the next scene" size="sm" onClick={onMerge} disabled={!next}>
            <Combine className="size-3.5" />
          </IconButton>
        </div>
      </div>
      {scene.ad.narration && <p className="rounded-lg bg-black/25 px-3 py-2 text-sm text-dim">“{scene.ad.narration}”</p>}
      {generated && (
        <>
          <Field label="What we see" hint="Concrete and visual. People are anonymous; no text, logos or app screens in generated pictures.">
            <Textarea rows={3} value={visual} onChange={(e) => setVisual(e.target.value)} onBlur={() => visual !== scene.description && save({ description: visual })} />
          </Field>
          <button type="button" className="flex cursor-pointer items-center gap-1 text-xs text-faint hover:text-dim" onClick={() => setShowDirection((v) => !v)} aria-expanded={showDirection}>
            Camera, light & prompt <ChevronDown className={cx('size-3 transition-transform', showDirection && 'rotate-180')} />
          </button>
          {showDirection && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(['framing', 'cameraMovement', 'lighting', 'mood', 'action'] as const).map((k) => (
                  <Field key={k} label={{ framing: 'Framing', cameraMovement: 'Camera movement', lighting: 'Lighting', mood: 'Mood', action: 'Visible action' }[k]}>
                    <Input value={dir[k]} onChange={(e) => setDir({ ...dir, [k]: e.target.value })} onBlur={() => save({ directions: dir })} className="!py-1.5 text-sm" />
                  </Field>
                ))}
              </div>
              <Field label="Prompt sent to the model" hint={`Compiled from the scene and the brief; ${scene.ad.kind === 'generated_video' ? `${sceneGenerationSeconds(len)} s clip, ${genAspect}` : `still, ${genAspect}`}. Write your own to override it.`}>
                <Textarea rows={6} value={override || promptPreview} onChange={(e) => setOverride(e.target.value)} onBlur={() => save({ promptOverride: override.trim() && override.trim() !== promptPreview.trim() ? override.trim() : null })} className="text-xs" />
              </Field>
            </div>
          )}
        </>
      )}
      {roles && (
        <Field label="Material" hint={options.length ? 'Supplied under Audio & assets.' : 'Nothing of this type is supplied yet — add it under Audio & assets.'}>
          <Select value={scene.ad.assetIds[0] ?? ''} onChange={(e) => save({ ad: { assetIds: e.target.value ? [e.target.value] : [] } })}>
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={`${o.role}-${o.assetId}`} value={o.assetId}>
                {o.label || o.assetId} ({o.role})
              </option>
            ))}
          </Select>
        </Field>
      )}
      {(scene.ad.kind === 'typography' || scene.ad.kind === 'end_card') && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={scene.ad.kind === 'end_card' ? 'Headline' : 'Text (when captions are off)'}>
            <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== scene.ad.onScreenText && save({ ad: { onScreenText: text } })} />
          </Field>
          {scene.ad.kind === 'end_card' && (
            <Field label="Second line">
              <Input value={sub} onChange={(e) => setSub(e.target.value)} onBlur={() => sub !== scene.ad.subText && save({ ad: { subText: sub } })} placeholder="indigenworld.com" />
            </Field>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Toggle checked={scene.ad.captions} onChange={(v) => save({ ad: { captions: v } })} label={scene.ad.kind === 'typography' ? 'Show the narration as typography' : 'Captions'} />
        {(scene.ad.kind === 'generated_image' || scene.ad.kind === 'photo' || scene.ad.kind === 'product_screen') && (
          <Field label="Still motion" className="w-40">
            <Select value={scene.ad.motion} onChange={(e) => save({ ad: { motion: e.target.value as AdScene['ad']['motion'] } })} className="!py-1.5 text-xs">
              <option value="push_in">Gentle push-in</option>
              <option value="none">Still</option>
            </Select>
          </Field>
        )}
        <Field label="Placeholder note" className="min-w-56 flex-1">
          <Input value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== scene.ad.replaceNote && save({ ad: { replaceNote: note } })} placeholder="e.g. Replace with real footage of a Kasem class" className="!py-1.5 text-xs" />
        </Field>
      </div>
    </li>
  );
}

export function StoryboardStep({ project, ad, scenes, go }: StepProps) {
  const song = useNarration(project.id, ad.audio.songId);
  const sheet = song.data?.lyricsSheet ?? null;
  const duration = ad.audio.durationSec ?? 0;
  const ai = useAiRun(project.id);
  const [confirm, setConfirm] = useState(false);
  const [planning, setPlanning] = useState(false);
  const windows = useMemo(() => (sheet && duration ? planSceneWindows(sheet, duration) : []), [sheet, duration]);
  const problems = useMemo(() => (duration && scenes.length ? sceneWindowProblems(scenes.map((s) => ({ start: s.timing?.start ?? 0, end: s.timing?.end ?? 0, kind: s.ad.kind })), duration) : []), [scenes, duration]);

  const plan = async () => {
    setConfirm(false);
    setPlanning(true);
    try {
      await writeStoryboard(project.id, ad, windows, scenes);
      toast.success(`${windows.length} scenes cut on the narration`, { description: 'Each scene starts just before its first word and the last one ends with the audio.' });
    } catch (e) {
      toast.error('Could not plan the storyboard', { description: String(e) });
    } finally {
      setPlanning(false);
    }
  };

  const suggest = async () => {
    const out = await ai.run<{ scenes: { index: number; kind: AdSceneKind; title: string; visual: string; framing: string; cameraMovement: string; lighting: string; mood: string; action: string; assetId: string; onScreenText: string; subText: string; captions: boolean; replaceNote: string }[]; notes: string }>(
      'ad.storyboard',
      {
        brief: ad.brief,
        aspect: ad.aspect,
        windows: scenes.map((s, index) => ({ index, start: s.timing?.start ?? 0, end: s.timing?.end ?? 0, seconds: Math.round(((s.timing?.end ?? 0) - (s.timing?.start ?? 0)) * 10) / 10, narration: s.ad.narration })),
        assets: ad.assets.map((a) => ({ assetId: a.assetId, role: a.role, label: a.label, note: a.note })),
        logoAvailable: Boolean(ad.brand.logoAssetId),
      },
      'Advert storyboard',
    );
    if (!out?.scenes?.length) return;
    let applied = 0;
    for (const s of out.scenes) {
      const scene = scenes[s.index];
      if (!scene) continue;
      const kind = (AD_SCENE_KINDS as readonly string[]).includes(s.kind) ? s.kind : scene.ad.kind;
      const roles = ROLES_FOR[kind];
      const asset = roles && ad.assets.find((a) => a.assetId === s.assetId && roles.includes(a.role));
      await updateScene(project.id, scene, {
        title: (s.title || scene.title).slice(0, 120),
        description: s.visual ?? '',
        directions: { ...scene.directions, framing: s.framing ?? '', cameraMovement: s.cameraMovement ?? '', lighting: s.lighting ?? '', mood: s.mood ?? '', action: s.action ?? '' },
        ad: { kind, assetIds: asset ? [asset.assetId] : roles ? scene.ad.assetIds : [], onScreenText: s.onScreenText ?? scene.ad.onScreenText, subText: s.subText ?? scene.ad.subText, captions: typeof s.captions === 'boolean' ? s.captions : scene.ad.captions, replaceNote: s.replaceNote ?? '' },
      });
      applied++;
    }
    toast.success(`Suggestions applied to ${applied} scenes`, { description: out.notes ? out.notes.slice(0, 220) : 'Review and edit every scene before generating.' });
  };

  const merge = async (i: number) => {
    const a = scenes[i];
    const b = scenes[i + 1];
    if (!a || !b) return;
    await updateScene(project.id, a, { timing: { start: a.timing?.start ?? 0, end: b.timing?.end ?? 0 }, ad: { narration: `${a.ad.narration} ${b.ad.narration}`.trim(), lineIds: [...a.ad.lineIds, ...b.ad.lineIds] }, durationSec: sceneGenerationSeconds((b.timing?.end ?? 0) - (a.timing?.start ?? 0)) });
    await deleteSubDoc(project.id, 'shots', b.id);
  };

  const split = async (i: number) => {
    const s = scenes[i];
    if (!s || !sheet) return;
    const lines = linesInWindow(sheet, s.timing?.start ?? 0, s.timing?.end ?? 0);
    if (lines.length < 2) return;
    const mid = Math.floor(lines.length / 2);
    const cut = Math.round(Math.max(lines[mid - 1]!.end ?? 0, (lines[mid]!.start ?? 0) - 0.12) * 1000) / 1000;
    const left = lines.slice(0, mid);
    const right = lines.slice(mid);
    await updateScene(project.id, s, { timing: { start: s.timing?.start ?? 0, end: cut }, ad: { narration: left.map((l) => l.text).join(' '), lineIds: left.map((l) => l.id) }, durationSec: sceneGenerationSeconds(cut - (s.timing?.start ?? 0)) });
    await addShots(project.id, [
      { ...newShot({ order: cut, number: `${s.number}b`, title: `${s.title} (2)`, durationSec: sceneGenerationSeconds((s.timing?.end ?? 0) - cut), aspectRatio: s.aspectRatio, resolution: s.resolution, timing: { start: cut, end: s.timing?.end ?? 0 }, lockRefs: false }), ad: { ...s.ad, narration: right.map((l) => l.text).join(' '), lineIds: right.map((l) => l.id), jobId: null, validationJobId: null, validation: null, qualityRepairs: 0, lock: null } },
    ]);
  };

  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow flex items-center gap-1.5">
              <LayoutList className="size-3.5" /> Scene plan
            </p>
            <p className="mt-1 text-sm text-dim">
              {sheet && duration
                ? `${windows.length} scenes cut on sentence boundaries of the real narration; together they cover exactly ${duration.toFixed(2)} s.`
                : 'Attach the audio and extract the transcript first: scenes are cut on the narration’s real timing.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant={scenes.length ? 'ghost' : 'primary'} loading={planning} disabled={!windows.length} onClick={() => (scenes.length ? setConfirm(true) : void plan())}>
              {scenes.length ? 'Re-plan from the narration' : 'Plan scenes from the narration'}
            </Button>
            <Button variant="subtle" loading={ai.busy} disabled={!scenes.length} onClick={() => void suggest()} icon={<Sparkles className="size-4" />}>
              Suggest visuals with AI
            </Button>
          </div>
        </div>
        <CoverageBar scenes={scenes} duration={duration} />
        {problems.length > 0 && (
          <Notice tone="danger" icon={<TriangleAlert className="size-4" />}>
            {problems.join(' ')}
          </Notice>
        )}
        <p className="text-xs text-faint">Prefer real product screens and footage; generated scenes show anonymous people and never contain text — captions, the tagline and the logo are composed in the edit.</p>
      </Card>
      {scenes.length === 0 ? (
        <EmptyState title="No scenes yet" body="Plan scenes from the narration, then choose what each one shows." />
      ) : (
        <ol className="space-y-3">
          {scenes.map((s, i) => (
            <SceneEditor key={s.id} project={project} ad={ad} scene={s} index={i} next={scenes[i + 1] ?? null} onMerge={() => void merge(i)} onSplit={() => void split(i)} />
          ))}
        </ol>
      )}
      <div className="flex justify-end">
        <Button variant="primary" icon={<ArrowRight className="size-4" />} onClick={() => go('generate')} disabled={!scenes.length}>
          Generate
        </Button>
      </div>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Re-plan the storyboard?" confirmLabel="Replace scenes" danger onConfirm={() => void plan()} body={<>The {scenes.length} current scenes are removed (their generated takes stay in the library) and new scenes are cut on the narration.</>} />
      {ai.dialog}
    </div>
  );
}
