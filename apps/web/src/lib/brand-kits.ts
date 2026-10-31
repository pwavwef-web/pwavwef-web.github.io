import { useMemo } from 'react';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { normalizeBrandKit, type BrandKitDoc, type BrandKitInput, type BrandKitRequestInput } from '@az-studio/shared';
import { api } from './api';
import { useDoc, useQuery, type WithId } from './data';
import { db } from './firebase';
import { useUid } from './session';

/**
 * Brand kits in the browser: read live from `brandKits` (owner-read rule), written only through the `brandKits` API
 * action (files checked, edited prices and contacts re-confirmed, revision conflicts refused).
 */

export function brandKitCall<T = unknown>(payload: BrandKitRequestInput): Promise<T> {
  return api<T, 'brandKits'>('brandKits', payload as never);
}

export type StoredKit = WithId<BrandKitDoc> & { kit: BrandKitInput };

const withKit = (d: WithId<BrandKitDoc>): StoredKit => ({ ...d, kit: normalizeBrandKit(d) });

export function useBrandKits() {
  const uid = useUid();
  const live = useQuery<BrandKitDoc>(() => (uid ? query(collection(db, 'brandKits'), where('ownerUid', '==', uid), orderBy('updatedAt', 'desc')) : null), [uid]);
  const data = useMemo(() => live.data.map(withKit), [live.data]);
  return { ...live, data };
}

export function useBrandKit(kitId: string | null | undefined) {
  const live = useDoc<BrandKitDoc>(kitId ? `brandKits/${kitId}` : null);
  const data = useMemo(() => (live.data ? withKit(live.data) : null), [live.data]);
  return { ...live, data };
}
