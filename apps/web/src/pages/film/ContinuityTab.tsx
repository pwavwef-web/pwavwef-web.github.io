import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Clapperboard, GitCompareArrows, ListChecks, MonitorSmartphone, Package, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import {
  COVERAGE_LABELS,
  coverageCost,
  formatUsd,
  normalizeCoverage,
  SCREEN_SURFACES,
  snapshotStatus,
  type CharacterDoc,
  type ContinuityStatus,
  type CoverageSuggestion,
  type ElementDoc,
  type LocationDoc,
  type ProjectDoc,
  type PropStateDoc,
  type ProtectedScreenDoc,
  type SceneDoc,
  type ScreenSurface,
  type ScriptDoc,
  type ShotDoc,
} from '@az-studio/shared';
import { useAiRun } from '../../lib/ai';
import { errorMessage } from '../../lib/api';
import type { WithId } from '../../lib/data';
import { applyCoverage, checkContinuity, deleteContinuity, saveContinuity, useProjectCollection, type Snapshot } from '../../lib/continuity';
import { useBoot } from '../../lib/session';
import { useSub } from '../../lib/studio';
import { sceneText } from '../../lib/text-utils';
import { ContinuityBadge, ContinuityModal, DirectionArrows } from '../../components/continuity-ui';
import { AssetSlot } from '../../components/fields';
import { EstimateText, useJobSubmitter } from '../../components/jobs';
import { AssetPicker, AssetThumb, useAsset, type Asset } from '../../components/media';
import { describePropState, PropBibleEditor } from '../../components/prop-bible';
import { DEFAULT_QUAD, ScreenQuadEditor, type Quad } from '../../components/screen-quad';
import { useShotContext } from '../../components/shots';
import { Badge, Button, Card, cx, EmptyState, Field, Input, Modal, Notice, Segmented, Select, Skeleton, Textarea, Toggle } from '../../components/ui';

type Shot = WithId<ShotDoc>;
type Names = { characters: Record<string, string>; props: Record<string, string> };

const shotLabel = (s: Pick<ShotDoc, 'number' | 'title'>) => `${s.number ? `${s.number} · ` : ''}${s.title || 'Untitled shot'}`;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const ATTENTION: ContinuityStatus[] = ['warning', 'failed', 'needs_review'];

