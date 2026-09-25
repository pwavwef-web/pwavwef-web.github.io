import { useState } from 'react';
import { arrayRemove, arrayUnion } from 'firebase/firestore';
import { toast } from 'sonner';
import { BadgeCheck, BookUser, ImagePlus, LayoutGrid, Lock, MapPin, Package, Plus, Shirt, Sparkles, Trash2, UserRound } from 'lucide-react';
import type { CharacterDoc, ElementDoc, ElementKind, ImagePurpose, JobRequest, LocationDoc, ProjectDoc, PropBibleDoc, SetBibleDoc } from '@az-studio/shared';
import { errorMessage } from '../lib/api';
import type { WithId } from '../lib/data';
import { useProjectCollection } from '../lib/continuity';
import { useBoot } from '../lib/session';
import { addDocs, deleteSubDoc, newCharacter, newElement, newLocation, updateSubDoc, useSub } from '../lib/studio';
import { CharacterBibleEditor } from './character-bible';
import { useJobSubmitter } from './jobs';
import { PropBibleEditor } from './prop-bible';
import { SetBibleEditor } from './set-bible';
import { AssetPicker, AssetThumb, useAsset, type Asset } from './media';
import { Badge, Button, Card, cx, EmptyState, Field, Input, Modal, Notice, Select, Textarea, Toggle } from './ui';

type Kind = 'characters' | 'locations' | 'elements';
type AnyDoc = WithId<CharacterDoc> | WithId<LocationDoc> | WithId<ElementDoc>;

const ICON = { characters: UserRound, locations: MapPin, elements: Package };

function RefImage({ id, primary, onPrimary, onRemove }: { id: string; primary: boolean; onPrimary: () => void; onRemove: () => void }) {
  const a = useAsset(id);
  return (
    <div className="relative">
      {a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} aspect="aspect-square" selected={primary} /> : <div className="aspect-square rounded-xl bg-white/5" />}
      <div className="absolute inset-x-1 bottom-1 z-20 flex justify-between gap-1">
        <button type="button" onClick={onPrimary} className={cx('cursor-pointer rounded-md px-1.5 py-0.5 text-[10px]', primary ? 'bg-accent text-white' : 'bg-black/70 text-dim hover:text-fg')}>
          {primary ? 'Primary' : 'Make primary'}
        </button>
        <button type="button" onClick={onRemove} aria-label="Remove reference" className="cursor-pointer rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-dim hover:text-fg">
          Remove
        </button>
      </div>
    </div>
  );
}

function Cover({ id }: { id: string | null }) {
  const a = useAsset(id);
  return a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} aspect="aspect-[4/5]" /> : <div className="cinema-thumb grid aspect-[4/5] place-items-center rounded-xl border border-line text-faint">No reference</div>;
}

const BIBLE_LABEL: Record<Kind, string> = { characters: 'Character Bible', locations: 'Set Bible', elements: 'Prop ledger' };

