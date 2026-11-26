import { AfterViewInit, Directive, ElementRef, NgZone, OnDestroy, effect, inject, untracked } from '@angular/core';
import { DiagramThemeService } from './diagram-theme.service';
import { installDiagramTooltips } from './diagram-tooltips';
import { DiagramViewerService } from './diagram-viewer.service';
import {
  DIAGRAM_CLASS,
  DIAGRAM_EXPAND_CLASS,
  expandedDiagramSvg,
  hydrateMarkdownDiagrams,
} from './markdown-diagrams';

/**
 * Renders diagram placeholders (see `diagramPlaceholderHtml`) inside rendered markdown.
 *
 * Works with any writer of the host's content (`[innerHTML]`, the streaming reconciler): a
 * MutationObserver picks up new placeholders, and a theme change re-renders the diagrams in the
 * new colors. A rendered diagram's expand button opens it in the full-window {@link DiagramViewerService}.
 * Pie slices show their value and share on hover/focus (see `diagram-tooltips.ts`).
 */
@Directive({
  selector: '[appMarkdownDiagrams]',
  standalone: true,
})
export class MarkdownDiagramsDirective implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly theme = inject(DiagramThemeService).theme;
  private readonly viewer = inject(DiagramViewerService);
  private readonly zone = inject(NgZone);
  private observer: MutationObserver | null = null;

  // The button is inserted outside Angular templates, so clicks are delegated from the host.
  private readonly onClick = (event: MouseEvent): void => {
    const button = (event.target as Element | null)?.closest?.(`.${DIAGRAM_EXPAND_CLASS}`);
    const diagram = button?.closest(`.${DIAGRAM_CLASS}`);
    if (!button || !diagram || !this.host.contains(diagram)) {
      return;
    }
    const svg = expandedDiagramSvg(diagram);
    if (!svg) {
      return;
    }
    event.preventDefault();
    this.zone.run(() => this.viewer.open({ svg, returnFocus: button as HTMLElement }));
  };

  constructor() {
    effect(() => {
      this.theme();
      untracked(() => this.scan());
    });
  }

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      // Document-wide, so the expanded viewer's copy gets slice tooltips too.
      installDiagramTooltips(this.host.ownerDocument);
      this.host.addEventListener('click', this.onClick);
      this.observer = new MutationObserver(() => this.scan());
      this.observer.observe(this.host, { childList: true, subtree: true });
      this.scan();
    });
  }

  ngOnDestroy(): void {
    this.host.removeEventListener('click', this.onClick);
    this.observer?.disconnect();
    this.observer = null;
  }

  private scan(): void {
    // Before ngAfterViewInit the host content is not bound yet; the first observed scan covers it.
    if (!this.observer) {
      return;
    }
    // Only cheap DOM work happens here; rendering itself resolves outside the zone.
    this.zone.runOutsideAngular(() => hydrateMarkdownDiagrams(this.host, untracked(this.theme)));
  }
}
