/**
 * ```chart fences: a Chart.js config written as JSON, rendered to an image wrapped in SVG so it
 * shares the diagram pipeline (cache, streaming, expand/viewer). See `markdown-diagrams.ts`.
 */
import type { Chart as ChartJs } from 'chart.js';
import { withAlpha, type DiagramPalette, type DiagramTheme } from './diagram-palette';

type ChartClass = typeof ChartJs;

/** Default chart size in CSS pixels; a spec may override with top-level `width` / `height`. */
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 380;
const MIN_SIZE = 160;
const MAX_SIZE = 2400;
/** Bitmap density: sharp inline and still crisp at 3× in the expanded viewer. */
const PIXEL_RATIO = 3;

/** Chart types drawn one color per data point instead of one per dataset. */
const PER_POINT_TYPES = new Set(['pie', 'doughnut', 'polarArea']);
/** Chart types whose area under a line gets a translucent fill. */
const AREA_TYPES = new Set(['line', 'radar']);

export interface ChartSpec {
  /** Chart.js config (`type`, `data`, `options`), JSON only: no callbacks. */
  config: { type: string; data: { datasets?: unknown[] } & Record<string, unknown>; options?: Record<string, unknown> };
  width: number;
  height: number;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    // Models often leave trailing commas; accept those, report the original error otherwise.
    try {
      return JSON.parse(source.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      throw new Error(`Chart must be a JSON Chart.js config: ${(error as Error).message}`);
    }
  }
}

function size(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, value)))
    : fallback;
}

/** Parses and validates a chart fence. Throws with a readable message on bad input. */
export function parseChartSpec(source: string): ChartSpec {
  const raw = parseJson(source);
  if (!isObject(raw)) {
    throw new Error('Chart must be a JSON object like {"type": "bar", "data": {...}}');
  }
  const { width, height, ...config } = raw;
  if (typeof config['type'] !== 'string' || !config['type'].trim()) {
    throw new Error('Chart needs a "type" (bar, line, pie, doughnut, radar, scatter, bubble, polarArea)');
  }
  if (!isObject(config['data'])) {
    throw new Error('Chart needs a "data" object with "datasets"');
  }
  if (config['options'] !== undefined && !isObject(config['options'])) {
    throw new Error('Chart "options" must be an object');
  }
  return {
    config: config as ChartSpec['config'],
    width: size(width, DEFAULT_WIDTH),
    height: size(height, DEFAULT_HEIGHT),
  };
}

/** Gives datasets without explicit colors the theme's series colors (in place). */
export function applyChartPalette(config: ChartSpec['config'], palette: DiagramPalette): void {
  const datasets = Array.isArray(config.data.datasets) ? config.data.datasets : [];
  datasets.forEach((dataset, index) => {
    if (!isObject(dataset) || dataset['backgroundColor'] !== undefined || dataset['borderColor'] !== undefined) {
      return;
    }
    const type = typeof dataset['type'] === 'string' ? dataset['type'] : config.type;
    const series = palette.series;
    if (PER_POINT_TYPES.has(type)) {
      const points = Array.isArray(dataset['data']) ? dataset['data'].length : series.length;
      dataset['backgroundColor'] = Array.from({ length: points }, (_, i) => series[i % series.length]);
      dataset['borderColor'] = palette.background;
      return;
    }
    const color = series[index % series.length]!;
    dataset['borderColor'] = color;
    dataset['backgroundColor'] = withAlpha(color, AREA_TYPES.has(type) ? 0.2 : 0.75);
  });
}

/** Options forced on every chart: a fixed-size, static, high-density render. */
function renderOptions(spec: ChartSpec): JsonObject {
  return {
    ...spec.config.options,
    responsive: false,
    maintainAspectRatio: false,
    animation: false,
    devicePixelRatio: PIXEL_RATIO,
  };
}

const importChart = (): Promise<ChartClass> => import('chart.js/auto').then((m) => m.default);
let loadChart: () => Promise<ChartClass> = importChart;
let chartReady: Promise<ChartClass> | null = null;

/** Test seam: replace the lazy `chart.js/auto` import; null restores it. */
export function setChartLoaderForTests(loader: (() => Promise<ChartClass>) | null): void {
  loadChart = loader ?? importChart;
  chartReady = null;
}

/** Loads Chart.js on first use; a failed chunk load is retried by the next chart. */
export async function loadChartJs(): Promise<ChartClass> {
  try {
    return await (chartReady ??= loadChart());
  } catch (error) {
    chartReady = null;
    throw error;
  }
}

/**
 * Renders a parsed chart to SVG markup (`id` on the root, sized by its viewBox). Callers serialize
 * renders: Chart.js text/grid colors are global defaults.
 */
export function renderChartSvg(Chart: ChartClass, spec: ChartSpec, theme: DiagramTheme, id: string): string {
  const config = structuredClone(spec.config);
  const palette = theme.palette;
  if (palette) {
    applyChartPalette(config, palette);
  }
  // Chart.js' own defaults when the theme did not resolve.
  Chart.defaults.color = palette?.text ?? '#666';
  Chart.defaults.borderColor = palette?.grid ?? 'rgba(0,0,0,0.1)';
  const doc = document;
  const canvas = doc.createElement('canvas');
  canvas.width = spec.width;
  canvas.height = spec.height;
  // Attached (but off-screen) so Chart.js can read computed styles for its layout.
  canvas.style.cssText = `position:fixed;left:-100000px;top:0;width:${spec.width}px;height:${spec.height}px;pointer-events:none;`;
  canvas.setAttribute('aria-hidden', 'true');
  doc.body.append(canvas);
  let chart: ChartJs | null = null;
  try {
    chart = new Chart(canvas, { ...config, options: renderOptions(spec) } as never);
    const png = canvas.toDataURL('image/png');
    return `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 ${spec.width} ${spec.height}" `
      + `width="${spec.width}" height="${spec.height}"><image href="${png}" width="${spec.width}" `
      + `height="${spec.height}"></image></svg>`;
  } finally {
    chart?.destroy();
    canvas.remove();
  }
}
