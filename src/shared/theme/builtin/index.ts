import type { ValkAdeThemeDocument, ThemeMode } from '../theme-document';
import { VALKADE_DARK_VALKYRIE_GOLD_THEME } from './valkade-dark-valkyrie-gold';
import { VALKADE_DARK_THEME } from './valkade-dark';
import { VALKADE_DARK_CADMIUM_LANTERN_THEME } from './valkade-dark-cadmium-lantern';
import { VALKADE_DARK_CADMIUM_ORANGE_THEME } from './valkade-dark-cadmium-orange';
import { VALKADE_LIGHT_THEME } from './valkade-light';
import { VALKADE_LIGHT_IRIS_THEME } from './valkade-light-iris';
import { VALKADE_LIGHT_OCHRE_THEME } from './valkade-light-ochre';

export { VALKADE_DARK_VALKYRIE_GOLD_THEME } from './valkade-dark-valkyrie-gold';
export { VALKADE_DARK_THEME } from './valkade-dark';
export { VALKADE_DARK_CADMIUM_LANTERN_THEME } from './valkade-dark-cadmium-lantern';
export { VALKADE_DARK_CADMIUM_ORANGE_THEME } from './valkade-dark-cadmium-orange';
export { VALKADE_LIGHT_THEME } from './valkade-light';
export { VALKADE_LIGHT_IRIS_THEME } from './valkade-light-iris';
export { VALKADE_LIGHT_OCHRE_THEME } from './valkade-light-ochre';

/** @deprecated Use {@link VALKADE_DARK_THEME}. Kept for one release after the ValkAde rename. */
export const CLARA_DARK_THEME = VALKADE_DARK_THEME;
/** @deprecated Use {@link VALKADE_DARK_CADMIUM_LANTERN_THEME}. */
export const CLARA_DARK_CADMIUM_LANTERN_THEME = VALKADE_DARK_CADMIUM_LANTERN_THEME;
/** @deprecated Use {@link VALKADE_DARK_CADMIUM_ORANGE_THEME}. */
export const CLARA_DARK_CADMIUM_ORANGE_THEME = VALKADE_DARK_CADMIUM_ORANGE_THEME;
/** @deprecated Use {@link VALKADE_LIGHT_THEME}. */
export const CLARA_LIGHT_THEME = VALKADE_LIGHT_THEME;
/** @deprecated Use {@link VALKADE_LIGHT_IRIS_THEME}. */
export const CLARA_LIGHT_IRIS_THEME = VALKADE_LIGHT_IRIS_THEME;
/** @deprecated Use {@link VALKADE_LIGHT_OCHRE_THEME}. */
export const CLARA_LIGHT_OCHRE_THEME = VALKADE_LIGHT_OCHRE_THEME;

/** First-run selection and fallback when a theme id cannot be resolved. */
export const DEFAULT_THEME: ValkAdeThemeDocument = VALKADE_DARK_VALKYRIE_GOLD_THEME;

/** Bundled, read-only themes. Users duplicate these to start their own. */
export const BUILTIN_THEMES: readonly ValkAdeThemeDocument[] = [
  VALKADE_DARK_VALKYRIE_GOLD_THEME,
  VALKADE_DARK_THEME,
  VALKADE_DARK_CADMIUM_LANTERN_THEME,
  VALKADE_DARK_CADMIUM_ORANGE_THEME,
  VALKADE_LIGHT_THEME,
  VALKADE_LIGHT_IRIS_THEME,
  VALKADE_LIGHT_OCHRE_THEME,
];

export const DEFAULT_THEME_ID = DEFAULT_THEME.id;

export const BUILTIN_THEME_IDS: readonly string[] = BUILTIN_THEMES.map((t) => t.id);

/**
 * Retired theme ids → built-in replacement. Every entry points straight at its final id (no
 * chains). Exact ids only: a user theme such as `clara-dark-copy` is the user's own.
 */
export const LEGACY_THEME_ID_MAP: Readonly<Record<string, string>> = {
  // pre-engine / former default
  default: VALKADE_DARK_VALKYRIE_GOLD_THEME.id,
  woodland: VALKADE_DARK_VALKYRIE_GOLD_THEME.id,
  'dark-classical': VALKADE_DARK_VALKYRIE_GOLD_THEME.id,
  classical: VALKADE_LIGHT_THEME.id,
  // Clara → ValkAde (v0.6)
  'clara-dark': VALKADE_DARK_THEME.id,
  'clara-dark-cadmium-lantern': VALKADE_DARK_CADMIUM_LANTERN_THEME.id,
  'clara-dark-cadmium-orange': VALKADE_DARK_CADMIUM_ORANGE_THEME.id,
  'clara-light': VALKADE_LIGHT_THEME.id,
  'clara-light-iris': VALKADE_LIGHT_IRIS_THEME.id,
  'clara-light-ochre': VALKADE_LIGHT_OCHRE_THEME.id,
};

export function isBuiltInThemeId(id: unknown): id is string {
  return typeof id === 'string' && BUILTIN_THEME_IDS.indexOf(id) >= 0;
}

export function findBuiltInTheme(id: string): ValkAdeThemeDocument | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}

/** Base built-in for a mode: first paint, unknown-id fallback, and tokens a partial theme omits. */
export function builtInThemeForMode(mode: ThemeMode): ValkAdeThemeDocument {
  return mode === 'light' ? VALKADE_LIGHT_THEME : DEFAULT_THEME;
}

/** Map a legacy id to its replacement; unknown ids pass through unchanged. */
export function resolveLegacyThemeId(id: string | null | undefined): string {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (!trimmed) {
    return DEFAULT_THEME_ID;
  }
  return LEGACY_THEME_ID_MAP[trimmed] ?? trimmed;
}
