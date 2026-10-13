import { logger } from 'firebase-functions';
import { HttpsError } from 'firebase-functions/v2/https';
import type { CharacterDoc } from '@az-studio/shared';
import { characterCoverRef } from '../lib/bible-cover';
import { queueBibleCover } from '../lib/bible-cover-jobs';

export async function handleBibleCoverChange(projectId: string, before: CharacterDoc | undefined, after: CharacterDoc | undefined): Promise<void> {
  if (before && after && characterCoverRef(before) === characterCoverRef(after) && before.realPerson === after.realPerson && before.consentConfirmed === after.consentConfirmed && before.name === after.name && before.appearance === after.appearance && before.wardrobe === after.wardrobe) return;
  try {
    await queueBibleCover(projectId);
  } catch (e) {
    // Incomplete references and spending caps are expected while a Bible is being developed.
    if (e instanceof HttpsError && ['failed-precondition', 'resource-exhausted'].includes(e.code)) {
      logger.info('Bible cover waiting', {projectId, reason: e.message});
      return;
    }
    throw e;
  }
}
