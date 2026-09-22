/** Presenter mode is a per-device preference for screen recordings (see components/presenter.tsx). */
const KEY = 'azs:presenter';
export const PRESENTER_EVENT = 'azs:presenter';

export function presenterEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setPresenterEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: the toggle still applies to this page.
  }
  window.dispatchEvent(new CustomEvent(PRESENTER_EVENT, { detail: on }));
}
