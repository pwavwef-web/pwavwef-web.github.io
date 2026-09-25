import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Save } from 'lucide-react';
import {
  defaultPropState,
  HANDS,
  PROP_EVENT_LABELS,
  PROP_STATUSES,
  type CharacterDoc,
  type ElementDoc,
  type PropBibleDoc,
  type PropState,
  type PropStateDoc,
  type ProjectDoc,
  type ShotDoc,
} from '@az-studio/shared';
import { errorMessage } from '../lib/api';
import type { WithId } from '../lib/data';
import { saveContinuity, useProjectCollection, useProjectDoc } from '../lib/continuity';
import { useSub } from '../lib/studio';
import { AssetSlot } from './fields';
import { AssetPicker } from './media';
import { Badge, Button, Card, Field, Input, Modal, Select, Textarea, Toggle } from './ui';

type Draft = Omit<PropBibleDoc, 'id' | 'updatedAt'>;

function draftOf(element: WithId<ElementDoc>, p: WithId<PropBibleDoc> | null): Draft {
  return {
    elementId: element.id,
    ownerId: p?.ownerId ?? element.characterId ?? null,
    approvedRefAssetId: p?.approvedRefAssetId ?? element.referenceAssetIds[0] ?? null,
    description: p?.description ?? element.description ?? '',
    scale: p?.scale ?? '',
    entersShotId: p?.entersShotId ?? null,
    leavesShotId: p?.leavesShotId ?? null,
    initial: { ...defaultPropState(), ...(p?.initial ?? {}) },
    notes: p?.notes ?? '',
  };
}

/** One prop's state, written the same way in the editor, the history and the shot panels. */
export function describePropState(s: Pick<PropState, 'present' | 'holderId' | 'hand' | 'location' | 'condition' | 'status'>, names: Record<string, string>): string {
  if (!s.present) return 'not in the scene';
  const where = s.holderId ? `held by ${names[s.holderId] ?? 'a character'}${s.hand ? ` (${s.hand} hand)` : ''}` : s.location ? `at ${s.location}` : 'in the scene';
  return [where, s.status !== 'intact' ? s.status : '', s.condition].filter(Boolean).join(' · ');
}

/** Planned and approved states of a prop, shot by shot, with the events that changed it. */
export function PropHistory({ projectId, propId, names }: { projectId: string; propId: string; names: Record<string, string> }) {
  const states = useProjectCollection<PropStateDoc>(projectId, 'propStates', { where: [['propId', '==', propId]], order: 'order' });
  const shots = useSub<ShotDoc>(projectId, 'shots');
  const title = (id: string) => {
    const s = shots.data.find((x) => x.id === id);
    return s ? `${s.number ? `${s.number} · ` : ''}${s.title || 'Untitled shot'}` : 'Deleted shot';
  };
  if (states.loading) return <p className="text-xs text-faint">Loading…</p>;
  if (!states.data.length) return <p className="text-xs text-faint">No shots use this prop yet. Each continuity check records the planned state here; approving a take records the approved state.</p>;
  return (
    <ol className="space-y-1.5">
      {states.data.map((s) => (
        <li key={s.id} className="rounded-lg border border-line px-3 py-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-fg">{title(s.shotId)}</span>
            {s.approved ? <Badge tone="success">approved</Badge> : <Badge>planned</Badge>}
          </div>
          {s.events.length > 0 && <p className="text-accent-2">{s.events.map((e) => `${e.characterId ? `${names[e.characterId] ?? 'Someone'} ` : ''}${PROP_EVENT_LABELS[e.type].toLowerCase()}${e.toCharacterId ? ` to ${names[e.toCharacterId] ?? 'someone'}` : ''}${e.hand ? ` (${e.hand} hand)` : ''}`).join('; ')}</p>}
          <p className="text-dim">{describePropState(s.approved ?? s.planned, names)}</p>
          {s.approved && JSON.stringify(s.approved) !== JSON.stringify(s.planned) && <p className="text-warning">Planned: {describePropState(s.planned, names)}</p>}
        </li>
      ))}
    </ol>
  );
}

/**
 * Prop ledger entry: approved reference, owner, scale, where it enters and leaves the story, its
 * starting state (who holds it, in which hand, where it rests, open/closed, damaged…) and its history.
 * Shots record events (picks up, hands over, puts down…) and continuity carries the state forward, so a
 * prop cannot jump hands, teleport or change appearance without a recorded reason.
 */
