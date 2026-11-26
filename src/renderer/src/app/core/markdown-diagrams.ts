/**
 * Diagram rendering for markdown surfaces (assistant chat replies and the `.md` preview).
 *
 * The markdown renderers emit an inert placeholder (`.md-diagram` wrapping the source in
 * `<pre><code>`) for diagram fences; {@link hydrateMarkdownDiagrams} later swaps placeholders
 * in the live DOM for SVG. Renderers (Mermaid, Chart.js) are imported lazily on first use so they
 * stay out of the initial bundle, and Mermaid's output is sanitized again before it touches the
 * document. Colors come from the app theme (see `diagram-theme.ts`).
 */
import DOMPurify from 'dompurify';
import type { Mermaid, MermaidConfig } from 'mermaid';
import type { DiagramPalette, DiagramTheme } from './diagram-palette';
import { annotateMermaidPie, hasTipTargets } from './diagram-tooltips';
import { loadChartJs, parseChartSpec, renderChartSvg } from './markdown-charts';

/** Fence languages rendered as diagrams instead of code. */
export type DiagramLanguage = 'mermaid' | 'chart';

/** Fence info strings (first word, lowercase) mapped to the renderer that draws them. */
const FENCE_LANGUAGES: Readonly<Record<string, DiagramLanguage>> = {
  mermaid: 'mermaid',
  chart: 'chart',
  chartjs: 'chart',
};

/** Class on the placeholder emitted by the markdown renderers (and kept once hydrated). */
export const DIAGRAM_CLASS = 'md-diagram';

/** Class on the button that opens a rendered diagram in the expanded viewer. */
export const DIAGRAM_EXPAND_CLASS = 'md-diagram__expand';

type MermaidApi = Pick<Mermaid, 'initialize' | 'render'>;

interface RenderedDiagram {
  svg: string;
  /** Render id; every occurrence is rewritten per inserted copy. */
  id: string;
}

/** `transient` marks failures unrelated to the source (the renderer chunk failed to load). */
type DiagramResult = RenderedDiagram | { error: string; transient?: boolean };

interface DiagramState {
  source: string;
  language: DiagramLanguage;
  themeKey: string;
}

interface CacheEntry {
  promise: Promise<DiagramResult>;
  result: DiagramResult | null;
}

/** Rendered results kept so re-parsed markdown (every streamed chunk) re-inserts SVG synchronously. */
const CACHE_LIMIT = 64;
const MAX_ERROR_CHARS = 600;

const cache = new Map<string, CacheEntry>();
/** Placeholders that have been claimed for rendering, with the source/theme they show (or will show). */
const states = new WeakMap<Element, DiagramState>();
/** SVG currently shown by each rendered diagram, for the expanded viewer. */
const rendered = new WeakMap<Element, RenderedDiagram>();

const importMermaid = (): Promise<MermaidApi> => import('mermaid').then((m) => m.default);
let loadMermaid: () => Promise<MermaidApi> = importMermaid;
let mermaidReady: Promise<MermaidApi> | null = null;
let initializedThemeKey: string | null = null;
/**
 * Mermaid's config and Chart.js' defaults are global: one render at a time so a theme switch
 * cannot leak into another render.
 */
let renderQueue: Promise<unknown> = Promise.resolve();
let renderCount = 0;
let instanceCount = 0;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Diagram language named by a fence info string (`mermaid`, `Mermaid title=x`, `chart`), else null. */
export function diagramLanguage(lang: string | undefined): DiagramLanguage | null {
  const first = (lang ?? '').trim().split(/\s+/, 1)[0]!.toLowerCase();
  return FENCE_LANGUAGES[first] ?? null;
}

/** True when a fenced code token's raw markdown ends with its closing fence (not still streaming). */
export function isClosedFence(raw: string): boolean {
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
  if (!open) {
    return false;
  }
  const lines = raw.replace(/\s+$/, '').split('\n');
  if (lines.length < 2) {
    return false;
  }
  const fence = open[1]!;
  const last = lines[lines.length - 1]!.trim();
  return last.length >= fence.length && last === fence[0]!.repeat(last.length);
}

