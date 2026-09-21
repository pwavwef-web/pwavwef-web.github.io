import { useMemo, useState } from 'react';
import { collection, doc, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { CheckCheck, CircleCheck, Clapperboard, Copy, Film, ImagePlus, Lock, LockOpen, Sparkles, Star, Trash2, Wand2 } from 'lucide-react';
import {
  compileShotPrompt,
  estimateImage,
  estimateVideo,
  formatTimecode,
  formatUsd,
  planOmniMedia,
  sumEstimates,
  type CharacterDoc,
  type ElementDoc,
  type JobRequest,
  type LocationDoc,
  type OmniMediaRef,
  type PricingTable,
  type ProjectDoc,
  type ShotDoc,
  type TakeDoc,
  type VideoCapabilities,
} from '@az-studio/shared';
import { api, errorMessage } from '../lib/api';
import { db } from '../lib/firebase';
import { useDoc, useQuery, type WithId } from '../lib/data';
import { useBoot } from '../lib/session';
import { addShots, deleteSubDoc, newShot, updateShot, useSub } from '../lib/studio';
import { EstimateText, useJobSubmitter } from './jobs';
import { AssetPicker, AssetThumb, useAsset, VideoPlayer, type Asset } from './media';
import { DirectionsEditor, PromptPreview } from './video-controls';
import { Badge, Button, Card, cx, EmptyState, Field, IconButton, Input, Modal, Notice, Segmented, Select, Slider, Textarea, Toggle } from './ui';

export type Shot = WithId<ShotDoc>;
export type Character = WithId<CharacterDoc>;
export type Location = WithId<LocationDoc>;
export type Element = WithId<ElementDoc>;

export interface ShotContext {
  project: WithId<ProjectDoc>;
  characters: Character[];
  locations: Location[];
  elements: Element[];
}

export function useShotContext(project: WithId<ProjectDoc>): ShotContext {
  const characters = useSub<CharacterDoc>(project.id, 'characters', 'name');
  const locations = useSub<LocationDoc>(project.id, 'locations', 'name');
  const elements = useSub<ElementDoc>(project.id, 'elements', 'name');
  return { project, characters: characters.data, locations: locations.data, elements: elements.data };
}

/** Media bindings for a shot: frames first, then locked character / location / element references. */
export function shotMedia(shot: ShotDoc, ctx: ShotContext, caps: VideoCapabilities): { media: OmniMediaRef[]; dropped: number } {
  const refs: OmniMediaRef[] = [];
  if (shot.refs.firstFrameAssetId) refs.push({ role: 'first_frame', assetId: shot.refs.firstFrameAssetId, label: 'first frame' });
  if (shot.refs.firstFrameAssetId && shot.refs.lastFrameAssetId) refs.push({ role: 'last_frame', assetId: shot.refs.lastFrameAssetId, label: 'last frame' });
  const imageRefs: OmniMediaRef[] = [];
  if (shot.lockRefs) {
    for (const id of shot.refs.characterIds) {
      const c = ctx.characters.find((x) => x.id === id);
      if (c?.primaryRefAssetId) imageRefs.push({ role: 'image_ref', assetId: c.primaryRefAssetId, label: c.name });
    }
    for (const id of shot.refs.locationIds) {
      const l = ctx.locations.find((x) => x.id === id);
      if (l?.primaryRefAssetId) imageRefs.push({ role: 'image_ref', assetId: l.primaryRefAssetId, label: l.name });
    }
    for (const id of shot.refs.elementIds) {
      const e = ctx.elements.find((x) => x.id === id);
      if (e?.referenceAssetIds[0]) imageRefs.push({ role: 'image_ref', assetId: e.referenceAssetIds[0], label: e.name });
    }
  }
  for (const id of shot.refs.assetIds) imageRefs.push({ role: 'image_ref', assetId: id, label: 'reference' });
  const unique = imageRefs.filter((r, i) => imageRefs.findIndex((x) => x.assetId === r.assetId) === i);
  const room = Math.max(0, caps.maxImageInputs - refs.length);
  return { media: [...refs, ...unique.slice(0, room)], dropped: Math.max(0, unique.length - room) };
}

export function shotPrompt(shot: ShotDoc, ctx: ShotContext, media: OmniMediaRef[], timedCues?: string[]): { body: string; declaration: string } {
  const planned = planOmniMedia(media);
  const tagOf = (assetId: string | null | undefined) => (assetId ? planned.media.find((m) => m.assetId === assetId && m.role === 'image_ref')?.tag ?? '' : '');
  const characters = shot.refs.characterIds.map((id) => ctx.characters.find((c) => c.id === id)).filter((c): c is Character => Boolean(c)).map((c) => ({ tag: shot.lockRefs ? tagOf(c.primaryRefAssetId) : '', name: c.name, description: [c.appearance, c.wardrobe].filter(Boolean).join('; ') }));
  const locations = shot.refs.locationIds.map((id) => ctx.locations.find((l) => l.id === id)).filter((l): l is Location => Boolean(l)).map((l) => ({ tag: shot.lockRefs ? tagOf(l.primaryRefAssetId) : '', name: l.name, description: [l.description, l.atmosphere, l.timeOfDay].filter(Boolean).join('; ') }));
  const elements = shot.refs.elementIds.map((id) => ctx.elements.find((e) => e.id === id)).filter((e): e is Element => Boolean(e)).map((e) => ({ tag: shot.lockRefs ? tagOf(e.referenceAssetIds[0]) : '', name: e.name, description: e.description }));
  const others = shot.refs.assetIds.map((id) => ({ tag: tagOf(id), name: 'the reference' }));
  const compiled = compileShotPrompt(shot.directions, { description: shot.description, styleBible: ctx.project.styleBible ?? null, characters, locations, elements, others, durationSec: shot.durationSec, ...(timedCues?.length ? { timedCues } : {}) });
  return { body: shot.promptOverride ?? compiled, declaration: planned.declaration };
}

export function shotJob(shot: Shot, ctx: ShotContext, caps: VideoCapabilities, timedCues?: string[]): JobRequest {
  const { media } = shotMedia(shot, ctx, caps);
  const { body } = shotPrompt(shot, ctx, media, timedCues);
  return {
    type: 'video.generate',
    projectId: ctx.project.id,
    mode: 'generate',
    prompt: body,
    aspectRatio: caps.aspectRatios.includes(shot.aspectRatio) ? shot.aspectRatio : caps.aspectRatios[0]!,
    resolution: caps.resolutions.includes(shot.resolution) ? shot.resolution : caps.defaultResolution,
    durationSec: Math.min(caps.durationSec.max, Math.max(caps.durationSec.min, Math.round(shot.durationSec))),
    media,
    characterIds: shot.refs.characterIds,
    target: { kind: 'shot', id: shot.id },
    title: shot.title,
    label: `Shot ${shot.number || ''} · ${shot.title}`.trim(),
  };
}

export function storyboardJob(shot: Shot, ctx: ShotContext, imageSize: string): JobRequest {
  const refIds = [
    ...shot.refs.characterIds.map((id) => ctx.characters.find((c) => c.id === id)?.primaryRefAssetId),
    ...shot.refs.locationIds.map((id) => ctx.locations.find((l) => l.id === id)?.primaryRefAssetId),
  ].filter((x): x is string => Boolean(x));
  const d = shot.directions;
  const prompt = [shot.description || d.action, [d.framing, d.lens, d.cameraMovement].filter(Boolean).join(', '), d.lighting && `Lighting: ${d.lighting}`, d.mood && `Mood: ${d.mood}`].filter(Boolean).join('. ');
  return {
    type: 'image.generate',
    projectId: ctx.project.id,
    prompt: prompt || shot.title,
    purpose: 'storyboard',
    aspectRatio: shot.aspectRatio,
    imageSize,
    referenceAssetIds: [...new Set(refIds)].slice(0, 13),
    grounding: false,
    applyStyleBible: true,
    characterIds: shot.refs.characterIds,
    collections: ['storyboard'],
    target: { kind: 'storyboard', id: shot.id },
    title: `Storyboard · ${shot.title}`,
    label: `Storyboard · ${shot.title}`,
  };
}

export function estimateShot(shot: ShotDoc, pricing: PricingTable, imageInputs: number) {
  return estimateVideo({ resolution: shot.resolution, outputSeconds: shot.durationSec, promptChars: 1200, imageInputs, videoInputSeconds: 0, task: 'generate' }, pricing);
}

// ---------------------------------------------------------------------------
// Take card
// ---------------------------------------------------------------------------

function TakeCard({ projectId, shot, take, onEdit }: { projectId: string; shot: Shot; take: WithId<TakeDoc>; onEdit: (take: WithId<TakeDoc>) => void }) {
  const [notes, setNotes] = useState(take.notes);
  const [busy, setBusy] = useState(false);
  const takeRef = doc(db, 'projects', projectId, 'shots', shot.id, 'takes', take.id);
  const approved = shot.approvedTakeId === take.id;
  const selected = shot.selectedTakeId === take.id;
  const approve = async () => {
    await updateDoc(takeRef, { approved: !approved });
    await updateShot(projectId, shot.id, approved ? { approvedTakeId: null, status: 'ready' } : { approvedTakeId: take.id, selectedTakeId: take.id, status: 'approved' });
  };
  const saveLastFrame = async () => {
    if (!take.assetId) return;
    setBusy(true);
    try {
      await api<{ assetId: string }, 'extractFrame'>('extractFrame', { assetId: take.assetId, atSec: shot.durationSec, collections: ['frames'], title: `${shot.title} — last frame` });
      toast.success('Last frame saved', { description: 'Pick it as the next shot’s first frame for seamless continuity.' });
    } catch (e) {
      toast.error('Could not save frame', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cx('rounded-2xl border p-3', approved ? 'border-success/40 bg-success/[0.04]' : selected ? 'border-accent/40' : 'border-line')}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-fg">{take.label}</p>
        <Badge tone={take.status === 'completed' ? 'success' : take.status === 'failed' ? 'danger' : 'accent'}>{take.status}</Badge>
        {approved && <Badge tone="success" icon={<CheckCheck className="size-3" />}>Approved</Badge>}
        {take.parentTakeId && <Badge tone="violet">edit</Badge>}
      </div>
      {take.status === 'completed' && take.assetId ? <VideoPlayer assetId={take.assetId} /> : <div className="grid aspect-video place-items-center rounded-xl bg-black/30 text-xs text-dim">{take.status === 'failed' ? 'Failed — see Jobs for details' : 'Generating…'}</div>}
      {take.status === 'completed' && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" aria-label={`Rate ${n}`} onClick={() => void updateDoc(takeRef, { rating: n })} className="cursor-pointer p-0.5">
                <Star className={cx('size-4', n <= take.rating ? 'fill-warning text-warning' : 'text-faint')} />
              </button>
            ))}
            <span className="ml-auto" />
            <Button size="sm" variant={selected ? 'subtle' : 'ghost'} onClick={() => void updateShot(projectId, shot.id, { selectedTakeId: take.id })}>
              {selected ? 'Selected' : 'Select'}
            </Button>
            <Button size="sm" variant={approved ? 'subtle' : 'secondary'} icon={<CircleCheck className="size-3.5" />} onClick={() => void approve()}>
              {approved ? 'Unapprove' : 'Approve'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />} onClick={() => onEdit(take)}>
              Edit this take
            </Button>
            <Button size="sm" variant="ghost" loading={busy} icon={<ImagePlus className="size-3.5" />} onClick={() => void saveLastFrame()}>
              Save last frame
            </Button>
          </div>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== take.notes && void updateDoc(takeRef, { notes })} placeholder="Take notes" aria-label="Take notes" className="!py-1.5 text-xs" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shot editor
// ---------------------------------------------------------------------------

function MultiPick<T extends { id: string; name: string }>({ label, items, value, onChange }: { label: string; items: T[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Field label={label}>
      {items.length === 0 ? (
        <p className="text-xs text-faint">None defined yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it) => {
            const on = value.includes(it.id);
            return (
              <button key={it.id} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== it.id) : [...value, it.id])} className={cx('cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors', on ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim hover:border-line-strong')}>
                {it.name}
              </button>
            );
          })}
        </div>
      )}
    </Field>
  );
}

