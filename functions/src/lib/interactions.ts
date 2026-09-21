import { logger } from 'firebase-functions';
import { col, FieldValue } from './firebase';

export interface InteractionLog {
  uid: string;
  projectId: string | null;
  jobId: string;
  modelId: string;
  api: 'generateContent' | 'interactions';
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  latencyMs: number;
  interactionId?: string | null;
}

/** Records a sanitised summary of a model call (prompts and parameters, never media bytes). */
export async function logInteraction(entry: InteractionLog): Promise<void> {
  const { uid, ...rest } = entry;
  try {
    await col.interactions().add({ ownerUid: uid, ...rest, createdAt: FieldValue.serverTimestamp() });
  } catch (e) {
    logger.warn('interaction log failed', { jobId: entry.jobId, error: String(e) });
  }
}
