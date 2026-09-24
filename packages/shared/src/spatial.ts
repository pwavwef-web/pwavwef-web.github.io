import type { BlockingCamera, BlockingEntity, BlockingPlanDoc, CameraAxisDoc, CameraHeight, ContinuityWarning, FloorItem, Layer, Posture, ScreenDirection, StagePoint } from './continuity';
import { DEFAULT_PLAN_SIZE_M, warningId } from './continuity';

/**
 * Spatial director: deterministic camera geometry on the top-down stage plan.
 *
 * Plan coordinates are 0–1 on both axes (north = top = y 0), scaled by the set's plan size in metres.
 * Angles are degrees clockwise from north. The camera is a pinhole with a full-frame (36 mm wide)
 * sensor, so the horizontal field of view follows from the lens. Everything the storyboard shows,
 * every blocking warning and the blocking text sent to the video model are derived from this.
 */

const DEG = Math.PI / 180;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Unit vector of a plan direction (0 = north/up, 90 = east/right). */
export function dirVector(deg: number): StagePoint {
  return { x: Math.sin(deg * DEG), y: -Math.cos(deg * DEG) };
}

/** Plan direction (degrees, 0–360) of a vector. */
export function angleOf(dx: number, dy: number): number {
  const a = Math.atan2(dx, -dy) / DEG;
  return (a + 360) % 360;
}

export function angleDiff(a: number, b: number): number {
  const d = (((a - b) % 360) + 540) % 360 - 180;
  return Math.abs(d);
}

/** Horizontal field of view (degrees) of a full-frame lens. */
export function horizontalFov(lensMm: number): number {
  const mm = Math.max(8, Math.min(600, lensMm || 35));
  return (2 * Math.atan(36 / (2 * mm))) / DEG;
}

export const BODY_WIDTH_M = 0.5;
export const HEAD_WIDTH_M = 0.2;

export type Facing = 'frontal' | 'three_quarter' | 'profile' | 'three_quarter_back' | 'back';

export interface ScreenProjection {
  /** Inside the horizontal field of view and in front of the camera. */
  visible: boolean;
  /** Horizontal screen position (0 = left edge, 1 = right edge; may be outside when not visible). */
  x: number;
  depthM: number;
  lateralM: number;
  /** Apparent body and head width as a fraction of frame width. */
  bodyFrac: number;
  headFrac: number;
  layer: Layer;
  facing: Facing | null;
  /** Which way the subject looks on screen. */
  looks: 'left' | 'right' | 'camera' | 'away' | null;
}

export function layerForDepth(depthM: number): Layer {
  if (depthM < 2.2) return 'foreground';
  if (depthM > 5.5) return 'background';
  return 'midground';
}

/** Projects a plan point (and optionally a facing direction) into the camera frame. */
export function projectPoint(cam: Pick<BlockingCamera, 'position' | 'directionDeg' | 'lensMm'>, p: StagePoint, facingDeg: number | null = null, planSizeM = DEFAULT_PLAN_SIZE_M): ScreenProjection {
  const f = dirVector(cam.directionDeg);
  const r = dirVector(cam.directionDeg + 90);
  const dx = (p.x - cam.position.x) * planSizeM;
  const dy = (p.y - cam.position.y) * planSizeM;
  const forward = dx * f.x + dy * f.y;
  const lateral = dx * r.x + dy * r.y;
  const half = Math.tan((horizontalFov(cam.lensMm) / 2) * DEG);
  const depth = Math.max(0.05, forward);
  const x = forward > 0.05 ? 0.5 + lateral / depth / (2 * half) : lateral >= 0 ? 9 : -9;
  const bodyFrac = BODY_WIDTH_M / depth / (2 * half);
  const headFrac = HEAD_WIDTH_M / depth / (2 * half);
  const visible = forward > 0.3 && x + bodyFrac / 2 > 0 && x - bodyFrac / 2 < 1;
  let facing: Facing | null = null;
  let looks: ScreenProjection['looks'] = null;
  if (facingDeg !== null && Number.isFinite(facingDeg)) {
    const toCam = { x: -dx, y: -dy };
    const len = Math.hypot(toCam.x, toCam.y) || 1;
    const fv = dirVector(facingDeg);
    const cos = (fv.x * toCam.x + fv.y * toCam.y) / len;
    const theta = Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
    facing = theta < 30 ? 'frontal' : theta < 70 ? 'three_quarter' : theta < 110 ? 'profile' : theta < 150 ? 'three_quarter_back' : 'back';
    const side = fv.x * r.x + fv.y * r.y;
    looks = Math.abs(side) >= 0.25 ? (side > 0 ? 'right' : 'left') : theta < 90 ? 'camera' : 'away';
  }
  return { visible, x: r3(x), depthM: r3(forward), lateralM: r3(lateral), bodyFrac: r3(bodyFrac), headFrac: r3(headFrac), layer: layerForDepth(forward), facing, looks };
}

