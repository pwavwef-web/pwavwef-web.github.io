/**
 * The release this function bundle belongs to, stamped by scripts/deploy.mjs into functions/.env.<project>
 * (a tagged commit, see scripts/release.mjs). Emulators and local runs report 'dev'.
 */
export const RELEASE = {
  version: process.env.AZS_RELEASE || 'dev',
  commit: process.env.AZS_COMMIT || null,
} as const;
