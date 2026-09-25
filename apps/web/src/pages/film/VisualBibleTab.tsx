import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BadgeCheck, CircleCheck, ImagePlus, Lock, Palette, Plus, Save, Wand2, X } from 'lucide-react';
import {
  CONSTRAINT_LEVEL_HELP,
  CONSTRAINT_LEVEL_LABELS,
  CONSTRAINT_LEVELS,
  EMPTY_COLOUR,
  VISUAL_BIBLE_ID,
  VISUAL_BIBLE_KEYS,
  VISUAL_BIBLE_LABELS,
  type BibleEntry,
  type ColourDirection,
  type JobDoc,
  type ProjectDoc,
  type SceneDoc,
  type VisualBibleDoc,
  type VisualBibleKey,
} from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { useDoc, type WithId } from '../../lib/data';
import { approveBible, saveContinuity, useProjectDoc } from '../../lib/continuity';
import { useSub } from '../../lib/studio';
import { useJobSubmitter } from '../../components/jobs';
import { AssetPicker, AssetThumb, ImageView, useAsset, VideoPlayer, type Asset } from '../../components/media';
import { Badge, Button, Card, cx, Field, Input, Notice, ProgressBar, Select, Slider, Textarea } from '../../components/ui';
import { LookbookTab } from './LookbookTab';

type Draft = Pick<VisualBibleDoc, 'entries' | 'referenceAssetIds' | 'lookbookAssetIds' | 'colour'>;

const PLACEHOLDER: Partial<Record<VisualBibleKey, string>> = {
  overallStyle: 'e.g. Warm naturalistic 35mm drama, handheld intimacy, no glossy commercial look',
  colourPalette: 'e.g. Ochre, indigo, sun-bleached white; no neon',
  contrast: 'e.g. Soft contrast, lifted blacks',
  filmGrain: 'e.g. Fine 35mm grain throughout',
  cameraLanguage: 'e.g. Eye-level, observational; slow push-ins at emotional beats',
  lensPreferences: 'e.g. 35mm and 50mm primes; 85mm for close-ups; no fisheye',
  lightingStyle: 'e.g. Motivated practical light; late-afternoon sun through windows',
  aspectRatio: 'e.g. Compose for 16:9, keep faces in the centre third for vertical crops',
  frameRate: 'e.g. 24 fps cinematic motion blur',
  compositionRules: 'e.g. Headroom kept; speakers on opposite thirds',
  culturalContext: 'e.g. Northern Ghana, Kasem-speaking community; authentic dress and architecture',
  historicalPeriod: 'e.g. Present day',
  architecture: 'e.g. Mud-brick compounds with thatched roofs',
  materials: 'e.g. Woven textiles, calabash, weathered wood',
  prohibited: 'e.g. Visible brand logos, modern cars, watermarks, text overlays',
};

function draftOf(v: WithId<VisualBibleDoc> | null): Draft {
  return { entries: v?.entries ?? {}, referenceAssetIds: v?.referenceAssetIds ?? [], lookbookAssetIds: v?.lookbookAssetIds ?? [], colour: { ...EMPTY_COLOUR, ...(v?.colour ?? {}) } };
}

function RefChip({ id, onRemove }: { id: string; onRemove: () => void }) {
  const a = useAsset(id);
  return (
    <div className="relative w-28">
      {a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} hoverPlay={false} /> : <div className="aspect-video rounded-lg bg-black/30" />}
      <button type="button" aria-label="Remove reference" onClick={onRemove} className="absolute top-1 right-1 grid size-5 cursor-pointer place-items-center rounded-full bg-black/70 text-fg">
        <X className="size-3" />
      </button>
    </div>
  );
}