/** Inert placeholder for a diagram fence; readable as a plain code block until hydrated. */
export function diagramPlaceholderHtml(language: DiagramLanguage, source: string): string {
  return `<div class="${DIAGRAM_CLASS}"><pre class="md-diagram__source"><code class="language-${language}">${escapeHtml(source)}</code></pre></div>`;
}

function placeholderSource(el: Element): string {
  return el.querySelector('code')?.textContent ?? '';
}

function placeholderLanguage(el: Element): DiagramLanguage {
  const match = /(?:^|\s)language-([\w-]+)/.exec(el.querySelector('code')?.className ?? '');
  return diagramLanguage(match?.[1]) ?? 'mermaid';
}

/** True when `el` was claimed by {@link hydrateMarkdownDiagrams} (SVG, error note or render in flight). */
export function isHydratedDiagram(el: Element): boolean {
  return states.has(el);
}

/**
 * True when hydrated diagram `target` already shows `source` (a freshly parsed placeholder), so a
 * DOM reconciler can keep the rendered SVG instead of reverting it to code.
 */
export function isHydratedDiagramFor(target: Element, source: Element): boolean {
  const state = states.get(target);
  return !!state
    && source.classList.contains(DIAGRAM_CLASS)
    && state.source === placeholderSource(source)
    && state.language === placeholderLanguage(source);
}

/** `annotate` runs on the sanitized markup (our own attributes, e.g. pie tooltips, are added after). */
function sanitizeSvg(svg: string, annotate?: (root: HTMLElement) => void): string {
  const fragment = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    // Mermaid draws HTML labels inside <foreignObject> and reuses symbols via <use> (checked below).
    ADD_TAGS: ['foreignObject', 'use'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    // Diagrams never need to fetch: no remote images, links or embedded documents.
    FORBID_TAGS: ['img', 'image', 'a', 'iframe', 'object', 'embed'],
    RETURN_DOM_FRAGMENT: true,
  });
  // <use> may only point at symbols inside the diagram itself.
  for (const use of Array.from(fragment.querySelectorAll('use'))) {
    const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
    if (!href.startsWith('#')) {
      use.remove();
    }
  }
  const wrapper = document.createElement('div');
  wrapper.append(fragment);
  annotate?.(wrapper);
  return wrapper.innerHTML;
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const text = raw.trim() || 'Unknown error';
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/** The `-r` terminator keeps one render id from being a prefix of another (see instantiateSvg). */
function nextRenderId(): string {
  return `md-diagram-${++renderCount}-r`;
}

function indexed(prefix: string, colors: readonly string[]): Record<string, string> {
  return Object.fromEntries(colors.map((color, i) => [`${prefix}${i}`, color]));
}

/**
 * Per-section colors (timeline, mindmap, kanban, treemap, journey, git graph). Set explicitly: the
 * `base` theme derives them by hue-turning `primaryColor` and then darkening them (by 75% in dark
 * mode), which leaves a muted node fill with near-identical, almost black sections.
 */
function sectionColors(p: DiagramPalette): Record<string, string> {
  return {
    ...indexed('cScale', p.scaleFills),
    ...indexed('cScalePeer', p.scale),
    ...indexed('cScaleInv', p.scale),
    scaleLabelColor: p.text,
    ...indexed('cScaleLabel', p.scaleFills.map(() => p.text)),
    ...indexed('fillType', p.scaleFills.slice(0, 8)),
    ...indexed('git', p.scale.slice(0, 8)),
    branchLabelColor: p.background,
    ...indexed('gitBranchLabel', p.scale.slice(0, 8).map(() => p.background)),
  };
}

/**
 * Mermaid settings for `theme`: the `base` theme seeded with app colors (Mermaid derives the
 * remaining shades), or the stock dark/default theme when the app palette is unavailable.
 */
