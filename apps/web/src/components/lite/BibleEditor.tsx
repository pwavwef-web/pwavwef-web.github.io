import { useState } from 'react';
import { toast } from 'sonner';
import { ImagePlus, Plus, Trash2, Wand2, X } from 'lucide-react';
import { liteId, type LiteBible, type LiteCharacter, type LiteImageStyle } from '@az-studio/shared';
import { waitForJobAssets } from '../../lib/lite';
import { useJobSubmitter } from '../jobs';
import { AssetPicker, AssetThumb, useAsset, type Asset } from '../media';
import { Button, Field, IconButton, Input, Textarea } from '../ui';

/**
 * The visual bible shared by Film Studio Lite and Music Video Lite: characters and locations with their
 * reference images, palette, light and image treatment. Every image prompt is compiled from it; approved
 * likeness references are what keep a face recognisable.
 */

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

export function References({ ids, onChange, projectId, onGenerate, generating, label }: { ids: string[]; onChange: (ids: string[]) => void; projectId: string; onGenerate?: () => void; generating?: boolean; label: string }) {
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

export interface BibleEditorProps {
  projectId: string;
  bible: LiteBible;
  imageStyle: LiteImageStyle;
  /** Applies a change to the bible (one undo step per label). */
  onChange: (fn: (b: LiteBible) => LiteBible, label: string) => void;
  /** Called when a character is removed (shots drop it). */
  onRemoveCharacter: (id: string) => void;
  /** Collection prefix for generated references (e.g. `lite` or `mvlite`). */
  collection: string;
  /** What the references are for, e.g. “film” or “music video”. */
  medium: string;
}

/** Characters, locations and the look shared by every image. */
export function BibleEditor({ projectId, bible, imageStyle, onChange, onRemoveCharacter, collection, medium }: BibleEditorProps) {
  const { submit, dialog } = useJobSubmitter();
  const [genRef, setGenRef] = useState<string | null>(null);
  const setChar = (id: string, patch: Partial<LiteCharacter>, label = 'char') => onChange((b) => ({ ...b, characters: b.characters.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), label);

  const generateReference = async (c: LiteCharacter) => {
    setGenRef(c.id);
    try {
      const ids = await submit([{ type: 'image.generate', projectId, prompt: `Character likeness reference for a ${medium}: ${c.name}. ${c.description}. Clothing: ${c.clothing || 'as described'}. Three-quarter view, neutral expression, plain softly lit background, head and shoulders, sharp focus on the face. ${imageStyle === 'illustration' || imageStyle === 'painterly' ? '' : 'Photorealistic, real person, not a cartoon or 3D render.'}`, purpose: 'character', aspectRatio: '3:4', imageSize: '2K', referenceAssetIds: c.refAssetIds.slice(0, 2), grounding: false, applyStyleBible: false, characterIds: [], collections: [`${collection}:ref`, `${collection}:character:${c.id}`], title: `${c.name} — likeness`, label: `Likeness reference · ${c.name}` }], { label: `Likeness reference · ${c.name}` });
      if (!ids?.[0]) return;
      const assets = await waitForJobAssets(ids[0]);
      onChange((b) => ({ ...b, characters: b.characters.map((x) => (x.id === c.id ? { ...x, refAssetIds: [...x.refAssetIds, ...assets].slice(0, 6) } : x)) }), 'refs');
      toast.success(`Reference added for ${c.name}`, { description: 'Remove it if the face is not right — only approved references are used.' });
    } catch (e) {
      toast.error('The reference was not added', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setGenRef(null);
    }
  };

  return (
    <div className="space-y-4">
      {bible.characters.map((c) => (
        <div key={c.id} className="rounded-xl border border-line p-3.5">
          <div className="flex items-start gap-3">
            <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)]">
              <Input aria-label="Character name" value={c.name} onChange={(e) => setChar(c.id, { name: e.target.value })} />
              <Textarea aria-label="Appearance" rows={2} value={c.description} placeholder="Age, face, hair, build…" onChange={(e) => setChar(c.id, { description: e.target.value })} />
              <Textarea aria-label="Clothing" rows={2} value={c.clothing} placeholder="Clothing (kept the same across scenes)" onChange={(e) => setChar(c.id, { clothing: e.target.value })} />
            </div>
            <IconButton label="Remove character" size="sm" onClick={() => onRemoveCharacter(c.id)}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
          <div className="mt-3">
            <References label={`references for ${c.name}`} ids={c.refAssetIds} projectId={projectId} generating={genRef === c.id} onGenerate={() => void generateReference(c)} onChange={(ids) => setChar(c.id, { refAssetIds: ids }, 'refs')} />
          </div>
        </div>
      ))}
      {bible.locations.map((l) => (
        <div key={l.id} className="rounded-xl border border-line p-3.5">
          <div className="flex items-start gap-3">
            <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-[180px_minmax(0,1fr)]">
              <Input aria-label="Location name" value={l.name} onChange={(e) => onChange((b) => ({ ...b, locations: b.locations.map((x) => (x.id === l.id ? { ...x, name: e.target.value } : x)) }), 'loc')} />
              <Textarea aria-label="Location description" rows={2} value={l.description} placeholder="Landscape, architecture, materials, time of day" onChange={(e) => onChange((b) => ({ ...b, locations: b.locations.map((x) => (x.id === l.id ? { ...x, description: e.target.value } : x)) }), 'loc')} />
            </div>
            <IconButton label="Remove location" size="sm" onClick={() => onChange((b) => ({ ...b, locations: b.locations.filter((x) => x.id !== l.id) }), 'loc')}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
          <div className="mt-3">
            <References label={`references for ${l.name}`} ids={l.refAssetIds} projectId={projectId} onChange={(ids) => onChange((b) => ({ ...b, locations: b.locations.map((x) => (x.id === l.id ? { ...x, refAssetIds: ids } : x)) }), 'refs')} />
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange((b) => ({ ...b, characters: [...b.characters, { id: liteId('ch'), name: 'New character', description: '', clothing: '', refAssetIds: [] }] }), 'char')}>
          Character
        </Button>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange((b) => ({ ...b, locations: [...b.locations, { id: liteId('lo'), name: 'New location', description: '', refAssetIds: [] }] }), 'loc')}>
          Location
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Field label="Palette">
          <Input value={bible.palette} onChange={(e) => onChange((b) => ({ ...b, palette: e.target.value }), 'palette')} />
        </Field>
        <Field label="Lighting">
          <Input value={bible.lighting} onChange={(e) => onChange((b) => ({ ...b, lighting: e.target.value }), 'lighting')} />
        </Field>
        <Field label="Image treatment" className="lg:col-span-2">
          <Textarea rows={2} value={bible.imageTreatment} onChange={(e) => onChange((b) => ({ ...b, imageTreatment: e.target.value }), 'treatment')} />
        </Field>
        <Field label="Avoid">
          <Input value={bible.avoid} onChange={(e) => onChange((b) => ({ ...b, avoid: e.target.value }), 'avoid')} />
        </Field>
        <Field label="Style references" hint="Match their look, not their content.">
          <References label="style references" ids={bible.styleRefAssetIds} projectId={projectId} onChange={(ids) => onChange((b) => ({ ...b, styleRefAssetIds: ids.slice(0, 2) }), 'refs')} />
        </Field>
      </div>
      {dialog}
    </div>
  );
}
