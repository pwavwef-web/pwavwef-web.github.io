/** Rebuilds plain objects with sorted keys (arrays keep their order) so equal data serialises equally. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => [k, canonical(obj[k])]),
    );
  }
  return value;
}

/**
 * Deep equality for Firestore-shaped data. Snapshots do not keep a stable key order (local writes and
 * server reads can differ), so comparing JSON.stringify output directly reports phantom changes.
 */
export function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
