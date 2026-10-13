import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { BookOpen, FileText, ImagePlus, Import, Plus, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import {
  LITE_DIRECTION_PRESETS,
  LITE_DIRECTIONS,
  LITE_DURATION,
  LITE_IMAGE_STYLE_LABELS,
  LITE_IMAGE_STYLES,
  LITE_LANGUAGES,
  applyDirection,
  clampDuration,
  estimateNarrationSec,
  liteId,
  scriptParagraphs,
  speechLanguageSupported,
  targetWords,
  wordCount,
  type LiteAspect,
  type LiteCharacter,
  type LiteImageStyle,
  type LiteLocation,
  type LiteSpec,
} from '@az-studio/shared';
import { useAiRun } from '../../lib/ai';
import { fountainToNarration, readFilmForImport, waitForJobAssets } from '../../lib/lite';
import { useProjects } from '../../lib/studio';
import { useJobSubmitter } from '../../components/jobs';
import { AssetPicker, AssetThumb, useAsset, type Asset } from '../../components/media';
import { Badge, Button, cx, Field, IconButton, Input, Modal, Notice, Segmented, Select, Textarea } from '../../components/ui';
import { fmtSec, LabeledSlider, Section, type StageProps } from './common';

interface TreatmentOut {
  title?: string;
  logline?: string;
  synopsis?: string;
  beginning?: string;
  development?: string;
  turns?: string[];
  ending?: string;
  tone?: string;
  paragraphs?: string[];
  characters?: { name?: string; description?: string; clothing?: string }[];
  locations?: { name?: string; description?: string }[];
  palette?: string;
  lighting?: string;
  imageTreatment?: string;
  pronunciation?: { term?: string; sayAs?: string }[];
  notes?: string;
}

function RefThumb({ assetId, onRemove }: { assetId: string; onRemove: () => void }) {
  const a = useAsset(assetId);
  return (
    <div className="relative w-20 shrink-0">
      {a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} aspect="aspect-[3/4]" hoverPlay={false} /> : <div className="aspect-[3/4] animate-pulse rounded-lg bg-panel-2" />}
      <button type="button" onClick={onRemove} aria-label="Remove reference" className="absolute -top-1.5 -right-1.5 grid size-5 cursor-pointer place-items-center rounded-full bg-black/80 text-white hover:bg-danger">
        <X className="size-3" />
      </button>
    </div>
  );
}

function References({ ids, onChange, projectId, onGenerate, generating, label }: { ids: string[]; onChange: (ids: string[]) => void; projectId: string; onGenerate?: () => void; generating?: boolean; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        {ids.map((id) => (
          <RefThumb key={id} assetId={id} onRemove={() => onChange(ids.filter((x) => x !== id))} />
        ))}
        <button type="button" onClick={() => setOpen(true)} className="grid aspect-[3/4] w-20 cursor-pointer place-items-center rounded-lg border border-dashed border-line text-faint hover:border-line-strong hover:text-dim" aria-label={`Add ${label}`}>
          <ImagePlus className="size-5" />
        </button>
        {onGenerate && (
          <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />} loading={generating} onClick={onGenerate}>
            Generate reference
          </Button>
        )}
      </div>
      <AssetPicker open={open} onOpenChange={setOpen} kinds={['image']} projectId={projectId} multiple max={4} initial={[]} title={`Choose ${label}`} onPick={(as) => onChange([...new Set([...ids, ...as.map((a) => a.id)])].slice(0, 6))} />
    </div>
  );
}

