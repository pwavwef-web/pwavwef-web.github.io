import { col, db, FieldValue } from './firebase';

export interface DerivedTakeInput {
  projectId: string;
  shotId: string;
  jobId: string;
  assetId: string;
  /** What was done, shown as the take's prompt. */
  prompt: string;
  params: Record<string, unknown>;
  parentTakeId: string | null;
  takeLabel: string;
  productionId: string | null;
}

/**
 * A derived version of a take (repair edit, colour match, screen composite, reframe) becomes a new take
 * of the shot, so it can be compared, selected and approved. The take it came from is never changed.
 * Returns null when the shot no longer exists.
 */
export async function recordDerivedTake(input: DerivedTakeInput): Promise<string | null> {
  const shotRef = col.projects().doc(input.projectId).collection('shots').doc(input.shotId);
  const takeRef = shotRef.collection('takes').doc();
  const created = await db.runTransaction(async (tx) => {
    const shot = await tx.get(shotRef);
    if (!shot.exists) return false;
    const index = Number(shot.get('takeCount') ?? 0) + 1;
    tx.set(takeRef, {
      index,
      jobId: input.jobId,
      assetId: input.assetId,
      status: 'completed',
      prompt: input.prompt,
      params: input.params,
      interactionId: null,
      parentTakeId: input.parentTakeId,
      label: `Take ${index} · ${input.takeLabel}`,
      rating: 0,
      notes: '',
      approved: false,
      productionId: input.productionId,
      versionId: null,
      quality: { verdict: 'pending', overall: null, reportId: null },
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(shotRef, { takeCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
  return created ? takeRef.id : null;
}
