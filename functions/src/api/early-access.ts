import type { ApiRequest } from '@az-studio/shared';
import type { Owner } from '../lib/owner';
import { deleteEarlyAccess, listEarlyAccess, setEarlyAccessPaused } from '../lib/early-access';

type Payload = Extract<ApiRequest, { action: 'earlyAccess' }>['payload'];

/** Owner-only administration of the public early-access list (azsApi has already checked the owner). */
export async function earlyAccess(_owner: Owner, payload: Payload) {
  switch (payload.op) {
    case 'list':
      return listEarlyAccess();
    case 'delete':
      return { deleted: await deleteEarlyAccess(payload.id) };
    case 'pause':
      return { paused: await setEarlyAccessPaused(payload.paused) };
  }
}
