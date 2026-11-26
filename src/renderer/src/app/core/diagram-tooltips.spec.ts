import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  TIP_ACTIVE_CLASS,
  TIP_HOT_CLASS,
  TIP_TARGET_CLASS,
  TOOLTIP_CLASS,
  annotateMermaidPie,
  installDiagramTooltips,
  pieSections,
  tipDetail,
} from './diagram-tooltips';

/** Markup shaped like Mermaid's pie renderer: slices and their % labels, then one legend row per section. */
function mermaidPie(sections: Array<[label: string, value: number]>): string {
  const total = sections.reduce((sum, [, value]) => sum + value, 0);
  const drawn = sections.filter(([, value]) => (value / total) * 100 >= 1);
  const colors = ['#f5a826', '#a9d48b', '#6ec9c4', '#ffde82'];
  return '<svg aria-roledescription="pie"><g><g>'
    + drawn.map(([label]) => `<path class="pieCircle" fill="${colors[sections.findIndex(([l]) => l === label)]}" d="M0 0"></path>`).join('')
    + drawn.map(([, value]) => `<text class="slice">${((value / total) * 100).toFixed(0)}%</text>`).join('')
    + '</g>'
    + sections.map(([label], i) => `<g class="legend"><rect style="fill: ${colors[i]}; stroke: ${colors[i]};"></rect><text>${label}</text></g>`).join('')
    + '</g></svg>';
}

function pieHost(source: string, sections: Array<[string, number]>): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = mermaidPie(sections);
  annotateMermaidPie(host, source);
  document.body.append(host);
  return host;
}

const PIE = 'pie title Languages\n  "Rust" : 42\n  "Go" : 30\n  \'TS\' : 47.5\n  "Tiny" : 0.5\n';
const PIE_SECTIONS: Array<[string, number]> = [['Rust', 42], ['Go', 30], ['TS', 47.5], ['Tiny', 0.5]];