function EntryRow({ k, entry, scenes, onChange }: { k: VisualBibleKey; entry: BibleEntry | undefined; scenes: WithId<SceneDoc>[]; onChange: (e: BibleEntry | undefined) => void }) {
  const e = entry ?? { value: '', level: 'preferred' as const, sceneIds: [] };
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-line py-3 last:border-0 md:grid-cols-[180px_minmax(0,1fr)_170px]">
      <p className="pt-2 text-sm text-fg">{VISUAL_BIBLE_LABELS[k]}</p>
      <div className="space-y-1.5">
        <Textarea rows={2} value={e.value} placeholder={PLACEHOLDER[k]} onChange={(ev) => onChange(ev.target.value.trim() || e.level !== 'preferred' ? { ...e, value: ev.target.value } : undefined)} aria-label={VISUAL_BIBLE_LABELS[k]} />
        {e.level === 'scene_specific' && (
          <div className="flex flex-wrap gap-1">
            {scenes.map((sc) => {
              const on = e.sceneIds.includes(sc.id);
              return (
                <button key={sc.id} type="button" aria-pressed={on} onClick={() => onChange({ ...e, sceneIds: on ? e.sceneIds.filter((x) => x !== sc.id) : [...e.sceneIds, sc.id] })} className={cx('cursor-pointer rounded-full border px-2 py-0.5 text-[11px]', on ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim')}>
                  {sc.number ? `${sc.number} ` : ''}
                  {sc.heading.slice(0, 40)}
                </button>
              );
            })}
            {!scenes.length && <span className="text-[11px] text-faint">Break the screenplay into scenes first.</span>}
          </div>
        )}
      </div>
      <Select value={e.level} onChange={(ev) => onChange({ ...e, level: ev.target.value as BibleEntry['level'] })} aria-label={`${VISUAL_BIBLE_LABELS[k]} level`} title={CONSTRAINT_LEVEL_HELP[e.level]}>
        {CONSTRAINT_LEVELS.map((l) => (
          <option key={l} value={l}>
            {CONSTRAINT_LEVEL_LABELS[l]}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** Colour Director: the approved look, and a measured colour match with a before-and-after preview. */
function ColourDirector({ project, colour, onChange }: { project: WithId<ProjectDoc>; colour: ColourDirection; onChange: (c: ColourDirection) => void }) {
  const [picker, setPicker] = useState<'ref' | 'lut' | 'clip' | null>(null);
  const [clipId, setClipId] = useState<string | null>(null);
  const [strength, setStrength] = useState(0.8);
  const [applyLut, setApplyLut] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useDoc<JobDoc>(jobId ? `jobs/${jobId}` : null);
  const lut = useAsset(colour.lutAssetId);
  const clip = useAsset(clipId);
  const { submit, busy, dialog } = useJobSubmitter();
  const [newColour, setNewColour] = useState('#c9853a');
  const run = async () => {
    if (!clipId) return;
    const ids = await submit([{ type: 'media.color_match', projectId: project.id, sourceAssetId: clipId, referenceAssetId: colour.referenceAssetId, strength, applyLut, label: 'Colour match' }], { label: 'Colour match' });
    if (ids?.[0]) setJobId(ids[0]);
  };
  const data = job.data?.result?.data as { before?: { deltaE: number; skinHueShift: number | null }; after?: { deltaE: number; skinHueShift: number | null } | null; correction?: { skinProtected: boolean; notes: string[] }; improved?: boolean } | undefined;
  const resultId = job.data?.result?.assetIds?.[0] ?? null;
  const isVideo = clip.data?.kind === 'video';
  const sel = <K extends keyof ColourDirection>(k: K, options: string[], label: string) => (
    <Field label={label}>
      <Select value={(colour[k] as string | null) ?? ''} onChange={(e) => onChange({ ...colour, [k]: e.target.value || null })}>
        <option value="">Match the reference</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    </Field>
  );
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow flex items-center gap-1.5">
          <Palette className="size-3.5" /> Colour Director
        </p>
        {colour.approvedAt && <Badge tone="success">approved with the bible</Badge>}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          <p className="text-xs text-dim">Reference still</p>
          {colour.referenceAssetId ? <ImageView assetId={colour.referenceAssetId} className="aspect-video w-full rounded-lg object-cover" /> : <div className="grid aspect-video place-items-center rounded-lg border border-dashed border-line text-xs text-faint">No reference</div>}
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" icon={<ImagePlus className="size-3.5" />} onClick={() => setPicker('ref')}>
              Choose
            </Button>
            {colour.referenceAssetId && (
              <Button size="sm" variant="ghost" onClick={() => onChange({ ...colour, referenceAssetId: null })}>
                Clear
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-3">
          <Field label="Palette">
            <div className="flex flex-wrap items-center gap-1.5">
              {colour.palette.map((c) => (
                <button key={c} type="button" title={`Remove ${c}`} onClick={() => onChange({ ...colour, palette: colour.palette.filter((x) => x !== c) })} className="flex cursor-pointer items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-dim">
                  <span className="size-3 rounded-full" style={{ background: /^#[0-9a-f]{6}$/i.test(c) ? c : 'transparent' }} />
                  {c}
                </button>
              ))}
              <input type="color" value={newColour} onChange={(e) => setNewColour(e.target.value)} aria-label="Palette colour" className="h-7 w-9 cursor-pointer rounded border border-line bg-transparent" />
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={colour.palette.length >= 12 || colour.palette.includes(newColour)} onClick={() => onChange({ ...colour, palette: [...colour.palette, newColour] })}>
                Add
              </Button>
            </div>
          </Field>
          <Field label="Skin-tone target" hint="Colour matching never pushes skin away from this.">
            <Input value={colour.skinTone} onChange={(e) => onChange({ ...colour, skinTone: e.target.value })} placeholder="e.g. Warm, natural deep brown skin; never grey or orange" />
          </Field>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Field label="White balance (K)">
              <Input type="number" min={1500} max={15000} step={100} value={colour.whiteBalanceK ?? ''} placeholder="reference" onChange={(e) => onChange({ ...colour, whiteBalanceK: e.target.value ? Math.max(1500, Math.min(15000, Number(e.target.value))) : null })} />
            </Field>
            {sel('contrast', ['low', 'medium', 'high'], 'Contrast')}
            {sel('saturation', ['muted', 'natural', 'rich'], 'Saturation')}
            {sel('grain', ['none', 'fine', 'medium', 'heavy'], 'Film grain')}
            {sel('highlightRollOff', ['soft', 'medium', 'hard'], 'Highlight roll-off')}
            {sel('shadowTreatment', ['lifted', 'neutral', 'crushed'], 'Shadows')}
            {sel('look', ['day', 'night', 'dusk', 'interior'], 'Day / night look')}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Creative LUT (.cube, optional)">
              <div className="flex items-center gap-2">
                <span className="text-xs text-dim">{lut.data?.title ?? 'None'}</span>
                <Button size="sm" variant="ghost" onClick={() => setPicker('lut')}>
                  {colour.lutAssetId ? 'Change' : 'Choose'}
                </Button>
                {colour.lutAssetId && (
                  <Button size="sm" variant="ghost" onClick={() => onChange({ ...colour, lutAssetId: null })}>
                    Clear
                  </Button>
                )}
              </div>
            </Field>
            {colour.lutAssetId && (
              <Field label={`LUT strength ${Math.round(colour.lutStrength * 100)}%`} className="w-48">
                <Slider label="LUT strength" min={0} max={1} step={0.05} value={colour.lutStrength} onChange={(v) => onChange({ ...colour, lutStrength: v })} />
              </Field>
            )}
          </div>
        </div>
      </div>
      <div className="space-y-2 rounded-xl border border-line p-3">
        <p className="text-sm text-fg">Match a clip to the approved look</p>
        <p className="text-xs text-faint">Measures the clip and the reference, applies a capped exposure / white-balance / contrast correction that protects skin tones (and the LUT if chosen), then measures the result again. The original is kept.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Button size="sm" variant="secondary" onClick={() => setPicker('clip')}>
            {clip.data ? `Clip: ${clip.data.title.slice(0, 40)}` : 'Choose a clip or still'}
          </Button>
          <Field label={`Strength ${Math.round(strength * 100)}%`} className="w-44">
            <Slider label="Strength" min={0.1} max={1} step={0.05} value={strength} onChange={setStrength} />
          </Field>
          {colour.lutAssetId && (
            <label className="flex items-center gap-1.5 text-xs text-dim">
              <input type="checkbox" checked={applyLut} onChange={(e) => setApplyLut(e.target.checked)} /> Apply the LUT
            </label>
          )}
          <Button size="sm" variant="primary" loading={busy} disabled={!clipId || !colour.referenceAssetId} title={colour.referenceAssetId ? undefined : 'Choose a reference still first (and save)'} icon={<Wand2 className="size-3.5" />} onClick={() => void run()}>
            Colour-match
          </Button>
        </div>
        {job.data && (
          <div className="space-y-2">
            {job.data.status !== 'completed' && job.data.status !== 'failed' && <ProgressBar value={job.data.progress} label="Colour match" />}
            <p className={cx('text-xs', job.data.status === 'failed' ? 'text-[#ff9b9b]' : 'text-dim')}>{job.data.status === 'failed' ? job.data.error?.message : job.data.stage}</p>
            {job.data.status === 'completed' && clipId && resultId && (
              <>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-[11px] text-faint">Before</p>
                    {isVideo ? <VideoPlayer assetId={clipId} /> : <ImageView assetId={clipId} className="w-full rounded-lg" />}
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] text-faint">After</p>
                    {isVideo ? <VideoPlayer assetId={resultId} /> : <ImageView assetId={resultId} className="w-full rounded-lg" />}
                  </div>
                </div>
                {data?.before && (
                  <p className="text-xs text-dim">
                    Distance to the reference ΔE {data.before.deltaE.toFixed(1)} → {data.after?.deltaE.toFixed(1) ?? '—'}
                    {data.after?.skinHueShift !== null && data.after?.skinHueShift !== undefined ? ` · skin hue ${data.after.skinHueShift.toFixed(0)}° from the reference` : ''}
                    {data.correction?.skinProtected ? ' · strength reduced to protect skin tones' : ''}
                    {data.improved === false ? ' · not closer to the reference (the look may be intentionally different)' : ''}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <AssetPicker
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        kinds={picker === 'lut' ? ['document'] : picker === 'clip' ? ['video', 'image'] : ['image']}
        projectId={project.id}
        onPick={(a) => {
          const id = a[0]?.id ?? null;
          if (picker === 'ref') onChange({ ...colour, referenceAssetId: id });
          else if (picker === 'lut') onChange({ ...colour, lutAssetId: id });
          else setClipId(id);
          setPicker(null);
        }}
        title={picker === 'ref' ? 'Reference still' : picker === 'lut' ? 'Creative LUT (.cube)' : 'Clip to colour-match'}
      />
      {dialog}
    </Card>
  );
}

/**
 * Visual Bible: the project's look as structured constraints (Locked / Preferred / Flexible /
 * Scene-specific), reference and lookbook images and the Colour Director. Edits stay a draft until the
 * director approves them; only the approved version reaches generation.
 */
export function VisualBibleTab({ project }: { project: WithId<ProjectDoc> }) {
  const bible = useProjectDoc<VisualBibleDoc>(project.id, 'visualBibles', VISUAL_BIBLE_ID);
  const scenes = useSub<SceneDoc>(project.id, 'scenes');
  const [draft, setDraft] = useState<Draft>(() => draftOf(null));
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'approve' | null>(null);
  const [picker, setPicker] = useState<'refs' | 'lookbook' | null>(null);
  const v = bible.data;
  // Load the stored bible once (and when it changes elsewhere while the draft is clean).
  const stamp = v ? `${v.version}:${v.approvedAt ?? ''}` : 'none';
  const stored = useMemo(() => draftOf(v), [v]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  useEffect(() => {
    if (bible.loading) return;
    if (loadedAt !== stamp && (!dirty || loadedAt === null)) {
      setDraft(stored);
      setLoadedAt(stamp);
    }
  }, [bible.loading, stamp, stored, dirty, loadedAt]);
  const save = async () => {
    setBusy('save');
    try {
      await saveContinuity(project.id, 'visualBibles', draft as unknown as Record<string, unknown>);
      toast.success('Visual Bible saved', { description: 'Approve it to make these constraints reach generation.' });
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const approve = async (on: boolean) => {
    setBusy('approve');
    try {
      if (dirty) await saveContinuity(project.id, 'visualBibles', draft as unknown as Record<string, unknown>);
      await approveBible(project.id, 'visual', VISUAL_BIBLE_ID, on);
      toast.success(on ? 'Visual Bible approved' : 'Approval withdrawn', { description: on ? 'Every new shot generation inherits the approved constraints.' : 'Generation no longer uses the Visual Bible.' });
    } catch (e) {
      toast.error('Could not update approval', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const locked = Object.values(draft.entries).filter((e) => e?.level === 'locked' && e.value.trim()).length;
  return (
    <div className="space-y-6">
      <Card className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="eyebrow">Visual Bible</p>
          {v?.approved ? <Badge tone="success" icon={<BadgeCheck className="size-3" />}>Approved v{v.approved.version} · {new Date(v.approved.approvedAt).toLocaleDateString()}</Badge> : <Badge>Not approved — generation does not use it yet</Badge>}
          {v && v.approved && !v.approvedAt && <Badge tone="warning">Draft changes not approved</Badge>}
          <span className="text-xs text-faint">{locked} locked constraint{locked === 1 ? '' : 's'}</span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" disabled={!dirty} loading={busy === 'save'} onClick={() => void save()} icon={<Save className="size-3.5" />}>
              Save draft
            </Button>
            {v?.approvedAt && !dirty ? (
              <Button size="sm" variant="ghost" loading={busy === 'approve'} onClick={() => void approve(false)}>
                Withdraw approval
              </Button>
            ) : (
              <Button size="sm" variant="primary" loading={busy === 'approve'} onClick={() => void approve(true)} icon={<CircleCheck className="size-3.5" />}>
                Approve for generation
              </Button>
            )}
          </span>
        </div>
        <Notice icon={<Lock className="size-4" />}>Locked constraints are sent with every shot and checked by the reviewer; preferred ones are sent as direction; flexible ones stay in the bible for reference; scene-specific ones apply only to the scenes you choose.</Notice>
        <div>
          {VISUAL_BIBLE_KEYS.map((k) => (
            <EntryRow key={k} k={k} entry={draft.entries[k]} scenes={scenes.data} onChange={(e) => setDraft((d) => ({ ...d, entries: { ...d.entries, [k]: e } }))} />
          ))}
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="space-y-2 p-5">
          <div className="flex items-center justify-between">
            <p className="eyebrow">Reference images</p>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setPicker('refs')}>
              Add
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {draft.referenceAssetIds.map((id) => (
              <RefChip key={id} id={id} onRemove={() => setDraft((d) => ({ ...d, referenceAssetIds: d.referenceAssetIds.filter((x) => x !== id) }))} />
            ))}
            {!draft.referenceAssetIds.length && <p className="text-xs text-faint">Mood references for the whole project.</p>}
          </div>
        </Card>
        <Card className="space-y-2 p-5">
          <div className="flex items-center justify-between">
            <p className="eyebrow">Approved lookbook</p>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setPicker('lookbook')}>
              Choose frames
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {draft.lookbookAssetIds.map((id) => (
              <RefChip key={id} id={id} onRemove={() => setDraft((d) => ({ ...d, lookbookAssetIds: d.lookbookAssetIds.filter((x) => x !== id) }))} />
            ))}
            {!draft.lookbookAssetIds.length && <p className="text-xs text-faint">The reference-of-record frames (up to 12), approved with the bible.</p>}
          </div>
        </Card>
      </div>
      <ColourDirector project={project} colour={draft.colour} onChange={(c) => setDraft((d) => ({ ...d, colour: c }))} />
      <div>
        <p className="eyebrow mb-3">Lookbook frames</p>
        <LookbookTab project={project} />
      </div>
      <AssetPicker
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        kinds={['image']}
        projectId={project.id}
        multiple
        max={picker === 'lookbook' ? 12 : 30}
        onPick={(a) => {
          const ids = a.map((x) => x.id);
          setDraft((d) => (picker === 'lookbook' ? { ...d, lookbookAssetIds: [...new Set([...d.lookbookAssetIds, ...ids])].slice(0, 12) } : { ...d, referenceAssetIds: [...new Set([...d.referenceAssetIds, ...ids])].slice(0, 30) }));
          setPicker(null);
        }}
        title={picker === 'lookbook' ? 'Approved lookbook frames' : 'Reference images'}
      />
    </div>
  );
}
