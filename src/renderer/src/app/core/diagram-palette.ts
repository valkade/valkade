/** Diagram/chart colors derived from the app theme tokens (pure; see `DiagramThemeService`). */
import type { ThemeColorResolver } from '@shared/theme';

/** Opaque `#rrggbb` colors taken from the app theme for diagrams and charts. */
export interface DiagramPalette {
  /** Diagram canvas background (`--t-code-bg`). */
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  /** Gridlines and other hairlines; softer than {@link border}. */
  grid: string;
  primary: string;
  /** Node fill: the primary accent tinted into the surface. */
  primaryFill: string;
  secondaryFill: string;
  noteFill: string;
  noteBorder: string;
  /** Distinct accents for chart series, pie slices and diagram color scales. */
  series: readonly string[];
}

/** How diagrams are colored; equal `key`s render identically (part of the render cache key). */
export interface DiagramTheme {
  key: string;
  dark: boolean;
  /** Null when the theme could not be resolved: Mermaid's stock dark/default theme is used. */
  palette: DiagramPalette | null;
}

/** Mermaid's stock theme for a mode (no app colors). */
export function stockDiagramTheme(dark: boolean): DiagramTheme {
  return { key: dark ? 'dark' : 'default', dark, palette: null };
}

const SERIES_TOKENS = [
  '--t-primary',
  '--t-hljs-string',
  '--t-hljs-keyword',
  '--t-hljs-number',
  '--t-hljs-function',
  '--t-hljs-class',
  '--t-log-level-warning',
  '--t-log-level-error',
];

function channels(hex: string): [number, number, number, number] | null {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!m) {
    return null;
  }
  const n = Number.parseInt(m[1]!, 16);
  const alpha = m[2] ? Number.parseInt(m[2], 16) / 255 : 1;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Series colors closer than this (RGB distance) read as the same color in a chart legend. */
const MIN_SERIES_DISTANCE = 48;

function distance(a: string, b: string): number {
  const x = channels(a);
  const y = channels(b);
  return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : Number.POSITIVE_INFINITY;
}

/** Keeps colors in order, dropping any too close to one already kept (themes reuse accents). */
export function distinctColors(colors: readonly string[]): string[] {
  const kept: string[] = [];
  for (const color of colors) {
    if (kept.every((other) => distance(color, other) >= MIN_SERIES_DISTANCE)) {
      kept.push(color);
    }
  }
  return kept;
}

/** Composite a possibly translucent `#rrggbb[aa]` over an opaque backdrop. */
export function flattenColor(color: string, backdrop: string): string | null {
  const fg = channels(color);
  const bg = channels(backdrop);
  if (!fg || !bg) {
    return null;
  }
  const a = fg[3];
  return toHex(fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a));
}

/** `#rrggbb` with an alpha channel, for translucent chart fills. */
export function withAlpha(hex: string, alpha: number): string {
  const c = channels(hex);
  if (!c) {
    return hex;
  }
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return `${toHex(c[0], c[1], c[2])}${a}`;
}

/**
 * Builds the diagram theme from the live theme tokens. `resolve` maps any CSS color expression to
 * `#rrggbb[aa]` (see `createDomColorResolver`); missing core tokens fall back to the stock theme.
 */
export function resolveDiagramTheme(dark: boolean, resolve: ThemeColorResolver): DiagramTheme {
  const base = dark ? '#000000' : '#ffffff';
  const page = flattenColor(resolve('var(--t-bg)') ?? '', base) ?? base;
  const background = flattenColor(resolve('var(--t-code-bg)') ?? '', page);
  const surface = flattenColor(resolve('var(--t-bg-surface)') ?? '', page);
  const opaque = (expression: string): string | null =>
    background ? flattenColor(resolve(expression) ?? '', background) : null;
  const text = opaque('var(--t-fg)');
  const primary = opaque('var(--t-primary)');
  if (!background || !surface || !text || !primary) {
    return stockDiagramTheme(dark);
  }
  const muted = opaque('var(--t-text-muted)') ?? text;
  const border = opaque('var(--t-border)') ?? muted;
  const warning = opaque('var(--t-log-level-warning)') ?? primary;
  const series = distinctColors(SERIES_TOKENS.map((token) => opaque(`var(${token})`)).filter((c): c is string => !!c));
  const tint = (color: string, percent: number): string =>
    opaque(`color-mix(in srgb, ${color} ${percent}%, ${surface})`) ?? surface;
  const palette: DiagramPalette = {
    background,
    surface,
    text,
    muted,
    border,
    grid: opaque(`color-mix(in srgb, ${border} 55%, ${background})`) ?? border,
    primary,
    primaryFill: tint(primary, 22),
    secondaryFill: tint(series[1] ?? muted, 22),
    noteFill: tint(warning, 16),
    noteBorder: warning,
    series: series.length ? series : [primary],
  };
  return { key: `${dark ? 'dark' : 'light'}:${JSON.stringify(palette)}`, dark, palette };
}
