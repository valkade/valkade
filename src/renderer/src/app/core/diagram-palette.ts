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
  /** {@link SCALE_SIZE} accents for per-section colors (timeline, mindmap, kanban, git graph…). */
  scale: readonly string[];
  /** {@link scale} tinted into the surface: section fills that keep {@link text} readable. */
  scaleFills: readonly string[];
}

/** Section colors Mermaid themes define (`cScale0`…`cScale11`). */
export const SCALE_SIZE = 12;

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

/** `#rrggbb` with its HSL hue turned by `degrees` (saturation and lightness kept). */
export function rotateHue(hex: string, degrees: number): string {
  const c = channels(hex);
  if (!c) {
    return hex;
  }
  const [r, g, b] = [c[0] / 255, c[1] / 255, c[2] / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    return toHex(c[0], c[1], c[2]);
  }
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const hue = (((h * 60 + degrees) % 360) + 360) % 360;
  const k = (n: number) => (n + hue / 30) % 12;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return toHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

/** Hue turns tried, in order, when the theme has fewer distinct accents than {@link SCALE_SIZE}. */
const SCALE_HUE_STEPS = [60, 180, 300, 120, 240, 30, 210, 90, 270, 150, 330];

/**
 * {@link SCALE_SIZE} section accents: the theme's series first, then hue turns of the primary that
 * stay distinct; a theme too gray to yield enough distinct hues repeats its accents.
 */
export function sectionScale(series: readonly string[], primary: string): string[] {
  const kept = distinctColors([...series, ...SCALE_HUE_STEPS.map((step) => rotateHue(primary, step))]);
  const scale = kept.length ? kept : [primary];
  return Array.from({ length: SCALE_SIZE }, (_, i) => scale[i % scale.length]!);
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
  const scale = sectionScale(series, primary);
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
    scale,
    scaleFills: scale.map((color) => tint(color, 35)),
  };
  return { key: `${dark ? 'dark' : 'light'}:${JSON.stringify(palette)}`, dark, palette };
}