function Overview({ project, shots, scenes, names }: { project: WithId<ProjectDoc>; shots: Shot[]; scenes: WithId<SceneDoc>[]; names: Names }) {
  const snaps = useProjectCollection<Snapshot>(project.id, 'continuitySnapshots', { order: 'order' });
  const [filter, setFilter] = useState<'all' | 'attention' | 'locked'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [checking, setChecking] = useState<{ done: number; total: number } | null>(null);
  const bySnap = useMemo(() => new Map(snaps.data.map((s) => [s.id, s])), [snaps.data]);
  const rows = shots.map((shot) => {
    const snap = bySnap.get(shot.id) ?? null;
    const status: ContinuityStatus | null = shot.continuityStatus?.status ?? (snap ? snapshotStatus(snap) : null);
    const open = shot.continuityStatus?.openWarnings ?? snap?.continuityWarnings.filter((w) => w.status === 'open' && w.severity !== 'info').length ?? 0;
    return { shot, snap, status, open };
  });
  const counts = rows.reduce<Partial<Record<ContinuityStatus, number>>>((acc, r) => (r.status ? { ...acc, [r.status]: (acc[r.status] ?? 0) + 1 } : acc), {});
  const visible = rows.filter((r) => (filter === 'attention' ? r.status && ATTENTION.includes(r.status) : filter === 'locked' ? r.status === 'locked' : true));
  const sceneName = (id: string | null) => scenes.find((s) => s.id === id)?.heading ?? 'No scene';
  const checkAll = async () => {
    const todo = rows.filter((r) => !r.snap?.approvedState).map((r) => r.shot);
    setChecking({ done: 0, total: todo.length });
    let failed = 0;
    for (const [i, s] of todo.entries()) {
      try {
        await checkContinuity(project.id, s.id, true);
      } catch {
        failed++;
      }
      setChecking({ done: i + 1, total: todo.length });
    }
    setChecking(null);
    if (failed) toast.error(`${failed} shot${failed === 1 ? '' : 's'} could not be checked`);
    else toast.success(`Continuity planned for ${todo.length} shot${todo.length === 1 ? '' : 's'}`, { description: 'Planning uses the approved bibles, the blocking and the previous approved shot — nothing is generated or charged.' });
  };
  const current = open ? shots.find((s) => s.id === open) ?? null : null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          label="Filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All (${rows.length})` },
            { value: 'attention', label: `Needs attention (${ATTENTION.reduce((n, k) => n + (counts[k] ?? 0), 0)})` },
            { value: 'locked', label: `Locked (${counts.locked ?? 0})` },
          ]}
        />
        <Button size="sm" variant="subtle" className="ml-auto" loading={checking !== null} onClick={() => void checkAll()} icon={<RefreshCw className="size-3.5" />}>
          {checking ? `Checking ${checking.done}/${checking.total}` : 'Plan all unapproved shots'}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(Object.entries(counts) as [ContinuityStatus, number][]).map(([k, n]) => (
          <span key={k} className="inline-flex items-center gap-1 text-xs text-dim">
            <ContinuityBadge status={k} /> {n}
          </span>
        ))}
      </div>
      {snaps.loading ? (
        <Skeleton className="h-40" />
      ) : !shots.length ? (
        <EmptyState icon={<Clapperboard className="size-5" />} title="No shots yet" body="Plan shots in Storyboard & shots; each one gets a continuity plan before it is generated." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="bg-white/[0.03] text-faint">
              <tr>
                <th className="px-3 py-2 font-medium">Shot</th>
                <th className="px-3 py-2 font-medium">Scene</th>
                <th className="px-3 py-2 font-medium">Continuity</th>
                <th className="px-3 py-2 font-medium">Direction</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ shot, snap, status, open: n }) => (
                <tr key={shot.id} className="cursor-pointer border-t border-line hover:bg-white/[0.03]" onClick={() => setOpen(shot.id)}>
                  <td className="px-3 py-2 text-fg">{shotLabel(shot)}</td>
                  <td className="max-w-48 truncate px-3 py-2 text-dim">{sceneName(shot.sceneId)}</td>
                  <td className="px-3 py-2">{status ? <ContinuityBadge status={status} openWarnings={n} /> : <span className="text-faint">Not planned</span>}</td>
                  <td className="px-3 py-2">
                    <DirectionArrows travel={(snap?.approvedState ?? snap?.plannedState)?.camera.travel} names={names.characters} />
                  </td>
                  <td className="px-3 py-2 text-dim">{snap?.approvedState ? 'Canonical (approved take)' : snap?.continuityAfter ? 'Inspected, awaiting approval' : snap ? 'Planned' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {current && <ContinuityModal projectId={project.id} shot={current} shots={shots} names={names} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prop ledger (history matrix)
// ---------------------------------------------------------------------------

function PropLedger({ project, shots, elements, names }: { project: WithId<ProjectDoc>; shots: Shot[]; elements: WithId<ElementDoc>[]; names: Names }) {
  const states = useProjectCollection<PropStateDoc>(project.id, 'propStates', { order: 'order' });
  const [edit, setEdit] = useState<WithId<ElementDoc> | null>(null);
  const props = elements.filter((e) => e.kind !== 'costume');
  const columns = useMemo(() => {
    const ids: string[] = [];
    for (const s of states.data) if (!ids.includes(s.shotId)) ids.push(s.shotId);
    return ids.map((id) => shots.find((s) => s.id === id)).filter((s): s is Shot => Boolean(s));
  }, [states.data, shots]);
  const cell = (propId: string, shotId: string) => states.data.find((s) => s.propId === propId && s.shotId === shotId) ?? null;
  if (!props.length) return <EmptyState icon={<Package className="size-5" />} title="No props yet" body="Add props in Props & costumes, then open each one’s Prop ledger to set its reference and starting state." />;
  return (
    <div className="space-y-3">
      <p className="text-xs text-faint">Each cell is the prop’s state in that shot — solid when approved, dashed while only planned. A dot marks an on-screen event (picked up, handed over, opened…). Click a prop to edit its ledger entry.</p>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="text-left text-xs">
          <thead className="bg-white/[0.03] text-faint">
            <tr>
              <th className="sticky left-0 z-10 bg-panel px-3 py-2 font-medium">Prop</th>
              {columns.map((s) => (
                <th key={s.id} className="max-w-28 min-w-24 truncate px-2 py-2 font-medium" title={shotLabel(s)}>
                  {s.number || s.title.slice(0, 14) || '—'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.map((p) => (
              <tr key={p.id} className="border-t border-line">
                <td className="sticky left-0 z-10 bg-panel px-3 py-2">
                  <button type="button" className="cursor-pointer text-fg hover:underline" onClick={() => setEdit(p)}>
                    {p.name}
                  </button>
                </td>
                {columns.map((s) => {
                  const c = cell(p.id, s.id);
                  if (!c) return <td key={s.id} className="px-2 py-2 text-faint">·</td>;
                  const st = c.approved ?? c.planned;
                  return (
                    <td key={s.id} className="px-2 py-1.5">
                      <span title={describePropState(st, names.characters)} className={cx('relative block truncate rounded-md border px-1.5 py-1', c.approved ? 'border-success/40 bg-success/[0.06] text-fg' : 'border-dashed border-line text-dim', !st.present && 'opacity-50')}>
                        {!st.present ? 'absent' : st.holderId ? `${(names.characters[st.holderId] ?? '?').slice(0, 8)}${st.hand ? ` ${st.hand === 'left' ? 'L' : st.hand === 'right' ? 'R' : 'L+R'}` : ''}` : st.location.slice(0, 12) || 'set down'}
                        {st.status !== 'intact' && <span className="text-warning"> · {st.status}</span>}
                        {c.events.length > 0 && <span className="absolute -top-1 -right-1 size-2 rounded-full bg-accent" aria-label="Event in this shot" />}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!columns.length && <p className="text-xs text-faint">No shot has been planned with these props yet. Choose the props a shot uses in its continuity plan (shot editor → Continuity) and check continuity.</p>}
      {edit && <PropBibleEditor project={project} element={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Protected screens, signs and logos
// ---------------------------------------------------------------------------

type ScreenDraft = Omit<ProtectedScreenDoc, 'id' | 'updatedAt'>;
const EMPTY_SCREEN: ScreenDraft = { name: '', surface: 'phone', expectedText: '', contentAssetId: null, referenceAssetId: null, logoAssetId: null, corners: null, mayMirror: false, composite: true, minTextHeight: 0.02, notes: '' };

function ScreenEditor({ project, screen, onClose }: { project: WithId<ProjectDoc>; screen: WithId<ProtectedScreenDoc> | null; onClose: () => void }) {
  const [d, setD] = useState<ScreenDraft>(() => {
    if (!screen) return { ...EMPTY_SCREEN };
    const { id: _id, updatedAt: _u, ...rest } = screen;
    void [_id, _u];
    return { ...EMPTY_SCREEN, ...rest };
  });
  const [picker, setPicker] = useState<'contentAssetId' | 'referenceAssetId' | 'logoAssetId' | null>(null);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const save = async () => {
    setBusy('save');
    try {
      await saveContinuity(project.id, 'protectedScreens', d as unknown as Record<string, unknown>, screen?.id ?? null);
      toast.success('Protected screen saved');
      onClose();
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!screen) return;
    setBusy('delete');
    try {
      await deleteContinuity(project.id, 'protectedScreens', screen.id);
      onClose();
    } catch (e) {
      toast.error('Could not delete', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={screen ? `Protected screen · ${screen.name}` : 'New protected screen'}
      description="Readable text, device screens, signs and logos. Every take is read back with OCR (also mirrored) and checked against the expected text; with compositing on, the approved content replaces whatever the video model drew."
      footer={
        <>
          {screen && (
            <Button variant="danger" className="mr-auto" loading={busy === 'delete'} icon={<Trash2 className="size-4" />} onClick={() => void remove()}>
              Delete
            </Button>
          )}
          <Button variant="primary" loading={busy === 'save'} disabled={!d.name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={d.name} onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))} placeholder="e.g. Ama’s phone — AZ Studio home" />
          </Field>
          <Field label="Surface">
            <Select value={d.surface} onChange={(e) => setD((x) => ({ ...x, surface: e.target.value as ScreenSurface }))}>
              {SCREEN_SURFACES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Text that must read exactly" hint="Compared with OCR on every take; a mirrored or changed reading is a continuity failure.">
          <Textarea rows={2} value={d.expectedText} onChange={(e) => setD((x) => ({ ...x, expectedText: e.target.value }))} placeholder="e.g. AZ Studio · Create" />
        </Field>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <AssetSlot label="Approved content (interface capture or graphic)" assetId={d.contentAssetId} onPick={() => setPicker('contentAssetId')} onClear={() => setD((x) => ({ ...x, contentAssetId: null }))} />
          <AssetSlot label="Reference still (the surface in the scene)" assetId={d.referenceAssetId} onPick={() => setPicker('referenceAssetId')} onClear={() => setD((x) => ({ ...x, referenceAssetId: null }))} />
          <AssetSlot label="Logo (optional)" assetId={d.logoAssetId} onPick={() => setPicker('logoAssetId')} onClear={() => setD((x) => ({ ...x, logoAssetId: null }))} />
        </div>
        <Card className="space-y-3 p-3">
          <Toggle checked={d.composite} onChange={(v) => setD((x) => ({ ...x, composite: v }))} label="Composite the approved content" description="The video model is asked for a clean, trackable surface; the real content is tracked onto it with matched perspective, brightness and blur, then re-read with OCR." />
          <Toggle checked={d.mayMirror} onChange={(v) => setD((x) => ({ ...x, mayMirror: v }))} label="May appear mirrored" description="Only for deliberate reflections (a mirror, a shop window seen from inside)." />
          <Field label="Smallest readable text height" hint="Fraction of the frame height (0.02 = 2%). Smaller readings are flagged as unreadable.">
            <Input type="number" step={0.005} min={0} max={0.5} value={d.minTextHeight} onChange={(e) => setD((x) => ({ ...x, minTextHeight: Math.max(0, Math.min(0.5, Number(e.target.value) || 0)) }))} className="w-32" />
          </Field>
        </Card>
        <Card className="space-y-2 p-3">
          <Toggle checked={d.corners !== null} onChange={(v) => setD((x) => ({ ...x, corners: v ? DEFAULT_QUAD : null }))} label="Fixed position in static shots" description="Drag the four corners onto the surface in the reference still. Moving shots are tracked automatically frame by frame." />
          {d.corners && <ScreenQuadEditor assetId={d.referenceAssetId ?? d.contentAssetId} value={d.corners as Quad} onChange={(q) => setD((x) => ({ ...x, corners: q }))} />}
        </Card>
        <Field label="Notes">
          <Textarea rows={2} value={d.notes} onChange={(e) => setD((x) => ({ ...x, notes: e.target.value }))} />
        </Field>
      </div>
      <AssetPicker
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        kinds={['image']}
        projectId={project.id}
        onPick={(a) => {
          if (picker) setD((x) => ({ ...x, [picker]: a[0]?.id ?? null }));
          setPicker(null);
        }}
        title="Choose an image"
      />
    </Modal>
  );
}

function ScreenCard({ screen, onOpen }: { screen: WithId<ProtectedScreenDoc>; onOpen: () => void }) {
  const a = useAsset(screen.contentAssetId ?? screen.referenceAssetId);
  return (
    <button type="button" onClick={onOpen} className="cursor-pointer rounded-xl border border-line p-2 text-left hover:border-accent/40">
      {a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} hoverPlay={false} /> : <div className="grid aspect-video place-items-center rounded-lg bg-white/5 text-faint"><MonitorSmartphone className="size-6" /></div>}
      <p className="mt-2 truncate text-sm text-fg">{screen.name}</p>
      <p className="truncate text-xs text-dim">“{screen.expectedText || '—'}”</p>
      <div className="mt-1 flex flex-wrap gap-1">
        <Badge>{screen.surface}</Badge>
        {screen.composite && <Badge tone="accent">composited</Badge>}
        {screen.mayMirror && <Badge tone="warning">may mirror</Badge>}
      </div>
    </button>
  );
}

function ProtectedScreens({ project }: { project: WithId<ProjectDoc> }) {
  const screens = useProjectCollection<ProtectedScreenDoc>(project.id, 'protectedScreens', { order: 'name' });
  const [edit, setEdit] = useState<WithId<ProtectedScreenDoc> | 'new' | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-faint">Attach screens to shots in the shot’s continuity plan. Screens with compositing on are replaced with the approved content automatically when a take shows the wrong or mirrored text.</p>
        <Button size="sm" variant="primary" className="ml-auto" icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>
          Add screen or sign
        </Button>
      </div>
      {screens.data.length === 0 ? (
        <EmptyState icon={<MonitorSmartphone className="size-5" />} title="No protected screens" body="Phones, laptops, TVs, signs, posters and logos whose text must stay readable and unmirrored." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {screens.data.map((s) => (
            <ScreenCard key={s.id} screen={s} onOpen={() => setEdit(s)} />
          ))}
        </div>
      )}
      {edit && <ScreenEditor key={edit === 'new' ? 'new' : edit.id} project={project} screen={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cross-shot comparison
// ---------------------------------------------------------------------------

function CompareShots({ project, shots, scenes }: { project: WithId<ProjectDoc>; shots: Shot[]; scenes: WithId<SceneDoc>[] }) {
  const candidates = shots.filter((s) => s.approvedTakeId || s.selectedTakeId);
  const [sel, setSel] = useState<string[]>([]);
  const { submit, busy, dialog } = useJobSubmitter();
  const toggle = (id: string) => setSel((x) => (x.includes(id) ? x.filter((y) => y !== id) : x.length >= 12 ? x : [...x, id]));
  const pickScene = (sceneId: string) => setSel(candidates.filter((s) => s.sceneId === sceneId).slice(0, 12).map((s) => s.id));
  const run = async () => {
    const ordered = candidates.filter((s) => sel.includes(s.id)).map((s) => s.id);
    const ids = await submit([{ type: 'continuity.compare', projectId: project.id, shotIds: ordered, label: `Continuity comparison · ${ordered.length} shots` }], { label: 'Continuity comparison', alwaysConfirm: true });
    if (ids) toast.success('Comparison queued', { description: 'Differences between the shots are recorded as warnings on the later shot of each pair.' });
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-faint">The reasoning model watches the approved (or selected) takes together in story order and reports every break between them — costume, hands, props, set, light, screen direction, eyelines and screen text. It never changes canonical state.</p>
      {candidates.length < 2 ? (
        <Notice>Approve or select takes on at least two shots to compare them.</Notice>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select className="h-8 w-64 text-xs" value="" onChange={(e) => e.target.value && pickScene(e.target.value)} aria-label="Select a scene">
              <option value="">Select a whole scene…</option>
              {scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.number ? `${s.number}. ` : ''}
                  {s.heading}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" onClick={() => setSel([])} disabled={!sel.length}>
              Clear
            </Button>
            <Button size="sm" variant="primary" className="ml-auto" loading={busy} disabled={sel.length < 2} icon={<GitCompareArrows className="size-4" />} onClick={() => void run()}>
              Compare {sel.length} shot{sel.length === 1 ? '' : 's'}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {candidates.map((s) => (
              <label key={s.id} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs', sel.includes(s.id) ? 'border-accent/50 bg-accent/[0.06]' : 'border-line')}>
                <input type="checkbox" checked={sel.includes(s.id)} onChange={() => toggle(s.id)} />
                <span className="min-w-0 flex-1 truncate text-fg">{shotLabel(s)}</span>
                {s.approvedTakeId ? <Badge tone="success">approved</Badge> : <Badge>selected</Badge>}
              </label>
            ))}
          </div>
        </>
      )}
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Coverage Generator
// ---------------------------------------------------------------------------

function CoverageGenerator({ project, shots, scenes, characters, locations }: { project: WithId<ProjectDoc>; shots: Shot[]; scenes: WithId<SceneDoc>[]; characters: WithId<CharacterDoc>[]; locations: WithId<LocationDoc>[] }) {
  const boot = useBoot();
  const ai = useAiRun(project.id);
  const scripts = useSub<ScriptDoc>(project.id, 'scripts', 'updatedAt', 'desc');
  const [sceneId, setSceneId] = useState('');
  const [masterId, setMasterId] = useState('');
  const [maxShots, setMaxShots] = useState(8);
  const [importance, setImportance] = useState(3);
  const [budgetNote, setBudgetNote] = useState('');
  const [items, setItems] = useState<CoverageSuggestion[]>([]);
  const [applying, setApplying] = useState(false);
  const scene = scenes.find((s) => s.id === sceneId) ?? null;
  const sceneShots = shots.filter((s) => s.sceneId === sceneId);
  const master = sceneShots.find((s) => s.id === masterId) ?? null;
  const caps = boot?.capabilities.video.durationSec ?? { min: 4, max: 10 };
  const resolution = project.format.videoResolution ?? boot?.settings.defaultVideoResolution ?? boot?.capabilities.video.defaultResolution ?? '720p';
  const cost = useMemo(() => (boot && items.length ? coverageCost(items, boot.pricing, resolution) : null), [boot, items, resolution]);
  const nameOf = (id: string) => characters.find((c) => c.id === id)?.name ?? '?';
  const plan = async () => {
    if (!scene) return;
    const sceneIndex = scenes.findIndex((s) => s.id === scene.id);
    const text = sceneText(scripts.data[0]?.content ?? '', sceneIndex);
    const chars = characters.filter((c) => scene.characterIds.includes(c.id) || master?.refs.characterIds.includes(c.id));
    const loc = locations.find((l) => l.id === scene.locationId) ?? null;
    const dialogue = (master?.directions.dialogue ?? []).map((l, i) => `${i}: ${l.character}: ${l.line}`);
    const out = await ai.run<unknown>(
      'film.coverage',
      {
        scene: { heading: scene.heading, summary: scene.summary, mood: scene.mood, text },
        dialogue,
        characters: chars.map((c) => ({ name: c.name, description: c.appearance })),
        location: loc ? { name: loc.name, description: loc.description } : null,
        importance,
        existing: sceneShots.map((s) => ({ title: s.title, framing: s.directions.framing })),
        maxShots,
        budgetNote: budgetNote.trim() || undefined,
      },
      `Coverage · ${scene.heading}`,
    );
    if (!out) return;
    const byName = Object.fromEntries(characters.flatMap((c) => [[c.name.toUpperCase(), c.id] as const, [c.name, c.id] as const]));
    const list = normalizeCoverage(out, byName, caps);
    if (!list.length) toast.error('The coverage plan came back empty — try again or add more detail to the scene.');
    setItems(list);
  };
  const apply = async () => {
    setApplying(true);
    try {
      const r = await applyCoverage(project.id, sceneId || null, masterId || null, items);
      toast.success(`${r.shotIds.length} coverage shot${r.shotIds.length === 1 ? '' : 's'} created`, { description: 'Each has blocking on the established side of the 180° line. Nothing is generated until you produce them.' });
      setItems([]);
    } catch (e) {
      toast.error('Could not create the shots', { description: errorMessage(e) });
    } finally {
      setApplying(false);
    }
  };
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Scene" className="min-w-56 flex-1">
          <Select
            value={sceneId}
            onChange={(e) => {
              setSceneId(e.target.value);
              setMasterId('');
              setItems([]);
            }}
          >
            <option value="">Choose a scene…</option>
            {scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.number ? `${s.number}. ` : ''}
                {s.heading}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Master shot (dialogue and blocking)" className="min-w-56 flex-1">
          <Select value={masterId} onChange={(e) => setMasterId(e.target.value)} disabled={!sceneShots.length}>
            <option value="">None</option>
            {sceneShots.map((s) => (
              <option key={s.id} value={s.id}>
                {shotLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Max shots" className="w-24">
          <Select value={maxShots} onChange={(e) => setMaxShots(Number(e.target.value))}>
            {[4, 6, 8, 10, 12, 16].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </Select>
        </Field>
        <Field label="Importance" className="w-28">
          <Select value={importance} onChange={(e) => setImportance(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? '(minor)' : n === 5 ? '(climax)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Budget note" className="min-w-48 flex-1">
          <Input value={budgetNote} onChange={(e) => setBudgetNote(e.target.value)} placeholder="e.g. keep it under 6 shots" />
        </Field>
        <Button variant="primary" loading={ai.busy} disabled={!scene} icon={<Sparkles className="size-4" />} onClick={() => void plan()}>
          Suggest coverage
        </Button>
      </Card>
      {!master && scene && <p className="text-xs text-faint">Choose a master shot to carry its dialogue lines and blocking into the coverage (over-the-shoulders and singles keep the characters where the master placed them).</p>}
      {items.length > 0 && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="eyebrow mr-auto">Suggested coverage · {items.filter((i) => i.accepted).length} of {items.length} accepted</p>
            {cost && <EstimateText estimate={cost.accepted} />}
            <Button variant="primary" loading={applying} disabled={!items.some((i) => i.accepted)} icon={<ListChecks className="size-4" />} onClick={() => void apply()}>
              Create {items.filter((i) => i.accepted).length} shots
            </Button>
          </div>
          <ul className="space-y-1.5">
            {items.map((it) => (
              <li key={it.id} className={cx('rounded-lg border px-3 py-2 text-xs', it.accepted ? 'border-accent/40' : 'border-line opacity-70')}>
                <label className="flex cursor-pointer items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={it.accepted} onChange={(e) => setItems((x) => x.map((y) => (y.id === it.id ? { ...y, accepted: e.target.checked } : y)))} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm text-fg">{COVERAGE_LABELS[it.type]}</span>
                      <Badge tone={it.priority === 'essential' ? 'accent' : it.priority === 'optional' ? 'neutral' : 'violet'}>{it.priority}</Badge>
                      {it.subjectIds.length > 0 && <span className="text-dim">{it.subjectIds.map(nameOf).join(' → ')}</span>}
                      <span className="text-faint">{it.durationSec}s</span>
                      {cost?.per[it.id] && <span className="ml-auto text-faint">≈ {formatUsd(cost.per[it.id]!.usd)}</span>}
                    </span>
                    <span className="block text-dim">{it.description}</span>
                    <span className="block text-faint">
                      {[it.framing, it.lens, it.cameraMovement].filter(Boolean).join(' · ')}
                      {it.dialogueLines.length ? ` · lines ${it.dialogueLines.join(', ')}` : ''}
                    </span>
                    {it.rationale && <span className="block text-faint italic">{it.rationale}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-faint">Costs are estimates from published list prices for {resolution}, one take each, before any automatic repairs.</p>
        </Card>
      )}
      {ai.dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

type Section = 'overview' | 'props' | 'screens' | 'compare' | 'coverage';

/**
 * Continuity workspace: every shot's continuity status, the prop ledger across the film, protected
 * screens and signs, cross-shot comparison of approved takes, and the Coverage Generator.
 */
export function ContinuityTab({ project }: { project: WithId<ProjectDoc> }) {
  const ctx = useShotContext(project);
  const shots = useSub<ShotDoc>(project.id, 'shots', 'order');
  const scenesLive = useSub<SceneDoc>(project.id, 'scenes', 'order');
  const [section, setSection] = useState<Section>('overview');
  const names: Names = useMemo(() => ({ characters: Object.fromEntries(ctx.characters.map((c) => [c.id, c.name])), props: Object.fromEntries(ctx.elements.map((e) => [e.id, e.name])) }), [ctx.characters, ctx.elements]);
  const scenes = scenesLive.data;
  return (
    <div className="space-y-4">
      <Segmented
        label="Continuity section"
        value={section}
        onChange={setSection}
        options={[
          { value: 'overview', label: 'Shots' },
          { value: 'props', label: 'Prop ledger' },
          { value: 'screens', label: 'Screens & signs' },
          { value: 'compare', label: 'Compare shots' },
          { value: 'coverage', label: 'Coverage' },
        ]}
      />
      {section === 'overview' && <Overview project={project} shots={shots.data} scenes={scenes} names={names} />}
      {section === 'props' && <PropLedger project={project} shots={shots.data} elements={ctx.elements} names={names} />}
      {section === 'screens' && <ProtectedScreens project={project} />}
      {section === 'compare' && <CompareShots project={project} shots={shots.data} scenes={scenes} />}
      {section === 'coverage' && <CoverageGenerator project={project} shots={shots.data} scenes={scenes} characters={ctx.characters} locations={ctx.locations} />}
    </div>
  );
}
