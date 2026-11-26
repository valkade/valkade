/** Zoom bounds for the expanded diagram viewer. */
export const DIAGRAM_VIEWER_MIN_ZOOM = 0.05;
export const DIAGRAM_VIEWER_MAX_ZOOM = 8;
/** Fit never enlarges a small diagram past this; Fill is the way to blow one up. */
export const DIAGRAM_VIEWER_MAX_FIT_ZOOM = 2;

export interface DiagramSize {
  width: number;
  height: number;
}

export function clampDiagramZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) {
    return 1;
  }
  return Math.min(DIAGRAM_VIEWER_MAX_ZOOM, Math.max(DIAGRAM_VIEWER_MIN_ZOOM, zoom));
}

function positive(value: string | null | undefined): number {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Natural (1×) size of a rendered diagram. Mermaid emits `width="100%"` plus a `viewBox`, so the
 * viewBox is authoritative; absolute width/height attributes are the fallback.
 */
export function diagramNaturalSize(svg: Element): DiagramSize | null {
  const box = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/);
  if (box.length === 4) {
    const width = positive(box[2]);
    const height = positive(box[3]);
    if (width && height) {
      return { width, height };
    }
  }
  const width = /%$/.test(svg.getAttribute('width') ?? '') ? 0 : positive(svg.getAttribute('width'));
  const height = /%$/.test(svg.getAttribute('height') ?? '') ? 0 : positive(svg.getAttribute('height'));
  return width && height ? { width, height } : null;
}

/** Largest zoom that shows the whole diagram inside `available` (capped at {@link DIAGRAM_VIEWER_MAX_FIT_ZOOM}). */
export function fitDiagramZoom(natural: DiagramSize, available: DiagramSize): number {
  if (available.width <= 0 || available.height <= 0) {
    return 1;
  }
  const zoom = Math.min(available.width / natural.width, available.height / natural.height);
  return clampDiagramZoom(Math.min(zoom, DIAGRAM_VIEWER_MAX_FIT_ZOOM));
}

/** Zoom that fills `available` on both axes; the longer axis overflows and scrolls. */
export function fillDiagramZoom(natural: DiagramSize, available: DiagramSize): number {
  if (available.width <= 0 || available.height <= 0) {
    return 1;
  }
  return clampDiagramZoom(Math.max(available.width / natural.width, available.height / natural.height));
}
