import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BadgeCheck, LayoutGrid, Lock, LockOpen, Plus, Save, Trash2 } from 'lucide-react';
import {
  emptySetBible,
  estimateImage,
  FLOOR_ITEM_KINDS,
  SET_VIEW_LABELS,
  SET_VIEWS,
  sumEstimates,
  type FloorItem,
  type FloorItemKind,
  type LocationDoc,
  type ProjectDoc,
  type SetBibleDoc,
  type SetVariant,
  type SetView,
} from '@az-studio/shared';
import { errorMessage } from '../lib/api';
import type { WithId } from '../lib/data';
import { approveBible, saveContinuity, useProjectDoc } from '../lib/continuity';
import { useBoot } from '../lib/session';
import { AssetSlot, ChipList } from './fields';
import { FloorPlan } from './floor-plan';
import { EstimateText, useJobSubmitter } from './jobs';
import { AssetPicker } from './media';
import { Badge, Button, Card, Field, Input, Modal, Notice, Select, Textarea, Toggle } from './ui';

type Draft = Omit<SetBibleDoc, 'id' | 'canonical' | 'updatedAt'>;

function draftOf(locationId: string, s: WithId<SetBibleDoc> | null): Draft {
  const base = emptySetBible(locationId);
  const { id: _id, canonical: _c, updatedAt: _u, ...rest } = { ...base, ...(s ?? {}) } as SetBibleDoc;
  void [_id, _c, _u];
  return rest;
}

const KIND_SIZE: Record<FloorItemKind, { w: number; h: number }> = {
  wall: { w: 0.5, h: 0.02 },
  door: { w: 0.09, h: 0.03 },
  window: { w: 0.12, h: 0.02 },
  furniture: { w: 0.14, h: 0.08 },
  light: { w: 0.04, h: 0.04 },
  object: { w: 0.05, h: 0.05 },
  sign: { w: 0.08, h: 0.02 },
  zone: { w: 0.3, h: 0.25 },
  camera: { w: 0.04, h: 0.04 },
};