function sideOfLine(a: StagePoint, b: StagePoint, c: StagePoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Which side of the directed axis a→b a point lies on (looking from a toward b). */
export function axisSide(a: StagePoint, b: StagePoint, c: StagePoint): 'left' | 'right' | null {
  const s = sideOfLine(a, b, c);
  if (Math.abs(s) < 1e-6) return null;
  // Plan y grows downward, so a positive cross product is on the right-hand side.
  return s > 0 ? 'right' : 'left';
}

export function pathEnd(e: Pick<BlockingEntity, 'position' | 'path'>): StagePoint {
  return e.path.length ? e.path[e.path.length - 1]! : e.position;
}

/** Screen travel direction of a moving entity (from its path start to end). */
export function travelDirection(cam: BlockingCamera, e: Pick<BlockingEntity, 'position' | 'path'>, planSizeM = DEFAULT_PLAN_SIZE_M): ScreenDirection {
  if (!e.path.length) return 'static';
  const a = projectPoint(cam, e.position, null, planSizeM);
  const b = projectPoint(cam, pathEnd(e), null, planSizeM);
  const clampX = (v: number) => Math.max(-1.5, Math.min(2.5, v));
  const dx = clampX(b.x) - clampX(a.x);
  const dz = b.depthM - a.depthM;
  if (Math.abs(dx) >= 0.12) return dx > 0 ? 'left_to_right' : 'right_to_left';
  if (Math.abs(dz) >= 0.6) return dz < 0 ? 'toward_camera' : 'away_from_camera';
  return 'static';
}

export function entrySide(cam: BlockingCamera, e: Pick<BlockingEntity, 'position' | 'path'>, planSizeM = DEFAULT_PLAN_SIZE_M): { entry: 'left' | 'right' | null; exit: 'left' | 'right' | null } {
  const a = projectPoint(cam, e.position, null, planSizeM);
  const b = projectPoint(cam, pathEnd(e), null, planSizeM);
  const side = (p: ScreenProjection) => (p.x < 0 ? 'left' : p.x > 1 ? 'right' : null);
  return { entry: e.path.length ? side(a) : null, exit: e.path.length ? side(b) : null };
}

function verticalOverlapFactor(height: CameraHeight, near: Posture, far: Posture): number {
  const base = height === 'overhead' ? 0.2 : height === 'high' ? 0.6 : 1;
  const low = (p: Posture) => p === 'seated' || p === 'kneeling' || p === 'crouching' || p === 'lying';
  if (low(far) && !low(near)) return Math.min(1, base * 1.2);
  if (low(near) && !low(far)) return base * 0.45;
  return base;
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function segmentHitsRect(p0: StagePoint, p1: StagePoint, it: FloorItem): boolean {
  // Transform into the rectangle's frame (rotation about its centre).
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  const rot = -(it.rotation || 0) * DEG;
  const tr = (p: StagePoint) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: dx * Math.cos(rot) - dy * Math.sin(rot), y: dx * Math.sin(rot) + dy * Math.cos(rot) };
  };
  const a = tr(p0);
  const b = tr(p1);
  const hw = it.w / 2;
  const hh = it.h / 2;
  // Liang–Barsky clipping against the axis-aligned box.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (!clip(-dx, a.x + hw) || !clip(dx, hw - a.x) || !clip(-dy, a.y + hh) || !clip(dy, hh - a.y)) return false;
  return t1 - t0 > 0.02;
}

