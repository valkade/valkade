import { describe, expect, it } from 'vitest';
import {
  SCALE_SIZE,
  distinctColors,
  flattenColor,
  resolveDiagramTheme,
  rotateHue,
  sectionScale,
  stockDiagramTheme,
  withAlpha,
} from './diagram-palette';

/** Token table standing in for `createDomColorResolver` (jsdom cannot resolve `var()` colors). */
function resolverFor(tokens: Record<string, string>) {
  return (expression: string): string | null => {
    const token = /^var\((--[\w-]+)\)$/.exec(expression)?.[1];
    if (token) {
      return tokens[token] ?? null;
    }
    // color-mix(in srgb, A P%, B): mix the two hex colors linearly, like the browser would.
    const mix = /^color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, (#[0-9a-f]{6})\)$/i.exec(expression);
    if (mix) {
      const p = Number(mix[2]) / 100;
      const a = Number.parseInt(mix[1]!.slice(1), 16);
      const b = Number.parseInt(mix[3]!.slice(1), 16);
      const ch = (n: number, s: number) => ((n >> s) & 255);
      const c = [16, 8, 0].map((s) => Math.round(ch(a, s) * p + ch(b, s) * (1 - p)));
      return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }
    return null;
  };
}

const DARK_TOKENS = {
  '--t-bg': '#0f0e0c',
  '--t-code-bg': '#0f0e0c',
  '--t-bg-surface': '#1a1814',
  '--t-fg': '#f6f2e9',
  '--t-text-muted': '#f6f2e980',
  '--t-border': '#f6f2e933',
  '--t-primary': '#f5a826',
  '--t-hljs-string': '#a9d48b',
  // Nearly the primary accent: must not become a second, indistinguishable series color.
  '--t-hljs-keyword': '#f3aa2a',
  '--t-hljs-number': '#6ec9c4',
  '--t-log-level-warning': '#ffde82',
};

describe('diagram palette', () => {
  it('flattens translucent colors onto their backdrop', () => {
    expect(flattenColor('#ffffff80', '#000000')).toBe('#808080');
    expect(flattenColor('#123456', '#ffffff')).toBe('#123456');
    expect(flattenColor('not-a-color', '#000000')).toBeNull();
  });

  it('adds an alpha channel for chart fills', () => {
    expect(withAlpha('#f5a826', 0.2)).toBe('#f5a82633');
    expect(withAlpha('#f5a826cc', 1)).toBe('#f5a826ff');
  });

  it('drops colors too close to one already kept', () => {
    expect(distinctColors(['#0b7a62', '#b3541e', '#0a7a66', '#1d63a8'])).toEqual(['#0b7a62', '#b3541e', '#1d63a8']);
  });

  it('resolves an opaque palette from the theme tokens', () => {
    const theme = resolveDiagramTheme(true, resolverFor(DARK_TOKENS));
    const palette = theme.palette!;
    expect(theme.dark).toBe(true);
    expect(palette.background).toBe('#0f0e0c');
    expect(palette.text).toBe('#f6f2e9');
    // Translucent tokens are composited onto the diagram background.
    expect(palette.muted).toMatch(/^#[0-9a-f]{6}$/);
    expect(palette.muted).not.toBe(palette.text);
    expect(palette.series).toEqual(['#f5a826', '#a9d48b', '#6ec9c4', '#ffde82']);
    // Node fill is the accent tinted into the surface, never the raw accent.
    expect(palette.primaryFill).not.toBe(palette.primary);
    expect(palette.noteBorder).toBe('#ffde82');
  });

  it('turns hues while keeping saturation and lightness', () => {
    expect(rotateHue('#ff0000', 120)).toBe('#00ff00');
    expect(rotateHue('#ff0000', -120)).toBe('#0000ff');
    expect(rotateHue('#f5a826', 360)).toBe('#f5a826');
    expect(rotateHue('#808080', 90)).toBe('#808080');
  });

  it('builds a full section scale of distinct accents', () => {
    const scale = sectionScale(['#f5a826', '#a9d48b'], '#f5a826');
    expect(scale).toHaveLength(SCALE_SIZE);
    expect(scale.slice(0, 2)).toEqual(['#f5a826', '#a9d48b']);
    expect(distinctColors(scale)).toEqual(scale);
    // A gray theme has no hues to turn: its accents repeat rather than collapse to one color.
    expect(sectionScale(['#808080', '#404040'], '#808080')).toEqual(
      Array.from({ length: SCALE_SIZE }, (_, i) => (i % 2 ? '#404040' : '#808080')),
    );
  });

  it('tints the section scale into section fills', () => {
    const palette = resolveDiagramTheme(true, resolverFor(DARK_TOKENS)).palette!;
    expect(palette.scale).toHaveLength(SCALE_SIZE);
    expect(palette.scale.slice(0, 4)).toEqual(palette.series);
    expect(palette.scaleFills).toHaveLength(SCALE_SIZE);
    expect(new Set(palette.scaleFills).size).toBe(SCALE_SIZE);
    expect(palette.scaleFills[0]).not.toBe(palette.scale[0]);
  });

  it('keys the theme by its colors so a palette change re-renders diagrams', () => {
    const a = resolveDiagramTheme(true, resolverFor(DARK_TOKENS));
    const b = resolveDiagramTheme(true, resolverFor({ ...DARK_TOKENS, '--t-primary': '#4ea1ff' }));
    expect(a.key).not.toBe(b.key);
    expect(resolveDiagramTheme(true, resolverFor(DARK_TOKENS)).key).toBe(a.key);
  });

  it('falls back to the stock theme when core tokens do not resolve', () => {
    expect(resolveDiagramTheme(false, () => null)).toEqual(stockDiagramTheme(false));
    const { '--t-primary': _, ...noPrimary } = DARK_TOKENS;
    expect(resolveDiagramTheme(true, resolverFor(noPrimary))).toEqual(stockDiagramTheme(true));
  });
});
