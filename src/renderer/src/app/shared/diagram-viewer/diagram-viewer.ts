import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  ViewEncapsulation,
  afterRenderEffect,
  computed,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { DiagramViewerService } from '../../core/diagram-viewer.service';
import {
  clampDiagramZoom,
  diagramNaturalSize,
  fillDiagramZoom,
  fitDiagramZoom,
  type DiagramSize,
} from './diagram-viewer-geometry';

const ZOOM_STEP = 1.25;
/** Same feel as the image viewer's wheel zoom. */
const WHEEL_ZOOM_SENSITIVITY = 0.0018;
/** Must match `.diagram-viewer__canvas` padding. */
const CANVAS_PADDING_PX = 24;

export type DiagramZoomMode = 'fit' | 'fill' | 'manual';

interface MountedDiagram {
  svg: string;
  stage: HTMLElement;
  el: SVGSVGElement;
  natural: DiagramSize;
}

interface PanDrag {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
}

/**
 * Full-window viewer for a rendered markdown diagram (opened from its expand button).
 *
 * The SVG is sized to `natural × zoom` inside a scrolling stage, so a diagram larger than the
 * window gets real scrollbars; dragging pans by scrolling, Ctrl+wheel / pinch zooms at the pointer.
 */
@Component({
  selector: 'app-diagram-viewer',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (viewer.active()) {
      <div class="diagram-viewer__backdrop" role="presentation" (click)="onBackdrop($event)">
        <div
          class="diagram-viewer__panel"
          role="dialog"
          aria-modal="true"
          aria-label="Diagram viewer"
          (click)="$event.stopPropagation()"
        >
          <div class="diagram-viewer__toolbar">
            <span class="diagram-viewer__title">Diagram</span>
            <div class="diagram-viewer__segment" role="group" aria-label="Zoom controls">
              <button
                type="button"
                class="diagram-viewer__btn diagram-viewer__btn--icon"
                title="Zoom out (-)"
                aria-label="Zoom out"
                (click)="zoomOut()"
              >
                <lucide-icon name="zoom-out" [size]="14" />
              </button>
              <span class="diagram-viewer__readout" aria-live="polite">{{ zoomPercent() }}%</span>
              <button
                type="button"
                class="diagram-viewer__btn diagram-viewer__btn--icon"
                title="Zoom in (+)"
                aria-label="Zoom in"
                (click)="zoomIn()"
              >
                <lucide-icon name="zoom-in" [size]="14" />
              </button>
              <span class="diagram-viewer__divider" aria-hidden="true"></span>
              <button
                type="button"
                class="diagram-viewer__btn"
                [class.is-active]="mode() === 'fit'"
                [attr.aria-pressed]="mode() === 'fit'"
                title="Fit the whole diagram (0)"
                (click)="fit()"
              >
                <lucide-icon name="maximize" [size]="13" />
                <span>Fit</span>
              </button>
              <button
                type="button"
                class="diagram-viewer__btn"
                [class.is-active]="mode() === 'fill'"
                [attr.aria-pressed]="mode() === 'fill'"
                title="Fill the window; scroll the rest (F)"
                (click)="fill()"
              >
                <lucide-icon name="maximize-2" [size]="13" />
                <span>Fill</span>
              </button>
              <button
                type="button"
                class="diagram-viewer__btn"
                [class.is-active]="mode() === 'manual' && zoomPercent() === 100"
                title="Actual size 100% (1)"
                (click)="actualSize()"
              >
                <lucide-icon name="scan" [size]="13" />
                <span>1:1</span>
              </button>
            </div>
            <span class="diagram-viewer__hint">Drag to pan · Ctrl + wheel to zoom</span>
            <button
              type="button"
              class="diagram-viewer__close"
              title="Close (Esc)"
              aria-label="Close"
              (click)="viewer.close()"
            >
              <lucide-icon name="x" [size]="15" />
            </button>
          </div>
          <div
            #stage
            class="diagram-viewer__stage"
            [class.is-panning]="isPanning()"
            tabindex="0"
            aria-label="Diagram, drag to pan"
          >
            <div #canvas class="diagram-viewer__canvas"></div>
          </div>
        </div>
      </div>
    }
  `,
  // The diagram SVG is inserted imperatively, so emulated encapsulation could not style it.
  // Every class is `diagram-viewer__`-prefixed to keep these rules scoped.
  encapsulation: ViewEncapsulation.None,
  styles: `
    app-diagram-viewer {
      display: contents;
    }

    .diagram-viewer__backdrop {
      position: fixed;
      inset: 0;
      z-index: 50000;
      display: flex;
      padding: 1.25rem;
      box-sizing: border-box;
      background: color-mix(in srgb, var(--t-bg-deep, #020402) 72%, transparent);
    }

    .diagram-viewer__panel {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      min-height: 0;
      border: 1px solid var(--t-border, #00ff4133);
      background: var(--t-bg-surface, #0d1a0d);
      color: var(--t-fg, #00ff41);
      box-shadow: var(--t-elev-shadow, 0 10px 28px rgba(0, 0, 0, 0.45));
    }

    .diagram-viewer__toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.6rem;
      padding: 0.4rem 0.45rem 0.4rem 0.8rem;
      border-bottom: 1px solid var(--t-border-subtle, #00ff4122);
      font-size: 0.78rem;
    }

    .diagram-viewer__title {
      font-weight: 600;
    }

    .diagram-viewer__segment {
      display: inline-flex;
      align-items: center;
      gap: 0.15rem;
      padding: 0.15rem;
      border: 1px solid var(--t-border-subtle, #00ff4122);
    }

    .diagram-viewer__btn {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      min-height: 1.6rem;
      padding: 0 0.55rem;
      border: 1px solid transparent;
      background: transparent;
      color: var(--t-text-muted, #00ff4199);
      font: inherit;
      cursor: pointer;
    }

    .diagram-viewer__btn--icon {
      justify-content: center;
      width: 1.75rem;
      padding: 0;
    }

    .diagram-viewer__btn:hover {
      background: var(--t-hover-bg, #00ff4115);
      color: var(--t-fg, #00ff41);
    }

    .diagram-viewer__btn.is-active {
      border-color: color-mix(in srgb, var(--t-primary, #00ff41) 60%, transparent);
      color: var(--t-primary, #00ff41);
    }

    .diagram-viewer__btn:focus-visible,
    .diagram-viewer__close:focus-visible {
      outline: 1px solid var(--t-primary, #00ff41);
      outline-offset: 1px;
    }

    .diagram-viewer__readout {
      min-width: 3.2rem;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }

    .diagram-viewer__divider {
      width: 1px;
      align-self: stretch;
      margin: 0.2rem 0.2rem;
      background: var(--t-border-subtle, #00ff4122);
    }

    .diagram-viewer__hint {
      flex: 1;
      min-width: 0;
      color: var(--t-text-muted, #00ff4199);
      font-size: 0.72rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .diagram-viewer__close {
      display: inline-grid;
      place-items: center;
      width: 1.75rem;
      height: 1.75rem;
      margin-left: auto;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--t-text-muted, #00ff4199);
      cursor: pointer;
    }

    .diagram-viewer__close:hover {
      background: var(--t-hover-bg, #00ff4115);
      color: var(--t-fg, #00ff41);
    }

    .diagram-viewer__stage {
      flex: 1;
      min-height: 0;
      overflow: auto;
      background: var(--t-code-bg, #060a06);
      cursor: grab;
      outline: none;
    }

    .diagram-viewer__stage.is-panning {
      cursor: grabbing;
    }

    .diagram-viewer__stage::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }

    .diagram-viewer__stage::-webkit-scrollbar-track,
    .diagram-viewer__stage::-webkit-scrollbar-corner {
      background: var(--t-bg-deep, #020402);
    }

    .diagram-viewer__stage::-webkit-scrollbar-thumb {
      background: var(--t-border, #00ff4133);
    }

    .diagram-viewer__stage::-webkit-scrollbar-thumb:hover {
      background: var(--t-secondary, #00ff4199);
    }

    /* At least the stage's size so a small diagram centers; grows (and scrolls) with the zoom. */
    .diagram-viewer__canvas {
      box-sizing: border-box;
      display: grid;
      place-items: center;
      width: max-content;
      min-width: 100%;
      min-height: 100%;
      padding: 24px;
      line-height: 1.5;
      user-select: none;
    }

    .diagram-viewer__canvas svg {
      display: block;
      max-width: none;
    }

    .diagram-viewer__canvas svg p {
      margin: 0;
    }
  `,
})
export class DiagramViewerComponent {
  protected readonly viewer = inject(DiagramViewerService);
  private readonly stage = viewChild<ElementRef<HTMLElement>>('stage');
  private readonly canvas = viewChild<ElementRef<HTMLElement>>('canvas');

  protected readonly zoom = signal(1);
  protected readonly mode = signal<DiagramZoomMode>('fit');
  protected readonly isPanning = signal(false);
  protected readonly zoomPercent = computed(() => Math.round(this.zoom() * 100));

  private mounted: MountedDiagram | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private drag: PanDrag | null = null;

  constructor() {
    afterRenderEffect(() => {
      const request = this.viewer.active();
      const stage = this.stage()?.nativeElement;
      const canvas = this.canvas()?.nativeElement;
      untracked(() => {
        if (request && stage && canvas) {
          this.mount(request.svg, stage, canvas);
        } else {
          this.unmount();
        }
      });
    });
    inject(DestroyRef).onDestroy(() => this.unmount());
  }

  @HostListener('document:keydown', ['$event'])
  protected onDocumentKeydown(ev: KeyboardEvent): void {
    if (!this.viewer.active()) {
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.viewer.close();
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) {
      return;
    }
    const actions: Record<string, () => void> = {
      '+': () => this.zoomIn(),
      '=': () => this.zoomIn(),
      '-': () => this.zoomOut(),
      '0': () => this.fit(),
      f: () => this.fill(),
      F: () => this.fill(),
      '1': () => this.actualSize(),
    };
    const action = actions[ev.key];
    if (action) {
      ev.preventDefault();
      action();
    }
  }

  protected onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) {
      this.viewer.close();
    }
  }

  /** Whole diagram visible, centered. */
  fit(): void {
    const m = this.mounted;
    if (!m) {
      return;
    }
    this.mode.set('fit');
    this.applyZoom(fitDiagramZoom(m.natural, this.available(m.stage)));
    m.stage.scrollLeft = 0;
    m.stage.scrollTop = 0;
  }

  /** Fill the stage on both axes; the longer axis scrolls from its start. */
  fill(): void {
    const m = this.mounted;
    if (!m) {
      return;
    }
    this.mode.set('fill');
    // The overflow scrollbar that appears takes space from the other axis: measure twice.
    for (let pass = 0; pass < 2; pass++) {
      this.applyZoom(fillDiagramZoom(m.natural, this.available(m.stage)));
    }
    m.stage.scrollLeft = 0;
    m.stage.scrollTop = 0;
  }

  actualSize(): void {
    this.mode.set('manual');
    this.applyZoom(1);
  }

  zoomIn(): void {
    this.zoomBy(ZOOM_STEP);
  }

  zoomOut(): void {
    this.zoomBy(1 / ZOOM_STEP);
  }

  private zoomBy(factor: number, anchor?: { x: number; y: number }): void {
    this.mode.set('manual');
    this.applyZoom(this.zoom() * factor, anchor);
  }

  private available(stage: HTMLElement): DiagramSize {
    return {
      width: stage.clientWidth - 2 * CANVAS_PADDING_PX,
      height: stage.clientHeight - 2 * CANVAS_PADDING_PX,
    };
  }

  /** Resize the SVG to `zoom`, keeping the diagram point under `anchor` (default: stage center) in place. */
  private applyZoom(next: number, anchor?: { x: number; y: number }): void {
    const m = this.mounted;
    if (!m) {
      return;
    }
    const zoom = clampDiagramZoom(next);
    const { stage, el, natural } = m;
    const stageRect = stage.getBoundingClientRect();
    const x = anchor?.x ?? stageRect.left + stage.clientWidth / 2;
    const y = anchor?.y ?? stageRect.top + stage.clientHeight / 2;
    const before = el.getBoundingClientRect();
    const fx = before.width > 0 ? (x - before.left) / before.width : 0.5;
    const fy = before.height > 0 ? (y - before.top) / before.height : 0.5;
    el.setAttribute('width', String(natural.width * zoom));
    el.setAttribute('height', String(natural.height * zoom));
    const after = el.getBoundingClientRect();
    stage.scrollLeft += after.left + fx * after.width - x;
    stage.scrollTop += after.top + fy * after.height - y;
    this.zoom.set(zoom);
  }

  private mount(svg: string, stage: HTMLElement, canvas: HTMLElement): void {
    if (this.mounted?.svg === svg && this.mounted.stage === stage) {
      return;
    }
    this.unmount();
    canvas.innerHTML = svg;
    const el = canvas.querySelector('svg');
    const natural = el ? diagramNaturalSize(el) : null;
    if (!el || !natural) {
      return;
    }
    // Mermaid caps the inline copy with a max-width; here the zoom decides the size.
    el.style.maxWidth = 'none';
    this.mounted = { svg, stage, el, natural };
    stage.addEventListener('wheel', this.onWheel, { passive: false });
    stage.addEventListener('pointerdown', this.onPointerDown);
    stage.addEventListener('pointermove', this.onPointerMove);
    stage.addEventListener('pointerup', this.onPointerUp);
    stage.addEventListener('pointercancel', this.onPointerUp);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.refit());
      this.resizeObserver.observe(stage);
    }
    this.fit();
    stage.focus({ preventScroll: true });
  }

  private unmount(): void {
    const m = this.mounted;
    if (!m) {
      return;
    }
    m.stage.removeEventListener('wheel', this.onWheel);
    m.stage.removeEventListener('pointerdown', this.onPointerDown);
    m.stage.removeEventListener('pointermove', this.onPointerMove);
    m.stage.removeEventListener('pointerup', this.onPointerUp);
    m.stage.removeEventListener('pointercancel', this.onPointerUp);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.drag = null;
    this.isPanning.set(false);
    this.mounted = null;
  }

  /** Keep Fit / Fill true to the window while it resizes; a manual zoom stays put. */
  private refit(): void {
    const mode = this.mode();
    if (mode === 'fit') {
      this.fit();
    } else if (mode === 'fill') {
      this.fill();
    }
  }

  // Plain wheel scrolls (long diagrams); Ctrl+wheel and trackpad pinch (sent as Ctrl+wheel) zoom.
  private readonly onWheel = (ev: WheelEvent): void => {
    if (!ev.ctrlKey) {
      return;
    }
    ev.preventDefault();
    const deltaY = ev.deltaMode === 1 ? ev.deltaY * 24 : ev.deltaY;
    this.zoomBy(Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY), { x: ev.clientX, y: ev.clientY });
  };

  private readonly onPointerDown = (ev: PointerEvent): void => {
    const stage = this.mounted?.stage;
    if (!stage || (ev.button !== 0 && ev.button !== 1)) {
      return;
    }
    // Leave presses on the scrollbars to the browser.
    const rect = stage.getBoundingClientRect();
    if (ev.clientX - rect.left >= stage.clientLeft + stage.clientWidth
      || ev.clientY - rect.top >= stage.clientTop + stage.clientHeight) {
      return;
    }
    ev.preventDefault();
    stage.focus({ preventScroll: true });
    try {
      stage.setPointerCapture(ev.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
    this.drag = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      scrollLeft: stage.scrollLeft,
      scrollTop: stage.scrollTop,
    };
    this.isPanning.set(true);
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    const drag = this.drag;
    const stage = this.mounted?.stage;
    if (!drag || !stage || ev.pointerId !== drag.pointerId) {
      return;
    }
    stage.scrollLeft = drag.scrollLeft - (ev.clientX - drag.startX);
    stage.scrollTop = drag.scrollTop - (ev.clientY - drag.startY);
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (!this.drag || ev.pointerId !== this.drag.pointerId) {
      return;
    }
    this.drag = null;
    this.isPanning.set(false);
  };
}
