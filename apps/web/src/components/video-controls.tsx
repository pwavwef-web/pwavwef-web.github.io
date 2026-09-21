import { useId, useMemo, useState, type ReactNode } from 'react';
import { Film, Image as ImageIcon, Info, Minus, Plus, X } from 'lucide-react';
import { DIRECTION_OPTIONS, planOmniMedia, type DialogueLine, type OmniMediaRef, type ShotDirections, type VideoCapabilities } from '@az-studio/shared';
import { AssetPicker, AssetThumb, useAsset, type Asset } from './media';
import { Button, cx, Field, IconButton, Input, Notice, Segmented, Select, Slider, Textarea, Tip } from './ui';

/** Text input with a curated suggestion list (free text allowed). */
export function Suggest({ label, value, onChange, options, placeholder }: { label: string; value: string; onChange: (v: string) => void; options: readonly string[]; placeholder?: string }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <Input id={id} list={`${id}-list`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? 'Choose or type…'} />
      <datalist id={`${id}-list`}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </Field>
  );
}

export function DirectionsEditor({ value, onChange, compact }: { value: ShotDirections; onChange: (d: ShotDirections) => void; compact?: boolean }) {
  const set = <K extends keyof ShotDirections>(k: K, v: ShotDirections[K]) => onChange({ ...value, [k]: v });
  const setLine = (i: number, patch: Partial<DialogueLine>) => set('dialogue', value.dialogue.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-4">
      <div className={cx('grid gap-3', compact ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3')}>
        <Suggest label="Framing" value={value.framing} onChange={(v) => set('framing', v)} options={DIRECTION_OPTIONS.framing} />
        <Suggest label="Camera movement" value={value.cameraMovement} onChange={(v) => set('cameraMovement', v)} options={DIRECTION_OPTIONS.cameraMovement} />
        <Suggest label="Lens" value={value.lens} onChange={(v) => set('lens', v)} options={DIRECTION_OPTIONS.lens} />
        <Suggest label="Lighting" value={value.lighting} onChange={(v) => set('lighting', v)} options={DIRECTION_OPTIONS.lighting} />
        <Suggest label="Mood" value={value.mood} onChange={(v) => set('mood', v)} options={DIRECTION_OPTIONS.mood} />
        <Suggest label="Visual style" value={value.style} onChange={(v) => set('style', v)} options={DIRECTION_OPTIONS.style} />
      </div>
      <Field label="Performance direction">
        <Input value={value.performance} onChange={(e) => set('performance', e.target.value)} placeholder="e.g. Quiet confidence; she holds his gaze before smiling" />
      </Field>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12.5px] font-medium text-dim">Dialogue</span>
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set('dialogue', [...value.dialogue, { character: '', line: '' }])}>
            Add line
          </Button>
        </div>
        {value.dialogue.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-faint">No dialogue — the prompt will say “No dialogue.”</p>
        ) : (
          <div className="space-y-2">
            {value.dialogue.map((l, i) => (
              <div key={i} className="flex gap-2">
                <Input className="w-36 shrink-0" value={l.character} onChange={(e) => setLine(i, { character: e.target.value })} placeholder="Character" aria-label={`Speaker ${i + 1}`} />
                <Input value={l.line} onChange={(e) => setLine(i, { line: e.target.value })} placeholder="Line of dialogue" aria-label={`Line ${i + 1}`} />
                <IconButton label="Remove line" onClick={() => set('dialogue', value.dialogue.filter((_, k) => k !== i))}>
                  <Minus className="size-4" />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ambient sound & effects">
          <Input value={value.ambientSound} onChange={(e) => set('ambientSound', e.target.value)} placeholder="e.g. market chatter, distant highlife guitar" />
        </Field>
        <Field label="Avoid" hint="Omni has no negative prompt — this becomes “Do not …”.">
          <Input value={value.avoid} onChange={(e) => set('avoid', e.target.value)} placeholder="e.g. text on screen, lens flares" />
        </Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reference media slots
// ---------------------------------------------------------------------------

function RefChip({ assetId, tag, onRemove }: { assetId: string; tag: string; onRemove: () => void }) {
  const a = useAsset(assetId);
  return (
    <div className="relative w-32 shrink-0">
      {a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} hoverPlay={false} /> : <div className="aspect-video rounded-xl bg-white/5" />}
      <span className="timecode absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-accent-2">{tag || 'source'}</span>
      <button type="button" onClick={onRemove} aria-label="Remove reference" className="absolute top-1.5 right-1.5 grid size-6 cursor-pointer place-items-center rounded-md bg-black/70 text-dim hover:text-fg">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function ReferenceSlots({ caps, media, onChange, projectId, allowSource }: { caps: VideoCapabilities; media: OmniMediaRef[]; onChange: (m: OmniMediaRef[]) => void; projectId?: string | null; allowSource?: boolean }) {
  const [picker, setPicker] = useState<null | { role: OmniMediaRef['role']; kinds: ('image' | 'video')[]; max: number }>(null);
  const planned = useMemo(() => planOmniMedia(media), [media]);
  const tagFor = (assetId: string, role: string) => planned.media.find((m) => m.assetId === assetId && m.role === role)?.tag ?? '';
  const count = (role: OmniMediaRef['role']) => media.filter((m) => m.role === role).length;
  const images = planned.media.filter((m) => m.kind === 'image').length;
  const videos = planned.media.filter((m) => m.kind === 'video').length;
  const remove = (assetId: string, role: string) => onChange(media.filter((m) => !(m.assetId === assetId && m.role === role)));
  const add = (role: OmniMediaRef['role'], assets: Asset[], replace = false) => {
    const rest = replace ? media.filter((m) => m.role !== role) : media;
    onChange([...rest, ...assets.map((a) => ({ role, assetId: a.id, label: a.title }))]);
  };

  const slot = (role: OmniMediaRef['role'], label: string, icon: ReactNode, opts: { kinds: ('image' | 'video')[]; max: number; single?: boolean; hint: string; disabled?: boolean }) => (
    <div className="rounded-xl border border-line bg-black/15 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-dim">
          {icon}
          {label}
          <Tip label={opts.hint}>
            <Info className="size-3.5 text-faint" aria-label={opts.hint} />
          </Tip>
        </p>
        <Button size="sm" variant="ghost" disabled={opts.disabled || (!opts.single && count(role) >= opts.max)} onClick={() => setPicker({ role, kinds: opts.kinds, max: opts.single ? 1 : opts.max - count(role) })} icon={<Plus className="size-3.5" />}>
          {opts.single && count(role) ? 'Replace' : 'Add'}
        </Button>
      </div>
      {count(role) === 0 ? (
        <p className="text-xs text-faint">None</p>
      ) : (
        <div className="scroll-x flex gap-2">
          {media
            .filter((m) => m.role === role)
            .map((m) => (
              <RefChip key={`${m.role}-${m.assetId}`} assetId={m.assetId} tag={tagFor(m.assetId, role)} onRemove={() => remove(m.assetId, role)} />
            ))}
        </div>
      )}
    </div>
  );

  const hasFirst = count('first_frame') > 0;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        {slot('first_frame', 'First frame', <ImageIcon className="size-3.5" />, { kinds: ['image'], max: 1, single: true, hint: 'The video starts on exactly this image (image-to-video).' })}
        {slot('last_frame', 'Last frame', <ImageIcon className="size-3.5" />, { kinds: ['image'], max: 1, single: true, disabled: !hasFirst, hint: 'The video ends on this image. Requires a first frame.' })}
      </div>
      {slot('image_ref', 'Image references', <ImageIcon className="size-3.5" />, { kinds: ['image'], max: Math.max(0, caps.maxImageInputs - (hasFirst ? 1 : 0) - (count('last_frame') ? 1 : 0)), hint: `Characters, objects, places or style (up to ${caps.maxImageInputs} images total). Mention their tags in the prompt.` })}
      {slot('video_ref', 'Video references', <Film className="size-3.5" />, { kinds: ['video'], max: caps.maxVideoInputs - (count('source_video') ? 1 : 0), hint: `Up to ${caps.maxVideoInputs} clips of ≤${caps.maxVideoRefSeconds}s each — best for likeness and motion. Their audio is ignored.` })}
      {allowSource && slot('source_video', 'Source video (to edit/extend)', <Film className="size-3.5" />, { kinds: ['video'], max: 1, single: true, hint: `Uploaded clips must be ≤${caps.maxEditInputSeconds}s. Use the trimmer for longer footage.` })}
      <p className="text-[11px] text-faint">
        {images}/{caps.maxImageInputs} images · {videos}/{caps.maxVideoInputs} videos. {caps.supportsAudioInput ? '' : 'Audio files are not accepted by this model.'}
      </p>
      {picker && (
        <AssetPicker
          open
          onOpenChange={(o) => !o && setPicker(null)}
          kinds={picker.kinds}
          projectId={projectId ?? null}
          multiple={picker.max > 1}
          max={Math.max(1, picker.max)}
          onPick={(assets) => add(picker.role, assets, picker.role === 'first_frame' || picker.role === 'last_frame' || picker.role === 'source_video')}
          title="Choose reference media"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model controls
// ---------------------------------------------------------------------------

export interface VideoSettings {
  aspectRatio: string;
  resolution: string;
  durationSec: number;
  takes: number;
}

export function VideoModelControls({ caps, value, onChange, showDuration = true, showTakes = true, durationLabel = 'Duration' }: { caps: VideoCapabilities; value: VideoSettings; onChange: (v: VideoSettings) => void; showDuration?: boolean; showTakes?: boolean; durationLabel?: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Aspect ratio">
        <Segmented label="Aspect ratio" value={value.aspectRatio} onChange={(v) => onChange({ ...value, aspectRatio: v })} options={caps.aspectRatios.map((a) => ({ value: a, label: a === '16:9' ? '16:9 landscape' : a === '9:16' ? '9:16 vertical' : a }))} />
      </Field>
      <Field label="Resolution" hint={value.resolution === '1080p' || value.resolution === '4k' ? 'Upscaled by the model; costs more per second.' : undefined}>
        <Select value={value.resolution} onChange={(e) => onChange({ ...value, resolution: e.target.value })} aria-label="Resolution">
          {caps.resolutions.map((r) => (
            <option key={r} value={r}>
              {r.toUpperCase()}
              {r === caps.defaultResolution ? ' (default)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      {showDuration && (
        <Field label={`${durationLabel}: ${value.durationSec}s`}>
          <Slider label={durationLabel} min={caps.durationSec.min} max={caps.durationSec.max} step={1} value={value.durationSec} onChange={(v) => onChange({ ...value, durationSec: v })} className="mt-2" />
        </Field>
      )}
      {showTakes && (
        <Field label={`Takes: ${value.takes}`} hint={`${caps.displayName} returns ${caps.outputsPerRequest} video per request — each take is a separate, separately billed generation.`}>
          <Slider label="Takes" min={1} max={4} step={1} value={value.takes} onChange={(v) => onChange({ ...value, takes: v })} className="mt-2" />
        </Field>
      )}
    </div>
  );
}

export function PromptPreview({ declaration, body, override, onOverride }: { declaration: string; body: string; override: string | null; onOverride?: (v: string | null) => void }) {
  const editing = override !== null;
  return (
    <div className="rounded-xl border border-line bg-black/25">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <p className="eyebrow">Prompt sent to the model</p>
        {onOverride && (
          <Button size="sm" variant="ghost" onClick={() => onOverride(editing ? null : body)}>
            {editing ? 'Use compiled prompt' : 'Edit raw prompt'}
          </Button>
        )}
      </div>
      {declaration && <p className="timecode border-b border-line px-3 py-2 text-[11px] break-all text-accent-2">{declaration}</p>}
      {editing ? (
        <Textarea value={override ?? ''} onChange={(e) => onOverride?.(e.target.value)} className="min-h-40 rounded-none border-0 bg-transparent" aria-label="Raw prompt" />
      ) : (
        <pre className="max-h-64 overflow-auto px-3 py-2.5 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-dim">{body || 'Describe the shot to build a prompt.'}</pre>
      )}
    </div>
  );
}

export function AudioNotice() {
  return (
    <Notice tone="neutral" icon={<Info className="size-4" />}>
      Omni generates dialogue, music and sound effects itself but cannot take an audio file as input. To score a clip with your own track, add it on the timeline — the renderer mixes it into the export.
    </Notice>
  );
}
