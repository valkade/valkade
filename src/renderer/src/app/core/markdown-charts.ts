/**
 * ```chart fences: a Chart.js config written as JSON, rendered to an image wrapped in SVG so it
 * shares the diagram pipeline (cache, streaming, expand/viewer). See `markdown-diagrams.ts`.
 * Pie, doughnut and polarArea slices get invisible SVG hit areas over the image that carry
 * hover/focus tooltips (see `diagram-tooltips.ts`).
 */
import type { Chart as ChartJs } from 'chart.js';
import { withAlpha, type DiagramPalette, type DiagramTheme } from './diagram-palette';
import { markTipTarget } from './diagram-tooltips';

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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Final geometry of a Chart.js arc element, in canvas CSS pixels. */
export interface ArcGeometry {
  x: number;
  y: number;
  startAngle: number;
  endAngle: number;
  innerRadius: number;
  outerRadius: number;
}

const ARC_PROPS = ['x', 'y', 'startAngle', 'endAngle', 'innerRadius', 'outerRadius'];

/** The parts of a live Chart.js chart the hit layer reads (`legendHitBoxes` is not in the typings). */
interface ChartLike {
  data?: { labels?: unknown[]; datasets?: Array<Record<string, unknown>> };
  getDatasetMeta?(index: number): {
    hidden?: boolean | null;
    data: Array<{ getProps(keys: string[], final?: boolean): Record<string, unknown> }>;
  };
  legend?: {
    legendItems?: Array<{ index?: number }>;
    legendHitBoxes?: Array<{ left: number; top: number; width: number; height: number }>;
  };
}

function round(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * SVG path of a Chart.js arc (canvas angles: 0 at 3 o'clock, growing clockwise). Each edge is drawn
 * as two half arcs so a single full-circle slice still has a well-defined path.
 */
export function arcPath(arc: ArcGeometry): string {
  const { x, y, startAngle, endAngle, innerRadius, outerRadius } = arc;
  const mid = (startAngle + endAngle) / 2;
  const at = (r: number, angle: number): string => `${round(x + r * Math.cos(angle))} ${round(y + r * Math.sin(angle))}`;
  const outer = round(outerRadius);
  let d = `M${at(outerRadius, startAngle)}A${outer} ${outer} 0 0 1 ${at(outerRadius, mid)}`
    + `A${outer} ${outer} 0 0 1 ${at(outerRadius, endAngle)}`;
  if (innerRadius > 0) {
    const inner = round(innerRadius);
    d += `L${at(innerRadius, endAngle)}A${inner} ${inner} 0 0 0 ${at(innerRadius, mid)}`
      + `A${inner} ${inner} 0 0 0 ${at(innerRadius, startAngle)}`;
  } else {
    d += `L${round(x)} ${round(y)}`;
  }
  return `${d}Z`;
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function pointLabel(labels: unknown[] | undefined, dataset: Record<string, unknown>, index: number, multi: boolean): string {
  const raw = labels?.[index];
  const name = Array.isArray(raw) ? raw.join(' ') : raw != null && raw !== '' ? String(raw) : `Item ${index + 1}`;
  const series = dataset['label'];
  return multi && typeof series === 'string' && series ? `${series} · ${name}` : name;
}

function pointColor(dataset: Record<string, unknown>, index: number): string | null {
  const fill = dataset['backgroundColor'];
  const color = Array.isArray(fill) ? fill[index % fill.length] : fill;
  return typeof color === 'string' ? color : null;
}

/**
 * Transparent hit areas over the chart image for pie / doughnut / polarArea slices (and, for a
 * single dataset, the legend rows), carrying tooltip data. Empty markup for other chart types.
 */
function chartHitLayer(chart: ChartLike, type: string, doc: Document): string {
  const datasets = chart.data?.datasets ?? [];
  if (typeof chart.getDatasetMeta !== 'function' || !datasets.length) {
    return '';
  }
  const labels = chart.data?.labels;
  const multi = datasets.length > 1;
  const group = doc.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'md-chart-hits');
  const totals = datasets.map((dataset) =>
    (Array.isArray(dataset['data']) ? dataset['data'] : []).reduce<number>((sum, v) => sum + (isAmount(v) ? v : 0), 0));
  datasets.forEach((dataset, d) => {
    const kind = typeof dataset['type'] === 'string' ? dataset['type'] : type;
    const values = Array.isArray(dataset['data']) ? dataset['data'] : [];
    const meta = chart.getDatasetMeta!(d);
    if (!PER_POINT_TYPES.has(kind) || meta.hidden) {
      return;
    }
    meta.data.forEach((element, j) => {
      const value = values[j];
      const arc = element.getProps(ARC_PROPS, true) as unknown as ArcGeometry;
      if (!isAmount(value) || !(arc.endAngle - arc.startAngle > 1e-6) || !(arc.outerRadius > 0)) {
        return;
      }
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'md-chart-hit');
      path.setAttribute('d', arcPath(arc));
      const tip = { label: pointLabel(labels, dataset, j, multi), value, total: totals[d]!, key: String(j) };
      markTipTarget(path, { ...tip, color: pointColor(dataset, j) }, true);
      group.append(path);
    });
  });
  // Legend rows map to data points only for a single per-point dataset.
  const only = datasets.length === 1 ? datasets[0]! : null;
  const items = chart.legend?.legendItems ?? [];
  const boxes = chart.legend?.legendHitBoxes ?? [];
  if (only && group.childNodes.length && items.length === boxes.length) {
    const values = Array.isArray(only['data']) ? only['data'] : [];
    items.forEach((item, i) => {
      const j = item.index;
      const value = typeof j === 'number' ? values[j] : undefined;
      const box = boxes[i]!;
      if (typeof j !== 'number' || !isAmount(value)) {
        return;
      }
      const rect = doc.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', 'md-chart-legend-hit');
      for (const [name, n] of [['x', box.left], ['y', box.top], ['width', box.width], ['height', box.height]] as const) {
        rect.setAttribute(name, round(n));
      }
      const tip = { label: pointLabel(labels, only, j, false), value, total: totals[0]!, key: String(j) };
      markTipTarget(rect, { ...tip, color: pointColor(only, j) }, false);
      group.append(rect);
    });
  }
  if (!group.childNodes.length) {
    return '';
  }
  // Serialized through the DOM so labels from the chart JSON are escaped.
  const holder = doc.createElement('div');
  holder.append(group);
  return holder.innerHTML;
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
    return `<svg xmlns="${SVG_NS}" id="${id}" viewBox="0 0 ${spec.width} ${spec.height}" `
      + `width="${spec.width}" height="${spec.height}"><image href="${png}" width="${spec.width}" `
      + `height="${spec.height}"></image>${chartHitLayer(chart as unknown as ChartLike, config.type, doc)}</svg>`;
  } finally {
    chart?.destroy();
    canvas.remove();
  }
}
