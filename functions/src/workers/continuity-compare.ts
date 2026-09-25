import type { Part } from '@google/genai';
import { WARNING_KINDS, type ContinuitySnapshotDoc, type ContinuityWarning, type ContinuityWarningKind, type JobDoc, type WarningSeverity } from '@az-studio/shared';
import { col, db, FieldValue, gsUri } from '../lib/firebase';
import { fail } from '../lib/errors';
import { logInteraction } from '../lib/interactions';
import { progress, transition } from '../lib/jobs';
import { callReasoning, usageFor } from './text';
import { CONTINUITY_COMPARE_SCHEMA } from './text-tasks';

interface CompareParams {
  items: { shotId: string; title: string; assetId: string; storagePath: string; durationSec: number }[];
}

interface CompareJson {
  summary?: string;
  shots?: { index?: number; consistent?: boolean; note?: string }[];
  issues?: { fromIndex?: number; toIndex?: number; kind?: string; severity?: string; subject?: string; expected?: string; detected?: string; message?: string }[];
}

/**
 * Cross-shot continuity: the approved (or selected) takes of several shots are watched together, in
 * story order, and every difference that breaks continuity between them is reported and recorded on
 * the later shot's continuity snapshot (it never changes canonical state).
 */
export async function runContinuityCompareJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as CompareParams;
  if (!job.projectId) fail('invalid_request', 'A continuity comparison needs a project.');
  if (!(await transition(job.id, 'generating', { stage: `Comparing ${p.items.length} shots`, progress: 0.1, lease: { until: Date.now() + 15 * 60_000 } }))) return;
  // Up to ten videos per request; longer lists are compared in overlapping groups so every cut is seen.
  const groups: (typeof p.items)[] = [];
  for (let i = 0; i < p.items.length; i += 9) groups.push(p.items.slice(i, Math.min(p.items.length, i + 10)));
  const issues: (NonNullable<CompareJson['issues']>[number] & { fromShot: string; toShot: string })[] = [];
  const summaries: string[] = [];
  for (const [g, items] of groups.entries()) {
    await progress(job.id, `Watching shots ${g * 9 + 1}–${g * 9 + items.length}`, 0.15 + (0.6 * g) / groups.length);
    const parts: Part[] = [];
    items.forEach((it, i) => {
      parts.push({ text: `Clip ${i}: “${it.title}” (${it.durationSec.toFixed(1)} s)` });
      parts.push({ fileData: { fileUri: gsUri(it.storagePath), mimeType: 'video/mp4' }, videoMetadata: { fps: 1 } });
    });
    parts.push({
      text: 'These clips are consecutive shots of one film, in story order. As a continuity supervisor, compare each clip with the ones before it: character identity, costume, hair and accessories; props (which hand holds what, open/closed, full/empty); the set (architecture, furniture, wall colours, background objects); lighting, time of day and weather; screen direction, eyelines and the camera’s side of the 180-degree line; colour and exposure; text on screens and signs (mirrored or changed). Report only real differences you can see, naming the clips involved; do not report intentional changes that the action explains (for example someone picks something up on screen).',
    });
    const r = await callReasoning(parts, { systemInstruction: 'You are a meticulous film continuity supervisor. Return only JSON matching the schema.', responseJsonSchema: CONTINUITY_COMPARE_SCHEMA }, 'MEDIUM');
    await usageFor(job, r, 'text', false);
    await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: r.modelId, api: 'generateContent', request: { task: 'continuity_compare', clips: items.length }, response: { usage: r.res.usageMetadata ?? null }, latencyMs: r.latencyMs });
    const json = (r.json ?? {}) as CompareJson;
    if (json.summary) summaries.push(json.summary);
    for (const x of json.issues ?? []) {
      const from = items[x.fromIndex ?? -1];
      const to = items[x.toIndex ?? -1];
      if (!from || !to || from.shotId === to.shotId) continue;
      if (!issues.some((y) => y.fromShot === from.shotId && y.toShot === to.shotId && y.message === x.message)) issues.push({ ...x, fromShot: from.shotId, toShot: to.shotId });
    }
  }
  // Record on the later shot of each pair (the earlier one stays the reference).
  const byShot = new Map<string, ContinuityWarning[]>();
  for (const x of issues) {
    const kind = ((WARNING_KINDS as readonly string[]).includes(String(x.kind)) ? x.kind : 'background') as ContinuityWarningKind;
    const severity: WarningSeverity = x.severity === 'critical' ? 'critical' : x.severity === 'info' ? 'info' : 'warning';
    const list = byShot.get(x.toShot) ?? [];
    list.push({ id: `w_cmp_${kind}_${list.length}`, kind, severity, subjectId: null, message: `${(x.message ?? '').slice(0, 400)}${x.subject ? ` (${x.subject.slice(0, 80)})` : ''}`, expected: (x.expected ?? '').slice(0, 200), detected: (x.detected ?? '').slice(0, 200) || null, difference: null, proposedRepair: null, affects: { previousShotId: x.fromShot, nextShotId: null }, source: 'compare', status: 'open' });
    byShot.set(x.toShot, list);
  }
  const pref = col.projects().doc(job.projectId!);
  for (const it of p.items) {
    const ref = pref.collection('continuitySnapshots').doc(it.shotId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const cur = snap.data() as ContinuitySnapshotDoc;
      // Replace this shot's earlier comparison findings with the new ones.
      const warnings = [...cur.continuityWarnings.filter((w) => w.source !== 'compare'), ...(byShot.get(it.shotId) ?? [])];
      tx.set(ref, { continuityWarnings: warnings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      const open = warnings.filter((w) => w.status === 'open' && w.severity !== 'info').length;
      tx.set(pref.collection('shots').doc(it.shotId), { continuityStatus: { status: cur.status, openWarnings: open, updatedAt: Date.now() } }, { merge: true });
    });
  }
  const critical = issues.filter((x) => x.severity === 'critical').length;
  await transition(job.id, 'completed', {
    stage: issues.length ? `${issues.length} continuity difference${issues.length === 1 ? '' : 's'} between shots${critical ? ` (${critical} critical)` : ''}` : 'No continuity breaks between these shots',
    result: { text: summaries.join('\n\n').slice(0, 2000), data: { issues: issues.slice(0, 60), shots: p.items.map((i) => i.shotId) } },
  });
}
