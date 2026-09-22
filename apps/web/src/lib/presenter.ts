import { useCallback, useEffect, useState } from 'react';
import { toMillis } from '@az-studio/shared';

/** Presenter mode is a per-device preference for screen recordings (see components/presenter.tsx). */
const KEY = 'azs:presenter';
const SINCE_KEY = 'azs:presenter-since';
export const PRESENTER_EVENT = 'azs:presenter';

export function presenterEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** When presenter mode was switched on; anything created earlier is treated as private. */
export function presenterSince(): number | null {
  try {
    if (localStorage.getItem(KEY) !== '1') return null;
    const v = Number(localStorage.getItem(SINCE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function setPresenterEnabled(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(KEY, '1');
      localStorage.setItem(SINCE_KEY, String(Date.now()));
    } else {
      localStorage.removeItem(KEY);
      localStorage.removeItem(SINCE_KEY);
    }
  } catch {
    // Storage unavailable: the toggle still applies to this page.
  }
  window.dispatchEvent(new CustomEvent(PRESENTER_EVENT, { detail: on }));
}

/**
 * In presenter mode, projects, assets and jobs created before the session began are private:
 * returns `{ 'data-private': '' }` for them so recordings blur earlier work.
 */
export function usePresenterPrivacy(): (createdAt: unknown) => { 'data-private'?: '' } {
  const [since, setSince] = useState(presenterSince);
  useEffect(() => {
    const sync = () => setSince(presenterSince());
    window.addEventListener(PRESENTER_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PRESENTER_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return useCallback(
    (createdAt: unknown) => {
      if (since === null) return {};
      const ms = toMillis(createdAt as Parameters<typeof toMillis>[0]);
      // Items still waiting for their server timestamp were just created, so they stay visible.
      return ms !== null && ms < since ? { 'data-private': '' as const } : {};
    },
    [since],
  );
}
