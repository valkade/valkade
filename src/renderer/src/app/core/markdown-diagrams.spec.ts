import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownPipe } from '../features/chat/chat-box/markdown.pipe';
import { patchStreamingMarkdownDom } from '../features/chat/chat-box/streaming-markdown';
import { renderMarkdownDoc } from '../features/workspace/workspace-monaco/markdown-doc-renderer';
import { MarkdownDiagramsDirective } from './markdown-diagrams.directive';
import { stockDiagramTheme, type DiagramPalette, type DiagramTheme } from './diagram-palette';
import { DiagramThemeService } from './diagram-theme.service';
import { DiagramViewerService } from './diagram-viewer.service';
import { setChartLoaderForTests } from './markdown-charts';
import {
  DIAGRAM_CLASS,
  DIAGRAM_EXPAND_CLASS,
  diagramLanguage,
  expandedDiagramSvg,
  diagramPlaceholderHtml,
  hydrateMarkdownDiagrams,
  isClosedFence,
  mermaidConfig,
  setMermaidLoaderForTests,
} from './markdown-diagrams';

const FLOW = 'graph TD\n  A-->B';
const DARK = stockDiagramTheme(true);
const LIGHT = stockDiagramTheme(false);
const PALETTE: DiagramPalette = {
  background: '#101010',
  surface: '#181818',
  text: '#eeeeee',
  muted: '#999999',
  border: '#444444',
  grid: '#2a2a2a',
  primary: '#f5a826',
  primaryFill: '#3a2f1c',
  secondaryFill: '#25301f',
  noteFill: '#33301c',
  noteBorder: '#ffde82',
  series: ['#f5a826', '#a9d48b', '#6ec9c4'],
  scale: Array.from({ length: 12 }, (_, i) => ['#f5a826', '#a9d48b', '#6ec9c4'][i % 3]!),
  scaleFills: Array.from({ length: 12 }, (_, i) => ['#5f4419', '#43502f', '#2f4c49'][i % 3]!),
};
const PALETTE_THEME: DiagramTheme = { key: 'dark:test', dark: true, palette: PALETTE };

// Lazy import, render queue and result callbacks each take a few microtasks (per queued render).
async function settle(): Promise<void> {
  for (let i = 0; i < 48; i++) await Promise.resolve();
}

/** jsdom cannot lay out SVG text, so a stub stands in for mermaid's render. */
function stubMermaid() {
  const initialize = vi.fn();
  const render = vi.fn(async (id: string, text: string) => {
    if (text.includes('broken')) {
      throw new Error('Parse error on line 1');
    }
    return {
      svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><style>#${id} .node { fill: red; }</style>`
        + `<g class="node" onclick="alert(1)"><foreignObject><div><p>${text.split('\n')[0]}</p></div></foreignObject></g>`
        + `<symbol id="${id}-icon"><path d="M0 0"></path></symbol><use href="#${id}-icon"></use>`
        + `<use href="https://example.com/sprite.svg#x"></use>`
        + `<image href="https://example.com/tracker.png"></image><script>alert(1)</script></svg>`,
    };
  });
  setMermaidLoaderForTests(() => Promise.resolve({ initialize, render } as never));
  return { initialize, render };
}

function placeholderHost(...sources: string[]): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = sources.map((source) => diagramPlaceholderHtml('mermaid', source)).join('');
  document.body.append(host);
  return host;
}