function ImportFilmDialog({ open, onOpenChange, onImport }: { open: boolean; onOpenChange: (o: boolean) => void; onImport: (id: string) => Promise<void> }) {
  const films = useProjects({ type: 'film' });
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Import from Film Studio" description="Copies the treatment, the latest script, characters and locations with their reference images. The original project is not changed.">
      {films.data.length === 0 ? (
        <p className="text-sm text-faint">You have no Film Studio projects yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {films.data.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-fg">{f.title}</p>
                <p className="truncate text-xs text-faint">{f.logline || 'No logline'}</p>
              </div>
              <Button
                size="sm"
                loading={busy === f.id}
                onClick={async () => {
                  setBusy(f.id);
                  try {
                    await onImport(f.id);
                    onOpenChange(false);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Import
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function StoryStage({ project, spec, update, go }: StageProps) {
  const ai = useAiRun(project.id);
  const { submit, dialog } = useJobSubmitter();
  const [importOpen, setImportOpen] = useState(false);
  const [genRef, setGenRef] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const d = LITE_DIRECTION_PRESETS[spec.setup.direction];
  const set = (fn: (s: LiteSpec) => LiteSpec, label = 'story') => update(fn, label);
  const paragraphs = scriptParagraphs(spec.story.script);
  const words = wordCount(spec.story.script);
  const spoken = estimateNarrationSec(spec.story.script, spec.setup.wordsPerMinute);
  const goal = targetWords(spec);
  const custom = !(LITE_DURATION.presets as readonly number[]).includes(spec.setup.targetSec);

  const writeTreatment = async () => {
    const out = await ai.run<TreatmentOut>(
      'lite.treatment',
      {
        idea: spec.story.idea,
        sourceText: spec.story.sourceText,
        script: spec.story.script,
        direction: { name: d.label, visual: d.visual, narration: d.narration, music: d.music.style },
        structure: d.structure,
        targetSec: spec.setup.targetSec,
        wordsPerMinute: spec.setup.wordsPerMinute,
        targetWords: goal,
        language: spec.setup.language,
        characters: spec.bible.characters.map((c) => ({ name: c.name, description: c.description, clothing: c.clothing })),
      },
      'Story treatment and narration',
    );
    if (!out) return;
    set((s) => {
      let chars: LiteCharacter[] = [...s.bible.characters];
      for (const c of out.characters ?? []) {
        if (!c.name?.trim()) continue;
        const key = c.name.trim().toLowerCase();
        if (chars.some((x) => x.name.toLowerCase() === key)) chars = chars.map((x) => (x.name.toLowerCase() === key ? { ...x, description: x.description || c.description || '', clothing: x.clothing || c.clothing || '' } : x));
        else chars.push({ id: liteId('ch'), name: c.name.trim(), description: c.description ?? '', clothing: c.clothing ?? '', refAssetIds: [] });
      }
      const locs: LiteLocation[] = [...s.bible.locations];
      for (const l of out.locations ?? []) if (l.name?.trim() && !locs.some((x) => x.name.toLowerCase() === l.name!.trim().toLowerCase())) locs.push({ id: liteId('lo'), name: l.name.trim(), description: l.description ?? '', refAssetIds: [] });
      const pron = [...s.pronunciation];
      for (const p of out.pronunciation ?? []) if (p.term?.trim() && p.sayAs?.trim() && !pron.some((x) => x.term.toLowerCase() === p.term!.toLowerCase())) pron.push({ id: liteId('pr'), term: p.term.trim(), sayAs: p.sayAs.trim(), note: 'Suggested — check by ear' });
      return {
        ...s,
        story: {
          ...s.story,
          treatment: { title: out.title ?? '', logline: out.logline ?? '', synopsis: out.synopsis ?? '', beginning: out.beginning ?? '', development: out.development ?? '', turns: out.turns ?? [], ending: out.ending ?? '', tone: out.tone ?? '' },
          script: out.paragraphs?.length ? out.paragraphs.map((p) => p.trim()).filter(Boolean).join('\n\n') : s.story.script,
          scriptApprovedAt: null,
        },
        bible: { ...s.bible, characters: chars, locations: locs, palette: out.palette || s.bible.palette, lighting: out.lighting || s.bible.lighting, imageTreatment: out.imageTreatment || s.bible.imageTreatment },
        pronunciation: pron,
      };
    }, 'treatment');
    if (out.notes) toast.message('Notes from the writer', { description: out.notes.slice(0, 400) });
  };

  const importFilm = async (id: string) => {
    try {
      const f = await readFilmForImport(id);
      set((s) => ({
        ...s,
        story: { ...s.story, idea: s.story.idea || f.idea, script: s.story.script || fountainToNarration(f.script) },
        bible: {
          ...s.bible,
          characters: [...s.bible.characters, ...f.characters.filter((c) => !s.bible.characters.some((x) => x.name.toLowerCase() === c.name.toLowerCase())).map((c) => ({ ...c, id: liteId('ch') }))],
          locations: [...s.bible.locations, ...f.locations.filter((l) => !s.bible.locations.some((x) => x.name.toLowerCase() === l.name.toLowerCase())).map((l) => ({ ...l, id: liteId('lo') }))],
        },
        importedFrom: { projectId: id, title: f.title, at: Date.now() },
      }), 'import');
      toast.success(`Imported from “${f.title}”`, { description: `${f.characters.length} characters, ${f.locations.length} locations${f.script ? ', the script' : ''}. The original is unchanged.` });
    } catch (e) {
      toast.error('Import failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const readSource = async (file: File) => {
    if (file.size > 2_000_000) return toast.error('That file is larger than 2 MB of text.');
    const text = await file.text();
    set((s) => ({ ...s, story: { ...s.story, sourceText: text.slice(0, 200_000) } }), 'source');
    toast.success(`Read “${file.name}”`, { description: `${wordCount(text).toLocaleString()} words of source text.` });
  };

  const generateReference = async (c: LiteCharacter) => {
    setGenRef(c.id);
    try {
      const ids = await submit([{ type: 'image.generate', projectId: project.id, prompt: `Character likeness reference for a film: ${c.name}. ${c.description}. Clothing: ${c.clothing || 'as described'}. Three-quarter view, neutral expression, plain softly lit background, head and shoulders, sharp focus on the face. ${spec.setup.imageStyle === 'illustration' || spec.setup.imageStyle === 'painterly' ? '' : 'Photorealistic, real person, not a cartoon or 3D render.'}`, purpose: 'character', aspectRatio: '3:4', imageSize: '2K', referenceAssetIds: c.refAssetIds.slice(0, 2), grounding: false, applyStyleBible: false, characterIds: [], collections: ['lite:ref', `lite:character:${c.id}`], title: `${c.name} — likeness`, label: `Likeness reference · ${c.name}` }], { label: `Likeness reference · ${c.name}` });
      if (!ids?.[0]) return;
      const assets = await waitForJobAssets(ids[0]);
      set((s) => ({ ...s, bible: { ...s.bible, characters: s.bible.characters.map((x) => (x.id === c.id ? { ...x, refAssetIds: [...x.refAssetIds, ...assets].slice(0, 6) } : x)) } }), 'refs');
      toast.success(`Reference added for ${c.name}`, { description: 'Remove it if the face is not right — only approved references are used.' });
    } catch (e) {
      toast.error('The reference was not added', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setGenRef(null);
    }
  };

  return (
    <>
      <Section
        title="Starting point"
        sub="An idea, a full script, source text — or all three. Existing images can be added on the Scenes stage."
        action={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={<Import className="size-3.5" />} onClick={() => setImportOpen(true)}>
              From Film Studio
            </Button>
            <Button size="sm" variant="ghost" icon={<FileText className="size-3.5" />} onClick={() => fileInput.current?.click()}>
              Source text file
            </Button>
            <input ref={fileInput} type="file" accept=".txt,.md,.fountain,text/plain,text/markdown" className="hidden" onChange={(e) => e.target.files?.[0] && void readSource(e.target.files[0])} />
          </div>
        }
      >
        {spec.importedFrom && <Notice className="mb-3">Material imported from “{spec.importedFrom.title}” (the original project was not changed).</Notice>}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Field label="Story idea" htmlFor="lite-idea">
            <Textarea id="lite-idea" rows={5} value={spec.story.idea} onChange={(e) => set((s) => ({ ...s, story: { ...s.story, idea: e.target.value } }), 'idea')} placeholder="e.g. A girl in a Kasena village learns why her grandmother keeps the river stones." />
          </Field>
          <Field label="Source text" htmlFor="lite-source" hint={spec.story.sourceText ? `${wordCount(spec.story.sourceText).toLocaleString()} words — facts and voice to draw on` : 'Optional: an article, notes, an oral history transcript.'}>
            <Textarea id="lite-source" rows={5} value={spec.story.sourceText} onChange={(e) => set((s) => ({ ...s, story: { ...s.story, sourceText: e.target.value } }), 'source')} />
          </Field>
        </div>
      </Section>

      <Section title="Direction and format" sub="A direction shapes planning, imagery, pacing and sound — not just a filter. Every value can be changed later.">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Direction">
          {LITE_DIRECTIONS.map((id) => {
            const p = LITE_DIRECTION_PRESETS[id];
            const on = spec.setup.direction === id;
            return (
              <button key={id} type="button" role="radio" aria-checked={on} onClick={() => update((s) => applyDirection(s, id), 'direction')} className={cx('cursor-pointer rounded-xl border p-3.5 text-left transition-colors', on ? 'border-accent/60 bg-accent/10' : 'border-line hover:border-line-strong')}>
                <p className="text-sm font-medium text-fg">{p.label}</p>
                <p className="mt-0.5 text-xs text-dim">{p.blurb}</p>
                <p className="mt-2 text-[11px] text-faint">
                  {p.wordsPerMinute} wpm · shots {p.shotSec[0]}–{p.shotSec[1]} s · {p.music.instrumentation.slice(0, 2).join(', ')}
                </p>
              </button>
            );
          })}
        </div>
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Field label="Length" hint={`An estimate until the narration exists; then it is measured. Up to ${LITE_DURATION.max / 60} minutes.`}>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented label="Length" value={custom ? 'custom' : String(spec.setup.targetSec)} onChange={(v) => v !== 'custom' && set((s) => ({ ...s, setup: { ...s.setup, targetSec: Number(v) } }), 'length')} options={[...LITE_DURATION.presets.map((p) => ({ value: String(p), label: `${p / 60} min` })), { value: 'custom', label: 'Custom' }]} />
              <Input type="number" min={LITE_DURATION.min / 60} max={LITE_DURATION.max / 60} step={0.5} className="!w-24" aria-label="Length in minutes" value={Math.round((spec.setup.targetSec / 60) * 10) / 10} onChange={(e) => set((s) => ({ ...s, setup: { ...s.setup, targetSec: clampDuration(Number(e.target.value) * 60) } }), 'length')} />
              <span className="text-xs text-faint">minutes</span>
            </div>
          </Field>
          <Field label="Format" hint="Landscape suits longer films. Extra formats reuse the same timing with their own framing and subtitle placement.">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented label="Primary format" value={spec.setup.aspect} onChange={(a: LiteAspect) => set((s) => ({ ...s, setup: { ...s.setup, aspect: a, extraAspects: s.setup.extraAspects.filter((x) => x !== a) } }), 'aspect')} options={[{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }]} />
              <span className="text-xs text-faint">Also export</span>
              {(['16:9', '9:16', '1:1'] as const)
                .filter((a) => a !== spec.setup.aspect)
                .map((a) => (
                  <label key={a} className="inline-flex items-center gap-1.5 text-xs text-dim">
                    <input type="checkbox" checked={spec.setup.extraAspects.includes(a)} onChange={(e) => set((s) => ({ ...s, setup: { ...s.setup, extraAspects: e.target.checked ? [...s.setup.extraAspects, a] : s.setup.extraAspects.filter((x) => x !== a) } }), 'aspect')} />
                    {a}
                  </label>
                ))}
            </div>
          </Field>
          <Field label="Image style">
            <Segmented label="Image style" value={spec.setup.imageStyle} onChange={(v: LiteImageStyle) => set((s) => ({ ...s, setup: { ...s.setup, imageStyle: v } }), 'style')} options={LITE_IMAGE_STYLES.map((v) => ({ value: v, label: LITE_IMAGE_STYLE_LABELS[v] }))} />
          </Field>
          <Field label="Visual plan" hint="Economical reframes one image for a second shot where it truly works; rich uses a new image for most shots.">
            <Segmented label="Visual plan" value={spec.setup.visualPlan} onChange={(v: 'economical' | 'rich') => set((s) => ({ ...s, setup: { ...s.setup, visualPlan: v } }), 'plan')} options={[{ value: 'economical', label: 'Economical' }, { value: 'rich', label: 'Rich' }]} />
          </Field>
          <Field label="Image resolution" hint={spec.setup.extraAspects.length && spec.setup.imageSize === '2K' ? 'Other formats crop the image — 4K keeps them sharp (each image costs more).' : '2K is sharp for 1080p with gentle movement.'}>
            <Segmented label="Image resolution" value={spec.setup.imageSize} onChange={(v: '2K' | '4K') => set((s) => ({ ...s, setup: { ...s.setup, imageSize: v } }), 'size')} options={[{ value: '2K', label: '2K' }, { value: '4K', label: '4K' }]} />
          </Field>
          <Field label="Frame rate">
            <Segmented label="Frame rate" value={String(spec.setup.fps) as '24' | '25' | '30'} onChange={(v) => set((s) => ({ ...s, setup: { ...s.setup, fps: Number(v) as 24 | 25 | 30 } }), 'fps')} options={[{ value: '24', label: '24 fps (cinematic)' }, { value: '25', label: '25' }, { value: '30', label: '30' }]} />
          </Field>
          <Field label="Narration language" hint={speechLanguageSupported(spec.setup.language) ? 'Supported by the studio voices.' : 'The studio voices do not document this language — record or upload the narration for native pronunciation.'}>
            <Select value={spec.setup.language} onChange={(e) => set((s) => ({ ...s, setup: { ...s.setup, language: e.target.value } }), 'language')} aria-label="Narration language">
              {LITE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <LabeledSlider label="Speaking pace (for estimates)" value={spec.setup.wordsPerMinute} display={`${spec.setup.wordsPerMinute} words/min`} min={90} max={190} step={5} onChange={(v) => set((s) => ({ ...s, setup: { ...s.setup, wordsPerMinute: v } }), 'pace')} />
        </div>
      </Section>

      <Section
        title="Treatment and narration"
        sub="Paragraphs become scenes. Length is estimated from your speaking pace until the voice is recorded."
        action={
          <Button variant="primary" icon={<Sparkles className="size-4" />} loading={ai.busy} disabled={!spec.story.idea.trim() && !spec.story.script.trim() && !spec.story.sourceText.trim()} onClick={() => void writeTreatment()}>
            {spec.story.script.trim() ? 'Write treatment around my script' : 'Write treatment & narration'}
          </Button>
        }
      >
        {spec.story.treatment && (
          <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {(['logline', 'synopsis', 'beginning', 'development', 'ending', 'tone'] as const).map((k) => (
              <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)} htmlFor={`tr-${k}`}>
                <Textarea id={`tr-${k}`} rows={k === 'synopsis' || k === 'development' ? 3 : 2} value={spec.story.treatment![k]} onChange={(e) => set((s) => ({ ...s, story: { ...s.story, treatment: { ...s.story.treatment!, [k]: e.target.value } } }), `tr-${k}`)} />
              </Field>
            ))}
            <Field label="Emotional turns" className="lg:col-span-2">
              <Textarea rows={2} value={spec.story.treatment.turns.join('\n')} onChange={(e) => set((s) => ({ ...s, story: { ...s.story, treatment: { ...s.story.treatment!, turns: e.target.value.split('\n') } } }), 'tr-turns')} aria-label="Emotional turns, one per line" />
            </Field>
          </div>
        )}
        <Field label="Narration script" htmlFor="lite-script" hint="Leave a blank line between paragraphs. Write for the ear; punctuation shapes the pauses.">
          <Textarea id="lite-script" rows={14} className="font-[450] leading-relaxed" value={spec.story.script} onChange={(e) => set((s) => ({ ...s, story: { ...s.story, script: e.target.value, scriptApprovedAt: null } }), 'script')} />
        </Field>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={words > goal * 1.15 ? 'warning' : 'neutral'}>{words.toLocaleString()} / ≈{goal.toLocaleString()} words</Badge>
          <Badge>{paragraphs.length} paragraph{paragraphs.length === 1 ? '' : 's'}</Badge>
          <Badge>≈ {fmtSec(spoken)} spoken (estimate)</Badge>
          {words > goal * 1.15 && <span className="text-warning">Longer than the target leaves little room for pauses.</span>}
          <span className="flex-1" />
          <Button size="sm" variant="secondary" disabled={!paragraphs.length} onClick={() => go('scenes')}>
            Plan scenes →
          </Button>
        </div>
      </Section>

      <Section title="Visual bible" sub="Used in every image prompt. Approved likeness references keep a character recognisable — text alone cannot guarantee the same face.">
        <div className="space-y-4">
          {spec.bible.characters.map((c) => (
            <div key={c.id} className="rounded-xl border border-line p-3.5">
              <div className="flex items-start gap-3">
                <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)]">
                  <Input aria-label="Character name" value={c.name} onChange={(e) => set((s) => ({ ...s, bible: { ...s.bible, characters: s.bible.characters.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)) } }), 'char')} />
                  <Textarea aria-label="Appearance" rows={2} value={c.description} placeholder="Age, face, hair, build…" onChange={(e) => set((s) => ({ ...s, bible: { ...s.bible, characters: s.bible.characters.map((x) => (x.id === c.id ? { ...x, description: e.target.value } : x)) } }), 'char')} />
                  <Textarea aria-label="Clothing" rows={2} value={c.clothing} placeholder="Clothing (kept the same across scenes)" onChange={(e) => set((s) => ({ ...s, bible: { ...s.bible, characters: s.bible.characters.map((x) => (x.id === c.id ? { ...x, clothing: e.target.value } : x)) } }), 'char')} />
                </div>
                <IconButton label="Remove character" size="sm" onClick={() => set((s) => ({ ...s, bible: { ...s.bible, characters: s.bible.characters.filter((x) => x.id !== c.id) }, scenes: s.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((sh) => ({ ...sh, characterIds: sh.characterIds.filter((x) => x !== c.id) })) })) }), 'char')}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
              <div className="mt-3">
                <References label={`references for ${c.name}`} ids={c.refAssetIds} projectId={project.id} generating={genRef === c.id} onGenerate={() => void generateReference(c)} onChange={(ids) => set((s) => ({ ...s, bible: { ...s.bible, characters: s.bible.characters.map((x) => (x.id === c.id ? { ...x, refAssetIds: ids } : x)) } }), 'refs')} />
              </div>
            </div>
          ))}
          {spec.bible.locations.map((l) => (
            <div key={l.id} className="rounded-xl border border-line p-3.5">
              <div className="flex items-start gap-3">
                <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-[180px_minmax(0,1fr)]">
                  <Input aria-label="Location name" value={l.name} onChange={(e) => set((s) => ({ ...s, bible: { ...s.bible, locations: s.bible.locations.map((x) => (x.id === l.id ? { ...x, name: e.target.value } : x)) } }), 'loc')} />
                  <Textarea aria-label="Location description" rows={2} value={l.description} placeholder="Landscape, architecture, materials, time of day" onChange={(e) => set((s) => ({ ...s, bible: { ...s.bible, locations: s.bible.locations.map((x) => (x.id === l.id ? { ...x, description: e.target.value } : x)) } }), 'loc')} />
                </div>
                <IconButton label="Remove location" size="sm" onClick={() => set((s) => ({ ...s, bible: { ...s.bible, locations: s.bible.locations.filter((x) => x.id !== l.id) } }), 'loc')}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
              <div className="mt-3">
                <References label={`references for ${l.name}`} ids={l.refAssetIds} projectId={project.id} onChange={(ids) => set((s) => ({ ...s, bible: { ...s.bible, locations: s.bible.locations.map((x) => (x.id === l.id ? { ...x, refAssetIds: ids } : x)) } }), 'refs')} />
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set((s) => ({ ...s, bible: { ...s.bible, characters: [...s.bible.characters, { id: liteId('ch'), name: 'New character', description: '', clothing: '', refAssetIds: [] }] } }), 'char')}>
              Character
            </Button>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set((s) => ({ ...s, bible: { ...s.bible, locations: [...s.bible.locations, { id: liteId('lo'), name: 'New location', description: '', refAssetIds: [] }] } }), 'loc')}>
              Location
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Field label="Palette">
              <Input value={spec.bible.palette} onChange={(e) => set((s) => ({ ...s, bible: { ...s.bible, palette: e.target.value } }), 'palette')} />
            </Field>
            <Field label="Lighting">
              <Input value={spec.bible.lighting} onChange={(e) => set((s) => ({ ...s, bible: { ...s.bible, lighting: e.target.value } }), 'lighting')} />
            </Field>
            <Field label="Image treatment" className="lg:col-span-2">
              <Textarea rows={2} value={spec.bible.imageTreatment} onChange={(e) => set((s) => ({ ...s, bible: { ...s.bible, imageTreatment: e.target.value } }), 'treatment')} />
            </Field>
            <Field label="Avoid">
              <Input value={spec.bible.avoid} onChange={(e) => set((s) => ({ ...s, bible: { ...s.bible, avoid: e.target.value } }), 'avoid')} />
            </Field>
            <Field label="Style references" hint="Match their look, not their content.">
              <References label="style references" ids={spec.bible.styleRefAssetIds} projectId={project.id} onChange={(ids) => set((s) => ({ ...s, bible: { ...s.bible, styleRefAssetIds: ids.slice(0, 2) } }), 'refs')} />
            </Field>
          </div>
        </div>
      </Section>

      <Section title="Pronunciation" sub="How the voice should say names and words. Subtitles always keep the written spelling. Check by ear — guidance cannot guarantee native pronunciation.">
        <div className="space-y-2">
          {spec.pronunciation.map((p) => (
            <div key={p.id} className="grid grid-cols-[1fr_1fr_1.4fr_auto] items-center gap-2">
              <Input aria-label="Written" value={p.term} placeholder="Written (e.g. Kasena)" onChange={(e) => set((s) => ({ ...s, pronunciation: s.pronunciation.map((x) => (x.id === p.id ? { ...x, term: e.target.value } : x)) }), 'pron')} />
              <Input aria-label="Say as" value={p.sayAs} placeholder="Say as (e.g. Kah-SEH-nah)" onChange={(e) => set((s) => ({ ...s, pronunciation: s.pronunciation.map((x) => (x.id === p.id ? { ...x, sayAs: e.target.value } : x)) }), 'pron')} />
              <Input aria-label="Note" value={p.note} placeholder="Note" onChange={(e) => set((s) => ({ ...s, pronunciation: s.pronunciation.map((x) => (x.id === p.id ? { ...x, note: e.target.value } : x)) }), 'pron')} />
              <IconButton label="Remove" size="sm" onClick={() => set((s) => ({ ...s, pronunciation: s.pronunciation.filter((x) => x.id !== p.id) }), 'pron')}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<BookOpen className="size-3.5" />} onClick={() => set((s) => ({ ...s, pronunciation: [...s.pronunciation, { id: liteId('pr'), term: '', sayAs: '', note: '' }] }), 'pron')}>
            Add pronunciation
          </Button>
        </div>
      </Section>
      <ImportFilmDialog open={importOpen} onOpenChange={setImportOpen} onImport={importFilm} />
      {ai.dialog}
      {dialog}
    </>
  );
}