function distToSegmentM(p: StagePoint, a: StagePoint, b: StagePoint, planSizeM: number): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy)) * planSizeM;
}

export interface BlockingAnalysis {
  entities: { id: string; label: string; refId: string | null; kind: string; start: ScreenProjection; end: ScreenProjection; travel: ScreenDirection; entry: 'left' | 'right' | null; exit: 'left' | 'right' | null; speaking: boolean }[];
  /** Characters ordered left → right on screen at the start of the shot. */
  screenOrder: string[];
  warnings: ContinuityWarning[];
  cameraSide: 'left' | 'right' | null;
}

export interface AnalyzeOptions {
  planSizeM?: number;
  floorPlan?: FloorItem[];
  axis?: CameraAxisDoc | null;
  /** This shot may cross the line (planned, neutral shot, moving camera, override). */
  axisCrossingAllowed?: boolean;
  shotId?: string | null;
  previousShotId?: string | null;
  nextShotId?: string | null;
  /** Face coverage above which a protected face counts as blocked. */
  occlusionThreshold?: number;
}

const warn = (kind: ContinuityWarning['kind'], severity: ContinuityWarning['severity'], subjectId: string | null, message: string, expected: string, opts: AnalyzeOptions, proposed: ContinuityWarning['proposedRepair'] = null): ContinuityWarning => ({
  id: warningId(kind),
  kind,
  severity,
  subjectId,
  message,
  expected,
  detected: null,
  difference: null,
  proposedRepair: proposed,
  affects: { previousShotId: opts.previousShotId ?? null, nextShotId: opts.nextShotId ?? null },
  source: 'plan',
  status: 'open',
});

const OCCLUSION_REPAIRS = ['Reposition character', 'Change camera angle', 'Change focal length', 'Raise or lower camera', 'Switch to a clean single', 'Use an over-the-shoulder shot', 'Add a reaction shot', 'Split the scene into multiple shots'];

/** Cameras sit on one side of the conversation line; returns the side of this plan's camera. */
export function cameraAxisSide(plan: Pick<BlockingPlanDoc, 'camera'>, axis: CameraAxisDoc['axis']): 'left' | 'right' | null {
  if (!axis) return null;
  return axisSide(axis.a, axis.b, plan.camera.position);
}

/** Default axis: the line through the first two blocked characters. */
export function inferAxis(plan: Pick<BlockingPlanDoc, 'entities'>): CameraAxisDoc['axis'] {
  const chars = plan.entities.filter((e) => e.kind === 'character');
  if (chars.length < 2) return null;
  const [a, b] = chars;
  return { aId: a!.refId, bId: b!.refId, a: a!.position, b: b!.position };
}

/**
 * Analyses a blocking plan from the camera: screen positions, layers, travel, entries and exits, and
 * the problems a director would catch on set — faces blocked during dialogue, people occupying the
 * same space, broken eyelines, crossing the line, walking through furniture or off-frame speakers.
 */
