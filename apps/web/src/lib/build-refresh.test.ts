import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isStaleChunkError, reloadForNewBuild } from './build-refresh';

describe('isStaleChunkError', () => {
  it('recognises chunk failures from Chromium, Firefox and Safari', () => {
    expect(isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: https://az-studio.web.app/assets/MusicStudio-DGoy9q0-.js'))).toBe(true);
    expect(isStaleChunkError(new TypeError('error loading dynamically imported module: https://x/assets/a.js'))).toBe(true);
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isStaleChunkError('Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".')).toBe(true);
  });

  it('ignores ordinary errors', () => {
    expect(isStaleChunkError(new Error('Missing or insufficient permissions.'))).toBe(false);
    expect(isStaleChunkError({ message: 'Failed to fetch dynamically imported module' })).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
  });
});

describe('reloadForNewBuild', () => {
  beforeEach(() => sessionStorage.clear());

  it('reloads once, then refuses to loop within the guard window', () => {
    const reload = vi.fn();
    expect(reloadForNewBuild(1_000_000, reload)).toBe(true);
    expect(reloadForNewBuild(1_010_000, reload)).toBe(false);
    expect(reloadForNewBuild(1_040_000, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