afterEach(() => {
  setMermaidLoaderForTests(null);
  setChartLoaderForTests(null);
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** jsdom has no canvas: a stub Chart records its config and the bitmap export is faked. */
function stubChartJs() {
  const configs: Array<{ type: string; data: { datasets: Record<string, unknown>[] }; options: Record<string, unknown> }> = [];
  class FakeChart {
    static defaults = { color: '', borderColor: '' };
    constructor(_canvas: HTMLCanvasElement, config: (typeof configs)[number]) {
      configs.push(config);
    }
    destroy(): void {}
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
  setChartLoaderForTests(() => Promise.resolve(FakeChart as never));
  return { FakeChart, configs };
}

describe('diagram fence detection', () => {
  it.each([
    ['mermaid', 'mermaid'],
    ['Mermaid', 'mermaid'],
    [' mermaid title="x"', 'mermaid'],
    ['mermaidjs', null],
    ['ts', null],
    ['', null],
    [undefined, null],
  ])('maps info string %j to %j', (lang, expected) => {
    expect(diagramLanguage(lang)).toBe(expected);
  });

  it('tells closed fences from ones still streaming in', () => {
    expect(isClosedFence('```mermaid\ngraph TD\n```')).toBe(true);
    expect(isClosedFence('```mermaid\ngraph TD\n```\n\n')).toBe(true);
    expect(isClosedFence('~~~~mermaid\ngraph TD\n~~~~~\n')).toBe(true);
    expect(isClosedFence('```mermaid\ngraph TD\n')).toBe(false);
    expect(isClosedFence('```mermaid\ngraph TD\n``')).toBe(false);
    expect(isClosedFence('````mermaid\ngraph TD\n```')).toBe(false);
    expect(isClosedFence('```mermaid\ngraph TD\n~~~')).toBe(false);
  });

  it('escapes the source in the placeholder', () => {
    const host = document.createElement('div');
    host.innerHTML = diagramPlaceholderHtml('mermaid', 'A["<img src=x onerror=alert(1)>"]');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('code')?.textContent).toBe('A["<img src=x onerror=alert(1)>"]');
  });
});

describe('markdown renderers', () => {
  @Component({
    standalone: true,
    imports: [MarkdownPipe],
    template: '<div class="assistant-md" [innerHTML]="text | markdown"></div>',
  })
  class PipeHost {
    text = '';
  }

  function renderPipe(text: string): HTMLElement {
    const fixture = TestBed.createComponent(PipeHost);
    fixture.componentInstance.text = text;
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).querySelector('.assistant-md')!;
  }

  it('chat pipe emits a placeholder that survives Angular sanitization once the fence closes', () => {
    const el = renderPipe(`Here:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n`);
    const diagram = el.querySelector(`.${DIAGRAM_CLASS}`);
    expect(diagram).not.toBeNull();
    expect(diagram?.querySelector('code')?.textContent).toBe(FLOW);
  });

  it('chat pipe keeps a still-streaming diagram fence as a plain code block', () => {
    const el = renderPipe(`Here:\n\n\`\`\`mermaid\n${FLOW}`);
    expect(el.querySelector(`.${DIAGRAM_CLASS}`)).toBeNull();
    expect(el.querySelector('pre code')?.textContent).toContain('A-->B');
  });

  it('document preview emits a placeholder that survives DOMPurify', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdownDoc(`# Doc\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n`, {
      workspaceRoot: 'C:/ws',
      fileRelativePath: 'docs/a.md',
    });
    expect(host.querySelector(`.${DIAGRAM_CLASS} code`)?.textContent).toBe(FLOW);
  });
});