function pointer(type: string, target: Element, init: MouseEventInit = {}): void {
  const Ctor = (window as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  target.dispatchEvent(new Ctor(type, { bubbles: true, clientX: 100, clientY: 80, ...init }));
}

function tooltip(): HTMLElement | null {
  return document.querySelector(`.${TOOLTIP_CLASS}`);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('tip text', () => {
  it('shows the value and its share with one decimal', () => {
    expect(tipDetail(42, 120)).toBe('42 (35.0%)');
    expect(tipDetail(1234.5, 1234.5)).toBe('1,234.5 (100.0%)');
    expect(tipDetail(0, 0)).toBe('0 (0.0%)');
  });
});

describe('pieSections', () => {
  it('reads quoted sections in order, keeping the first of a repeated label', () => {
    const source = '---\nconfig:\n  pie:\n    "textPosition": 0.5\n---\npie showData\n  title "Pets"\n'
      + '  "Dogs" : 386 %% most\n  \'Cats\': 85.9\n  "Dogs" : 1\n  accTitle: x\n';
    expect(pieSections(source)).toEqual([{ label: 'Dogs', value: 386 }, { label: 'Cats', value: 85.9 }]);
  });
});

describe('annotateMermaidPie', () => {
  it('marks drawn slices and every legend row with exact values', () => {
    const host = pieHost(PIE, PIE_SECTIONS);
    const slices = Array.from(host.querySelectorAll('path.pieCircle'));
    expect(slices).toHaveLength(3);
    expect(slices.map((s) => s.getAttribute('data-md-tip'))).toEqual(['Rust', 'Go', 'TS']);
    expect(slices[0]!.getAttribute('data-md-tip-detail')).toBe('42 (35.0%)');
    expect(slices[0]!.getAttribute('aria-label')).toBe('Rust: 42 (35.0%)');
    expect(slices[0]!.getAttribute('tabindex')).toBe('0');
    expect(slices[2]!.getAttribute('data-md-tip-key')).toBe('2');
    expect(slices[2]!.getAttribute('data-md-tip-color')).toBe('#6ec9c4');

    const legend = Array.from(host.querySelectorAll('g.legend'));
    // Mermaid draws no slice under 1%, but the legend row still reports it.
    expect(legend[3]!.getAttribute('data-md-tip-detail')).toBe('0.5 (0.4%)');
    expect(legend[3]!.getAttribute('data-md-tip-color')).toBe('#ffde82');
    expect(legend[3]!.hasAttribute('tabindex')).toBe(false);
    expect(host.querySelector('text.slice')?.getAttribute('pointer-events')).toBe('none');
  });

  it('marks nothing when the SVG does not match the source', () => {
    const host = pieHost('pie\n  "Rust" : 42\n  "Go" : 60\n', [['Rust', 42], ['Go', 30]]);
    expect(host.querySelector(`.${TIP_TARGET_CLASS}`)).toBeNull();
    const other = pieHost('graph TD\n  A-->B', [['Rust', 42], ['Go', 30]]);
    expect(other.querySelector(`.${TIP_TARGET_CLASS}`)).toBeNull();
  });
});

describe('installDiagramTooltips', () => {
  beforeAll(() => {
    installDiagramTooltips(document);
    // Idempotent: a second directive must not double the listeners.
    installDiagramTooltips(document);
  });

  it('shows a tooltip on hover and highlights the slice with its legend row', () => {
    const host = pieHost(PIE, PIE_SECTIONS);
    const svg = host.querySelector('svg')!;
    const [rust, go] = Array.from(host.querySelectorAll('path.pieCircle'));
    const legend = Array.from(host.querySelectorAll('g.legend'));

    pointer('pointerover', rust!);
    const tip = tooltip()!;
    expect(tip.hidden).toBe(false);
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.querySelector(`.${TOOLTIP_CLASS}__label`)?.textContent).toBe('Rust');
    expect(tip.querySelector(`.${TOOLTIP_CLASS}__detail`)?.textContent).toBe('42 (35.0%)');
    expect(tip.style.left).toBe('114px');
    expect(svg.classList.contains(TIP_ACTIVE_CLASS)).toBe(true);
    expect(rust!.classList.contains(TIP_HOT_CLASS)).toBe(true);
    expect(legend[0]!.classList.contains(TIP_HOT_CLASS)).toBe(true);
    expect(go!.classList.contains(TIP_HOT_CLASS)).toBe(false);

    // Hovering a legend row (via its text) highlights that row's slice instead.
    pointer('pointerover', legend[1]!.querySelector('text')!);
    expect(tip.querySelector(`.${TOOLTIP_CLASS}__label`)?.textContent).toBe('Go');
    expect(go!.classList.contains(TIP_HOT_CLASS)).toBe(true);
    expect(rust!.classList.contains(TIP_HOT_CLASS)).toBe(false);

    pointer('pointerover', host);
    expect(tip.hidden).toBe(true);
    expect(svg.classList.contains(TIP_ACTIVE_CLASS)).toBe(false);
    expect(host.querySelector(`.${TIP_HOT_CLASS}`)).toBeNull();
  });

  it('stays hidden while dragging and hides on press and Escape', () => {
    const host = pieHost(PIE, PIE_SECTIONS);
    const rust = host.querySelector('path.pieCircle')!;
    pointer('pointerover', rust, { buttons: 1 });
    expect(tooltip()?.hidden ?? true).toBe(true);

    pointer('pointerover', rust);
    expect(tooltip()!.hidden).toBe(false);
    pointer('pointerdown', rust);
    expect(tooltip()!.hidden).toBe(true);

    pointer('pointerover', host);
    pointer('pointerover', rust);
    expect(tooltip()!.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tooltip()!.hidden).toBe(true);
  });

  it('shows the tooltip for a keyboard-focused slice', () => {
    const host = pieHost(PIE, PIE_SECTIONS);
    const ts = host.querySelectorAll('path.pieCircle')[2] as SVGElement;
    vi.spyOn(ts, 'matches').mockImplementation((selector: string) => selector === ':focus-visible');
    ts.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(tooltip()!.hidden).toBe(false);
    expect(tooltip()!.querySelector(`.${TOOLTIP_CLASS}__label`)?.textContent).toBe('TS');
    ts.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(tooltip()!.hidden).toBe(true);
  });
});