export function analyzeBlocking(plan: Pick<BlockingPlanDoc, 'camera' | 'entities'>, opts: AnalyzeOptions = {}): BlockingAnalysis {
  const size = opts.planSizeM ?? DEFAULT_PLAN_SIZE_M;
  const cam = plan.camera;
  const threshold = opts.occlusionThreshold ?? 0.35;
  const warnings: ContinuityWarning[] = [];
  const entities = plan.entities.map((e) => {
    const start = projectPoint(cam, e.position, e.facingDeg, size);
    const endFacing = e.path.length ? angleOf(pathEnd(e).x - (e.path[e.path.length - 2] ?? e.position).x, pathEnd(e).y - (e.path[e.path.length - 2] ?? e.position).y) : e.facingDeg;
    const end = projectPoint(cam, pathEnd(e), endFacing, size);
    const sides = entrySide(cam, e, size);
    return { id: e.id, label: e.label, refId: e.refId, kind: e.kind, start, end, travel: travelDirection(cam, e, size), entry: sides.entry, exit: sides.exit, speaking: e.speaking, src: e };
  });
  const chars = entities.filter((x) => x.kind === 'character');

  // Speakers and protected faces must be in frame and facing the lens.
  for (const c of chars) {
    const e = c.src;
    if (!c.start.visible && !c.end.visible && (e.speaking || e.protectedVisibility !== 'none')) {
      warnings.push(warn('out_of_frame', e.speaking ? 'critical' : 'warning', e.refId, `${e.label} is outside the camera’s field of view${e.speaking ? ' while speaking' : ''}.`, `${e.label} visible in frame`, opts, { type: 'correct_blocking', label: 'Reposition character or camera', estimateUsd: null }));
    }
    if (e.speaking && e.protectedVisibility === 'face' && c.start.visible && (c.start.facing === 'back' || c.start.facing === 'three_quarter_back') && !e.occlusionAllowed) {
      warnings.push(warn('face_hidden', 'warning', e.refId, `${e.label} speaks with their back to the camera — the face and lip-sync will not read.`, `${e.label} facing the camera while speaking`, opts, { type: 'correct_blocking', label: 'Turn the character or move the camera', estimateUsd: null }));
    }
  }

  // Occlusion and merging between every pair of characters.
  for (let i = 0; i < chars.length; i++) {
    for (let j = i + 1; j < chars.length; j++) {
      const A = chars[i]!;
      const B = chars[j]!;
      const distM = Math.hypot(A.src.position.x - B.src.position.x, A.src.position.y - B.src.position.y) * size;
      if (distM < BODY_WIDTH_M * 0.9) {
        warnings.push(warn('same_space', 'critical', A.src.refId, `${A.label} and ${B.label} occupy the same space (${distM.toFixed(2)} m apart) — bodies will merge.`, 'At least half a metre between characters', opts, { type: 'correct_blocking', label: 'Reposition character', estimateUsd: null }));
        continue;
      }
      if (!A.start.visible || !B.start.visible) continue;
      const [near, far] = A.start.depthM <= B.start.depthM ? [A, B] : [B, A];
      const nb0 = near.start.x - near.start.bodyFrac / 2;
      const nb1 = near.start.x + near.start.bodyFrac / 2;
      const fh0 = far.start.x - far.start.headFrac / 2;
      const fh1 = far.start.x + far.start.headFrac / 2;
      const coverage = (overlap(nb0, nb1, fh0, fh1) / Math.max(1e-6, far.start.headFrac)) * verticalOverlapFactor(cam.height, near.src.posture, far.src.posture);
      const intentional = near.src.occlusionAllowed;
      if (coverage >= threshold && !intentional && far.src.protectedVisibility !== 'none') {
        const critical = far.src.speaking && far.src.protectedVisibility === 'face';
        warnings.push(
          warn(
            'occlusion',
            critical ? 'critical' : 'warning',
            far.src.refId,
            `${near.label} covers about ${Math.round(Math.min(1, coverage) * 100)}% of ${far.label}’s face${far.src.speaking ? ' while they speak' : ''}.`,
            `${far.label}’s ${far.src.protectedVisibility} clearly visible`,
            opts,
            { type: 'correct_blocking', label: OCCLUSION_REPAIRS.slice(0, 3).join(' / '), estimateUsd: null },
          ),
        );
      } else if (!intentional) {
        // Silhouettes that just touch read as one body ("attached" characters).
        const fb0 = far.start.x - far.start.bodyFrac / 2;
        const fb1 = far.start.x + far.start.bodyFrac / 2;
        const touch = overlap(nb0, nb1, fb0, fb1) / Math.max(1e-6, far.start.bodyFrac);
        if (touch > 0.05 && touch < 0.25 && Math.abs(near.start.depthM - far.start.depthM) > 1.2) {
          warnings.push(warn('tangent', 'info', far.src.refId, `${near.label} and ${far.label} line up edge to edge on screen and may read as one figure.`, 'Clear space between silhouettes', opts, { type: 'correct_blocking', label: 'Reposition character', estimateUsd: null }));
        }
      }
    }
  }

  // Eyelines: a character looking at another must look toward that character's side of the frame.
  for (const c of chars) {
    const g = c.src.gaze;
    if (g.kind !== 'entity' || !g.targetId) continue;
    const target = entities.find((x) => x.id === g.targetId || x.refId === g.targetId);
    if (!target || !c.start.visible) continue;
    const wantRight = target.start.x > c.start.x;
    const toTarget = angleOf(target.src.position.x - c.src.position.x, target.src.position.y - c.src.position.y);
    const off = angleDiff(toTarget, c.src.facingDeg);
    if (off > 60) {
      warnings.push(warn('eyeline', 'warning', c.src.refId, `${c.label} is turned ${Math.round(off)}° away from ${target.label}, whom they should be looking at.`, `${c.label} faces ${target.label}`, opts, { type: 'correct_blocking', label: 'Turn the character toward their eyeline', estimateUsd: null }));
    } else if (c.start.looks && c.start.looks !== 'camera' && c.start.looks !== 'away' && (c.start.looks === 'right') !== wantRight && target.start.visible) {
      warnings.push(warn('eyeline', 'warning', c.src.refId, `${c.label} looks screen-${c.start.looks} but ${target.label} is on the ${wantRight ? 'right' : 'left'} of frame.`, `${c.label} looks screen-${wantRight ? 'right' : 'left'}`, opts));
    }
  }

  // Walking through furniture or through another character.
  const solids = (opts.floorPlan ?? []).filter((it) => it.kind === 'furniture' || it.kind === 'wall' || it.kind === 'object');
  for (const c of entities) {
    if (!c.src.path.length) continue;
    const pts = [c.src.position, ...c.src.path];
    for (let k = 1; k < pts.length; k++) {
      const hit = solids.find((it) => segmentHitsRect(pts[k - 1]!, pts[k]!, it));
      if (hit) {
        warnings.push(warn('walk_through', 'critical', c.src.refId, `${c.label}’s movement passes through the ${hit.label || hit.kind}.`, `A path around the ${hit.label || hit.kind}`, opts, { type: 'correct_blocking', label: 'Redraw the movement path', estimateUsd: null }));
        break;
      }
      const other = chars.find((o) => o.id !== c.id && !o.src.path.length && distToSegmentM(o.src.position, pts[k - 1]!, pts[k]!, size) < BODY_WIDTH_M * 0.8);
      if (other) {
        warnings.push(warn('walk_through', 'critical', c.src.refId, `${c.label} walks through ${other.label}.`, `A path around ${other.label}`, opts, { type: 'correct_blocking', label: 'Redraw the movement path', estimateUsd: null }));
        break;
      }
    }
  }

  // The 180-degree line.
  const axis = opts.axis?.axis ?? inferAxis(plan);
  let cameraSide: 'left' | 'right' | null = null;
  if (axis) {
    cameraSide = axisSide(axis.a, axis.b, cam.position);
    const established = opts.axis?.establishedSide ?? null;
    const endSide = cam.endPosition ? axisSide(axis.a, axis.b, cam.endPosition) : cameraSide;
    const crossesDuringShot = Boolean(cam.endPosition) && endSide !== cameraSide;
    if (established && cameraSide && cameraSide !== established && !opts.axisCrossingAllowed && !crossesDuringShot) {
      warnings.push(
        warn('axis_crossing', 'critical', null, 'The camera is on the other side of the 180-degree line from the rest of the scene — characters will appear to swap sides.', `Camera on the ${established} side of the line`, opts, {
          type: 'correct_blocking',
          label: 'Move the camera back across the line, add a neutral shot, or mark the crossing as planned',
          estimateUsd: null,
        }),
      );
    }
  }

  const screenOrder = chars.filter((c) => c.start.visible).sort((a, b) => a.start.x - b.start.x).map((c) => c.refId ?? c.id);
  return { entities: entities.map(({ src: _src, ...rest }) => rest), screenOrder, warnings, cameraSide };
}

