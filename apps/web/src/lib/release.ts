/** The release this web build belongs to (stamped by scripts/deploy.mjs; 'dev' for local builds). */
export const WEB_RELEASE = {
  version: (import.meta.env.VITE_AZS_RELEASE as string | undefined) || 'dev',
  commit: (import.meta.env.VITE_AZS_COMMIT as string | undefined) || null,
};

/** True when the open tab runs a different release from the deployed functions (an older tab, or a half deploy). */
export function releaseMismatch(server: { version: string; commit: string | null } | undefined): boolean {
  if (!server || server.version === 'dev' || WEB_RELEASE.version === 'dev') return false;
  return server.version !== WEB_RELEASE.version;
}
