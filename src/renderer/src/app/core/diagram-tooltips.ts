/**
 * Hover and keyboard-focus tooltips for data diagrams: Mermaid `pie` slices and Chart.js
 * pie / doughnut / polarArea slices (see `markdown-charts.ts`).
 *
 * Renderers mark hoverable shapes with `data-md-tip*` attributes at render time, so the marks travel
 * with the cached SVG into every copy (chat, `.md` preview, expanded viewer). One delegated listener
 * set per document ({@link installDiagramTooltips}) shows a themed tooltip at the pointer, or above a
 * keyboard-focused slice, and highlights every shape sharing the hovered key: hovering a legend row
 * lights up its slice.
 */

/** Class on every shape that shows a tooltip. */
export const TIP_TARGET_CLASS = 'md-tip-target';
/** Set while a target in that diagram is hovered/focused (on the outermost `<svg>`). */
export const TIP_ACTIVE_CLASS = 'md-tip-active';
/** Shapes sharing the hovered target's key (the slice and its legend row). */
export const TIP_HOT_CLASS = 'md-tip-hot';
/** The floating tooltip element. */
export const TOOLTIP_CLASS = 'md-diagram-tip';

const LABEL_ATTR = 'data-md-tip';
const DETAIL_ATTR = 'data-md-tip-detail';
const COLOR_ATTR = 'data-md-tip-color';
const KEY_ATTR = 'data-md-tip-key';

/** Gap between the pointer (or focused shape) and the tooltip, and from the viewport edge. */
const POINTER_GAP_PX = 14;
const EDGE_GAP_PX = 8;

// The app UI is English; a fixed locale keeps values and percentages formatted alike.
const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const PERCENT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export interface DataTip {
  label: string;
  value: number;
  /** Sum of the series the value belongs to (the percentage base). */
  total: number;
  /** Links shapes that highlight together (a slice and its legend row). */
  key: string;
  /** Swatch shown in the tooltip. */
  color?: string | null;
}

/** `42 (35.0%)`. */
export function tipDetail(value: number, total: number): string {
  const share = total > 0 ? (value / total) * 100 : 0;
  return `${NUMBER.format(value)} (${PERCENT.format(share)}%)`;
}

/** Marks `el` as a tooltip target; `focusable` puts it in the tab order (slices, not legend rows). */
export function markTipTarget(el: Element, tip: DataTip, focusable: boolean): void {
  const detail = tipDetail(tip.value, tip.total);
  el.classList.add(TIP_TARGET_CLASS);
  el.setAttribute(LABEL_ATTR, tip.label);
  el.setAttribute(DETAIL_ATTR, detail);
  el.setAttribute(KEY_ATTR, tip.key);
  if (tip.color) {
    el.setAttribute(COLOR_ATTR, tip.color);
  }
  if (focusable) {
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `${tip.label}: ${detail}`);
  }
}

/** True when rendered markup under `root` has tooltip targets. */
export function hasTipTargets(root: ParentNode): boolean {
  return root.querySelector(`.${TIP_TARGET_CLASS}`) !== null;
}

export interface PieSection {
  label: string;
  value: number;
}

const PIE_SECTION = /^\s*(?:"([^"]*)"|'([^']*)')\s*:\s*(\d+(?:\.\d+)?)\s*(?:%%.*)?$/;

/** Sections of a Mermaid `pie` source in drawing order; a repeated label keeps its first value, like Mermaid. */
export function pieSections(source: string): PieSection[] {
  let body = source.replace(/\r\n?/g, '\n');
  // YAML frontmatter (`config:` / `title:`) holds no sections.
  const frontmatter = /^\s*---\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(body);
  if (frontmatter) {
    body = body.slice(frontmatter[0].length);
  }
  const sections = new Map<string, number>();
  for (const line of body.split('\n')) {
    const match = PIE_SECTION.exec(line);
    if (!match) {
      continue;
    }
    const label = match[1] ?? match[2] ?? '';
    if (!sections.has(label)) {
      sections.set(label, Number(match[3]));
    }
  }
  return Array.from(sections, ([label, value]) => ({ label, value }));
}