describe('hydrateMarkdownDiagrams', () => {
  let mermaid: ReturnType<typeof stubMermaid>;

  beforeEach(() => {
    mermaid = stubMermaid();
  });

  it('renders placeholders to sanitized SVG with strict mermaid settings', async () => {
    const host = placeholderHost(FLOW);
    hydrateMarkdownDiagrams(host, DARK);
    await settle();

    const diagram = host.querySelector(`.${DIAGRAM_CLASS}`)!;
    expect(diagram.classList.contains('md-diagram--rendered')).toBe(true);
    expect(diagram.querySelector('pre')).toBeNull();
    expect(diagram.querySelector('svg foreignObject p')?.textContent).toBe('graph TD');
    expect(diagram.querySelector('svg style')).not.toBeNull();
    expect(diagram.querySelector('script, image, [onclick]')).toBeNull();
    const uses = diagram.querySelectorAll('use');
    expect(uses.length).toBe(1);
    expect(uses[0]!.getAttribute('href')).toMatch(/^#md-diagram-\d+-r\d+-icon$/);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', startOnLoad: false, theme: 'dark' }),
    );
  });

  it('marks rendered pie slices for tooltips after sanitizing', async () => {
    mermaid.render.mockImplementation(async (id: string) => ({
      svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" aria-roledescription="pie"><g><g>`
        + '<path class="pieCircle" fill="#f5a826" d="M0 0"></path><path class="pieCircle" fill="#a9d48b" d="M0 0"></path>'
        + '<text class="slice">75%</text><text class="slice">25%</text></g>'
        + '<g class="legend"><rect style="fill: #f5a826;"></rect><text>Done</text></g>'
        + '<g class="legend"><rect style="fill: #a9d48b;"></rect><text>Open</text></g></g></svg>',
    }));
    const host = placeholderHost('pie\n  "Done" : 3\n  "Open" : 1');
    hydrateMarkdownDiagrams(host, DARK);
    await settle();

    const slices = Array.from(host.querySelectorAll('path.pieCircle'));
    expect(slices.map((s) => s.getAttribute('aria-label'))).toEqual(['Done: 3 (75.0%)', 'Open: 1 (25.0%)']);
    expect(host.querySelector('.md-diagram__canvas')?.getAttribute('role')).toBe('group');
    expect(expandedDiagramSvg(host.querySelector(`.${DIAGRAM_CLASS}`)!)).toContain('data-md-tip-detail="1 (25.0%)"');
  });

  it('adds an expand button and hands out independent copies for the viewer', async () => {
    const host = placeholderHost(FLOW, 'graph TD\n  broken');
    hydrateMarkdownDiagrams(host, DARK);
    await settle();

    const [ok, failed] = Array.from(host.querySelectorAll(`.${DIAGRAM_CLASS}`));
    expect(ok!.querySelector(`button.${DIAGRAM_EXPAND_CLASS}`)?.getAttribute('aria-label')).toBe('Expand diagram');
    expect(failed!.querySelector(`.${DIAGRAM_EXPAND_CLASS}`)).toBeNull();
    expect(expandedDiagramSvg(failed!)).toBeNull();

    const copy = document.createElement('div');
    copy.innerHTML = expandedDiagramSvg(ok!)!;
    const inlineId = ok!.querySelector('svg')!.id;
    expect(copy.querySelector('svg')!.id).not.toBe(inlineId);
    expect(copy.querySelector('style')?.textContent).toContain(`#${copy.querySelector('svg')!.id} `);
  });

  it('re-inserts cached SVG synchronously with ids unique per copy', async () => {
    const first = placeholderHost(FLOW);
    hydrateMarkdownDiagrams(first, DARK);
    await settle();

    const second = placeholderHost(FLOW);
    hydrateMarkdownDiagrams(second, DARK);
    const svg = second.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(svg!.id).not.toBe(first.querySelector('svg')!.id);
    expect(second.querySelector('style')?.textContent).toContain(`#${svg!.id} `);
  });

  it('shows the error and keeps the source when the diagram does not parse', async () => {
    const host = placeholderHost('graph TD\n  broken');
    hydrateMarkdownDiagrams(host, DARK);
    await settle();

    const diagram = host.querySelector(`.${DIAGRAM_CLASS}`)!;
    expect(diagram.classList.contains('md-diagram--error')).toBe(true);
    expect(diagram.querySelector('.md-diagram__error')?.textContent).toContain('Parse error on line 1');
    expect(diagram.querySelector('pre code')?.textContent).toBe('graph TD\n  broken');
  });

  it('retries after the renderer chunk fails to load', async () => {
    const { initialize, render } = mermaid;
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('chunk offline'))
      .mockResolvedValue({ initialize, render });
    setMermaidLoaderForTests(loader);

    const first = placeholderHost(FLOW);
    hydrateMarkdownDiagrams(first, DARK);
    await settle();
    expect(first.querySelector('.md-diagram__error')?.textContent).toContain('failed to load: chunk offline');

    const second = placeholderHost(FLOW);
    hydrateMarkdownDiagrams(second, DARK);
    await settle();
    expect(second.querySelector('svg')).not.toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('re-renders for a new theme and leaves detached placeholders alone', async () => {
    const host = placeholderHost(FLOW);
    hydrateMarkdownDiagrams(host, DARK);
    await settle();
    hydrateMarkdownDiagrams(host, DARK);
    expect(mermaid.render).toHaveBeenCalledTimes(1);

    hydrateMarkdownDiagrams(host, LIGHT);
    await settle();
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }));

    const detached = placeholderHost('graph LR\n  X-->Y');
    hydrateMarkdownDiagrams(detached, DARK);
    detached.remove();
    await settle();
    expect(detached.querySelector('svg')).toBeNull();
  });

  it('streaming patches keep a rendered diagram until its source changes', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const html = (source: string, tail: string) => `${diagramPlaceholderHtml('mermaid', source)}<p>${tail}</p>`;

    patchStreamingMarkdownDom(host, html(FLOW, 'Hello'), { animate: true, nowMs: 0 });
    hydrateMarkdownDiagrams(host, DARK);
    await settle();
    const svg = host.querySelector('svg');
    expect(svg).not.toBeNull();

    patchStreamingMarkdownDom(host, html(FLOW, 'Hello world'), { animate: true, nowMs: 1000 });
    expect(host.querySelector('svg')).toBe(svg);
    expect(host.querySelector(':scope > p')?.textContent).toBe('Hello world');

    patchStreamingMarkdownDom(host, html('graph LR\n  C-->D', 'Hello world'), { animate: true, nowMs: 2000 });
    expect(host.querySelector('svg')).toBeNull();
    expect(host.querySelector(`.${DIAGRAM_CLASS} code`)?.textContent).toBe('graph LR\n  C-->D');
  });
});

