/** Prefixes read in order: the current one, then the legacy ones (dropped in v0.7). */
const ENV_PREFIXES = ['VALKADE_', 'CLARA_', 'NEMO_'] as const;

/**
 * Prefer ``VALKADE_{suffix}``; fall back to legacy ``CLARA_{suffix}`` then ``NEMO_{suffix}``.
 * Pass the suffix without prefix, e.g. ``envValkade('PYTHON')`` reads VALKADE_PYTHON, CLARA_PYTHON, NEMO_PYTHON.
 */
export function envValkade(suffix: string): string | undefined {
  for (const prefix of ENV_PREFIXES) {
    const value = process.env[`${prefix}${suffix}`]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Set ``VALKADE_{suffix}`` in this process and drop the legacy spellings, so a stale
 * ``CLARA_``/``NEMO_`` value can't come back through the fallback. Empty or undefined clears all three.
 */
export function setEnvValkade(suffix: string, value: string | undefined): void {
  for (const prefix of ENV_PREFIXES) delete process.env[`${prefix}${suffix}`];
  if (value) process.env[`VALKADE_${suffix}`] = value;
}

/** The legacy names of ``suffix``, for removing them from a child's inherited env. */
export function legacyEnvKeys(suffix: string): string[] {
  return ENV_PREFIXES.slice(1).map((prefix) => `${prefix}${suffix}`);
}
