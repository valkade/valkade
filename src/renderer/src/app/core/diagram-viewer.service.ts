import { Injectable, signal } from '@angular/core';

/** A diagram shown in the expanded viewer overlay. */
export interface DiagramViewerRequest {
  /** Sanitized SVG markup (see `expandedDiagramSvg`); ids are unique to this copy. */
  svg: string;
  /** Element to refocus when the viewer closes (the expand button that opened it). */
  returnFocus?: HTMLElement | null;
}

/** Opens rendered markdown diagrams in the full-window viewer (`app-diagram-viewer`). */
@Injectable({ providedIn: 'root' })
export class DiagramViewerService {
  /** When non-null, the viewer overlay is shown. */
  readonly active = signal<DiagramViewerRequest | null>(null);

  open(request: DiagramViewerRequest): void {
    this.active.set(request);
  }

  close(): void {
    const current = this.active();
    if (!current) {
      return;
    }
    this.active.set(null);
    if (current.returnFocus?.isConnected) {
      current.returnFocus.focus();
    }
  }
}