describe('chart fences', () => {
  const BAR = JSON.stringify({
    type: 'bar',
    data: { labels: ['a', 'b'], datasets: [{ label: 'x', data: [1, 2] }, { label: 'y', data: [3, 4], borderColor: '#123456' }] },
    width: 500,
    height: 9999,
  });

  function chartHost(source: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = diagramPlaceholderHtml('chart', source);
    document.body.append(host);
    return host;
  }

  it('maps chart fence names', () => {
    expect(diagramLanguage('chart')).toBe('chart');
    expect(diagramLanguage('ChartJS')).toBe('chart');
  });

  it('renders a static, themed, high-density chart image at the requested size', async () => {
    const { FakeChart, configs } = stubChartJs();
    const host = chartHost(BAR);
    hydrateMarkdownDiagrams(host, PALETTE_THEME);
    await settle();

    const svg = host.querySelector('.md-diagram__canvas svg')!;
    // Height is clamped to the maximum chart size.
    expect(svg.getAttribute('viewBox')).toBe('0 0 500 2400');
    expect(svg.querySelector('image')?.getAttribute('href')).toBe('data:image/png;base64,AAAA');
    expect(host.querySelector(`.${DIAGRAM_EXPAND_CLASS}`)?.getAttribute('aria-label')).toBe('Expand chart');
    expect(document.querySelector('body > canvas')).toBeNull();

    const config = configs[0]!;
    expect(config.options).toEqual(expect.objectContaining({ responsive: false, animation: false, devicePixelRatio: 3 }));
    // Uncolored datasets take the theme series; explicit colors are left alone.
    expect(config.data.datasets[0]).toEqual(expect.objectContaining({ borderColor: '#f5a826' }));
    expect(config.data.datasets[1]).toEqual(expect.objectContaining({ borderColor: '#123456' }));
    expect(config.data.datasets[1]!['backgroundColor']).toBeUndefined();
    expect(FakeChart.defaults).toEqual({ color: '#eeeeee', borderColor: '#2a2a2a' });
  });

  it('accepts trailing commas but explains other bad input', async () => {
    stubChartJs();
    const host = document.createElement('div');
    host.innerHTML = [
      '{"type": "line", "data": {"datasets": [{"data": [1, 2],}],},}',
      '{"type": "bar", data: {}}',
      '{"data": {}}',
      '[1, 2]',
    ].map((source) => diagramPlaceholderHtml('chart', source)).join('');
    document.body.append(host);
    hydrateMarkdownDiagrams(host, DARK);
    await settle();

    const [lenient, unquoted, untyped, array] = Array.from(host.querySelectorAll(`.${DIAGRAM_CLASS}`));
    expect(lenient!.classList.contains('md-diagram--rendered')).toBe(true);
    expect(unquoted!.querySelector('.md-diagram__error')?.textContent).toContain('Chart must be a JSON Chart.js config');
    expect(unquoted!.querySelector('pre code.language-chart')?.textContent).toBe('{"type": "bar", data: {}}');
    expect(untyped!.querySelector('.md-diagram__error')?.textContent).toContain('Chart needs a "type"');
    expect(array!.querySelector('.md-diagram__error')?.textContent).toContain('JSON object');
  });

  it('lays invisible tooltip hit areas over doughnut slices and legend rows', async () => {
    const arcs = [
      { x: 360, y: 190, startAngle: -Math.PI / 2, endAngle: Math.PI, innerRadius: 80, outerRadius: 160 },
      { x: 360, y: 190, startAngle: Math.PI, endAngle: 1.5 * Math.PI, innerRadius: 80, outerRadius: 160 },
    ];
    class PieChart {
      static defaults = { color: '', borderColor: '' };
      readonly data: { labels: unknown[]; datasets: Record<string, unknown>[] };
      readonly legend = {
        legendItems: [{ index: 0 }, { index: 1 }],
        legendHitBoxes: [{ left: 300, top: 10, width: 40, height: 12 }, { left: 350, top: 10, width: 60, height: 12 }],
      };
      constructor(_canvas: HTMLCanvasElement, config: { data: PieChart['data'] }) {
        this.data = config.data;
      }
      getDatasetMeta() {
        return { hidden: false, data: arcs.map((arc) => ({ getProps: () => arc })) };
      }
      destroy(): void {}
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
    setChartLoaderForTests(() => Promise.resolve(PieChart as never));
    const host = chartHost(JSON.stringify({
      type: 'doughnut',
      data: { labels: ['Done', '<b>Open</b>'], datasets: [{ data: [3, 1] }] },
    }));
    hydrateMarkdownDiagrams(host, PALETTE_THEME);
    await settle();

    const slices = Array.from(host.querySelectorAll('.md-chart-hit'));
    expect(slices.map((s) => s.getAttribute('data-md-tip'))).toEqual(['Done', '<b>Open</b>']);
    expect(host.querySelector('b')).toBeNull();
    expect(slices[0]!.getAttribute('data-md-tip-detail')).toBe('3 (75.0%)');
    expect(slices[0]!.getAttribute('data-md-tip-color')).toBe('#f5a826');
    expect(slices[0]!.getAttribute('tabindex')).toBe('0');
    expect(slices[0]!.getAttribute('d')).toBe('M360 30A160 160 0 0 1 473.14 303.14A160 160 0 0 1 200 190L280 190A80 80 0 0 0 416.57 246.57A80 80 0 0 0 360 110Z');
    const legend = Array.from(host.querySelectorAll('.md-chart-legend-hit'));
    expect(legend.map((r) => [r.getAttribute('x'), r.getAttribute('data-md-tip-key')])).toEqual([['300', '0'], ['350', '1']]);
    expect(host.querySelector('.md-diagram__canvas')?.getAttribute('role')).toBe('group');
    // The viewer copy keeps the hit areas.
    expect(expandedDiagramSvg(host.querySelector(`.${DIAGRAM_CLASS}`)!)).toContain('data-md-tip="Done"');
  });

  it('adds no hit areas to charts that are not pie-like', async () => {
    stubChartJs();
    const host = chartHost('{"type": "bar", "data": {"labels": ["a"], "datasets": [{"data": [1]}]}}');
    hydrateMarkdownDiagrams(host, PALETTE_THEME);
    await settle();
    expect(host.querySelector('.md-diagram__canvas svg image')).not.toBeNull();
    expect(host.querySelector('.md-chart-hits')).toBeNull();
    expect(host.querySelector('.md-diagram__canvas')?.getAttribute('role')).toBe('img');
  });

  it('chat pipe keeps a still-streaming chart fence as code', () => {
    @Component({ standalone: true, imports: [MarkdownPipe], template: '<div [innerHTML]="text | markdown"></div>' })
    class Host {
      text = '```chart\n{"type": "bar"';
    }
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector(`.${DIAGRAM_CLASS}`)).toBeNull();
  });
});