export function mermaidConfig(theme: DiagramTheme): MermaidConfig {
  const common: MermaidConfig = {
    startOnLoad: false,
    // Strict: labels are sanitized and click/script directives are disabled.
    securityLevel: 'strict',
    suppressErrorRendering: true,
    darkMode: theme.dark,
  };
  const p = theme.palette;
  if (!p) {
    return { ...common, theme: theme.dark ? 'dark' : 'default' };
  }
  const pie = Object.fromEntries(p.series.map((color, i) => [`pie${i + 1}`, color]));
  return {
    ...common,
    theme: 'base',
    themeVariables: {
      darkMode: theme.dark,
      background: p.background,
      mainBkg: p.primaryFill,
      primaryColor: p.primaryFill,
      primaryTextColor: p.text,
      primaryBorderColor: p.primary,
      secondaryColor: p.secondaryFill,
      secondaryTextColor: p.text,
      secondaryBorderColor: p.border,
      tertiaryColor: p.surface,
      tertiaryTextColor: p.text,
      tertiaryBorderColor: p.border,
      lineColor: p.muted,
      textColor: p.text,
      titleColor: p.text,
      edgeLabelBackground: p.background,
      clusterBkg: p.surface,
      clusterBorder: p.border,
      noteBkgColor: p.noteFill,
      noteTextColor: p.text,
      noteBorderColor: p.noteBorder,
      actorBkg: p.primaryFill,
      actorBorder: p.primary,
      actorTextColor: p.text,
      actorLineColor: p.muted,
      signalColor: p.text,
      signalTextColor: p.text,
      labelBoxBkgColor: p.primaryFill,
      labelBoxBorderColor: p.primary,
      labelTextColor: p.text,
      loopTextColor: p.text,
      ...sectionColors(p),
      ...pie,
      pieStrokeColor: p.background,
      pieOuterStrokeColor: p.border,
      pieTitleTextColor: p.text,
      pieLegendTextColor: p.text,
      pieSectionTextColor: p.background,
      xyChart: {
        backgroundColor: p.background,
        titleColor: p.text,
        xAxisLabelColor: p.text,
        xAxisTitleColor: p.text,
        xAxisTickColor: p.muted,
        xAxisLineColor: p.muted,
        yAxisLabelColor: p.text,
        yAxisTitleColor: p.text,
        yAxisTickColor: p.muted,
        yAxisLineColor: p.muted,
        plotColorPalette: p.series.join(', '),
      },
    },
  };
}

async function renderMermaid(source: string, theme: DiagramTheme): Promise<DiagramResult> {
  let mermaid: MermaidApi;
  try {
    mermaid = await (mermaidReady ??= loadMermaid());
  } catch (error) {
    // Let a later diagram retry a failed chunk load.
    mermaidReady = null;
    return { error: `Diagram renderer failed to load: ${errorText(error)}`, transient: true };
  }
  const id = nextRenderId();
  try {
    if (initializedThemeKey !== theme.key) {
      initializedThemeKey = null;
      mermaid.initialize(mermaidConfig(theme));
      initializedThemeKey = theme.key;
    }
    const { svg } = await mermaid.render(id, source);
    return { svg: sanitizeSvg(svg, (root) => annotateMermaidPie(root, source)), id };
  } catch (error) {
    // Mermaid can leave its scratch container behind when parsing fails.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    return { error: errorText(error) };
  }
}

async function renderChart(source: string, theme: DiagramTheme): Promise<DiagramResult> {
  let spec;
  try {
    spec = parseChartSpec(source);
  } catch (error) {
    return { error: errorText(error) };
  }
  let Chart;
  try {
    Chart = await loadChartJs();
  } catch (error) {
    return { error: `Chart renderer failed to load: ${errorText(error)}`, transient: true };
  }
  const id = nextRenderId();
  try {
    // Our own markup around a canvas PNG (JSON config only, no callbacks): no SVG sanitizing needed.
    return { svg: renderChartSvg(Chart, spec, theme, id), id };
  } catch (error) {
    return { error: errorText(error) };
  }
}

function cachedRender(source: string, language: DiagramLanguage, theme: DiagramTheme): CacheEntry {
  const key = `${language}\n${theme.key}\n${source}`;
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency so streamed/edited documents keep their visible diagrams cached.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const run = (): Promise<DiagramResult> =>
    language === 'chart' ? renderChart(source, theme) : renderMermaid(source, theme);
  const promise = renderQueue.then(run, run);
  renderQueue = promise;
  const entry: CacheEntry = { promise, result: null };
  void promise.then((result) => {
    entry.result = result;
    // A failed chunk load is not a property of this diagram: let the next scan try again.
    if ('error' in result && result.transient && cache.get(key) === entry) {
      cache.delete(key);
    }
  });
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value!);
  }
  return entry;
}