function Editor({ kind, project, item, onClose, onOpenBible }: { kind: Kind; project: WithId<ProjectDoc>; item: AnyDoc; onClose: () => void; onOpenBible: () => void }) {
  const boot = useBoot();
  const [draft, setDraft] = useState<AnyDoc>(item);
  const [picker, setPicker] = useState(false);
  const { submit, busy, dialog } = useJobSubmitter();
  const characters = useSub<CharacterDoc>(project.id, 'characters', 'name');
  const set = (patch: Record<string, unknown>) => setDraft({ ...draft, ...patch } as AnyDoc);
  const c = draft as WithId<CharacterDoc>;
  const l = draft as WithId<LocationDoc>;
  const e = draft as WithId<ElementDoc>;
  // Reference images are shared with generation jobs, which append to them when they finish, so they
  // are read live and written immediately (arrayUnion/arrayRemove) instead of going through the draft.
  const refs = item.referenceAssetIds;
  const primary = kind === 'elements' ? (refs[0] ?? null) : (item as WithId<CharacterDoc>).primaryRefAssetId;
  const turnaround = kind === 'characters' ? (item as WithId<CharacterDoc>).turnaroundAssetId : null;
  const updateRefs = (patch: Record<string, unknown>) => {
    updateSubDoc(project.id, kind, item.id, patch).catch((err: unknown) => toast.error('Could not update reference images', { description: errorMessage(err) }));
  };
  const addRefs = (ids: string[]) => {
    if (ids.length) updateRefs({ referenceAssetIds: arrayUnion(...ids), ...(kind !== 'elements' && !primary ? { primaryRefAssetId: ids[0] } : {}) });
  };
  const removeRef = (id: string) => updateRefs({ referenceAssetIds: arrayRemove(id), ...(kind !== 'elements' && primary === id ? { primaryRefAssetId: null } : {}), ...(turnaround === id ? { turnaroundAssetId: null } : {}) });
  const makePrimary = (id: string) => updateRefs(kind === 'elements' ? { referenceAssetIds: [id, ...refs.filter((x) => x !== id)] } : { primaryRefAssetId: id });

  const save = async () => {
    // The Character Bible is written through the API (approval locks identity), never from this form.
    const { id, referenceAssetIds, primaryRefAssetId, turnaroundAssetId, bible, ...fields } = draft as AnyDoc & { primaryRefAssetId?: unknown; turnaroundAssetId?: unknown; bible?: unknown };
    void [referenceAssetIds, primaryRefAssetId, turnaroundAssetId, bible];
    await updateSubDoc(project.id, kind, id, fields);
    toast.success('Saved');
  };
  const describe = () => {
    if (kind === 'characters') return [c.name, c.appearance, c.wardrobe, c.description].filter(Boolean).join('. ');
    if (kind === 'locations') return [l.name, l.description, l.atmosphere, l.timeOfDay, l.palette && `Palette: ${l.palette}`].filter(Boolean).join('. ');
    return [e.name, e.description].filter(Boolean).join('. ');
  };
  const gen = async (purpose: ImagePurpose) => {
    await save();
    const sources = refs.slice(0, 6);
    const job: JobRequest = {
      type: 'image.generate',
      projectId: project.id,
      prompt: describe() || draft.name,
      purpose,
      aspectRatio: purpose === 'turnaround' ? '16:9' : kind === 'locations' ? '16:9' : '4:5',
      imageSize: boot?.settings.defaultImageSize ?? '2K',
      referenceAssetIds: purpose === 'character' && !sources.length ? [] : sources,
      grounding: false,
      applyStyleBible: true,
      characterIds: kind === 'characters' ? [draft.id] : [],
      collections: [kind === 'characters' ? `character:${draft.id}` : kind === 'locations' ? `location:${draft.id}` : `element:${draft.id}`],
      target: { kind: kind === 'characters' ? 'character' : kind === 'locations' ? 'location' : 'element', id: draft.id },
      title: `${draft.name} · ${purpose}`,
      label: `${draft.name} · ${purpose}`,
    };
    await submit([job]);
  };
  const blocked = kind === 'characters' && c.realPerson && !c.consentConfirmed;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={draft.name}
      footer={
        <>
          <Button variant="danger" className="mr-auto" icon={<Trash2 className="size-4" />} onClick={() => void deleteSubDoc(project.id, kind, draft.id).then(onClose)}>
            Delete
          </Button>
          {(kind !== 'elements' || e.kind !== 'costume') && (
            <Button variant="ghost" icon={kind === 'locations' ? <LayoutGrid className="size-4" /> : <BookUser className="size-4" />} onClick={() => void save().then(onOpenBible)}>
              {BIBLE_LABEL[kind]}
            </Button>
          )}
          <Button variant="primary" onClick={() => void save().then(onClose)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={draft.name} onChange={(ev) => set({ name: ev.target.value })} />
          </Field>
          {kind === 'characters' && (
            <Field label="Role">
              <Input value={c.role} onChange={(ev) => set({ role: ev.target.value })} placeholder="Lead, antagonist, dancer…" />
            </Field>
          )}
          {kind === 'locations' && (
            <Field label="Time of day">
              <Input value={l.timeOfDay} onChange={(ev) => set({ timeOfDay: ev.target.value })} />
            </Field>
          )}
          {kind === 'elements' && (
            <Field label="Kind">
              <Select value={e.kind} onChange={(ev) => set({ kind: ev.target.value as ElementKind })}>
                <option value="prop">Prop</option>
                <option value="costume">Costume</option>
                <option value="vehicle">Vehicle</option>
                <option value="set_dressing">Set dressing</option>
              </Select>
            </Field>
          )}
        </div>
        {kind === 'characters' && (
          <>
            <Field label="Appearance" hint="Specific and reusable: age range, build, skin tone, hair, distinguishing features.">
              <Textarea rows={2} value={c.appearance} onChange={(ev) => set({ appearance: ev.target.value })} />
            </Field>
            <Field label="Wardrobe">
              <Textarea rows={2} value={c.wardrobe} onChange={(ev) => set({ wardrobe: ev.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Personality">
                <Textarea rows={2} value={c.personality} onChange={(ev) => set({ personality: ev.target.value })} />
              </Field>
              <Field label="Voice">
                <Textarea rows={2} value={c.voice} onChange={(ev) => set({ voice: ev.target.value })} />
              </Field>
            </div>
            <Field label="Background">
              <Textarea rows={2} value={c.description} onChange={(ev) => set({ description: ev.target.value })} />
            </Field>
            <Card className="space-y-3 p-4">
              <Toggle checked={c.realPerson} onChange={(v) => set({ realPerson: v, consentConfirmed: v ? c.consentConfirmed : false })} label="This character depicts a real person" description="Generating a real person’s likeness requires their consent." />
              {c.realPerson && <Toggle checked={c.consentConfirmed} onChange={(v) => set({ consentConfirmed: v })} label="I have this person’s documented consent" />}
              {blocked && <Notice tone="warning">Generation with this character is blocked until consent is confirmed.</Notice>}
            </Card>
          </>
        )}
        {kind === 'locations' && (
          <>
            <Field label="Description">
              <Textarea rows={3} value={l.description} onChange={(ev) => set({ description: ev.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Atmosphere">
                <Input value={l.atmosphere} onChange={(ev) => set({ atmosphere: ev.target.value })} />
              </Field>
              <Field label="Palette">
                <Input value={l.palette} onChange={(ev) => set({ palette: ev.target.value })} />
              </Field>
            </div>
          </>
        )}
        {kind === 'elements' && (
          <>
            <Field label="Description">
              <Textarea rows={3} value={e.description} onChange={(ev) => set({ description: ev.target.value })} />
            </Field>
            <Field label="Belongs to character">
              <Select value={e.characterId ?? ''} onChange={(ev) => set({ characterId: ev.target.value || null })}>
                <option value="">—</option>
                {characters.data.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        <Toggle checked={draft.locked} onChange={(v) => set({ locked: v })} label={<span className="inline-flex items-center gap-1.5"><Lock className="size-3.5" /> Continuity locked</span>} description="Locked entries are the reference of record — keep their look consistent across shots." />
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="eyebrow">Reference images ({refs.length})</p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setPicker(true)}>
                Add
              </Button>
              {kind === 'characters' && (
                <>
                  <Button size="sm" variant="subtle" loading={busy} disabled={blocked} icon={<Sparkles className="size-3.5" />} onClick={() => void gen('character')}>
                    Portrait
                  </Button>
                  <Button size="sm" variant="subtle" loading={busy} disabled={blocked || !refs.length} icon={<ImagePlus className="size-3.5" />} onClick={() => void gen('turnaround')}>
                    Turnaround
                  </Button>
                  <Button size="sm" variant="subtle" loading={busy} disabled={blocked} icon={<Shirt className="size-3.5" />} onClick={() => void gen('costume')}>
                    Costume
                  </Button>
                </>
              )}
              {kind === 'locations' && (
                <Button size="sm" variant="subtle" loading={busy} icon={<Sparkles className="size-3.5" />} onClick={() => void gen('location')}>
                  Location frame
                </Button>
              )}
              {kind === 'elements' && (
                <Button size="sm" variant="subtle" loading={busy} icon={<Sparkles className="size-3.5" />} onClick={() => void gen(e.kind === 'costume' ? 'costume' : 'product')}>
                  Concept image
                </Button>
              )}
            </div>
          </div>
          {refs.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-faint">Add or generate reference images. The primary image is sent to Omni as a locked reference in every shot that uses this {kind === 'characters' ? 'character' : kind === 'locations' ? 'location' : 'item'}.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {refs.map((id) => (
                <RefImage key={id} id={id} primary={primary === id} onPrimary={() => makePrimary(id)} onRemove={() => removeRef(id)} />
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-faint">Generated references appear here automatically when their job completes.</p>
        </div>
      </div>
      <AssetPicker
        open={picker}
        onOpenChange={setPicker}
        kinds={['image']}
        projectId={project.id}
        multiple
        max={14}
        onPick={(a) => addRefs(a.map((x) => x.id).filter((id) => !refs.includes(id)))}
      />
      {dialog}
    </Modal>
  );
}

export function BibleBoard({ kind, project, onExtract, extracting }: { kind: Kind; project: WithId<ProjectDoc>; onExtract?: () => void; extracting?: boolean }) {
  const items = useSub<AnyDoc>(project.id, kind, 'name');
  const sets = useProjectCollection<SetBibleDoc>(kind === 'locations' ? project.id : null, 'setBibles');
  const props = useProjectCollection<PropBibleDoc>(kind === 'elements' ? project.id : null, 'props');
  const [open, setOpen] = useState<string | null>(null);
  const [bibleFor, setBibleFor] = useState<string | null>(null);
  const Icon = ICON[kind];
  const label = kind === 'characters' ? 'character' : kind === 'locations' ? 'location' : 'prop or costume';
  const add = async () => {
    const [id] = await addDocs(project.id, kind, [kind === 'characters' ? newCharacter() : kind === 'locations' ? newLocation() : newElement()]);
    if (id) setOpen(id);
  };
  const current = open ? items.data.find((i) => i.id === open) : null;
  const bibleItem = bibleFor ? items.data.find((i) => i.id === bibleFor) : null;
  const status = (it: AnyDoc) => {
    if (kind === 'characters') return (it as WithId<CharacterDoc>).bible?.approvedAt ? { tone: 'success' as const, label: 'Identity locked' } : (it as WithId<CharacterDoc>).bible ? { tone: 'neutral' as const, label: 'Bible draft' } : null;
    if (kind === 'locations') {
      const sb = sets.data.find((x) => x.id === it.id);
      return sb?.canonical.status === 'locked' ? { tone: 'success' as const, label: 'Set locked' } : sb?.canonical.status === 'pending_approval' ? { tone: 'warning' as const, label: 'Views to approve' } : sb ? { tone: 'neutral' as const, label: 'Set draft' } : null;
    }
    return props.data.some((x) => x.id === it.id) ? { tone: 'accent' as const, label: 'In prop ledger' } : null;
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => void add()}>
          Add {label}
        </Button>
        {onExtract && (
          <Button size="sm" loading={extracting} icon={<Sparkles className="size-4" />} onClick={onExtract}>
            Extract from screenplay
          </Button>
        )}
      </div>
      {items.data.length === 0 ? (
        <EmptyState icon={<Icon className="size-5" />} title={`No ${kind} yet`} body={`Build a ${kind === 'characters' ? 'character bible' : kind === 'locations' ? 'location bible' : 'continuity list'} so every shot stays consistent.`} />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {items.data.map((it) => (
            <div key={it.id} className="group text-left">
              <button type="button" onClick={() => setOpen(it.id)} className="block w-full cursor-pointer text-left">
                <Cover id={'primaryRefAssetId' in it ? it.primaryRefAssetId : (it as WithId<ElementDoc>).referenceAssetIds[0] ?? null} />
                <div className="mt-2 flex items-center gap-1.5 px-1">
                  <p className="truncate text-sm font-medium text-fg">{it.name}</p>
                  {it.locked && <Lock className="size-3 text-accent-2" aria-label="Locked" />}
                </div>
                <p className="line-clamp-1 px-1 text-xs text-faint">{'role' in it ? it.role || 'Character' : 'atmosphere' in it ? it.atmosphere || it.timeOfDay || 'Location' : (it as WithId<ElementDoc>).kind.replace('_', ' ')}</p>
              </button>
              <div className="mt-1 flex flex-wrap items-center gap-1 px-1">
                {'realPerson' in it && it.realPerson && <Badge tone={it.consentConfirmed ? 'success' : 'warning'}>{it.consentConfirmed ? 'Consent on file' : 'Needs consent'}</Badge>}
                {(() => {
                  const st = status(it);
                  return st ? <Badge tone={st.tone} icon={st.tone === 'success' ? <BadgeCheck className="size-3" /> : undefined}>{st.label}</Badge> : null;
                })()}
                {(kind !== 'elements' || (it as WithId<ElementDoc>).kind !== 'costume') && (
                  <button type="button" className="cursor-pointer text-[11px] text-accent-2 hover:underline" onClick={() => setBibleFor(it.id)}>
                    {BIBLE_LABEL[kind]}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {current && (
        <Editor
          key={current.id}
          kind={kind}
          project={project}
          item={current}
          onClose={() => setOpen(null)}
          onOpenBible={() => {
            setOpen(null);
            setBibleFor(current.id);
          }}
        />
      )}
      {bibleItem && kind === 'characters' && <CharacterBibleEditor key={bibleItem.id} project={project} character={bibleItem as WithId<CharacterDoc>} onClose={() => setBibleFor(null)} />}
      {bibleItem && kind === 'locations' && <SetBibleEditor key={bibleItem.id} project={project} location={bibleItem as WithId<LocationDoc>} onClose={() => setBibleFor(null)} />}
      {bibleItem && kind === 'elements' && <PropBibleEditor key={bibleItem.id} project={project} element={bibleItem as WithId<ElementDoc>} onClose={() => setBibleFor(null)} />}
    </div>
  );
}