describe('mermaidConfig', () => {
  it('uses the stock theme without a palette', () => {
    expect(mermaidConfig(LIGHT)).toEqual(expect.objectContaining({ theme: 'default', darkMode: false, securityLevel: 'strict' }));
    expect(mermaidConfig(DARK)).toEqual(expect.objectContaining({ theme: 'dark', darkMode: true }));
  });

  it('seeds the base theme with the app palette', () => {
    const config = mermaidConfig(PALETTE_THEME);
    expect(config.theme).toBe('base');
    expect(config.securityLevel).toBe('strict');
    expect(config.themeVariables).toEqual(expect.objectContaining({
      primaryColor: PALETTE.primaryFill,
      primaryBorderColor: PALETTE.primary,
      primaryTextColor: PALETTE.text,
      background: PALETTE.background,
      lineColor: PALETTE.muted,
      noteBkgColor: PALETTE.noteFill,
      pie1: '#f5a826',
      pie3: '#6ec9c4',
    }));
    expect(config.themeVariables.xyChart.plotColorPalette).toBe('#f5a826, #a9d48b, #6ec9c4');
  });

  it('sets every section color so timelines and mindmaps get distinct sections', () => {
    const vars = mermaidConfig(PALETTE_THEME).themeVariables as Record<string, unknown>;
    for (let i = 0; i < 12; i++) {
      expect(vars[`cScale${i}`]).toBe(PALETTE.scaleFills[i]);
      expect(vars[`cScaleInv${i}`]).toBe(PALETTE.scale[i]);
      expect(vars[`cScalePeer${i}`]).toBe(PALETTE.scale[i]);
      expect(vars[`cScaleLabel${i}`]).toBe(PALETTE.text);
    }
    expect(new Set([vars['cScale0'], vars['cScale1'], vars['cScale2']]).size).toBe(3);
    expect(vars['fillType7']).toBe(PALETTE.scaleFills[7]);
    expect(vars['git0']).toBe(PALETTE.scale[0]);
    expect(vars['gitBranchLabel3']).toBe(PALETTE.background);
  });
});