function Variants({ label, value, onChange, onPick }: { label: string; value: SetVariant[]; onChange: (v: SetVariant[]) => void; onPick: (id: string) => void }) {
  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center justify-between">
        <p className="eyebrow">{label}</p>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={value.length >= 8} onClick={() => onChange([...value, { id: `v${Date.now().toString(36)}${value.length}`, label: '', assetId: null, description: '' }])}>
          Add
        </Button>
      </div>
      {value.map((x) => (
        <div key={x.id} className="grid grid-cols-[120px_minmax(0,1fr)_auto] gap-2">
          <AssetSlot label={x.label || 'Variant'} assetId={x.assetId} onPick={() => onPick(x.id)} onClear={() => onChange(value.map((y) => (y.id === x.id ? { ...y, assetId: null } : y)))} />
          <div className="space-y-1.5">
            <Input value={x.label} placeholder="e.g. Night, Harmattan dust" onChange={(e) => onChange(value.map((y) => (y.id === x.id ? { ...y, label: e.target.value } : y)))} aria-label="Variant name" />
            <Textarea rows={2} value={x.description} onChange={(e) => onChange(value.map((y) => (y.id === x.id ? { ...y, description: e.target.value } : y)))} aria-label="Variant description" />
          </div>
          <Button size="sm" variant="ghost" aria-label="Remove variant" onClick={() => onChange(value.filter((y) => y.id !== x.id))}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
    </Card>
  );
}

/**
 * Set Bible: canonical views of a recurring location, a floor plan with doors, windows, furniture,
 * light sources, zones and camera positions, what may and must never change, and time-of-day and
 * weather variants. Nano Banana Pro can propose a coherent reference pack; nothing is locked until the
 * director approves the canonical views.
 */
export function SetBibleEditor({ project, location, onClose }: { project: WithId<ProjectDoc>; location: WithId<LocationDoc>; onClose: () => void }) {
  const boot = useBoot();
  const stored = useProjectDoc<SetBibleDoc>(project.id, 'setBibles', location.id);
  const [d, setD] = useState<Draft>(() => draftOf(location.id, null));
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [addKind, setAddKind] = useState<FloorItemKind>('furniture');
  const [busy, setBusy] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ kind: 'view'; view: SetView } | { kind: 'detail' } | { kind: 'plan' } | { kind: 'tod'; id: string } | { kind: 'weather'; id: string } | null>(null);
  const [packViews, setPackViews] = useState<SetView[]>(['wide', 'front', 'rear', 'left', 'right']);
  const [packDirection, setPackDirection] = useState('');
  const [approveViews, setApproveViews] = useState<SetView[]>([]);
  const { submit, busy: submitting, dialog } = useJobSubmitter();
  const status = stored.data?.canonical.status ?? 'draft';
  const locked = status === 'locked';
  useEffect(() => {
    if (stored.loading || loaded) return;
    setD(draftOf(location.id, stored.data));
    setApproveViews(stored.data ? (SET_VIEWS.filter((v) => stored.data!.views[v]) as SetView[]) : []);
    setLoaded(true);
  }, [stored.loading, stored.data, loaded, location.id]);
  // Views generated by a reference pack arrive on the stored document while the editor is open.
  const liveViews = stored.data?.views;
  useEffect(() => {
    if (!liveViews) return;
    setD((x) => ({ ...x, views: { ...x.views, ...Object.fromEntries(Object.entries(liveViews).filter(([v, id]) => id && !x.views[v as SetView])) } }));
  }, [liveViews]);
  const sel = d.floorPlan.find((i) => i.id === selected) ?? null;
  const setItem = (id: string, patch: Partial<FloorItem>) => setD((x) => ({ ...x, floorPlan: x.floorPlan.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  const save = async () => {
    setBusy('save');
    try {
      await saveContinuity(project.id, 'setBibles', d as unknown as Record<string, unknown>);
      toast.success('Set Bible saved');
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const approve = async (on: boolean) => {
    setBusy(on ? 'approve' : 'unlock');
    try {
      if (on) await saveContinuity(project.id, 'setBibles', d as unknown as Record<string, unknown>);
      await approveBible(project.id, 'set', location.id, on, on ? approveViews : []);
      toast.success(on ? `${location.name} is locked` : 'Set unlocked', { description: on ? 'Every shot in this location inherits the approved views and the plan.' : 'Changes are allowed again; shots use the set only after it is locked.' });
    } catch (e) {
      toast.error('Could not update the set', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const packEstimate = useMemo(() => (boot ? sumEstimates(packViews.map(() => estimateImage({ imageSize: boot.settings.defaultImageSize, referenceImages: 1, promptChars: 1500, outputs: 1 }, boot.pricing)), boot.pricing) : null), [boot, packViews]);
  const generatePack = async () => {
    await save();
    await submit([{ type: 'reference.pack', projectId: project.id, locationId: location.id, views: packViews, imageSize: boot?.settings.defaultImageSize ?? '2K', aspectRatio: '16:9', ...(packDirection.trim() ? { direction: packDirection.trim() } : {}) }], { label: `Reference pack · ${location.name}`, alwaysConfirm: true });
  };
  const addItem = (p?: { x: number; y: number }) => {
    const size = KIND_SIZE[addKind];
    const item: FloorItem = { id: `f${Date.now().toString(36)}${d.floorPlan.length}`, kind: addKind, label: addKind === 'camera' ? `Camera ${d.floorPlan.filter((i) => i.kind === 'camera').length + 1}` : '', x: Math.max(0, Math.min(1 - size.w, (p?.x ?? 0.5) - size.w / 2)), y: Math.max(0, Math.min(1 - size.h, (p?.y ?? 0.5) - size.h / 2)), w: size.w, h: size.h, rotation: 0, locked: false };
    setD((x) => ({ ...x, floorPlan: [...x.floorPlan, item] }));
    setSelected(item.id);
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={
        <span className="flex items-center gap-2">
          Set Bible · {location.name}
          {locked ? <Badge tone="success" icon={<Lock className="size-3" />}>Locked</Badge> : status === 'pending_approval' ? <Badge tone="warning">Reference pack awaiting approval</Badge> : <Badge>Draft</Badge>}
        </span>
      }
      description="Every shot in this location inherits the locked views, the layout, the light and what must never change; the reviewer compares each take with them."
      footer={
        <>
          {locked ? (
            <Button variant="ghost" className="mr-auto" loading={busy === 'unlock'} icon={<LockOpen className="size-4" />} onClick={() => void approve(false)}>
              Unlock to change
            </Button>
          ) : (
            <span className="mr-auto text-xs text-faint">Approve the views that are canonical — they become the reference for every shot here.</span>
          )}
          <Button variant="ghost" loading={busy === 'save'} disabled={locked} onClick={() => void save()} icon={<Save className="size-4" />}>
            Save
          </Button>
          {!locked && (
            <Button variant="primary" loading={busy === 'approve'} disabled={!approveViews.some((v) => d.views[v])} onClick={() => void approve(true)} icon={<BadgeCheck className="size-4" />}>
              Approve & lock ({approveViews.filter((v) => d.views[v]).length} view{approveViews.filter((v) => d.views[v]).length === 1 ? '' : 's'})
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        {locked && <Notice icon={<Lock className="size-4" />}>This set is locked: views, plan, colours, materials, protected features, signs and “never change” items are protected. Unlock it to change them (shots already approved keep their records).</Notice>}
        <div>
          <p className="eyebrow mb-2">Canonical views</p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            {SET_VIEWS.map((v) => (
              <AssetSlot
                key={v}
                label={SET_VIEW_LABELS[v]}
                assetId={d.views[v]}
                onPick={() => !locked && setPicker({ kind: 'view', view: v })}
                onClear={locked ? undefined : () => setD((x) => ({ ...x, views: { ...x.views, [v]: null } }))}
                badge={
                  !locked && d.views[v] ? (
                    <label className="flex items-center gap-1 text-[10px] text-dim">
                      <input type="checkbox" checked={approveViews.includes(v)} onChange={(e) => setApproveViews((a) => (e.target.checked ? [...a, v] : a.filter((x) => x !== v)))} /> approve
                    </label>
                  ) : locked && stored.data?.canonical.approvedViews.includes(v) ? (
                    <Badge tone="success">canonical</Badge>
                  ) : undefined
                }
              />
            ))}
          </div>
        </div>
        {!locked && (
          <Card className="space-y-2 p-3">
            <p className="eyebrow flex items-center gap-1.5">
              <LayoutGrid className="size-3.5" /> Reference pack (Nano Banana Pro)
            </p>
            <p className="text-xs text-faint">The wide view is generated first (or your existing one is used) and every other view is generated from it, following the floor plan, so the room stays one coherent place. The views are proposed for approval — nothing is locked automatically.</p>
            <div className="flex flex-wrap gap-2">
              {SET_VIEWS.map((v) => (
                <label key={v} className="flex items-center gap-1 text-xs text-dim">
                  <input type="checkbox" checked={packViews.includes(v)} onChange={(e) => setPackViews((a) => (e.target.checked ? [...a, v] : a.filter((x) => x !== v)))} /> {SET_VIEW_LABELS[v]}
                </label>
              ))}
            </div>
            <Textarea rows={2} value={packDirection} onChange={(e) => setPackDirection(e.target.value)} placeholder="Optional direction (e.g. late-afternoon sun from the west window, dust in the air)" aria-label="Reference pack direction" />
            <div className="flex items-center justify-end gap-3">
              <EstimateText estimate={packEstimate} />
              <Button size="sm" variant="primary" loading={submitting} disabled={!packViews.length} onClick={() => void generatePack()}>
                Generate {packViews.length} view{packViews.length === 1 ? '' : 's'}
              </Button>
            </div>
          </Card>
        )}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="eyebrow mr-auto">Floor plan (north at the top)</p>
              <Select value={addKind} onChange={(e) => setAddKind(e.target.value as FloorItemKind)} aria-label="Item to add" className="h-8 w-36 text-xs" disabled={locked}>
                {FLOOR_ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k === 'zone' ? 'zone (actors can stand)' : k === 'camera' ? 'camera position' : k === 'light' ? 'light source' : k}
                  </option>
                ))}
              </Select>
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={locked} onClick={() => addItem()}>
                Add
              </Button>
              <Field label="Plan size (m)" className="w-28">
                <Input type="number" min={2} max={500} value={d.planSizeM} disabled={locked} onChange={(e) => setD((x) => ({ ...x, planSizeM: Math.max(2, Math.min(500, Number(e.target.value) || 10)) }))} />
              </Field>
            </div>
            <FloorPlan items={d.floorPlan} planSizeM={d.planSizeM} editable={!locked} selectedId={selected} onSelect={setSelected} onMove={(id, x, y) => setItem(id, { x, y })} />
          </div>
          <div className="space-y-3">
            {sel ? (
              <Card className="space-y-2 p-3">
                <p className="eyebrow">{sel.kind}</p>
                <Field label="Label">
                  <Input value={sel.label} disabled={locked} onChange={(e) => setItem(sel.id, { label: e.target.value })} />
                </Field>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Width">
                    <Input type="number" step={0.01} min={0} max={1.5} value={sel.w} disabled={locked} onChange={(e) => setItem(sel.id, { w: Math.max(0, Math.min(1.5, Number(e.target.value))) })} />
                  </Field>
                  <Field label="Depth">
                    <Input type="number" step={0.01} min={0} max={1.5} value={sel.h} disabled={locked} onChange={(e) => setItem(sel.id, { h: Math.max(0, Math.min(1.5, Number(e.target.value))) })} />
                  </Field>
                  <Field label="Rotation">
                    <Input type="number" step={5} min={-360} max={360} value={sel.rotation} disabled={locked} onChange={(e) => setItem(sel.id, { rotation: Math.max(-360, Math.min(360, Number(e.target.value))) })} />
                  </Field>
                </div>
                <Toggle checked={sel.locked} onChange={(v) => !locked && setItem(sel.id, { locked: v })} label="Protected — must never move" />
                <Button size="sm" variant="danger" disabled={locked} icon={<Trash2 className="size-3.5" />} onClick={() => {
                  setD((x) => ({ ...x, floorPlan: x.floorPlan.filter((i) => i.id !== sel.id) }));
                  setSelected(null);
                }}>
                  Remove
                </Button>
              </Card>
            ) : (
              <p className="text-xs text-faint">Select an item to edit it, drag to move it. Doors, windows, furniture, light sources, zones where characters can stand and camera positions all feed the reference pack, the blocking editor and the continuity checks.</p>
            )}
            <AssetSlot label="Floor-plan drawing (optional)" assetId={d.floorPlanAssetId} onPick={() => !locked && setPicker({ kind: 'plan' })} onClear={locked ? undefined : () => setD((x) => ({ ...x, floorPlanAssetId: null }))} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Wall colours">
            <Input value={d.wallColours} disabled={locked} onChange={(e) => setD((x) => ({ ...x, wallColours: e.target.value }))} placeholder="e.g. ochre lime plaster, indigo door frames" />
          </Field>
          <Field label="Materials">
            <Input value={d.materials} disabled={locked} onChange={(e) => setD((x) => ({ ...x, materials: e.target.value }))} placeholder="e.g. mud brick, thatch, worn wooden beams" />
          </Field>
          <Field label="Key light direction">
            <Input value={d.lighting.keyDirection} onChange={(e) => setD((x) => ({ ...x, lighting: { ...x.lighting, keyDirection: e.target.value } }))} placeholder="e.g. from the west window" />
          </Field>
          <Field label="Light colour">
            <Input value={d.lighting.colour} onChange={(e) => setD((x) => ({ ...x, lighting: { ...x.lighting, colour: e.target.value } }))} placeholder="e.g. warm late-afternoon sun" />
          </Field>
          <Field label="Background population">
            <Input value={d.population} onChange={(e) => setD((x) => ({ ...x, population: e.target.value }))} placeholder="e.g. empty; or two children playing by the well" />
          </Field>
          <Field label="Lighting notes">
            <Input value={d.lighting.notes} onChange={(e) => setD((x) => ({ ...x, lighting: { ...x.lighting, notes: e.target.value } }))} />
          </Field>
          <Field label="Important background objects">
            <ChipList value={d.backgroundObjects} max={40} onChange={(v) => setD((x) => ({ ...x, backgroundObjects: v }))} placeholder="e.g. clay water pot by the door" />
          </Field>
          <Field label="Protected architectural features">
            <ChipList value={d.protectedFeatures} max={30} onChange={(v) => !locked && setD((x) => ({ ...x, protectedFeatures: v }))} placeholder="e.g. arched doorway on the north wall" />
          </Field>
          <Field label="Elements that may change">
            <ChipList value={d.mayChange} max={30} onChange={(v) => setD((x) => ({ ...x, mayChange: v }))} placeholder="e.g. cooking fire lit or out" />
          </Field>
          <Field label="Elements that must never change">
            <ChipList value={d.neverChange} max={30} onChange={(v) => !locked && setD((x) => ({ ...x, neverChange: v }))} placeholder="e.g. window positions, wall colours" />
          </Field>
        </div>
        <Card className="space-y-2 p-3">
          <div className="flex items-center justify-between">
            <p className="eyebrow">Text or signs that must stay readable</p>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={locked || d.readableSigns.length >= 20} onClick={() => setD((x) => ({ ...x, readableSigns: [...x.readableSigns, { text: '', where: '' }] }))}>
              Add
            </Button>
          </div>
          {d.readableSigns.map((s, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
              <Input value={s.text} disabled={locked} placeholder="Exact text" onChange={(e) => setD((x) => ({ ...x, readableSigns: x.readableSigns.map((y, k) => (k === i ? { ...y, text: e.target.value } : y)) }))} aria-label="Sign text" />
              <Input value={s.where} disabled={locked} placeholder="Where (e.g. above the shop door)" onChange={(e) => setD((x) => ({ ...x, readableSigns: x.readableSigns.map((y, k) => (k === i ? { ...y, where: e.target.value } : y)) }))} aria-label="Sign position" />
              <Button size="sm" variant="ghost" disabled={locked} aria-label="Remove sign" onClick={() => setD((x) => ({ ...x, readableSigns: x.readableSigns.filter((_, k) => k !== i) }))}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </Card>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Variants label="Time-of-day variants" value={d.timeOfDayVariants} onChange={(v) => setD((x) => ({ ...x, timeOfDayVariants: v }))} onPick={(id) => setPicker({ kind: 'tod', id })} />
          <Variants label="Weather variants" value={d.weatherVariants} onChange={(v) => setD((x) => ({ ...x, weatherVariants: v }))} onPick={(id) => setPicker({ kind: 'weather', id })} />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="eyebrow">Important detail images</p>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={locked} onClick={() => setPicker({ kind: 'detail' })}>
              Add
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
            {d.detailAssetIds.map((id) => (
              <AssetSlot key={id} label="Detail" assetId={id} onPick={() => undefined} onClear={locked ? undefined : () => setD((x) => ({ ...x, detailAssetIds: x.detailAssetIds.filter((y) => y !== id) }))} />
            ))}
          </div>
        </div>
      </div>
      <AssetPicker
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        kinds={['image']}
        projectId={project.id}
        multiple={picker?.kind === 'detail'}
        max={picker?.kind === 'detail' ? 20 : 1}
        onPick={(a) => {
          const id = a[0]?.id ?? null;
          if (picker?.kind === 'view') setD((x) => ({ ...x, views: { ...x.views, [picker.view]: id } }));
          else if (picker?.kind === 'detail') setD((x) => ({ ...x, detailAssetIds: [...new Set([...x.detailAssetIds, ...a.map((y) => y.id)])].slice(0, 20) }));
          else if (picker?.kind === 'plan') setD((x) => ({ ...x, floorPlanAssetId: id }));
          else if (picker?.kind === 'tod') setD((x) => ({ ...x, timeOfDayVariants: x.timeOfDayVariants.map((y) => (y.id === picker.id ? { ...y, assetId: id } : y)) }));
          else if (picker?.kind === 'weather') setD((x) => ({ ...x, weatherVariants: x.weatherVariants.map((y) => (y.id === picker.id ? { ...y, assetId: id } : y)) }));
          setPicker(null);
        }}
        title="Choose an image"
      />
      {dialog}
    </Modal>
  );
}
