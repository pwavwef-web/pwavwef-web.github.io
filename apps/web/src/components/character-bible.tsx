import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BadgeCheck, Lock, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import { emptyCharacterBible, type CharacterBible, type CharacterDoc, type CharacterStateDoc, type ProjectDoc, type ShotDoc } from '@az-studio/shared';
import { errorMessage } from '../lib/api';
import type { WithId } from '../lib/data';
import { approveBible, saveCharacterBible, useProjectCollection } from '../lib/continuity';
import { useBoot } from '../lib/session';
import { useSub } from '../lib/studio';
import { AssetSlot, ChipList } from './fields';
import { useJobSubmitter } from './jobs';
import { AssetPicker, AssetThumb, useAsset, type Asset } from './media';
import { Badge, Button, Card, cx, Field, Input, Modal, Notice, Textarea } from './ui';

type View = keyof CharacterBible['refs'];

const VIEWS: { key: View; label: string; prompt: string }[] = [
  { key: 'front', label: 'Front', prompt: 'front view portrait facing the camera, neutral expression, even soft light, plain neutral background' },
  { key: 'profile', label: 'Profile', prompt: 'strict side profile (90 degrees), same person, same lighting, plain neutral background' },
  { key: 'threeQuarter', label: 'Three-quarter', prompt: 'three-quarter view (about 45 degrees), same person, plain neutral background' },
  { key: 'fullBody', label: 'Full body', prompt: 'full-body front view from head to toe in the default costume, standing naturally, plain neutral background' },
];

function RefToggle({ id, on, order, onToggle }: { id: string; on: boolean; order: number; onToggle: () => void }) {
  const a = useAsset(id);
  return (
    <button type="button" onClick={onToggle} aria-pressed={on} className={cx('relative cursor-pointer rounded-xl border-2', on ? 'border-success' : 'border-transparent')}>
      {a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} aspect="aspect-square" hoverPlay={false} /> : <div className="aspect-square rounded-xl bg-white/5" />}
      {on && <span className="absolute top-1 left-1 grid size-5 place-items-center rounded-full bg-success text-[11px] font-semibold text-black">{order}</span>}
    </button>
  );
}