describe('MarkdownDiagramsDirective', () => {
  @Component({
    standalone: true,
    imports: [MarkdownDiagramsDirective],
    template: '<div appMarkdownDiagrams [innerHTML]="html()"></div>',
  })
  class DirectiveHost {
    html = signal('');
  }

  it('hydrates bound placeholders and re-renders when the app theme changes', async () => {
    const { initialize, render } = stubMermaid();
    const theme = signal<DiagramTheme>(DARK);
    TestBed.configureTestingModule({ providers: [{ provide: DiagramThemeService, useValue: { theme } }] });
    const fixture = TestBed.createComponent(DirectiveHost);
    fixture.detectChanges();

    fixture.componentInstance.html.set(diagramPlaceholderHtml('mermaid', FLOW));
    fixture.detectChanges();
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('svg')).not.toBeNull();
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));

    theme.set(PALETTE_THEME);
    fixture.detectChanges();
    await settle();
    expect(render).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'base' }));
    fixture.destroy();
  });

  it('opens the expanded viewer from a rendered diagram and returns focus to its button', async () => {
    stubMermaid();
    TestBed.configureTestingModule({ providers: [{ provide: DiagramThemeService, useValue: { theme: signal(DARK) } }] });
    const fixture = TestBed.createComponent(DirectiveHost);
    const viewer = TestBed.inject(DiagramViewerService);
    fixture.detectChanges();
    fixture.componentInstance.html.set(diagramPlaceholderHtml('mermaid', FLOW));
    fixture.detectChanges();
    await settle();

    const el = fixture.nativeElement as HTMLElement;
    const button = el.querySelector<HTMLButtonElement>(`.${DIAGRAM_EXPAND_CLASS}`)!;
    button.click();
    const request = viewer.active();
    expect(request?.svg).toContain('<svg');
    expect(request?.svg).not.toContain(`id="${el.querySelector('svg')!.id}"`);
    expect(request?.returnFocus).toBe(button);
    fixture.destroy();
  });
});
