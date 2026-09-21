import { useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon, Plus, Sparkles, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import { compileImagePrompt, estimateImage, IMAGE_PURPOSES, sumEstimates, type ImagePurpose, type JobRequest, type ProjectDoc } from '@az-studio/shared';
import type { WithId } from '../lib/data';
import { useBoot } from '../lib/session';
import { useAiRun } from '../lib/ai';
import { ChainList, ChainView, useChains } from '../components/chain';
import { EstimateText, useJobSubmitter } from '../components/jobs';
import { AssetPicker, AssetThumb, useAsset, type Asset } from '../components/media';
import { ProjectHeader } from '../components/project-header';
import { Badge, Button, Card, cx, EmptyState, Field, Input, SectionHeader, Segmented, Select, Skeleton, Slider, Textarea, Toggle } from '../components/ui';

function Ref({ id, onRemove }: { id: string; onRemove: () => void }) {
  const a = useAsset(id);
  return (
    <div className="relative w-24 shrink-0">
      {a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} aspect="aspect-square" /> : <div className="aspect-square rounded-xl bg-white/5" />}
      <button type="button" onClick={onRemove} aria-label="Remove reference" className="absolute top-1 right-1 grid size-6 cursor-pointer place-items-center rounded-md bg-black/70 text-dim hover:text-fg">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

const COLLECTION_FOR: Partial<Record<ImagePurpose, string>> = { lookbook: 'lookbook', storyboard: 'storyboard', poster: 'posters', thumbnail: 'thumbnails', character: 'characters', turnaround: 'characters', costume: 'costumes', location: 'locations' };

export default function ImageStudio({ project }: { project?: WithId<ProjectDoc> }) {
  const boot = useBoot();
  const caps = boot?.capabilities.image;
  const projectId = project?.id ?? null;
  const [purpose, setPurpose] = useState<ImagePurpose>('free');
  const [prompt, setPrompt] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [aspect, setAspect] = useState(project?.format.aspectRatio === '9:16' ? '9:16' : '16:9');
  const [size, setSize] = useState(boot?.settings.defaultImageSize ?? caps?.defaultImageSize ?? '2K');
  const [variations, setVariations] = useState(1);
  const [grounding, setGrounding] = useState(false);
  const [applyStyle, setApplyStyle] = useState(true);
  const [title, setTitle] = useState('');
  const [picker, setPicker] = useState<'refs' | 'source' | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const chains = useChains('image', projectId);
  const { submit, busy, dialog } = useJobSubmitter();
  const polish = useAiRun(projectId);

  useEffect(() => {
    if (!selected && chains.data[0]) setSelected(chains.data[0].id);
  }, [chains.data, selected]);

  const full = useMemo(() => compileImagePrompt(purpose, prompt, applyStyle ? project?.styleBible ?? null : null), [purpose, prompt, applyStyle, project?.styleBible]);
  const estimate = useMemo(() => {
    if (!boot) return null;
    const one = estimateImage({ imageSize: size, referenceImages: refs.length + (source ? 1 : 0), promptChars: full.length, outputs: 1 }, boot.pricing);
    return variations > 1 ? sumEstimates(Array(variations).fill(one), boot.pricing) : one;
  }, [boot, size, refs.length, source, full.length, variations]);

  if (!boot || !caps) return <Skeleton className="h-96" />;
  const maxRefs = caps.maxReferenceImages - (source ? 1 : 0);

  const generate = async () => {
    const job: JobRequest = {
      type: 'image.generate',
      projectId,
      prompt: prompt.trim(),
      purpose,
      aspectRatio: aspect,
      imageSize: size,
      referenceAssetIds: refs,
      sourceAssetId: source,
      grounding,
      applyStyleBible: applyStyle,
      characterIds: [],
      collections: COLLECTION_FOR[purpose] ? [COLLECTION_FOR[purpose]!] : [],
      title: title.trim() || prompt.slice(0, 80),
    };
    const ids = await submit(Array(variations).fill(job), { label: `${IMAGE_PURPOSES[purpose].label} · ${variations} variation${variations > 1 ? 's' : ''}` });
    if (ids) setSelected(null);
  };

  const polishPrompt = async () => {
    const out = await polish.run<{ prompt: string; notes: string }>('prompt.polish', { prompt, kind: 'image' }, 'Polish image prompt');
    if (out?.prompt) {
      setPrompt(out.prompt);
      toast.success('Prompt polished');
    }
  };

  return (
    <div className="space-y-8">
      {project ? <ProjectHeader project={project} /> : <SectionHeader eyebrow="Create" title={<span className="text-5xl">Image Studio</span>} sub={`${caps.displayName} · generation and iterative editing up to 4K.`} />}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card className="space-y-5 p-5">
            <Field label="Purpose">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {(Object.keys(IMAGE_PURPOSES) as ImagePurpose[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPurpose(p)}
                    aria-pressed={purpose === p}
                    className={cx('cursor-pointer rounded-xl border px-3 py-2 text-left text-[13px] transition-all', purpose === p ? 'border-accent/60 bg-accent/10 text-fg' : 'border-line text-dim hover:border-line-strong hover:text-fg')}
                  >
                    {IMAGE_PURPOSES[p].label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label={source ? 'Edit instruction' : 'Describe the image'} htmlFor="img-prompt">
              <Textarea id="img-prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={source ? 'e.g. Replace the background with a rain-soaked Accra street at night; keep her pose and lighting direction.' : 'e.g. Ama, early twenties, braided crown, indigo kente wrap, standing on a Cape Coast rampart at dawn.'} />
            </Field>
            {IMAGE_PURPOSES[purpose].template && <p className="rounded-lg border border-line bg-black/20 px-3 py-2 text-xs text-faint">Preset adds: “{IMAGE_PURPOSES[purpose].template}”</p>}
            <Field label="Title (optional)" htmlFor="img-title">
              <Input id="img-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Shown in your library" />
            </Field>
          </Card>
          <Card className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <p className="eyebrow">Image to edit</p>
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setPicker('source')}>
                {source ? 'Replace' : 'Choose'}
              </Button>
            </div>
            {source ? <div className="flex gap-2"><Ref id={source} onRemove={() => setSource(null)} /></div> : <p className="text-xs text-faint">Optional — start from an existing image for image-to-image edits.</p>}
            <div className="flex items-center justify-between border-t border-line pt-4">
              <p className="eyebrow">
                References ({refs.length}/{maxRefs})
              </p>
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={refs.length >= maxRefs} onClick={() => setPicker('refs')}>
                Add
              </Button>
            </div>
            {refs.length ? (
              <div className="scroll-x flex gap-2">
                {refs.map((id) => (
                  <Ref key={id} id={id} onRemove={() => setRefs((r) => r.filter((x) => x !== id))} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-faint">Characters, wardrobe, places or style images keep results consistent (up to {caps.maxReferenceImages}).</p>
            )}
          </Card>
          <Card className="space-y-5 p-5">
            <div className="flex items-center justify-between">
              <p className="eyebrow">Output</p>
              <Badge tone="accent">{caps.displayName}</Badge>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Aspect ratio">
                <Select value={aspect} onChange={(e) => setAspect(e.target.value)} aria-label="Aspect ratio">
                  {caps.aspectRatios.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Resolution">
                <Segmented label="Image size" value={size} onChange={setSize} options={caps.imageSizes.map((s) => ({ value: s, label: s }))} />
              </Field>
              <Field label={`Variations: ${variations}`} hint="Each variation is a separate, separately billed request.">
                <Slider label="Variations" min={1} max={4} step={1} value={variations} onChange={setVariations} className="mt-2" />
              </Field>
              <div className="space-y-3 pt-1">
                {caps.supportsSearchGrounding && <Toggle checked={grounding} onChange={setGrounding} label="Ground with Google Search" description="For real-world places, products or facts." />}
                {project && <Toggle checked={applyStyle} onChange={setApplyStyle} label="Apply project style bible" />}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <EstimateText estimate={estimate} />
              <div className="flex gap-2">
                <Button variant="ghost" loading={polish.busy} disabled={!prompt.trim()} onClick={() => void polishPrompt()} icon={<Wand2 className="size-4" />}>
                  Polish prompt
                </Button>
                <Button variant="primary" loading={busy} disabled={!prompt.trim()} onClick={() => void generate()} icon={<Sparkles className="size-4" />}>
                  {source ? 'Edit image' : 'Generate'}
                </Button>
              </div>
            </div>
          </Card>
        </div>
        <div className="space-y-5">
          <SectionHeader eyebrow="Results" title="Images & edit history" />
          {chains.loading ? (
            <Skeleton className="aspect-square" />
          ) : chains.data.length === 0 ? (
            <EmptyState icon={<ImageIcon className="size-5" />} title="No images yet" body="Every image keeps its full edit history — keep refining it turn by turn." />
          ) : (
            <>
              {selected && <ChainView key={selected} chainId={selected} kind="image" projectId={projectId} />}
              <ChainList chains={chains.data} selected={selected} onSelect={setSelected} />
            </>
          )}
        </div>
      </div>
      <AssetPicker
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        kinds={['image']}
        projectId={projectId}
        multiple={picker === 'refs'}
        max={picker === 'refs' ? Math.max(1, maxRefs - refs.length) : 1}
        onPick={(assets) => (picker === 'source' ? setSource(assets[0]?.id ?? null) : setRefs((r) => [...r, ...assets.map((a) => a.id).filter((id) => !r.includes(id))].slice(0, maxRefs)))}
        title={picker === 'source' ? 'Choose an image to edit' : 'Choose reference images'}
      />
      {dialog}
      {polish.dialog}
    </div>
  );
}