// ---------------------------------------------------------------------------
// Blocking → words for the video model
// ---------------------------------------------------------------------------

const sideWord = (x: number) => (x < 0.36 ? 'camera-left' : x > 0.64 ? 'camera-right' : 'centre frame');
const facingWords: Record<Facing, string> = {
  frontal: 'facing the camera',
  three_quarter: 'in three-quarter view',
  profile: 'in profile',
  three_quarter_back: 'turned mostly away (three-quarter back)',
  back: 'with their back to the camera',
};
const heightWords: Record<CameraHeight, string> = { ground: 'ground level', low: 'a low angle', eye: 'eye level', high: 'a high angle', overhead: 'directly overhead' };

/** Compiles a blocking plan into precise camera-relative direction. `names` maps entity ids to display names. */
export function blockingDirection(plan: Pick<BlockingPlanDoc, 'camera' | 'entities'>, analysis: BlockingAnalysis, names: (e: { id: string; refId: string | null; label: string }) => string): string[] {
  const lines: string[] = [];
  const cam = plan.camera;
  lines.push(`Camera at ${heightWords[cam.height]} with a ${Math.round(cam.lensMm)}mm lens${cam.endPosition ? ', moving during the shot' : ', holding its position'}.`);
  const visible = analysis.entities.filter((e) => e.kind === 'character' && (e.start.visible || e.end.visible));
  for (const e of visible) {
    const src = plan.entities.find((x) => x.id === e.id)!;
    const who = names(e);
    const parts = [`${who} is ${e.start.visible ? sideWord(e.start.x) : e.entry === 'left' ? 'off-screen left' : 'off-screen right'} in the ${e.start.layer}`];
    if (e.start.facing) parts.push(facingWords[e.start.facing]);
    if (src.posture !== 'standing') parts.push(src.posture);
    if (src.gaze.kind === 'camera') parts.push('looking into the lens');
    else if (src.gaze.kind === 'entity' && src.gaze.targetId) {
      const t = analysis.entities.find((x) => x.id === src.gaze.targetId || x.refId === src.gaze.targetId);
      if (t) parts.push(`looking at ${names(t)}${e.start.looks === 'left' || e.start.looks === 'right' ? ` (eyeline screen-${e.start.looks})` : ''}`);
    }
    let line = parts.join(', ');
    if (e.travel === 'left_to_right' || e.travel === 'right_to_left') line += `; moves ${e.travel === 'left_to_right' ? 'from left to right' : 'from right to left'} across the frame${e.exit ? ` and exits frame ${e.exit}` : ` to ${sideWord(e.end.x)}`}`;
    else if (e.travel === 'toward_camera') line += '; walks toward the camera';
    else if (e.travel === 'away_from_camera') line += '; walks away from the camera';
    if (e.entry) line += ` (enters from frame ${e.entry})`;
    lines.push(`${line}.`);
  }
  const order = analysis.screenOrder.map((id) => {
    const e = analysis.entities.find((x) => x.refId === id || x.id === id);
    return e ? names(e) : id;
  });
  if (order.length >= 2) lines.push(`Left-to-right order on screen: ${order.join(', ')}. Keep this order for the whole shot; nobody swaps sides.`);
  const protectedFaces = plan.entities.filter((e) => e.kind === 'character' && e.protectedVisibility === 'face' && !e.occlusionAllowed);
  const speakers = plan.entities.filter((e) => e.kind === 'character' && e.speaking);
  if (speakers.length) lines.push(`Keep ${speakers.map((s) => names({ id: s.id, refId: s.refId, label: s.label })).join(' and ')} fully visible with the face unobstructed while speaking; no one passes in front of a speaker.`);
  else if (protectedFaces.length) lines.push(`Keep ${protectedFaces.map((s) => names({ id: s.id, refId: s.refId, label: s.label })).join(' and ')} clearly visible.`);
  const allowed = plan.entities.filter((e) => e.kind === 'character' && e.occlusionAllowed);
  for (const a of allowed) lines.push(`${names({ id: a.id, refId: a.refId, label: a.label })} may be partly out of focus or cut by frame edge in the foreground (deliberate framing).`);
  if (visible.length >= 2) lines.push('Characters keep a natural distance: bodies never overlap, merge or pass through each other or the furniture.');
  return lines;
}

