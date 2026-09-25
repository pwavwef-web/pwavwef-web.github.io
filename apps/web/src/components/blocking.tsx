import { useEffect, useId, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { toast } from 'sonner';
import { Camera, Crosshair, Footprints, Plus, RefreshCw, RotateCcw, Save, SquareDashed, Trash2, Wand2 } from 'lucide-react';
import {
  analyzeBlocking,
  angleOf,
  AXIS_CROSSING_LABELS,
  axisSide,
  BLOCKING_ENTITY_KINDS,
  BODY_WIDTH_M,
  CAMERA_HEIGHTS,
  COVERAGE_LABELS,
  DEFAULT_PLAN_SIZE_M,
  defaultCamera,
  dirVector,
  horizontalFov,
  inferAxis,
  LAYERS,
  POSTURES,
  SCREEN_DIRECTION_LABELS,
  WARNING_LABELS,
  type AnalyzeOptions,
  type BlockingAnalysis,
  type BlockingCamera,
  type BlockingEntity,
  type BlockingEntityKind,
  type BlockingPlanDoc,
  type CameraAxisDoc,
  type CameraHeight,
  type CharacterDoc,
  type ContinuityWarning,
  type CoverageSuggestion,
  type CoverageType,
  type ElementDoc,
  type Layer,
  type Posture,
  type ProjectDoc,
  type ProtectedZone,
  type SceneDoc,
  type SetBibleDoc,
  type ShotDoc,
  type StagePoint,
} from '@az-studio/shared';
import { errorMessage } from '../lib/api';
import type { WithId } from '../lib/data';
import { applyCoverage, checkContinuity, saveContinuity, useProjectCollection, useProjectDoc, type Snapshot } from '../lib/continuity';
import { useSub } from '../lib/studio';
import { DirectionArrows, WarningItem } from './continuity-ui';
import { FloorPlan } from './floor-plan';
import { useShotContext } from './shots';
import { Badge, Button, Card, cx, EmptyState, Field, Input, Notice, Segmented, Select, Skeleton, Toggle } from './ui';

type Shot = WithId<ShotDoc>;
type Character = WithId<CharacterDoc>;
type Plan = Omit<BlockingPlanDoc, 'id' | 'updatedAt'>;
type Mode = 'select' | 'path' | 'zone';

const S = 1000;
const PALETTE = ['#4c8dff', '#f4b84a', '#3ed690', '#ff6b6b', '#9b8cff', '#5ad1e6', '#ff9f5a', '#e67bd8'];
const LENSES = [18, 24, 28, 35, 50, 85, 135];
const EYE_HEIGHT_M: Record<CameraHeight, number> = { ground: 0.3, low: 1.0, eye: 1.6, high: 2.4, overhead: 3.5 };
const POSTURE_HEIGHT_M: Record<Posture, number> = { standing: 1.7, walking: 1.7, running: 1.65, seated: 1.25, kneeling: 1.15, crouching: 0.95, lying: 0.45 };
const OBJECT_HEIGHT_M: Record<BlockingEntityKind, number> = { character: 1.7, prop: 0.35, door: 2.1, exit: 2.1, furniture: 0.9, vehicle: 1.5 };
const FRAMING: Partial<Record<CoverageType, string>> = { clean_single: 'Medium close-up', over_the_shoulder: 'Over-the-shoulder shot', reaction: 'Close-up', close_up: 'Close-up' };
const FIXABLE = new Set<ContinuityWarning['kind']>(['occlusion', 'face_hidden', 'out_of_frame', 'same_space', 'axis_crossing', 'eyeline', 'tangent', 'blocking']);

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clampPlan = (p: StagePoint): StagePoint => ({ x: r3(Math.min(1.2, Math.max(-0.2, p.x))), y: r3(Math.min(1.2, Math.max(-0.2, p.y))) });
const clamp01 = (n: number) => Math.min(0.98, Math.max(0.02, n));
const eid = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const normDeg = (d: number) => Math.round(((d % 360) + 360) % 360);

function newEntity(kind: BlockingEntityKind, refId: string | null, label: string, position: StagePoint): BlockingEntity {
  return { id: eid(), kind, refId, label: label.slice(0, 80), position, facingDeg: 180, gaze: { kind: 'none', targetId: null, deg: null }, path: [], layer: null, occlusionAllowed: false, protectedVisibility: kind === 'character' ? 'face' : 'none', speaking: false, posture: 'standing' };
}

/** First blocking for a shot: its characters side by side (conversations face each other), camera south. */
function defaultPlan(shot: Shot, characters: Character[], locationId: string | null): Plan {
  const ids = shot.refs.characterIds.filter((id) => characters.some((c) => c.id === id));
  const speakers = new Set(shot.directions.dialogue.map((l) => l.character.trim().toUpperCase()));
  const n = ids.length;
  const entities = ids.map((id, i) => {
    const c = characters.find((x) => x.id === id)!;
    const e = newEntity('character', id, c.name, { x: r3(n === 1 ? 0.5 : 0.3 + (0.4 * i) / (n - 1)), y: 0.5 });
    e.speaking = speakers.has(c.name.trim().toUpperCase());
    return e;
  });
  if (n === 2) {
    entities[0]!.facingDeg = 120;
    entities[1]!.facingDeg = 240;
    entities[0]!.gaze = { kind: 'entity', targetId: entities[1]!.id, deg: null };
    entities[1]!.gaze = { kind: 'entity', targetId: entities[0]!.id, deg: null };
  }
  return { shotId: shot.id, sceneId: shot.sceneId, locationId, camera: defaultCamera(), entities, protectedZones: [], notes: '' };
}

function fromStored(p: WithId<BlockingPlanDoc>): Plan {
  return { shotId: p.shotId, sceneId: p.sceneId ?? null, locationId: p.locationId ?? null, camera: { ...defaultCamera(), ...p.camera }, entities: p.entities ?? [], protectedZones: p.protectedZones ?? [], notes: p.notes ?? '' };
}

// ---------------------------------------------------------------------------
// Automatic camera adjustment (least-destructive repair on the plan)
// ---------------------------------------------------------------------------

function badness(a: BlockingAnalysis): number {
  return a.warnings.reduce((n, w) => n + (FIXABLE.has(w.kind) ? (w.severity === 'critical' ? 3 : w.severity === 'warning' ? 1 : 0) : 0), 0);
}

/**
 * Searches camera positions around the group (same side of the line first), lenses and heights for the
 * smallest change that clears occlusion, hidden faces, off-frame speakers and line crossings.
 */
function suggestCamera(plan: Plan, opts: AnalyzeOptions): { camera: BlockingCamera; before: number; after: number; summary: string } | null {
  const before = badness(analyzeBlocking(plan, opts));
  if (!before) return null;
  const chars = plan.entities.filter((e) => e.kind === 'character');
  if (!chars.length) return null;
  const centre = { x: chars.reduce((s, c) => s + c.position.x, 0) / chars.length, y: chars.reduce((s, c) => s + c.position.y, 0) / chars.length };
  const cam = plan.camera;
  const dist = Math.max(0.12, Math.hypot(cam.position.x - centre.x, cam.position.y - centre.y));
  const baseAngle = angleOf(cam.position.x - centre.x, cam.position.y - centre.y);
  let best: { camera: BlockingCamera; cost: number; score: number; dA: number; scale: number } | null = null;
  for (const dA of [0, -15, 15, -30, 30, -45, 45, -60, 60]) {
    for (const scale of [1, 1.3, 0.8, 1.6]) {
      for (const lens of [...new Set([cam.lensMm, 28, 35, 50, 85])]) {
        for (const height of [...new Set<CameraHeight>([cam.height, 'high'])]) {
          const v = dirVector(baseAngle + dA);
          const pos = { x: r3(clamp01(centre.x + v.x * dist * scale)), y: r3(clamp01(centre.y + v.y * dist * scale)) };
          const camera: BlockingCamera = { ...cam, position: pos, directionDeg: normDeg(angleOf(centre.x - pos.x, centre.y - pos.y)), lensMm: lens, height };
          const score = badness(analyzeBlocking({ ...plan, camera }, opts));
          const cost = score * 100 + Math.abs(dA) / 15 + Math.abs(scale - 1) * 3 + (lens !== cam.lensMm ? 1 : 0) + (height !== cam.height ? 2 : 0);
          if (!best || cost < best.cost) best = { camera, cost, score, dA, scale };
        }
      }
    }
  }
  if (!best || best.score >= before) return null;
  const parts = [
    best.dA ? `moved ${Math.abs(best.dA)}° around the group` : '',
    best.scale !== 1 ? `${best.scale > 1 ? 'pulled back' : 'pushed in'} ×${best.scale}` : '',
    best.camera.lensMm !== cam.lensMm ? `${best.camera.lensMm} mm lens` : '',
    best.camera.height !== cam.height ? `raised to ${best.camera.height}` : '',
  ].filter(Boolean);
  return { camera: best.camera, before, after: best.score, summary: parts.length ? `Camera ${parts.join(', ')}` : 'Camera re-aimed at the group' };
}

// ---------------------------------------------------------------------------
// Camera view (what the lens sees)
// ---------------------------------------------------------------------------

function CameraView({ plan, analysis, colours, flagged }: { plan: Plan; analysis: BlockingAnalysis; colours: Record<string, string>; flagged: Set<string> }) {
  const clip = useId();
  const W = 320;
  const H = 180;
  const half = Math.tan(((horizontalFov(plan.camera.lensMm) / 2) * Math.PI) / 180);
  const eye = EYE_HEIGHT_M[plan.camera.height];
  const items = analysis.entities
    .map((a) => ({ a, e: plan.entities.find((x) => x.id === a.id) }))
    .filter((x): x is { a: BlockingAnalysis['entities'][number]; e: BlockingEntity } => Boolean(x.e) && x.a.start.visible)
    .sort((p, q) => q.a.start.depthM - p.a.start.depthM);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-line bg-[#070b12]" role="img" aria-label="Camera view (schematic, level camera)">
      <defs>
        <clipPath id={clip}>
          <rect x={0} y={0} width={W} height={H} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="rgba(150,172,214,0.12)" />
        <rect x={W / 3} y={0} width={W / 3} height={H} fill="none" stroke="rgba(150,172,214,0.06)" />
        {items.map(({ a, e }) => {
          const depth = Math.max(0.3, a.start.depthM);
          const ppm = W / (2 * half * depth);
          const heightM = e.kind === 'character' ? POSTURE_HEIGHT_M[e.posture] : OBJECT_HEIGHT_M[e.kind];
          const x = a.start.x * W;
          const foot = H / 2 + eye * ppm;
          const top = H / 2 - (heightM - eye) * ppm;
          const bodyW = (e.kind === 'character' ? BODY_WIDTH_M : e.kind === 'prop' ? 0.3 : e.kind === 'vehicle' ? 4 : 1) * ppm;
          const colour = colours[e.id] ?? '#9eabc2';
          const bad = flagged.has(e.id);
          if (e.kind !== 'character') return <rect key={e.id} x={x - bodyW / 2} y={top} width={bodyW} height={foot - top} rx={3} fill={colour} fillOpacity={0.25} stroke={colour} strokeOpacity={0.6} />;
          const headR = 0.11 * ppm;
          return (
            <g key={e.id}>
              <rect x={x - bodyW / 2} y={top + headR * 2} width={bodyW} height={Math.max(0, foot - top - headR * 2)} rx={bodyW / 4} fill={colour} fillOpacity={0.55} stroke={bad ? '#ff6b6b' : e.speaking ? '#ffffff' : colour} strokeWidth={bad || e.speaking ? 2 : 1} />
              <circle cx={x} cy={top + headR} r={headR} fill={colour} fillOpacity={0.85} stroke={bad ? '#ff6b6b' : '#0a101b'} strokeWidth={bad ? 2 : 1} />
              <text x={x} y={Math.max(9, top - 3)} textAnchor="middle" fontSize={9} fill="#e9eef7">
                {e.label.slice(0, 12)}
                {e.speaking ? ' 🗣' : ''}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Camera axis (scene level)
// ---------------------------------------------------------------------------

function AxisPanel({ project, shot, shots, plan, analysis, axis, names }: { project: WithId<ProjectDoc>; shot: Shot; shots: Shot[]; plan: Plan; analysis: BlockingAnalysis; axis: WithId<CameraAxisDoc> | null; names: Record<string, string> }) {
  const chars = plan.entities.filter((e) => e.kind === 'character' && e.refId);
  const [a, setA] = useState(axis?.axis?.aId ?? chars[0]?.refId ?? '');
  const [b, setB] = useState(axis?.axis?.bId ?? chars[1]?.refId ?? '');
  const [busy, setBusy] = useState(false);
  if (!shot.sceneId) return <p className="text-xs text-faint">Put this shot in a scene to track the scene’s 180° line and travel directions.</p>;
  const save = async (patch: Partial<Omit<CameraAxisDoc, 'id' | 'sceneId' | 'updatedAt'>>, done: string) => {
    setBusy(true);
    try {
      await saveContinuity(project.id, 'cameraAxes', { sceneId: shot.sceneId, axis: axis?.axis ?? null, establishedSide: axis?.establishedSide ?? null, travel: axis?.travel ?? [], crossings: axis?.crossings ?? [], ...patch });
      toast.success(done);
    } catch (e) {
      toast.error('Could not update the line', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const pa = chars.find((e) => e.refId === a);
  const pb = chars.find((e) => e.refId === b);
  const inferred = !axis?.axis && inferAxis(plan);
  const title = (id: string) => shots.find((s) => s.id === id)?.title ?? 'Deleted shot';
  return (
    <div className="space-y-2 text-xs">
      <p className="text-dim">
        {axis?.axis ? `Line between ${names[axis.axis.aId ?? ''] ?? 'A'} and ${names[axis.axis.bId ?? ''] ?? 'B'}` : inferred ? 'Line inferred from the first two characters (not saved yet)' : 'No line yet — block two characters.'}
        {' · '}established side: <span className="text-fg">{axis?.establishedSide ?? 'not established'}</span> · this camera: <span className={cx(axis?.establishedSide && analysis.cameraSide && axis.establishedSide !== analysis.cameraSide ? 'text-danger' : 'text-fg')}>{analysis.cameraSide ?? '—'}</span>
      </p>
      {chars.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Select className="h-8 w-36 text-xs" value={a} onChange={(e) => setA(e.target.value)} aria-label="First character on the line">
            {chars.map((c) => (
              <option key={c.id} value={c.refId!}>
                {c.label}
              </option>
            ))}
          </Select>
          <span className="text-faint">↔</span>
          <Select className="h-8 w-36 text-xs" value={b} onChange={(e) => setB(e.target.value)} aria-label="Second character on the line">
            {chars.map((c) => (
              <option key={c.id} value={c.refId!}>
                {c.label}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="ghost" loading={busy} disabled={!pa || !pb || a === b} onClick={() => void save({ axis: { aId: a, bId: b, a: pa!.position, b: pb!.position }, establishedSide: axisSide(pa!.position, pb!.position, plan.camera.position) }, 'Line set and this camera side established')}>
            Set line here
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="ghost" loading={busy} disabled={!analysis.cameraSide || axis?.establishedSide === analysis.cameraSide} onClick={() => void save({ axis: axis?.axis ?? inferAxis(plan), establishedSide: analysis.cameraSide }, `Scene established on the ${analysis.cameraSide} side`)}>
          Establish this camera side
        </Button>
        {axis?.establishedSide && (
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void save({ establishedSide: null }, 'Established side cleared')}>
            Clear side
          </Button>
        )}
      </div>
      {(axis?.travel.length ?? 0) > 0 && (
        <div>
          <p className="eyebrow mb-1">Established travel</p>
          <ul className="space-y-0.5">
            {axis!.travel.map((t) => (
              <li key={t.refId} className="flex items-center gap-2">
                <span className="text-fg">{names[t.refId] ?? t.refId}</span>
                <span className="text-dim">{SCREEN_DIRECTION_LABELS[t.direction]}</span>
                <button type="button" className="ml-auto cursor-pointer text-faint hover:text-fg" onClick={() => void save({ travel: axis!.travel.filter((x) => x.refId !== t.refId) }, 'Travel direction cleared')}>
                  clear
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(axis?.crossings.length ?? 0) > 0 && (
        <div>
          <p className="eyebrow mb-1">Recorded crossings</p>
          <ul className="space-y-0.5 text-dim">
            {axis!.crossings.map((c) => (
              <li key={`${c.shotId}${c.at}`}>
                {title(c.shotId)} · {AXIS_CROSSING_LABELS[c.reason]}
                {c.note ? ` — ${c.note}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function BlockingEditor({ project, shot, shots, scenes, characters, elements }: { project: WithId<ProjectDoc>; shot: Shot; shots: Shot[]; scenes: WithId<SceneDoc>[]; characters: Character[]; elements: WithId<ElementDoc>[] }) {
  const arrow = useId();
  const locationId = shot.refs.locationIds[0] ?? scenes.find((s) => s.id === shot.sceneId)?.locationId ?? null;
  const stored = useProjectDoc<BlockingPlanDoc>(project.id, 'blockingPlans', shot.id);
  const setBible = useProjectDoc<SetBibleDoc>(project.id, 'setBibles', locationId);
  const axisDoc = useProjectDoc<CameraAxisDoc>(project.id, 'cameraAxes', shot.sceneId);
  const snap = useProjectDoc<Snapshot>(project.id, 'continuitySnapshots', shot.id);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('select');
  const [drag, setDrag] = useState<{ kind: 'entity' | 'facing' | 'waypoint' | 'camera' | 'camDir' | 'camEnd' | 'zone'; id: string; index?: number; dx?: number; dy?: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fix, setFix] = useState<ReturnType<typeof suggestCamera> | 'none' | null>(null);
  useEffect(() => {
    if (stored.loading || plan !== null) return;
    setPlan(stored.data ? fromStored(stored.data) : defaultPlan(shot, characters, locationId));
  }, [stored.loading, stored.data, plan, shot, characters, locationId]);

  const planSizeM = setBible.data?.planSizeM ?? DEFAULT_PLAN_SIZE_M;
  const floor = useMemo(() => setBible.data?.floorPlan ?? [], [setBible.data]);
  const opts: AnalyzeOptions = useMemo(() => ({ planSizeM, floorPlan: floor, axis: axisDoc.data ?? null, axisCrossingAllowed: Boolean(shot.continuity?.axisCrossing), shotId: shot.id }), [planSizeM, floor, axisDoc.data, shot.continuity?.axisCrossing, shot.id]);
  const analysis = useMemo(() => (plan ? analyzeBlocking(plan, opts) : null), [plan, opts]);
  const colours = useMemo(() => Object.fromEntries((plan?.entities ?? []).map((e, i) => [e.id, e.kind === 'character' ? PALETTE[i % PALETTE.length]! : '#9eabc2'])), [plan?.entities]);
  const names = useMemo(() => Object.fromEntries(characters.map((c) => [c.id, c.name])), [characters]);

  if (!plan || !analysis) return <Skeleton className="h-[520px]" />;

  const update = (fn: (p: Plan) => Plan) => {
    setPlan((p) => (p ? fn(p) : p));
    setDirty(true);
    setFix(null);
  };
  const setEntity = (id: string, patch: Partial<BlockingEntity>) => update((p) => ({ ...p, entities: p.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  const setCamera = (patch: Partial<BlockingCamera>) => update((p) => ({ ...p, camera: { ...p.camera, ...patch } }));
  const setZone = (id: string, patch: Partial<ProtectedZone>) => update((p) => ({ ...p, protectedZones: p.protectedZones.map((z) => (z.id === id ? { ...z, ...patch } : z)) }));
  const entity = plan.entities.find((e) => e.id === sel) ?? null;
  const zone = plan.protectedZones.find((z) => z.id === sel) ?? null;
  const flagged = new Set(analysis.warnings.filter((w) => w.severity !== 'info' && w.subjectId).flatMap((w) => plan.entities.filter((e) => e.refId === w.subjectId).map((e) => e.id)));

  const toPlan = (e: ReactPointerEvent<SVGElement>) => {
    const svg = (e.currentTarget as SVGElement).ownerSVGElement ?? (e.currentTarget as unknown as SVGSVGElement);
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const begin = (d: NonNullable<typeof drag>) => (e: ReactPointerEvent<SVGElement>) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    let next = d;
    if (d.kind === 'entity' || d.kind === 'zone') {
      const p = toPlan(e);
      const origin = d.kind === 'entity' ? plan.entities.find((x) => x.id === d.id)!.position : plan.protectedZones.find((z) => z.id === d.id)!;
      next = { ...d, dx: p.x - origin.x, dy: p.y - origin.y };
    }
    setDrag(next);
    setSel(d.kind === 'camera' || d.kind === 'camDir' || d.kind === 'camEnd' ? 'camera' : d.id);
  };
  const move = (e: ReactPointerEvent<SVGElement>) => {
    if (!drag) return;
    const p = toPlan(e);
    if (drag.kind === 'entity') {
      const moved = clampPlan({ x: p.x - (drag.dx ?? 0), y: p.y - (drag.dy ?? 0) });
      setEntity(drag.id, { position: moved });
    } else if (drag.kind === 'zone') {
      const moved = clampPlan({ x: p.x - (drag.dx ?? 0), y: p.y - (drag.dy ?? 0) });
      setZone(drag.id, { x: moved.x, y: moved.y });
    } else if (drag.kind === 'facing') {
      const en = plan.entities.find((x) => x.id === drag.id)!;
      setEntity(drag.id, { facingDeg: normDeg(angleOf(p.x - en.position.x, p.y - en.position.y)) });
    } else if (drag.kind === 'waypoint') {
      const en = plan.entities.find((x) => x.id === drag.id)!;
      setEntity(drag.id, { path: en.path.map((w, i) => (i === drag.index ? clampPlan(p) : w)) });
    } else if (drag.kind === 'camera') {
      setCamera({ position: clampPlan(p) });
    } else if (drag.kind === 'camDir') {
      setCamera({ directionDeg: normDeg(angleOf(p.x - plan.camera.position.x, p.y - plan.camera.position.y)) });
    } else if (drag.kind === 'camEnd') {
      setCamera({ endPosition: clampPlan(p) });
    }
  };
  const handlers = (d: NonNullable<typeof drag>) => ({ onPointerDown: begin(d), onPointerMove: move, onPointerUp: () => setDrag(null), onPointerCancel: () => setDrag(null) });

  const onBackground = (p: StagePoint) => {
    if (mode === 'path' && entity) {
      if (entity.path.length >= 20) return;
      setEntity(entity.id, { path: [...entity.path, clampPlan(p)] });
      return;
    }
    if (mode === 'zone') {
      if (plan.protectedZones.length >= 12) return;
      const z: ProtectedZone = { id: eid(), label: 'Important action', x: r3(Math.max(0, p.x - 0.05)), y: r3(Math.max(0, p.y - 0.05)), w: 0.1, h: 0.1 };
      update((x) => ({ ...x, protectedZones: [...x.protectedZones, z] }));
      setSel(z.id);
      setMode('select');
      return;
    }
    setSel(null);
  };

  const add = (kind: BlockingEntityKind, refId: string | null, label: string) => {
    if (plan.entities.length >= 24) return;
    const e = newEntity(kind, refId, label, { x: 0.5, y: 0.45 });
    update((p) => ({ ...p, entities: [...p.entities, e] }));
    setSel(e.id);
  };

  const save = async (check = true): Promise<boolean> => {
    setBusy('save');
    try {
      await saveContinuity(project.id, 'blockingPlans', { ...plan, shotId: shot.id, sceneId: shot.sceneId, locationId } as unknown as Record<string, unknown>);
      setDirty(false);
      if (check) await checkContinuity(project.id, shot.id, true).catch(() => null);
      toast.success('Blocking saved', { description: check ? 'The shot’s continuity plan was updated from it.' : undefined });
      return true;
    } catch (e) {
      toast.error('Could not save the blocking', { description: errorMessage(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const coverage = async (type: CoverageType, subjectIds: string[], label: string) => {
    if (dirty && !(await save(false))) return;
    setBusy(label);
    try {
      const dialogue = shot.directions.dialogue;
      const linesOf = (id: string) => dialogue.map((l, k) => (l.character.trim().toUpperCase() === (names[id] ?? '').trim().toUpperCase() ? k : -1)).filter((k) => k >= 0);
      const mk = (i: number, ids: string[], focus: string): CoverageSuggestion => ({ id: `cov${i + 1}`, type, subjectIds: ids, description: `${COVERAGE_LABELS[type]} on ${names[focus] ?? 'the subject'}`, action: shot.directions.action, framing: FRAMING[type] ?? '', lens: '', cameraMovement: 'Static, locked-off camera', durationSec: shot.durationSec, dialogueLines: type === 'reaction' ? [] : linesOf(focus), priority: 'essential', rationale: `Repairs blocking in “${shot.title}”.`, accepted: true });
      // Over-the-shoulder: foreground shoulder first, then the character facing the camera.
      const items = type === 'over_the_shoulder' ? [mk(0, subjectIds, subjectIds[subjectIds.length - 1]!)] : subjectIds.map((id, i) => mk(i, [id], id));
      const r = await applyCoverage(project.id, shot.sceneId, shot.id, items);
      toast.success(`${r.shotIds.length} shot${r.shotIds.length === 1 ? '' : 's'} added after this one`, { description: 'Blocked on the established side of the line; nothing is generated until you produce them.' });
    } catch (e) {
      toast.error('Could not add the shot', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const cam = plan.camera;
  const fov = horizontalFov(cam.lensMm);
  const ray = (deg: number, len: number) => {
    const v = dirVector(deg);
    return { x: (cam.position.x + v.x * len) * S, y: (cam.position.y + v.y * len) * S };
  };
  const r1 = ray(cam.directionDeg - fov / 2, 0.6);
  const r2 = ray(cam.directionDeg + fov / 2, 0.6);
  const dirHandle = ray(cam.directionDeg, 0.07);
  const axis = axisDoc.data?.axis ?? inferAxis(plan);
  const axisLine = axis
    ? (() => {
        const dx = axis.b.x - axis.a.x;
        const dy = axis.b.y - axis.a.y;
        const len = Math.hypot(dx, dy) || 1;
        const u = { x: dx / len, y: dy / len };
        const side = axisDoc.data?.establishedSide ?? null;
        const n = side === 'right' ? { x: -u.y, y: u.x } : side === 'left' ? { x: u.y, y: -u.x } : null;
        const p0 = { x: axis.a.x - u.x * 3, y: axis.a.y - u.y * 3 };
        const p1 = { x: axis.b.x + u.x * 3, y: axis.b.y + u.y * 3 };
        return { p0, p1, shade: n ? [p0, p1, { x: p1.x + n.x * 3, y: p1.y + n.y * 3 }, { x: p0.x + n.x * 3, y: p0.y + n.y * 3 }] : null };
      })()
    : null;
  const a = entity ? analysis.entities.find((x) => x.id === entity.id) ?? null : null;
  const planWarnings = (snap.data?.continuityWarnings ?? []).filter((w) => w.status === 'open' && ['screen_direction', 'entry_exit', 'axis_crossing', 'eyeline', 'occlusion', 'face_hidden'].includes(w.kind) && w.source !== 'plan');
  const snapPlanWarnings = (snap.data?.continuityWarnings ?? []).filter((w) => w.status === 'open' && (w.kind === 'screen_direction' || w.kind === 'entry_exit'));
  const shotTitle = (id: string | null) => (id ? shots.find((s) => s.id === id)?.title ?? null : null);
  const availableChars = characters.filter((c) => !plan.entities.some((e) => e.refId === c.id));
  const speakers = plan.entities.filter((e) => e.kind === 'character' && e.speaking && e.refId).map((e) => e.refId!);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          label="Tool"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'select', label: 'Move' },
            { value: 'path', label: 'Draw path', disabled: !entity, title: 'Click the plan to add waypoints to the selected character or object' },
            { value: 'zone', label: 'Protected zone', title: 'Click the plan to mark an important action or object that must stay visible' },
          ]}
        />
        <Select className="h-8 w-44 text-xs" value="" onChange={(e) => {
            const c = characters.find((x) => x.id === e.target.value);
            if (c) add('character', c.id, c.name);
          }} aria-label="Add a character" disabled={!availableChars.length}>
          <option value="">+ Character…</option>
          {availableChars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select className="h-8 w-40 text-xs" value="" onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            if (v.startsWith('el:')) {
              const el = elements.find((x) => x.id === v.slice(3));
              if (el) add('prop', el.id, el.name);
            } else add(v as BlockingEntityKind, null, v);
          }} aria-label="Add an object">
          <option value="">+ Object…</option>
          {elements.filter((x) => x.kind !== 'costume').map((el) => (
            <option key={el.id} value={`el:${el.id}`}>
              Prop: {el.name}
            </option>
          ))}
          {BLOCKING_ENTITY_KINDS.filter((k) => k !== 'character' && k !== 'prop').map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <div className="ml-auto flex items-center gap-1.5">
          {dirty && <span className="text-[11px] text-warning">Unsaved</span>}
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => {
              setPlan(defaultPlan(shot, characters, locationId));
              setDirty(true);
              setSel(null);
            }}>
            Reset
          </Button>
          <Button size="sm" variant="primary" loading={busy === 'save'} disabled={!dirty && Boolean(stored.data)} icon={<Save className="size-3.5" />} onClick={() => void save()}>
            Save blocking
          </Button>
        </div>
      </div>
      {!setBible.data && <Notice>No Set Bible for this shot’s location — the plan shows no walls or furniture, so walking-through checks are limited. Build it under Locations → Set Bible.</Notice>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-3">
          <FloorPlan items={floor} planSizeM={planSizeM} editable={false} onBackgroundPointer={(p) => onBackground(p)} className={cx(mode !== 'select' && 'cursor-crosshair')}>
            <defs>
              <marker id={arrow} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#e9eef7" />
              </marker>
            </defs>
            {axisLine?.shade && <polygon points={axisLine.shade.map((q) => `${q.x * S},${q.y * S}`).join(' ')} fill="rgba(62,214,144,0.05)" pointerEvents="none" />}
            {axisLine && (
              <g pointerEvents="none">
                <line x1={axisLine.p0.x * S} y1={axisLine.p0.y * S} x2={axisLine.p1.x * S} y2={axisLine.p1.y * S} stroke="#ff6b6b" strokeOpacity={0.55} strokeWidth={2} strokeDasharray="14 8" />
                <text x={((axis!.a.x + axis!.b.x) / 2) * S} y={((axis!.a.y + axis!.b.y) / 2) * S - 30} textAnchor="middle" fontSize={16} fill="#ff6b6b" fillOpacity={0.8}>
                  180° line
                </text>
              </g>
            )}
            {plan.protectedZones.map((z) => (
              <g key={z.id} {...handlers({ kind: 'zone', id: z.id })} className="cursor-move">
                <rect x={z.x * S} y={z.y * S} width={z.w * S} height={z.h * S} fill="rgba(244,184,74,0.1)" stroke="#f4b84a" strokeWidth={sel === z.id ? 4 : 2} strokeDasharray="8 6" />
                <text x={(z.x + z.w / 2) * S} y={z.y * S - 6} textAnchor="middle" fontSize={15} fill="#f4b84a" pointerEvents="none">
                  {z.label.slice(0, 24)}
                </text>
              </g>
            ))}
            <polygon points={`${cam.position.x * S},${cam.position.y * S} ${r1.x},${r1.y} ${r2.x},${r2.y}`} fill="rgba(233,238,247,0.06)" stroke="rgba(233,238,247,0.25)" strokeWidth={1.5} pointerEvents="none" />
            {cam.endPosition && (
              <g>
                <line x1={cam.position.x * S} y1={cam.position.y * S} x2={cam.endPosition.x * S} y2={cam.endPosition.y * S} stroke="#e9eef7" strokeOpacity={0.5} strokeWidth={2} strokeDasharray="6 6" markerEnd={`url(#${arrow})`} pointerEvents="none" />
                <rect x={cam.endPosition.x * S - 11} y={cam.endPosition.y * S - 11} width={22} height={22} rx={4} fill="#172236" stroke="#e9eef7" strokeWidth={2} className="cursor-move" {...handlers({ kind: 'camEnd', id: 'camera' })}>
                  <title>Camera end position</title>
                </rect>
              </g>
            )}
            {plan.entities.map((e) => {
              const c = colours[e.id]!;
              const pts = [e.position, ...e.path];
              const target = e.gaze.kind === 'entity' ? plan.entities.find((x) => x.id === e.gaze.targetId || x.refId === e.gaze.targetId) : null;
              const gazeTo = target ? target.position : e.gaze.kind === 'camera' ? cam.position : null;
              const facingTip = { x: e.position.x * S + dirVector(e.facingDeg).x * 38, y: e.position.y * S + dirVector(e.facingDeg).y * 38 };
              const inFrame = analysis.entities.find((x) => x.id === e.id)?.start.visible ?? false;
              return (
                <g key={e.id} opacity={inFrame ? 1 : 0.55}>
                  {gazeTo && <line x1={e.position.x * S} y1={e.position.y * S} x2={gazeTo.x * S} y2={gazeTo.y * S} stroke={c} strokeOpacity={0.5} strokeWidth={1.5} strokeDasharray="2 6" pointerEvents="none" />}
                  {e.gaze.kind === 'direction' && e.gaze.deg !== null && <line x1={e.position.x * S} y1={e.position.y * S} x2={e.position.x * S + dirVector(e.gaze.deg).x * 70} y2={e.position.y * S + dirVector(e.gaze.deg).y * 70} stroke={c} strokeOpacity={0.5} strokeDasharray="2 6" pointerEvents="none" />}
                  {e.path.length > 0 && <polyline points={pts.map((q) => `${q.x * S},${q.y * S}`).join(' ')} fill="none" stroke={c} strokeWidth={2.5} strokeDasharray="10 6" markerEnd={`url(#${arrow})`} pointerEvents="none" />}
                  {e.path.map((w, i) => (
                    <circle key={i} cx={w.x * S} cy={w.y * S} r={8} fill="#0a101b" stroke={c} strokeWidth={2} className="cursor-move" {...handlers({ kind: 'waypoint', id: e.id, index: i })}>
                      <title>{i === e.path.length - 1 ? 'End position' : `Waypoint ${i + 1}`}</title>
                    </circle>
                  ))}
                  {e.speaking && <circle cx={e.position.x * S} cy={e.position.y * S} r={30} fill="none" stroke="#ffffff" strokeOpacity={0.6} strokeWidth={2} strokeDasharray="4 4" pointerEvents="none" />}
                  <g className="cursor-move" {...handlers({ kind: 'entity', id: e.id })}>
                    {e.kind === 'character' ? (
                      <circle cx={e.position.x * S} cy={e.position.y * S} r={20} fill={c} fillOpacity={0.85} stroke={sel === e.id ? '#ffffff' : flagged.has(e.id) ? '#ff6b6b' : '#0a101b'} strokeWidth={sel === e.id || flagged.has(e.id) ? 4 : 2} />
                    ) : (
                      <rect x={e.position.x * S - 16} y={e.position.y * S - 16} width={32} height={32} rx={e.kind === 'door' || e.kind === 'exit' ? 2 : 8} fill={e.kind === 'door' || e.kind === 'exit' ? '#b7773a' : '#3d7a5a'} stroke={sel === e.id ? '#ffffff' : '#0a101b'} strokeWidth={sel === e.id ? 4 : 2} />
                    )}
                  </g>
                  <line x1={e.position.x * S} y1={e.position.y * S} x2={facingTip.x} y2={facingTip.y} stroke="#e9eef7" strokeWidth={3} pointerEvents="none" />
                  <circle cx={facingTip.x} cy={facingTip.y} r={7} fill="#e9eef7" className="cursor-grab" {...handlers({ kind: 'facing', id: e.id })}>
                    <title>Drag to turn</title>
                  </circle>
                  <text x={e.position.x * S} y={e.position.y * S + 42} textAnchor="middle" fontSize={16} fill="#e9eef7" pointerEvents="none">
                    {e.label.slice(0, 16)}
                  </text>
                </g>
              );
            })}
            <g className="cursor-move" {...handlers({ kind: 'camera', id: 'camera' })}>
              <circle cx={cam.position.x * S} cy={cam.position.y * S} r={18} fill={sel === 'camera' ? '#ffffff' : '#e9eef7'} stroke="#0a101b" strokeWidth={3} />
              <text x={cam.position.x * S} y={cam.position.y * S + 6} textAnchor="middle" fontSize={16} fill="#0a101b" pointerEvents="none">
                ◉
              </text>
            </g>
            <circle cx={dirHandle.x} cy={dirHandle.y} r={8} fill="#4c8dff" stroke="#0a101b" strokeWidth={2} className="cursor-grab" {...handlers({ kind: 'camDir', id: 'camera' })}>
              <title>Drag to aim the camera</title>
            </circle>
          </FloorPlan>
          <div>
            <p className="eyebrow mb-1">Camera view (schematic)</p>
            <CameraView plan={plan} analysis={analysis} colours={colours} flagged={flagged} />
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-faint">
              Left → right: {analysis.screenOrder.map((id) => names[id] ?? plan.entities.find((e) => e.id === id)?.label ?? id).join(', ') || '—'}
              <DirectionArrows travel={Object.fromEntries(analysis.entities.filter((x) => x.refId && x.travel !== 'static').map((x) => [x.refId!, x.travel]))} names={names} />
            </p>
          </div>
        </div>
        <div className="space-y-3">
          {sel === 'camera' || (!entity && !zone) ? (
            <Card className="space-y-2 p-3">
              <p className="eyebrow flex items-center gap-1.5">
                <Camera className="size-3.5" /> Camera
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Lens">
                  <Select value={cam.lensMm} onChange={(e) => setCamera({ lensMm: Number(e.target.value) })}>
                    {[...new Set([...LENSES, cam.lensMm])].sort((x, y) => x - y).map((l) => (
                      <option key={l} value={l}>
                        {l} mm ({Math.round(horizontalFov(l))}°)
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Height">
                  <Select value={cam.height} onChange={(e) => setCamera({ height: e.target.value as CameraHeight })}>
                    {CAMERA_HEIGHTS.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Direction (°)">
                  <Input type="number" min={0} max={359} value={cam.directionDeg} onChange={(e) => setCamera({ directionDeg: normDeg(Number(e.target.value) || 0) })} />
                </Field>
                <div className="flex items-end">
                  <Button size="sm" variant="ghost" icon={<Crosshair className="size-3.5" />} disabled={!plan.entities.length} onClick={() => {
                      const cs = plan.entities.filter((x) => x.kind === 'character');
                      const list = cs.length ? cs : plan.entities;
                      const cx0 = list.reduce((s, x) => s + x.position.x, 0) / list.length;
                      const cy0 = list.reduce((s, x) => s + x.position.y, 0) / list.length;
                      setCamera({ directionDeg: normDeg(angleOf(cx0 - cam.position.x, cy0 - cam.position.y)) });
                    }}>
                    Aim at group
                  </Button>
                </div>
              </div>
              <Toggle checked={cam.endPosition !== null} onChange={(v) => setCamera({ endPosition: v ? clampPlan({ x: cam.position.x + 0.15, y: cam.position.y }) : null })} label="Moving camera" description="Tracking, dolly or crane: drag the square to where it ends. A camera that visibly crosses the line may cross it." />
            </Card>
          ) : entity ? (
            <Card className="space-y-2 p-3">
              <div className="flex items-center gap-2">
                <p className="eyebrow mr-auto">{entity.kind}</p>
                <Button size="sm" variant="ghost" aria-label="Remove from the plan" onClick={() => {
                    update((p) => ({ ...p, entities: p.entities.filter((x) => x.id !== entity.id).map((x) => (x.gaze.targetId === entity.id ? { ...x, gaze: { kind: 'none', targetId: null, deg: null } } : x)) }));
                    setSel(null);
                  }}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Label">
                  <Input value={entity.label} onChange={(e) => setEntity(entity.id, { label: e.target.value.slice(0, 80) })} />
                </Field>
                {entity.kind === 'character' ? (
                  <Field label="Character">
                    <Select value={entity.refId ?? ''} onChange={(e) => setEntity(entity.id, { refId: e.target.value || null, label: names[e.target.value] ?? entity.label })}>
                      <option value="">—</option>
                      {characters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : entity.kind === 'prop' ? (
                  <Field label="Prop">
                    <Select value={entity.refId ?? ''} onChange={(e) => setEntity(entity.id, { refId: e.target.value || null, label: elements.find((x) => x.id === e.target.value)?.name ?? entity.label })}>
                      <option value="">—</option>
                      {elements.filter((x) => x.kind !== 'costume').map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : (
                  <div />
                )}
                <Field label="Body orientation (°)">
                  <Input type="number" min={0} max={359} value={entity.facingDeg} onChange={(e) => setEntity(entity.id, { facingDeg: normDeg(Number(e.target.value) || 0) })} />
                </Field>
                <div className="flex items-end">
                  <Button size="sm" variant="ghost" onClick={() => setEntity(entity.id, { facingDeg: normDeg(angleOf(cam.position.x - entity.position.x, cam.position.y - entity.position.y)) })}>
                    Face camera
                  </Button>
                </div>
                <Field label="Gaze">
                  <Select value={entity.gaze.kind} onChange={(e) => setEntity(entity.id, { gaze: { kind: e.target.value as BlockingEntity['gaze']['kind'], targetId: e.target.value === 'entity' ? plan.entities.find((x) => x.id !== entity.id)?.id ?? null : null, deg: e.target.value === 'direction' ? entity.facingDeg : null } })}>
                    <option value="none">Unspecified</option>
                    <option value="camera">Into the lens</option>
                    <option value="entity">At someone / something</option>
                    <option value="direction">In a direction</option>
                  </Select>
                </Field>
                {entity.gaze.kind === 'entity' ? (
                  <Field label="Looks at">
                    <Select value={entity.gaze.targetId ?? ''} onChange={(e) => setEntity(entity.id, { gaze: { ...entity.gaze, targetId: e.target.value || null } })}>
                      {plan.entities.filter((x) => x.id !== entity.id).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : entity.gaze.kind === 'direction' ? (
                  <Field label="Gaze direction (°)">
                    <Input type="number" min={0} max={359} value={entity.gaze.deg ?? 0} onChange={(e) => setEntity(entity.id, { gaze: { ...entity.gaze, deg: normDeg(Number(e.target.value) || 0) } })} />
                  </Field>
                ) : (
                  <div />
                )}
                <Field label="Layer">
                  <Select value={entity.layer ?? ''} onChange={(e) => setEntity(entity.id, { layer: (e.target.value || null) as Layer | null })}>
                    <option value="">From the camera</option>
                    {LAYERS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
                {entity.kind === 'character' && (
                  <Field label="Posture">
                    <Select value={entity.posture} onChange={(e) => setEntity(entity.id, { posture: e.target.value as Posture })}>
                      {POSTURES.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <Field label="Must stay visible">
                  <Select value={entity.protectedVisibility} onChange={(e) => setEntity(entity.id, { protectedVisibility: e.target.value as BlockingEntity['protectedVisibility'] })}>
                    <option value="face">Face</option>
                    <option value="body">Body</option>
                    <option value="none">No requirement</option>
                  </Select>
                </Field>
              </div>
              {entity.kind === 'character' && <Toggle checked={entity.speaking} onChange={(v) => setEntity(entity.id, { speaking: v })} label="Speaks in this shot" />}
              <Toggle checked={entity.occlusionAllowed} onChange={(v) => setEntity(entity.id, { occlusionAllowed: v })} label="Partial occlusion is intentional" description="Over-the-shoulder, foreground silhouette, crossing the frame or purposeful concealment." />
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <Footprints className="size-3.5 text-faint" />
                <span className="text-dim">{entity.path.length ? `${entity.path.length} waypoint${entity.path.length === 1 ? '' : 's'} (last = end position)` : 'Static'}</span>
                <Button size="sm" variant={mode === 'path' ? 'subtle' : 'ghost'} onClick={() => setMode(mode === 'path' ? 'select' : 'path')}>
                  {mode === 'path' ? 'Done' : 'Draw path'}
                </Button>
                {entity.path.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setEntity(entity.id, { path: [] })}>
                    Clear
                  </Button>
                )}
              </div>
              {a && (
                <p className="text-[11px] text-faint">
                  {a.start.visible ? `In frame at ${Math.round(a.start.x * 100)}% from the left` : 'Out of frame at the start'} · {a.start.depthM.toFixed(1)} m from the lens · {a.start.layer}
                  {a.start.facing ? ` · ${a.start.facing.replace(/_/g, ' ')}` : ''}
                  {a.travel !== 'static' ? ` · travels ${SCREEN_DIRECTION_LABELS[a.travel].toLowerCase()}` : ''}
                  {a.entry ? ` · enters ${a.entry}` : ''}
                  {a.exit ? ` · exits ${a.exit}` : ''}
                </p>
              )}
            </Card>
          ) : zone ? (
            <Card className="space-y-2 p-3">
              <div className="flex items-center gap-2">
                <p className="eyebrow mr-auto flex items-center gap-1.5">
                  <SquareDashed className="size-3.5" /> Protected zone
                </p>
                <Button size="sm" variant="ghost" aria-label="Remove zone" onClick={() => {
                    update((p) => ({ ...p, protectedZones: p.protectedZones.filter((z) => z.id !== zone.id) }));
                    setSel(null);
                  }}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <Field label="What must stay visible">
                <Input value={zone.label} onChange={(e) => setZone(zone.id, { label: e.target.value.slice(0, 80) })} placeholder="e.g. the handover of the letter" />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Width">
                  <Input type="number" step={0.01} min={0.01} max={1} value={zone.w} onChange={(e) => setZone(zone.id, { w: Math.max(0.01, Math.min(1, Number(e.target.value) || 0.1)) })} />
                </Field>
                <Field label="Depth">
                  <Input type="number" step={0.01} min={0.01} max={1} value={zone.h} onChange={(e) => setZone(zone.id, { h: Math.max(0.01, Math.min(1, Number(e.target.value) || 0.1)) })} />
                </Field>
              </div>
              <p className="text-[11px] text-faint">Checked against the camera: the zone must be in frame and nobody may stand in front of it.</p>
            </Card>
          ) : null}
          <Card className="space-y-2 p-3">
            <div className="flex items-center gap-2">
              <p className="eyebrow mr-auto">Blocking check</p>
              {analysis.warnings.some((w) => FIXABLE.has(w.kind) && w.severity !== 'info') && (
                <Button size="sm" variant="subtle" icon={<Wand2 className="size-3.5" />} onClick={() => setFix(suggestCamera(plan, opts) ?? 'none')}>
                  Suggest camera fix
                </Button>
              )}
            </div>
            {fix === 'none' && <p className="text-xs text-faint">No camera position on this side of the line clears these problems — reposition the characters or add coverage below.</p>}
            {fix && fix !== 'none' && (
              <Notice tone="accent">
                <span className="block">
                  {fix.summary} — problems {fix.before} → {fix.after}.
                </span>
                <span className="mt-1 flex gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => {
                      setCamera(fix.camera);
                      toast.success('Camera adjusted', { description: 'Save the blocking to keep it.' });
                    }}>
                    Apply
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setFix(null)}>
                    Dismiss
                  </Button>
                </span>
              </Notice>
            )}
            {analysis.warnings.length === 0 ? (
              <p className="text-xs text-success">No blocking problems from this camera.</p>
            ) : (
              <ul className="space-y-1.5">
                {analysis.warnings.map((w) => (
                  <li key={w.id} className={cx('rounded-lg border px-2.5 py-1.5 text-xs', w.severity === 'critical' ? 'border-danger/35 bg-danger/[0.05]' : w.severity === 'warning' ? 'border-warning/30' : 'border-line')}>
                    <div className="flex items-start gap-1.5">
                      <Badge tone={w.severity === 'critical' ? 'danger' : w.severity === 'warning' ? 'warning' : 'neutral'}>{WARNING_LABELS[w.kind]}</Badge>
                      <span className="text-fg">{w.message}</span>
                    </div>
                    {w.proposedRepair && <p className="mt-0.5 text-faint">Repair: {w.proposedRepair.label}</p>}
                    {w.subjectId && (w.kind === 'occlusion' || w.kind === 'face_hidden') && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(['clean_single', 'over_the_shoulder', 'reaction'] as CoverageType[]).map((t) => (
                          <Button key={t} size="sm" variant="ghost" loading={busy === t} onClick={() => void coverage(t, t === 'over_the_shoulder' ? [plan.entities.find((x) => x.kind === 'character' && x.refId && x.refId !== w.subjectId)?.refId ?? '', w.subjectId!].filter(Boolean) : [w.subjectId!], t)}>
                            + {COVERAGE_LABELS[t]}
                          </Button>
                        ))}
                        {speakers.length > 1 && (
                          <Button size="sm" variant="ghost" loading={busy === 'split'} onClick={() => void coverage('clean_single', speakers, 'split')}>
                            Split into {speakers.length} singles
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {(snapPlanWarnings.length > 0 || planWarnings.length > 0) && (
            <Card className="space-y-2 p-3">
              <p className="eyebrow">From the continuity plan and inspections</p>
              <ul className="space-y-1.5">
                {[...snapPlanWarnings, ...planWarnings.filter((w) => !snapPlanWarnings.includes(w))].map((w) => (
                  <WarningItem key={w.id} projectId={project.id} shotId={shot.id} warning={w} shotTitle={shotTitle} />
                ))}
              </ul>
            </Card>
          )}
          <Card className="space-y-2 p-3">
            <p className="eyebrow">180° line · scene</p>
            <AxisPanel project={project} shot={shot} shots={shots} plan={plan} analysis={analysis} axis={axisDoc.data ?? null} names={names} />
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * Blocking: a top-down stage editor per shot (positions, orientation, gaze, movement paths, layers,
 * intentional occlusion, protected visibility and zones), the camera with its field of view, the
 * scene's 180° line, a schematic camera view and live checks for occlusion, merging bodies, eyelines,
 * walking through furniture and line crossings — before anything is generated.
 */
export function BlockingWorkspace({ project }: { project: WithId<ProjectDoc> }) {
  const ctx = useShotContext(project);
  const shots = useSub<ShotDoc>(project.id, 'shots', 'order');
  const scenes = useSub<SceneDoc>(project.id, 'scenes', 'order');
  const plans = useProjectCollection<BlockingPlanDoc>(project.id, 'blockingPlans');
  const [sceneId, setSceneId] = useState('');
  const [shotId, setShotId] = useState<string | null>(null);
  const visible = sceneId ? shots.data.filter((s) => s.sceneId === sceneId) : shots.data;
  const shot = shots.data.find((s) => s.id === shotId) ?? null;
  if (shots.loading) return <Skeleton className="h-96" />;
  if (!shots.data.length) return <EmptyState icon={<Plus className="size-5" />} title="No shots to block yet" body="Plan shots in Storyboard & shots; multi-character shots should be blocked before they are generated." />;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-2">
        <Select value={sceneId} onChange={(e) => setSceneId(e.target.value)} aria-label="Scene">
          <option value="">All scenes</option>
          {scenes.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.number ? `${s.number}. ` : ''}
              {s.heading}
            </option>
          ))}
        </Select>
        <ul className="max-h-[70vh] space-y-1 overflow-y-auto pr-1">
          {visible.map((s) => {
            const blocked = plans.data.some((p) => p.id === s.id);
            const multi = s.refs.characterIds.length >= 2;
            return (
              <li key={s.id}>
                <button type="button" onClick={() => setShotId(s.id)} className={cx('w-full cursor-pointer rounded-lg border px-3 py-2 text-left text-xs', s.id === shotId ? 'border-accent/50 bg-accent/[0.08]' : 'border-line hover:bg-white/[0.03]')}>
                  <span className="block truncate text-fg">
                    {s.number ? `${s.number} · ` : ''}
                    {s.title || 'Untitled shot'}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1">
                    {blocked ? <Badge tone="success">blocked</Badge> : multi ? <Badge tone="warning">needs blocking</Badge> : <Badge>not blocked</Badge>}
                    <span className="text-faint">{s.refs.characterIds.length} character{s.refs.characterIds.length === 1 ? '' : 's'}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        {shot ? (
          <BlockingEditor key={shot.id} project={project} shot={shot} shots={shots.data} scenes={scenes.data} characters={ctx.characters} elements={ctx.elements} />
        ) : (
          <EmptyState icon={<RefreshCw className="size-5" />} title="Choose a shot" body="Multi-character shots marked “needs blocking” benefit most: the checks catch blocked speakers and merged bodies before any generation is paid for." />
        )}
      </div>
    </div>
  );
}