function roundedShare(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(0)}%`;
}

/**
 * Marks the slices and legend rows of a rendered Mermaid pie under `root` with their exact value
 * and share. Mermaid draws no slice for sections under 1%; when the SVG does not line up with the
 * parsed source (a Mermaid change, an unusual source) nothing is marked rather than mislabeled.
 */
export function annotateMermaidPie(root: ParentNode, source: string): void {
  const slices = Array.from(root.querySelectorAll('path.pieCircle'));
  if (!slices.length) {
    return;
  }
  const sections = pieSections(source);
  const total = sections.reduce((sum, section) => sum + section.value, 0);
  if (total <= 0) {
    return;
  }
  // Same filter as Mermaid's pie renderer.
  const drawn = sections.filter((s) => (s.value / total) * 100 >= 1 && roundedShare(s.value, total) !== '0%');
  const shares = Array.from(root.querySelectorAll('text.slice'), (text) => text.textContent?.trim());
  if (drawn.length !== slices.length || drawn.some((s, i) => shares[i] !== roundedShare(s.value, total))) {
    return;
  }
  const colors = new Map<string, string | null>();
  drawn.forEach((section, i) => {
    const slice = slices[i]!;
    const key = String(sections.indexOf(section));
    colors.set(key, slice.getAttribute('fill'));
    markTipTarget(slice, { ...section, total, key, color: colors.get(key) }, true);
  });
  // The percentage labels sit on the slices: let the pointer reach the slice underneath.
  root.querySelectorAll('text.slice').forEach((text) => text.setAttribute('pointer-events', 'none'));
  const legend = Array.from(root.querySelectorAll('g.legend'));
  if (legend.length === sections.length) {
    legend.forEach((row, i) => {
      const key = String(i);
      // Legend swatches carry their color inline (`style="fill: …"`); slices under 1% have no path.
      const inline = /(?:^|;)\s*fill:\s*([^;]+)/.exec(row.querySelector('rect')?.getAttribute('style') ?? '');
      const color = colors.get(key) ?? inline?.[1]?.trim() ?? null;
      markTipTarget(row, { ...sections[i]!, total, key, color }, false);
    });
  }
}

const installed = new WeakSet<Document>();

/** Starts the delegated tooltip for `doc` (idempotent; listeners live as long as the document). */
export function installDiagramTooltips(doc: Document = document): void {
  if (installed.has(doc)) {
    return;
  }
  installed.add(doc);
  new DiagramTooltip(doc);
}

function tipTarget(node: EventTarget | null): Element | null {
  return node instanceof Element ? node.closest(`.${TIP_TARGET_CLASS}`) : null;
}

/** The diagram's root `<svg>` (keys are unique only within one diagram). */
function diagramRoot(el: Element): Element | null {
  let root: Element | null = el.closest('svg');
  while (root?.parentElement?.closest('svg')) {
    root = root.parentElement.closest('svg');
  }
  return root;
}

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    // Engines without :focus-visible: treat every focus as keyboard focus.
    return true;
  }
}

class DiagramTooltip {
  private current: Element | null = null;
  private tip: HTMLElement | null = null;

  constructor(private readonly doc: Document) {
    const capture = { capture: true, passive: true } as const;
    doc.addEventListener('pointerover', this.onPointerOver, capture);
    doc.addEventListener('pointermove', this.onPointerMove, capture);
    doc.addEventListener('pointerout', this.onPointerOut, capture);
    doc.addEventListener('pointerdown', this.hide, capture);
    doc.addEventListener('focusin', this.onFocusIn, capture);
    doc.addEventListener('focusout', this.onFocusOut, capture);
    doc.addEventListener('scroll', this.hide, capture);
    doc.addEventListener('keydown', this.onKeyDown, capture);
  }

  private readonly onPointerOver = (ev: PointerEvent): void => {
    // No tooltips while dragging (the viewer pans by drag).
    const target = ev.buttons ? null : tipTarget(ev.target);
    if (!target) {
      this.hide();
    } else if (target !== this.current) {
      this.show(target);
      this.placeAtPointer(ev.clientX, ev.clientY);
    }
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (!this.current) {
      return;
    }
    if (ev.buttons || !this.current.isConnected || tipTarget(ev.target) !== this.current) {
      this.hide();
      return;
    }
    this.placeAtPointer(ev.clientX, ev.clientY);
  };

  private readonly onPointerOut = (ev: PointerEvent): void => {
    // Leaving the window: no pointerover follows.
    if (!ev.relatedTarget) {
      this.hide();
    }
  };

  private readonly onFocusIn = (ev: FocusEvent): void => {
    const target = tipTarget(ev.target);
    if (target && target === ev.target && isFocusVisible(target)) {
      this.show(target);
      this.placeAtTarget(target);
    }
  };

  private readonly onFocusOut = (ev: FocusEvent): void => {
    if (ev.target === this.current) {
      this.hide();
    }
  };

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      this.hide();
    }
  };

  private show(target: Element): void {
    this.clearHighlight();
    this.current = target;
    const root = diagramRoot(target);
    const key = target.getAttribute(KEY_ATTR);
    if (root && key !== null) {
      root.classList.add(TIP_ACTIVE_CLASS);
      for (const shape of Array.from(root.querySelectorAll(`.${TIP_TARGET_CLASS}`))) {
        if (shape.getAttribute(KEY_ATTR) === key) {
          shape.classList.add(TIP_HOT_CLASS);
        }
      }
    }
    const tip = this.element();
    const swatch = tip.children[0] as HTMLElement;
    const color = target.getAttribute(COLOR_ATTR);
    swatch.hidden = !color;
    swatch.style.background = color ?? '';
    tip.children[1]!.textContent = target.getAttribute(LABEL_ATTR) ?? '';
    tip.children[2]!.textContent = target.getAttribute(DETAIL_ATTR) ?? '';
    tip.hidden = false;
  }

  private readonly hide = (): void => {
    this.clearHighlight();
    this.current = null;
    if (this.tip) {
      this.tip.hidden = true;
    }
  };

  private clearHighlight(): void {
    const root = this.current ? diagramRoot(this.current) : null;
    if (!root) {
      return;
    }
    root.classList.remove(TIP_ACTIVE_CLASS);
    root.querySelectorAll(`.${TIP_HOT_CLASS}`).forEach((shape) => shape.classList.remove(TIP_HOT_CLASS));
  }

  private element(): HTMLElement {
    if (this.tip?.isConnected) {
      return this.tip;
    }
    const tip = this.doc.createElement('div');
    tip.className = TOOLTIP_CLASS;
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    for (const part of ['swatch', 'label', 'detail']) {
      const span = this.doc.createElement('span');
      span.className = `${TOOLTIP_CLASS}__${part}`;
      tip.append(span);
    }
    this.doc.body.append(tip);
    this.tip = tip;
    return tip;
  }

  /** Below-right of the pointer, flipped to the other side near the viewport edges. */
  private placeAtPointer(x: number, y: number): void {
    const tip = this.tip;
    if (!tip || tip.hidden) {
      return;
    }
    const view = this.doc.defaultView;
    const width = view?.innerWidth ?? 0;
    const height = view?.innerHeight ?? 0;
    const { offsetWidth: w, offsetHeight: h } = tip;
    let left = x + POINTER_GAP_PX;
    if (left + w > width - EDGE_GAP_PX) {
      left = x - POINTER_GAP_PX - w;
    }
    let top = y + POINTER_GAP_PX;
    if (top + h > height - EDGE_GAP_PX) {
      top = y - POINTER_GAP_PX - h;
    }
    this.place(Math.max(EDGE_GAP_PX, left), Math.max(EDGE_GAP_PX, top));
  }

  /** Centered above a focused shape (below when there is no room above). */
  private placeAtTarget(target: Element): void {
    const tip = this.tip;
    if (!tip) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const width = this.doc.defaultView?.innerWidth ?? 0;
    const { offsetWidth: w, offsetHeight: h } = tip;
    const left = Math.min(Math.max(EDGE_GAP_PX, rect.left + rect.width / 2 - w / 2), Math.max(EDGE_GAP_PX, width - EDGE_GAP_PX - w));
    const above = rect.top - EDGE_GAP_PX - h;
    this.place(left, above >= EDGE_GAP_PX ? above : rect.bottom + EDGE_GAP_PX);
  }

  private place(left: number, top: number): void {
    this.tip!.style.left = `${Math.round(left)}px`;
    this.tip!.style.top = `${Math.round(top)}px`;
  }
}