/** Character states shot by shot (planned vs approved). */
function StateTimeline({ project, character }: { project: WithId<ProjectDoc>; character: WithId<CharacterDoc> }) {
  const states = useProjectCollection<CharacterStateDoc>(project.id, 'characterStates', { where: [['characterId', '==', character.id]], order: 'order' });
  const shots = useSub<ShotDoc>(project.id, 'shots');
  const title = (id: string) => shots.data.find((s) => s.id === id)?.title ?? 'Deleted shot';
  if (!states.data.length) return <p className="text-xs text-faint">No approved shots with {character.name} yet — each approved take records the character’s state here.</p>;
  return (
    <ol className="space-y-1.5">
      {states.data.map((s) => {
        const st = s.approved ?? s.planned;
        return (
          <li key={s.id} className="rounded-lg border border-line px-3 py-1.5 text-xs">
            <span className="text-fg">{title(s.shotId)}</span>
            {s.approved ? <Badge tone="success" className="ml-1.5">approved</Badge> : <Badge className="ml-1.5">planned</Badge>}
            <p className="text-dim">
              {st.costume || 'costume unchanged'} · {st.posture} · L: {st.leftHand ?? 'empty'} · R: {st.rightHand ?? 'empty'}
              {st.emotion ? ` · ${st.emotion}` : ''}
              {st.physical ? ` · ${st.physical}` : ''}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Character Bible and identity lock: approved face and body references (front, profile, three-quarter,
 * full body), physical description, costumes, accessories, voice and movement, and the identity
 * requirements every take is checked against. Approving locks the character for generation.
 */
export function CharacterBibleEditor({ project, character, onClose }: { project: WithId<ProjectDoc>; character: WithId<CharacterDoc>; onClose: () => void }) {
  const boot = useBoot();
  const [b, setB] = useState<CharacterBible>(() => ({ ...emptyCharacterBible(), ...(character.bible ?? {}) }));
  const [busy, setBusy] = useState<'save' | 'approve' | 'withdraw' | null>(null);
  const [picker, setPicker] = useState<{ kind: 'view'; view: View } | { kind: 'costume'; id: string } | null>(null);
  const { submit, busy: submitting, dialog } = useJobSubmitter();
  const approved = Boolean(character.bible?.approvedAt);
  const refs = character.referenceAssetIds;
  const blocked = character.realPerson && !character.consentConfirmed;
  const set = (patch: Partial<CharacterBible>) => setB((x) => ({ ...x, ...patch }));
  const candidates = useMemo(() => [...new Set([...refs, ...Object.values(b.refs).filter((x): x is string => Boolean(x))])], [refs, b.refs]);
  const bibleBody = () => {
    const { approvedAt, ...rest } = b;
    void approvedAt;
    return rest;
  };
  const save = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'save');
    try {
      await saveCharacterBible(project.id, character.id, bibleBody(), approve);
      toast.success(approve ? `${character.name} is locked` : 'Character Bible saved', { description: approve ? 'Every shot with this character now uses the approved references and is checked against them.' : undefined });
      if (approve) onClose();
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const withdraw = async () => {
    setBusy('withdraw');
    try {
      await approveBible(project.id, 'character', character.id, false);
      toast.success('Identity lock withdrawn');
    } catch (e) {
      toast.error('Could not withdraw', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const generateView = async (view: (typeof VIEWS)[number]) => {
    const refIds = (b.approvedRefIds.length ? b.approvedRefIds : character.primaryRefAssetId ? [character.primaryRefAssetId] : refs.slice(0, 3)).slice(0, 6);
    const description = [character.appearance, b.skinTone && `skin tone ${b.skinTone}`, b.hair && `hair ${b.hair}`, b.features, b.ageRange && `age ${b.ageRange}`, view.key === 'fullBody' ? b.costumes.find((c) => c.id === b.defaultCostumeId)?.description ?? character.wardrobe : ''].filter(Boolean).join('; ');
    await submit(
      [
        {
          type: 'image.generate',
          projectId: project.id,
          prompt: `${character.name}: ${view.prompt}. ${description}. Identity must match the reference images exactly.`,
          purpose: 'character',
          aspectRatio: view.key === 'fullBody' ? '9:16' : '4:5',
          imageSize: boot?.settings.defaultImageSize ?? '2K',
          referenceAssetIds: refIds,
          grounding: false,
          applyStyleBible: false,
          characterIds: [character.id],
          collections: [`character:${character.id}`],
          target: { kind: 'character', id: character.id },
          title: `${character.name} · ${view.label}`,
          label: `${character.name} · ${view.label} reference`,
        },
      ],
      { label: `${character.name} · ${view.label} reference` },
    );
  };
  const text = (k: 'height' | 'build' | 'skinTone' | 'hair' | 'facialHair' | 'ageRange' | 'performer', label: string, placeholder?: string) => (
    <Field label={label}>
      <Input value={b[k]} onChange={(e) => set({ [k]: e.target.value })} placeholder={placeholder} />
    </Field>
  );
  const area = (k: 'features' | 'voiceProfile' | 'speakingStyle' | 'emotionalBaseline' | 'movementStyle', label: string, placeholder?: string) => (
    <Field label={label}>
      <Textarea rows={2} value={b[k]} onChange={(e) => set({ [k]: e.target.value })} placeholder={placeholder} />
    </Field>
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={
        <span className="flex items-center gap-2">
          Character Bible · {character.name}
          {approved ? <Badge tone="success" icon={<BadgeCheck className="size-3" />}>Locked</Badge> : <Badge>Draft</Badge>}
        </span>
      }
      description="Approved references and identity requirements are sent with every shot of this character, and every take is checked against them."
      footer={
        <>
          {approved && (
            <Button variant="ghost" className="mr-auto" loading={busy === 'withdraw'} onClick={() => void withdraw()}>
              Withdraw lock
            </Button>
          )}
          <Button variant="ghost" loading={busy === 'save'} onClick={() => void save(false)} icon={<Save className="size-4" />}>
            Save draft
          </Button>
          <Button variant="primary" loading={busy === 'approve'} disabled={!b.approvedRefIds.length || blocked} onClick={() => void save(true)} icon={<Lock className="size-4" />}>
            {approved ? 'Save & keep locked' : 'Approve & lock identity'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {blocked && <Notice tone="warning">{character.name} depicts a real person: confirm their consent on the character sheet before approving identity references.</Notice>}
        <div>
          <p className="eyebrow mb-2">Identity views</p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {VIEWS.map((v) => (
              <AssetSlot
                key={v.key}
                label={v.label}
                aspect="aspect-[4/5]"
                assetId={b.refs[v.key]}
                onPick={() => setPicker({ kind: 'view', view: v.key })}
                onClear={() => set({ refs: { ...b.refs, [v.key]: null } })}
                action={
                  <Button size="sm" variant="subtle" loading={submitting} disabled={blocked} icon={<Sparkles className="size-3.5" />} onClick={() => void generateView(v)}>
                    Generate
                  </Button>
                }
              />
            ))}
          </div>
          <p className="mt-1 text-[11px] text-faint">Generated views land in the character’s reference images; choose them into the slots above.</p>
        </div>
        <div>
          <p className="eyebrow mb-1">Approved references for generation (in order, up to 6)</p>
          {candidates.length ? (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
              {candidates.map((id) => (
                <RefToggle key={id} id={id} on={b.approvedRefIds.includes(id)} order={b.approvedRefIds.indexOf(id) + 1} onToggle={() => set({ approvedRefIds: b.approvedRefIds.includes(id) ? b.approvedRefIds.filter((x) => x !== id) : [...b.approvedRefIds, id].slice(0, 6) })} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-faint">Add reference images to the character first.</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {text('height', 'Height', 'e.g. 1.72 m, tall')}
          {text('build', 'Body proportions')}
          {text('skinTone', 'Skin tone')}
          {text('ageRange', 'Age range', 'e.g. 30–35')}
          {text('hair', 'Hair')}
          {text('facialHair', 'Facial hair')}
          {text('performer', 'Performer / voice credit')}
        </div>
        {area('features', 'Distinguishing features', 'e.g. small scar over the left eyebrow, gap in the front teeth')}
        <Card className="space-y-2 p-3">
          <div className="flex items-center justify-between">
            <p className="eyebrow">Costumes</p>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={b.costumes.length >= 20} onClick={() => {
                const nid = `c${Date.now().toString(36)}${b.costumes.length}`;
                set({ costumes: [...b.costumes, { id: nid, name: b.costumes.length ? `Costume ${b.costumes.length + 1}` : 'Default', description: '', assetId: null }], ...(b.defaultCostumeId ? {} : { defaultCostumeId: nid }) });
              }}
            >
              Add costume
            </Button>
          </div>
          {b.costumes.map((c) => (
            <div key={c.id} className="grid grid-cols-1 gap-2 rounded-lg border border-line p-2 md:grid-cols-[160px_minmax(0,1fr)_140px_auto]">
              <Input value={c.name} onChange={(e) => set({ costumes: b.costumes.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)) })} aria-label="Costume name" />
              <Textarea rows={2} value={c.description} onChange={(e) => set({ costumes: b.costumes.map((x) => (x.id === c.id ? { ...x, description: e.target.value } : x)) })} placeholder="Garments, colours, fabrics, how it is worn" aria-label="Costume description" />
              <AssetSlot label="Image" assetId={c.assetId} aspect="aspect-[4/5]" onPick={() => setPicker({ kind: 'costume', id: c.id })} onClear={() => set({ costumes: b.costumes.map((x) => (x.id === c.id ? { ...x, assetId: null } : x)) })} />
              <div className="flex flex-col gap-1">
                <Button size="sm" variant={b.defaultCostumeId === c.id ? 'subtle' : 'ghost'} onClick={() => set({ defaultCostumeId: c.id })}>
                  {b.defaultCostumeId === c.id ? 'Default' : 'Make default'}
                </Button>
                <Button size="sm" variant="ghost" aria-label="Remove costume" onClick={() => set({ costumes: b.costumes.filter((x) => x.id !== c.id), defaultCostumeId: b.defaultCostumeId === c.id ? null : b.defaultCostumeId })}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </Card>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Accessories (always present)">
            <ChipList value={b.accessories} max={20} onChange={(v) => set({ accessories: v })} placeholder="e.g. silver bracelet on the right wrist" />
          </Field>
          <Field label="Items usually carried">
            <ChipList value={b.itemsCarried} max={12} onChange={(v) => set({ itemsCarried: v })} placeholder="e.g. leather satchel" />
          </Field>
          <Field label="Protected identity requirements" hint="Checked in every take; a miss fails the take.">
            <ChipList value={b.protectedIdentity} max={12} onChange={(v) => set({ protectedIdentity: v })} placeholder="e.g. scar over the left eyebrow must be visible" />
          </Field>
          <Field label="Character colour palette">
            <ChipList value={b.palette} max={10} onChange={(v) => set({ palette: v })} placeholder="e.g. indigo" />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {area('voiceProfile', 'Voice profile')}
          {area('speakingStyle', 'Speaking style')}
          {area('emotionalBaseline', 'Emotional baseline')}
          {area('movementStyle', 'Movement style')}
        </div>
        <Card className="space-y-2 p-3">
          <p className="eyebrow">State through the film</p>
          <StateTimeline project={project} character={character} />
        </Card>
      </div>
      <AssetPicker
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        kinds={['image']}
        projectId={project.id}
        onPick={(a) => {
          const id = a[0]?.id ?? null;
          if (picker?.kind === 'view') set({ refs: { ...b.refs, [picker.view]: id } });
          else if (picker?.kind === 'costume') set({ costumes: b.costumes.map((x) => (x.id === picker.id ? { ...x, assetId: id } : x)) });
          setPicker(null);
        }}
        title="Choose an image"
      />
      {dialog}
    </Modal>
  );
}