/** Simple top-down default blocking for a coverage type (camera placed on the established side). */
export function coverageCamera(type: string, a: StagePoint, b: StagePoint | null, side: 'left' | 'right' | null): { position: StagePoint; directionDeg: number; lensMm: number } {
  const mid = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a;
  const axisDeg = b ? angleOf(b.x - a.x, b.y - a.y) : 0;
  // Perpendicular pointing to the chosen side of the a→b line.
  const perp = axisDeg + (side === 'left' ? -90 : 90);
  const place = (from: StagePoint, deg: number, dist: number) => {
    const v = dirVector(deg);
    return { x: Math.max(0.02, Math.min(0.98, from.x + (v.x * dist) / DEFAULT_PLAN_SIZE_M)), y: Math.max(0.02, Math.min(0.98, from.y + (v.y * dist) / DEFAULT_PLAN_SIZE_M)) };
  };
  const look = (pos: StagePoint, target: StagePoint) => angleOf(target.x - pos.x, target.y - pos.y);
  // Of two candidate positions, keep the one on the established side of the a→b line.
  const onSide = (cands: StagePoint[]) => (b && side ? cands.find((p) => axisSide(a, b, p) === side) ?? cands[0]! : cands[0]!);
  switch (type) {
    case 'establishing':
    case 'environment': {
      const pos = place(mid, perp, 7);
      return { position: pos, directionDeg: look(pos, mid), lensMm: 24 };
    }
    case 'master':
    case 'two_shot': {
      const pos = place(mid, perp, type === 'master' ? 5 : 3.2);
      return { position: pos, directionDeg: look(pos, mid), lensMm: type === 'master' ? 28 : 35 };
    }
    case 'over_the_shoulder': {
      // Behind A's shoulder looking at B, still on the chosen side of the line.
      const target = b ?? a;
      const behind = b ? angleOf(a.x - b.x, a.y - b.y) : 180;
      const pos = onSide([place(a, behind + 20, 0.8), place(a, behind - 20, 0.8)]);
      return { position: pos, directionDeg: look(pos, target), lensMm: 50 };
    }
    case 'close_up':
    case 'clean_single':
    case 'reaction':
    case 'medium': {
      const target = type === 'reaction' && b ? b : a;
      const other = target === a ? b : a;
      const toward = other ? angleOf(other.x - target.x, other.y - target.y) : 180;
      const dist = type === 'medium' ? 2.4 : 1.6;
      const pos = onSide([place(target, toward + 35, dist), place(target, toward - 35, dist)]);
      return { position: pos, directionDeg: look(pos, target), lensMm: type === 'close_up' ? 85 : type === 'medium' ? 50 : 65 };
    }
    default: {
      const pos = place(mid, perp, 2.5);
      return { position: pos, directionDeg: look(pos, mid), lensMm: 50 };
    }
  }
}