function FrameSlot({ label, assetId, onPick, onClear, disabled }: { label: string; assetId: string | null; onPick: () => void; onClear: () => void; disabled?: boolean }) {
  const a = useAsset(assetId);
  return (
    <div className="rounded-xl border border-line p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-dim">{label}</span>
        <div className="flex gap-1">
          {assetId && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              Clear
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onPick} disabled={disabled}>
            {assetId ? 'Change' : 'Choose'}
          </Button>
        </div>
      </div>
      {a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} hoverPlay={false} /> : <div className="grid aspect-video place-items-center rounded-lg bg-black/25 text-[11px] text-faint">{disabled ? 'Set a first frame first' : 'Optional'}</div>}
    </div>
  );
}

export function ShotEditor({ ctx, shot, onClose, timedCues }: { ctx: ShotContext; shot: Shot; onClose: () => void; timedCues?: string[] }) {
  const boot = useBoot();
  const caps = boot!.capabilities.video;
  const [draft, setDraft] = useState<Shot>(shot);
  const [takes, setTakes] = useState(1);
  const [picker, setPicker] = useState<'first' | 'last' | 'refs' | null>(null);
  const [editing, setEditing] = useState<WithId<TakeDoc> | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [editMode, setEditMode] = useState<'edit' | 'extend'>('edit');
  const [extendSec, setExtendSec] = useState(4);
  const { submit, busy, dialog } = useJobSubmitter();
  const takeDocs = useQuery<TakeDoc>(() => query(collection(db, 'projects', ctx.project.id, 'shots', shot.id, 'takes'), orderBy('index', 'desc')), [ctx.project.id, shot.id]);
  const { media, dropped } = useMemo(() => shotMedia(draft, ctx, caps), [draft, ctx, caps]);
  const prompt = useMemo(() => shotPrompt(draft, ctx, media, timedCues), [draft, ctx, media, timedCues]);
  const imageInputs = planOmniMedia(media).media.length;
  const estimate = boot ? (takes > 1 ? sumEstimates(Array(takes).fill(estimateShot(draft, boot.pricing, imageInputs)), boot.pricing) : estimateShot(draft, boot.pricing, imageInputs)) : null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(shot);

  const save = async () => {
    const { id, ...rest } = draft;
    void id;
    await updateShot(ctx.project.id, shot.id, { ...rest, updatedAt: serverTimestamp() as never });
    toast.success('Shot saved');
  };
  const generate = async () => {
    if (dirty) await save();
    await submit(Array(takes).fill(shotJob(draft, ctx, caps, timedCues)), { label: `${draft.title} · ${takes} take${takes > 1 ? 's' : ''}` });
  };
  const board = async () => {
    if (dirty) await save();
    await submit([storyboardJob(draft, ctx, boot?.settings.defaultImageSize ?? '2K')], { label: `Storyboard · ${draft.title}` });
  };
  const sendEdit = async () => {
    if (!editing || !editPrompt.trim()) return;
    const job: JobRequest = { type: 'video.generate', projectId: ctx.project.id, mode: editMode, prompt: editPrompt.trim(), resolution: draft.resolution, ...(editMode === 'extend' ? { durationSec: extendSec } : {}), media: [], characterIds: draft.refs.characterIds, target: { kind: 'shot', id: shot.id }, parentTakeId: editing.id, label: `${draft.title} · ${editMode} of ${editing.label}` };
    const ids = await submit([job]);
    if (ids) {
      setEditing(null);
      setEditPrompt('');
    }
  };
  const setRefs = (patch: Partial<ShotDoc['refs']>) => setDraft({ ...draft, refs: { ...draft.refs, ...patch } });

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={
        <span className="flex items-center gap-2">
          <Film className="size-5 text-accent-2" /> {draft.number ? `${draft.number} · ` : ''}
          {draft.title}
        </span>
      }
      description={draft.timing ? `Song position ${formatTimecode(draft.timing.start)} – ${formatTimecode(draft.timing.end)}` : undefined}
      footer={
        <>
          <EstimateText estimate={estimate} className="mr-auto" />
          <Button variant="ghost" disabled={!dirty} onClick={() => void save()}>
            Save
          </Button>
          <Button variant="secondary" loading={busy} onClick={() => void board()} icon={<ImagePlus className="size-4" />}>
            Storyboard frame
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void generate()} icon={<Sparkles className="size-4" />}>
            Generate {takes > 1 ? `${takes} takes` : 'take'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
            <Field label="No.">
              <Input value={draft.number} onChange={(e) => setDraft({ ...draft, number: e.target.value })} />
            </Field>
            <Field label="Title">
              <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Field>
          </div>
          <Field label="What happens">
            <Textarea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
          <DirectionsEditor compact value={draft.directions} onChange={(d) => setDraft({ ...draft, directions: d })} />
          <Card className="space-y-4 p-4">
            <div className="flex items-center justify-between">
              <p className="eyebrow">Continuity references</p>
              <Toggle checked={draft.lockRefs} onChange={(v) => setDraft({ ...draft, lockRefs: v })} label={<span className="inline-flex items-center gap-1.5">{draft.lockRefs ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />} Lock references</span>} />
            </div>
            <MultiPick label="Characters" items={ctx.characters} value={draft.refs.characterIds} onChange={(v) => setRefs({ characterIds: v })} />
            <MultiPick label="Locations" items={ctx.locations} value={draft.refs.locationIds} onChange={(v) => setRefs({ locationIds: v })} />
            <MultiPick label="Props & costumes" items={ctx.elements} value={draft.refs.elementIds} onChange={(v) => setRefs({ elementIds: v })} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FrameSlot label="First frame" assetId={draft.refs.firstFrameAssetId} onPick={() => setPicker('first')} onClear={() => setRefs({ firstFrameAssetId: null, lastFrameAssetId: null })} />
              <FrameSlot label="Last frame" assetId={draft.refs.lastFrameAssetId} onPick={() => setPicker('last')} onClear={() => setRefs({ lastFrameAssetId: null })} disabled={!draft.refs.firstFrameAssetId} />
            </div>
            {draft.refs.storyboardAssetId && !draft.refs.firstFrameAssetId && (
              <Button size="sm" variant="subtle" onClick={() => setRefs({ firstFrameAssetId: draft.refs.storyboardAssetId })}>
                Use storyboard frame as first frame
              </Button>
            )}
            <Field label={`Extra image references (${draft.refs.assetIds.length})`}>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => setPicker('refs')}>
                  Add images
                </Button>
                {draft.refs.assetIds.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setRefs({ assetIds: [] })}>
                    Clear
                  </Button>
                )}
              </div>
            </Field>
            {dropped > 0 && <Notice tone="warning">{dropped} reference image(s) exceed Omni’s {caps.maxImageInputs}-image limit and will be left out.</Notice>}
            {!draft.lockRefs && <p className="text-xs text-faint">Unlocked: characters and locations are described in words only.</p>}
          </Card>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={`Duration ${draft.durationSec}s`}>
              <Slider label="Duration" min={caps.durationSec.min} max={caps.durationSec.max} step={1} value={draft.durationSec} onChange={(v) => setDraft({ ...draft, durationSec: v })} className="mt-2" />
            </Field>
            <Field label="Aspect">
              <Select value={draft.aspectRatio} onChange={(e) => setDraft({ ...draft, aspectRatio: e.target.value as ShotDoc['aspectRatio'] })}>
                {caps.aspectRatios.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </Select>
            </Field>
            <Field label="Resolution">
              <Select value={draft.resolution} onChange={(e) => setDraft({ ...draft, resolution: e.target.value })}>
                {caps.resolutions.map((r) => (
                  <option key={r} value={r}>
                    {r.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={`Takes per generation: ${takes}`} hint="Alternate takes are separate generations, each billed.">
            <Slider label="Takes" min={1} max={4} step={1} value={takes} onChange={setTakes} />
          </Field>
          <PromptPreview declaration={prompt.declaration} body={prompt.body} override={draft.promptOverride} onOverride={(v) => setDraft({ ...draft, promptOverride: v })} />
          <Field label="Production notes">
            <Textarea rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </Field>
        </div>
        <div className="space-y-4">
          <p className="eyebrow">Takes ({takeDocs.data.length})</p>
          {editing && (
            <Card className="space-y-3 border-violet/40 p-4">
              <p className="text-sm text-fg">Conversational edit of {editing.label}</p>
              <Segmented label="Edit mode" size="sm" value={editMode} onChange={setEditMode} options={[{ value: 'edit', label: 'Edit' }, { value: 'extend', label: 'Extend' }]} />
              {editMode === 'extend' && (
                <Field label={`Add ${extendSec}s`}>
                  <Slider label="Extension" min={caps.durationSec.min} max={caps.durationSec.max} step={1} value={extendSec} onChange={setExtendSec} />
                </Field>
              )}
              <Textarea rows={3} value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} placeholder="e.g. Keep everything, but make the drummer look up to camera on the last beat" aria-label="Edit instruction" />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" loading={busy} disabled={!editPrompt.trim()} onClick={() => void sendEdit()}>
                  Send to Omni
                </Button>
              </div>
            </Card>
          )}
          {takeDocs.data.length === 0 ? (
            <EmptyState icon={<Clapperboard className="size-5" />} title="No takes yet" body="Generate a take; approve the best one for the edit." />
          ) : (
            takeDocs.data.map((t) => <TakeCard key={t.id} projectId={ctx.project.id} shot={{ ...shot, ...draft }} take={t} onEdit={setEditing} />)
          )}
        </div>
      </div>
      <AssetPicker
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        kinds={['image']}
        projectId={ctx.project.id}
        multiple={picker === 'refs'}
        max={caps.maxImageInputs}
        onPick={(a) => {
          if (picker === 'first') setRefs({ firstFrameAssetId: a[0]?.id ?? null });
          else if (picker === 'last') setRefs({ lastFrameAssetId: a[0]?.id ?? null });
          else setRefs({ assetIds: [...new Set([...draft.refs.assetIds, ...a.map((x) => x.id)])] });
        }}
        title={picker === 'refs' ? 'Reference images' : picker === 'first' ? 'First frame' : 'Last frame'}
      />
      {dialog}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Shot list with batch generation
// ---------------------------------------------------------------------------

/** Selected take, else storyboard frame, else first frame. */
function ShotThumb({ projectId, shot }: { projectId: string; shot: Shot }) {
  const take = useDoc<TakeDoc>(shot.selectedTakeId ? `projects/${projectId}/shots/${shot.id}/takes/${shot.selectedTakeId}` : null);
  const asset = useAsset(take.data?.assetId ?? shot.refs.storyboardAssetId ?? shot.refs.firstFrameAssetId);
  return asset.data ? (
    <AssetThumb asset={asset.data as Asset} showMeta={false} />
  ) : (
    <div className="cinema-thumb grid aspect-video place-items-center rounded-xl border border-line text-faint">
      <Film className="size-4" />
    </div>
  );
}

export function ShotQueue({ ctx, shots, timedCuesFor, emptyAction }: { ctx: ShotContext; shots: Shot[]; timedCuesFor?: (s: Shot) => string[] | undefined; emptyAction?: React.ReactNode }) {
  const boot = useBoot();
  const caps = boot?.capabilities.video;
  const [open, setOpen] = useState<Shot | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState<'all' | 'planned' | 'ready' | 'approved' | 'failed'>('all');
  const { submit, busy, dialog } = useJobSubmitter();
  if (!boot || !caps) return null;
  const visible = shots.filter((s) => filter === 'all' || s.status === filter || (filter === 'ready' && s.status === 'generating'));
  const chosen = shots.filter((s) => selected.includes(s.id));
  const batchEstimate = chosen.length ? sumEstimates(chosen.map((s) => estimateShot(s, boot.pricing, shotMedia(s, ctx, caps).media.length)), boot.pricing) : null;
  const boardEstimate = chosen.length ? sumEstimates(chosen.map(() => estimateImage({ imageSize: boot.settings.defaultImageSize, referenceImages: 2, promptChars: 600, outputs: 1 }, boot.pricing)), boot.pricing) : null;

  const generate = async () => {
    const ids = await submit(chosen.map((s) => shotJob(s, ctx, caps, timedCuesFor?.(s))), { label: `${chosen.length} shots`, alwaysConfirm: chosen.length > 1 });
    if (ids) setSelected([]);
  };
  const boards = async () => {
    const ids = await submit(chosen.map((s) => storyboardJob(s, ctx, boot.settings.defaultImageSize)), { label: `${chosen.length} storyboard frames`, alwaysConfirm: chosen.length > 1 });
    if (ids) setSelected([]);
  };
  const duplicate = async (s: Shot) => {
    const { id, ...rest } = s;
    void id;
    await addShots(ctx.project.id, [newShot({ ...rest, title: `${s.title} (copy)`, order: s.order + 0.5, status: 'planned', selectedTakeId: null, approvedTakeId: null, takeCount: 0 })]);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Filter shots"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All ${shots.length}` },
            { value: 'planned', label: 'Planned' },
            { value: 'ready', label: 'Has takes' },
            { value: 'approved', label: 'Approved' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
        <Button size="sm" variant="ghost" onClick={() => setSelected(selected.length === visible.length ? [] : visible.map((s) => s.id))}>
          {selected.length === visible.length && visible.length ? 'Clear selection' : 'Select all'}
        </Button>
        {chosen.length > 0 && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void boards()} icon={<ImagePlus className="size-3.5" />}>
              Storyboard {chosen.length} · ≈ {formatUsd(boardEstimate?.usd ?? 0)}
            </Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void generate()} icon={<Sparkles className="size-3.5" />}>
              Generate {chosen.length} shot{chosen.length > 1 ? 's' : ''} · ≈ {formatUsd(batchEstimate?.usd ?? 0)}
            </Button>
          </div>
        )}
      </div>
      {visible.length === 0 ? (
        <EmptyState icon={<Film className="size-5" />} title="No shots here" body="Plan shots with the assistant or add them manually." action={emptyAction} />
      ) : (
        <ul className="space-y-2">
          {visible.map((s) => (
            <li key={s.id} className={cx('card flex items-center gap-3 p-2.5 transition-colors', selected.includes(s.id) && 'border-accent/50')}>
              <input type="checkbox" className="size-4 shrink-0 accent-[#4c8dff]" checked={selected.includes(s.id)} onChange={() => setSelected((x) => (x.includes(s.id) ? x.filter((y) => y !== s.id) : [...x, s.id]))} aria-label={`Select ${s.title}`} />
              <button type="button" onClick={() => setOpen(s)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left">
                <div className="w-28 shrink-0 sm:w-36">
                  <ShotThumb projectId={ctx.project.id} shot={s} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="timecode text-xs text-faint">{s.number}</span>
                    <p className="truncate text-sm font-medium text-fg">{s.title}</p>
                    <Badge tone={s.status === 'approved' ? 'success' : s.status === 'failed' ? 'danger' : s.status === 'planned' ? 'neutral' : 'accent'}>{s.status}</Badge>
                    {s.takeCount > 0 && <span className="text-[11px] text-faint">{s.takeCount} take{s.takeCount > 1 ? 's' : ''}</span>}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-dim">{s.description || s.directions.action || 'No description'}</p>
                  <p className="mt-1 text-[11px] text-faint">
                    {s.durationSec}s · {s.aspectRatio} · {s.resolution}
                    {s.timing ? ` · ${formatTimecode(s.timing.start)}–${formatTimecode(s.timing.end)}` : ''}
                    {[s.directions.framing, s.directions.cameraMovement].filter(Boolean).length ? ` · ${[s.directions.framing, s.directions.cameraMovement].filter(Boolean).join(' · ')}` : ''}
                  </p>
                </div>
              </button>
              <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
                <IconButton label="Duplicate shot" onClick={() => void duplicate(s)}>
                  <Copy className="size-4" />
                </IconButton>
                <IconButton label="Delete shot" onClick={() => void deleteSubDoc(ctx.project.id, 'shots', s.id)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {open && <ShotEditor ctx={ctx} shot={shots.find((x) => x.id === open.id) ?? open} timedCues={timedCuesFor?.(open)} onClose={() => setOpen(null)} />}
      {dialog}
    </div>
  );
}
