/**
 * After a deploy, a tab opened on the previous build can request lazy chunks that Hosting no longer
 * serves (the SPA fallback answers with index.html). Reload once to pick up the new build; a short
 * guard prevents reload loops when a chunk is genuinely broken.
 */
const RELOAD_KEY = 'azs:build-reload-at';
const GUARD_MS = 30_000;
const STALE_CHUNK = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Expected a JavaScript[- ]or[- ]Wasm module script|Unable to preload CSS/i;

export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return STALE_CHUNK.test(message);
}

/** Reloads the page unless it already did so moments ago. Returns whether a reload was started. */
export function reloadForNewBuild(now = Date.now(), reload = () => window.location.reload()): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (now - last < GUARD_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false; // Without storage there is no loop guard; the error screen offers a manual reload.
  }
  reload();
  return true;
}

/** The original error still reaches the route error screen, which explains the reload. */
export function watchForNewBuilds(): void {
  window.addEventListener('vite:preloadError', () => {
    reloadForNewBuild();
  });
}
