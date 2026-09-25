import { Plus, Trash2 } from 'lucide-react';
import {
  AXIS_CROSSING_LABELS,
  AXIS_CROSSING_REASONS,
  emptyShotContinuity,
  ENTRY_SIDES,
  HANDS,
  POSTURES,
  PROP_EVENT_LABELS,
  PROP_EVENT_TYPES,
  type CharacterState,
  type ProtectedScreenDoc,
  type PropEvent,
  type ShotContinuityInput,
  type ShotDoc,
} from '@az-studio/shared';
import type { WithId } from '../lib/data';
import { useProjectCollection } from '../lib/continuity';
import type { Character, Element } from './shots';
import { Button, Card, cx, Field, Input, Select, Toggle } from './ui';

type CharChange = Partial<CharacterState> & { costumeChangeReason?: string };

/**
 * The director's continuity plan for one shot: what changes for each character, which props are in play
 * and what happens to them on screen, the environment, protected screens, and deliberate decisions
 * about the 180-degree line and screen direction. Everything else continues from the previous shot.
 */
export function ShotContinuityEditor({ projectId, shot, value, onChange, characters, elements }: { projectId: string; shot: ShotDoc; value: ShotContinuityInput | null | undefined; onChange: (v: ShotContinuityInput) => void; characters: Character[]; elements: Element[] }) {
  const v = value ?? emptyShotContinuity();
  const screens = useProjectCollection<ProtectedScreenDoc>(projectId, 'protectedScreens', { order: 'name' });
  const inShot = characters.filter((c) => shot.refs.characterIds.includes(c.id));
  const propIds = [...new Set([...shot.refs.elementIds, ...v.propIds])];
  const props = elements.filter((e) => propIds.includes(e.id));
  const setChar = (id: string, patch: CharChange) => onChange({ ...v, characters: { ...v.characters, [id]: { ...(v.characters[id] ?? {}), ...patch } } });
  const clearChar = (id: string, key: keyof CharChange) => {
    const cur = { ...(v.characters[id] ?? {}) } as Record<string, unknown>;
    delete cur[key];
    onChange({ ...v, characters: { ...v.characters, [id]: cur as CharChange } });
  };
  const setEvent = (i: number, patch: Partial<PropEvent>) => onChange({ ...v, propEvents: v.propEvents.map((e, k) => (k === i ? { ...e, ...patch } : e)) });
  const text = (id: string, key: 'costume' | 'hair' | 'physical' | 'emotion' | 'action' | 'gaze' | 'costumeChangeReason', label: string, placeholder = 'continues') => (
    <Field label={label}>
      <Input
        value={(v.characters[id]?.[key] as string | undefined) ?? ''}
        placeholder={placeholder}
        onChange={(e) => (e.target.value ? setChar(id, { [key]: e.target.value }) : clearChar(id, key))}
      />
    </Field>
  );
  const handSelect = (id: string, key: 'leftHand' | 'rightHand', label: string) => {
    const cur = v.characters[id]?.[key];
    return (
      <Field label={label}>
        <Select value={cur === undefined ? '__keep' : cur === null ? '__empty' : cur} onChange={(e) => (e.target.value === '__keep' ? clearChar(id, key) : setChar(id, { [key]: e.target.value === '__empty' ? null : e.target.value }))}>
          <option value="__keep">Continues</option>
          <option value="__empty">Empty</option>
          {props.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
    );
  };
  return (
    <div className="space-y-4">
      <p className="text-xs text-faint">Only record what changes in this shot — everything else continues from the previous approved shot. A change of costume needs a reason; prop changes need an on-screen action.</p>
      {inShot.map((c) => {
        const ch = v.characters[c.id] ?? {};
        return (
          <Card key={c.id} className="space-y-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-fg">{c.name}</p>
              <Toggle checked={ch.present !== false} onChange={(on) => (on ? clearChar(c.id, 'present') : setChar(c.id, { present: false }))} label="In the shot" />
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {c.bible?.costumes?.length ? (
                <Field label="Costume">
                  <Select value={ch.costumeId ?? '__keep'} onChange={(e) => (e.target.value === '__keep' ? (clearChar(c.id, 'costumeId'), clearChar(c.id, 'costume')) : setChar(c.id, { costumeId: e.target.value, costume: c.bible!.costumes.find((x) => x.id === e.target.value)?.name ?? '' }))}>
                    <option value="__keep">Continues</option>
                    {c.bible.costumes.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                text(c.id, 'costume', 'Costume')
              )}
              {(ch.costume || ch.costumeId) && text(c.id, 'costumeChangeReason', 'Why the costume changes', 'e.g. she changes for the wedding off screen')}
              {text(c.id, 'hair', 'Hair')}
              {text(c.id, 'physical', 'Physical change', 'none (dirt, injury, wet…)')}
              {text(c.id, 'emotion', 'Emotional state')}
              <Field label="Posture">
                <Select value={ch.posture ?? '__keep'} onChange={(e) => (e.target.value === '__keep' ? clearChar(c.id, 'posture') : setChar(c.id, { posture: e.target.value as CharacterState['posture'] }))}>
                  <option value="__keep">Continues</option>
                  {POSTURES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </Field>
              {handSelect(c.id, 'leftHand', 'Left hand')}
              {handSelect(c.id, 'rightHand', 'Right hand')}
              {(['entry', 'exit'] as const).map((k) => (
                <Field key={k} label={k === 'entry' ? 'Enters from' : 'Exits to'}>
                  <Select value={ch[k] ?? '__keep'} onChange={(e) => (e.target.value === '__keep' ? clearChar(c.id, k) : setChar(c.id, { [k]: e.target.value as CharacterState['entry'] }))}>
                    <option value="__keep">—</option>
                    {ENTRY_SIDES.filter((s) => s !== 'none').map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
              {text(c.id, 'action', 'Current action')}
              {text(c.id, 'gaze', 'Looks at', 'camera, another character or a prop')}
            </div>
          </Card>
        );
      })}
      {!inShot.length && <p className="text-xs text-faint">Add characters to the shot to plan their state.</p>}

      <Card className="space-y-2 p-3">
        <div className="flex items-center justify-between">
          <p className="eyebrow">Props in play</p>
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={!props.length} onClick={() => onChange({ ...v, propEvents: [...v.propEvents, { propId: props[0]!.id, type: 'pick_up', characterId: inShot[0]?.id ?? null, toCharacterId: null, hand: 'right', location: '', note: '' }] })}>
            Prop action
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {elements.map((e) => {
            const on = propIds.includes(e.id);
            const fromShot = shot.refs.elementIds.includes(e.id);
            return (
              <button key={e.id} type="button" disabled={fromShot} aria-pressed={on} onClick={() => onChange({ ...v, propIds: on ? v.propIds.filter((x) => x !== e.id) : [...v.propIds, e.id] })} className={cx('cursor-pointer rounded-full border px-2.5 py-1 text-xs disabled:cursor-default', on ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim')}>
                {e.name}
              </button>
            );
          })}
        </div>
        {v.propEvents.map((ev, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-line p-2 md:grid-cols-[1fr_1fr_1fr_1fr_1fr_auto]">
            <Select aria-label="Prop" value={ev.propId} onChange={(e) => setEvent(i, { propId: e.target.value })}>
              {props.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Action" value={ev.type} onChange={(e) => setEvent(i, { type: e.target.value as PropEvent['type'] })}>
              {PROP_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PROP_EVENT_LABELS[t]}
                </option>
              ))}
            </Select>
            <Select aria-label="Who" value={ev.characterId ?? ''} onChange={(e) => setEvent(i, { characterId: e.target.value || null })}>
              <option value="">Nobody</option>
              {inShot.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            {ev.type === 'hand_over' ? (
              <Select aria-label="To" value={ev.toCharacterId ?? ''} onChange={(e) => setEvent(i, { toCharacterId: e.target.value || null })}>
                <option value="">To…</option>
                {inShot.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            ) : (
              <Select aria-label="Hand" value={ev.hand ?? ''} onChange={(e) => setEvent(i, { hand: (e.target.value || null) as PropEvent['hand'] })}>
                <option value="">Any hand</option>
                {HANDS.map((h) => (
                  <option key={h} value={h}>
                    {h} hand
                  </option>
                ))}
              </Select>
            )}
            <Input aria-label="Where it ends up" value={ev.location} placeholder="Ends up (put down)" onChange={(e) => setEvent(i, { location: e.target.value })} />
            <Button size="sm" variant="ghost" aria-label="Remove prop action" onClick={() => onChange({ ...v, propEvents: v.propEvents.filter((_, k) => k !== i) })}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </Card>

      <Card className="space-y-2 p-3">
        <p className="eyebrow">Environment</p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {(['timeOfDay', 'weather', 'lightDirection', 'lightColour', 'background'] as const).map((k) => (
            <Field key={k} label={{ timeOfDay: 'Time of day', weather: 'Weather', lightDirection: 'Light direction', lightColour: 'Light colour', background: 'Background change' }[k]}>
              <Input value={v.environment[k] ?? ''} placeholder="continues" onChange={(e) => onChange({ ...v, environment: { ...v.environment, [k]: e.target.value } })} />
            </Field>
          ))}
          <Field label="Intentionally different look" hint="Colour matching leaves this shot alone (flashback, night, dream).">
            <Input value={v.intentionalLook} onChange={(e) => onChange({ ...v, intentionalLook: e.target.value })} placeholder="none" />
          </Field>
        </div>
      </Card>

      <Card className="space-y-2 p-3">
        <p className="eyebrow">Protected screens, signs and logos</p>
        {screens.data.length === 0 ? (
          <p className="text-xs text-faint">Define protected surfaces (phones, signs, logos) in the Continuity workspace.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {screens.data.map((sc: WithId<ProtectedScreenDoc>) => {
              const on = v.screenIds.includes(sc.id);
              return (
                <button key={sc.id} type="button" aria-pressed={on} onClick={() => onChange({ ...v, screenIds: on ? v.screenIds.filter((x) => x !== sc.id) : [...v.screenIds, sc.id] })} className={cx('cursor-pointer rounded-full border px-2.5 py-1 text-xs', on ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim')}>
                  {sc.name}
                  {sc.composite ? ' · composited' : ''}
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="space-y-2 p-3">
        <p className="eyebrow">Camera axis and screen direction</p>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <Field label="Crossing the 180° line" hint="Allowed only when planned, bridged by a neutral shot, shown by a moving camera or overridden.">
            <Select value={v.axisCrossing?.reason ?? ''} onChange={(e) => onChange({ ...v, axisCrossing: e.target.value ? { reason: e.target.value as NonNullable<ShotContinuityInput['axisCrossing']>['reason'], note: v.axisCrossing?.note ?? '' } : null })}>
              <option value="">Must not cross</option>
              {AXIS_CROSSING_REASONS.map((r) => (
                <option key={r} value={r}>
                  {AXIS_CROSSING_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          {v.axisCrossing && (
            <Field label="Why">
              <Input value={v.axisCrossing.note} onChange={(e) => onChange({ ...v, axisCrossing: { ...v.axisCrossing!, note: e.target.value } })} />
            </Field>
          )}
          <Field label="Deliberate change of travel direction">
            <Select value={v.directionChange?.refId ?? ''} onChange={(e) => onChange({ ...v, directionChange: e.target.value ? { refId: e.target.value, reason: v.directionChange?.reason ?? '' } : null })}>
              <option value="">None</option>
              {inShot.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} turns back
                </option>
              ))}
            </Select>
          </Field>
          {v.directionChange && (
            <Field label="Why">
              <Input value={v.directionChange.reason} onChange={(e) => onChange({ ...v, directionChange: { ...v.directionChange!, reason: e.target.value } })} />
            </Field>
          )}
        </div>
        <Toggle checked={v.startFromPreviousFrame} onChange={(on) => onChange({ ...v, startFromPreviousFrame: on })} label="Begin exactly where the previous approved shot ended" description="Its final frame becomes this shot's first frame." />
      </Card>
    </div>
  );
}