export function PropBibleEditor({ project, element, onClose }: { project: WithId<ProjectDoc>; element: WithId<ElementDoc>; onClose: () => void }) {
  const stored = useProjectDoc<PropBibleDoc>(project.id, 'props', element.id);
  const characters = useSub<CharacterDoc>(project.id, 'characters', 'name');
  const shots = useSub<ShotDoc>(project.id, 'shots');
  const [d, setD] = useState<Draft>(() => draftOf(element, null));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  useEffect(() => {
    if (stored.loading || loaded) return;
    setD(draftOf(element, stored.data));
    setLoaded(true);
  }, [stored.loading, stored.data, loaded, element]);
  const names = Object.fromEntries(characters.data.map((c) => [c.id, c.name]));
  const setInitial = (patch: Partial<PropState>) => setD((x) => ({ ...x, initial: { ...x.initial, ...patch } }));
  const save = async () => {
    setBusy(true);
    try {
      await saveContinuity(project.id, 'props', d as unknown as Record<string, unknown>);
      toast.success('Prop ledger saved');
      onClose();
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const shotOptions = shots.data.map((s) => (
    <option key={s.id} value={s.id}>
      {s.number ? `${s.number} · ` : ''}
      {s.title || 'Untitled shot'}
    </option>
  ));
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Prop ledger · ${element.name}`}
      description="The reviewer checks every take against this entry and the state continuity carries forward from the previous approved shot."
      footer={
        <Button variant="primary" loading={busy} disabled={!loaded} onClick={() => void save()} icon={<Save className="size-4" />}>
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_minmax(0,1fr)]">
          <AssetSlot label="Approved reference" aspect="aspect-square" assetId={d.approvedRefAssetId} onPick={() => setPicker(true)} onClear={() => setD((x) => ({ ...x, approvedRefAssetId: null }))} />
          <div className="space-y-3">
            <Field label="Appearance" hint="Exact look the reviewer compares with: colour, material, markings, wear.">
              <Textarea rows={3} value={d.description} onChange={(e) => setD((x) => ({ ...x, description: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Scale">
                <Input value={d.scale} onChange={(e) => setD((x) => ({ ...x, scale: e.target.value }))} placeholder="e.g. fits in one hand, 20 cm" />
              </Field>
              <Field label="Owner">
                <Select value={d.ownerId ?? ''} onChange={(e) => setD((x) => ({ ...x, ownerId: e.target.value || null }))}>
                  <option value="">—</option>
                  {characters.data.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Enters the story in">
                <Select value={d.entersShotId ?? ''} onChange={(e) => setD((x) => ({ ...x, entersShotId: e.target.value || null }))}>
                  <option value="">From the start</option>
                  {shotOptions}
                </Select>
              </Field>
              <Field label="Leaves the story after">
                <Select value={d.leavesShotId ?? ''} onChange={(e) => setD((x) => ({ ...x, leavesShotId: e.target.value || null }))}>
                  <option value="">Stays to the end</option>
                  {shotOptions}
                </Select>
              </Field>
            </div>
          </div>
        </div>
        <Card className="space-y-3 p-3">
          <p className="eyebrow">Starting state</p>
          <Toggle checked={d.initial.present} onChange={(v) => setInitial({ present: v })} label="Present when it enters" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Field label="Held by">
              <Select value={d.initial.holderId ?? ''} onChange={(e) => setInitial({ holderId: e.target.value || null, hand: e.target.value ? d.initial.hand ?? 'right' : null })}>
                <option value="">Nobody</option>
                {characters.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Hand">
              <Select value={d.initial.hand ?? ''} disabled={!d.initial.holderId} onChange={(e) => setInitial({ hand: (e.target.value || null) as PropState['hand'] })}>
                <option value="">—</option>
                {HANDS.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select value={d.initial.status} onChange={(e) => setInitial({ status: e.target.value as PropState['status'] })}>
                {PROP_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Where it rests">
              <Input value={d.initial.location} onChange={(e) => setInitial({ location: e.target.value })} placeholder="e.g. on the kitchen table" />
            </Field>
            <Field label="Condition">
              <Input value={d.initial.condition} onChange={(e) => setInitial({ condition: e.target.value })} placeholder="e.g. new, dusty, cracked lid" />
            </Field>
            <Field label="Orientation">
              <Input value={d.initial.orientation} onChange={(e) => setInitial({ orientation: e.target.value })} placeholder="e.g. label facing out" />
            </Field>
          </div>
        </Card>
        <Field label="Notes">
          <Textarea rows={2} value={d.notes} onChange={(e) => setD((x) => ({ ...x, notes: e.target.value }))} />
        </Field>
        <Card className="space-y-2 p-3">
          <p className="eyebrow">History through the film</p>
          <PropHistory projectId={project.id} propId={element.id} names={names} />
        </Card>
      </div>
      <AssetPicker
        open={picker}
        onOpenChange={setPicker}
        kinds={['image']}
        projectId={project.id}
        onPick={(a) => {
          setD((x) => ({ ...x, approvedRefAssetId: a[0]?.id ?? null }));
          setPicker(false);
        }}
        title="Choose the approved reference"
      />
    </Modal>
  );
}