/**
 * Cached SVG can be shown more than once (repeats, chat + preview, the expanded viewer); give each
 * copy its own ids so marker/style references never resolve into a hidden twin.
 */
function instantiateSvg(diagram: RenderedDiagram): string {
  return diagram.svg.split(diagram.id).join(`${diagram.id}${++instanceCount}`);
}

/** Static Lucide `maximize-2` glyph for the expand button (inserted outside Angular templates). */
const EXPAND_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline>'
  + '<line x1="21" x2="14" y1="3" y2="10"></line><line x1="3" x2="10" y1="21" y2="14"></line></svg>';

function applyResult(el: Element, source: string, language: DiagramLanguage, result: DiagramResult): void {
  const doc = el.ownerDocument;
  const noun = language === 'chart' ? 'chart' : 'diagram';
  if ('svg' in result) {
    const canvas = doc.createElement('div');
    canvas.className = 'md-diagram__canvas';
    canvas.innerHTML = instantiateSvg(result);
    // An `img` hides its children from assistive tech; keep focusable slices reachable.
    canvas.setAttribute('role', hasTipTargets(canvas) ? 'group' : 'img');
    canvas.setAttribute('aria-label', language === 'chart' ? 'Chart' : 'Diagram');
    // Clicks are handled by the host's MarkdownDiagramsDirective (see expandedDiagramSvg).
    const expand = doc.createElement('button');
    expand.type = 'button';
    expand.className = DIAGRAM_EXPAND_CLASS;
    expand.title = `Expand ${noun}`;
    expand.setAttribute('aria-label', `Expand ${noun}`);
    expand.innerHTML = EXPAND_ICON;
    el.replaceChildren(canvas, expand);
    el.classList.remove('md-diagram--error');
    el.classList.add('md-diagram--rendered');
    rendered.set(el, result);
    return;
  }
  rendered.delete(el);
  const note = doc.createElement('div');
  note.className = 'md-diagram__error';
  note.setAttribute('role', 'note');
  note.textContent = `${noun === 'chart' ? 'Chart' : 'Diagram'} could not be rendered: ${result.error}`;
  const pre = doc.createElement('pre');
  pre.className = 'md-diagram__source';
  const code = doc.createElement('code');
  code.className = `language-${language}`;
  code.textContent = source;
  pre.append(code);
  el.replaceChildren(note, pre);
  el.classList.remove('md-diagram--rendered');
  el.classList.add('md-diagram--error');
}

/**
 * Renders every diagram placeholder under `host` that is not already showing `theme`.
 * Cached diagrams are inserted synchronously; new ones render in the background and are applied
 * only if their placeholder is still attached and still wants that source/theme.
 */
export function hydrateMarkdownDiagrams(host: ParentNode, theme: DiagramTheme): void {
  for (const el of Array.from(host.querySelectorAll(`.${DIAGRAM_CLASS}`))) {
    const previous = states.get(el);
    if (previous?.themeKey === theme.key) {
      continue;
    }
    const source = previous?.source ?? placeholderSource(el);
    if (!source.trim()) {
      continue;
    }
    const language = previous?.language ?? placeholderLanguage(el);
    const state: DiagramState = { source, language, themeKey: theme.key };
    states.set(el, state);
    const entry = cachedRender(source, language, theme);
    if (entry.result) {
      applyResult(el, source, language, entry.result);
      continue;
    }
    void entry.promise.then((result) => {
      if (states.get(el) === state && el.isConnected) {
        applyResult(el, source, language, result);
      }
    });
  }
}

/** A fresh copy (own ids) of the SVG shown by rendered diagram `el`, or null when it shows none. */
export function expandedDiagramSvg(el: Element): string | null {
  const shown = rendered.get(el);
  return shown ? instantiateSvg(shown) : null;
}

/** Test seam: replace the lazy `mermaid` import (jsdom cannot lay out SVG text); null restores it. */
export function setMermaidLoaderForTests(loader: (() => Promise<MermaidApi>) | null): void {
  loadMermaid = loader ?? importMermaid;
  mermaidReady = null;
  initializedThemeKey = null;
  cache.clear();
}
