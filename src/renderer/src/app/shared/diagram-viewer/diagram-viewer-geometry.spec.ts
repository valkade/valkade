import { describe, expect, it } from 'vitest';
import {
  DIAGRAM_VIEWER_MAX_FIT_ZOOM,
  DIAGRAM_VIEWER_MAX_ZOOM,
  DIAGRAM_VIEWER_MIN_ZOOM,
  clampDiagramZoom,
  diagramNaturalSize,
  fillDiagramZoom,
  fitDiagramZoom,
} from './diagram-viewer-geometry';

function svg(attrs: Record<string, string>): Element {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, value);
  }
  return el;
}

describe('diagram viewer geometry', () => {
  it('reads the natural size from the viewBox, ignoring percentage widths', () => {
    expect(diagramNaturalSize(svg({ viewBox: '-8 -8 360 430', width: '100%' }))).toEqual({ width: 360, height: 430 });
    expect(diagramNaturalSize(svg({ viewBox: '0,0,120.5,80' }))).toEqual({ width: 120.5, height: 80 });
  });

  it('falls back to absolute width/height and rejects unusable sizes', () => {
    expect(diagramNaturalSize(svg({ width: '200', height: '100' }))).toEqual({ width: 200, height: 100 });
    expect(diagramNaturalSize(svg({ width: '100%', height: '100' }))).toBeNull();
    expect(diagramNaturalSize(svg({ viewBox: '0 0 0 50' }))).toBeNull();
    expect(diagramNaturalSize(svg({}))).toBeNull();
  });

  it('fits the whole diagram but never enlarges past the fit cap', () => {
    // A tall diagram is limited by height.
    expect(fitDiagramZoom({ width: 400, height: 2000 }, { width: 1000, height: 500 })).toBeCloseTo(0.25);
    // A tiny diagram stops at the cap instead of filling the window.
    expect(fitDiagramZoom({ width: 50, height: 50 }, { width: 1000, height: 1000 })).toBe(DIAGRAM_VIEWER_MAX_FIT_ZOOM);
  });

  it('fills on both axes so the longer one scrolls', () => {
    // A tall diagram fills the width; its height overflows.
    expect(fillDiagramZoom({ width: 400, height: 2000 }, { width: 1000, height: 500 })).toBeCloseTo(2.5);
    // A wide diagram fills the height; its width overflows.
    expect(fillDiagramZoom({ width: 4000, height: 200 }, { width: 1000, height: 500 })).toBeCloseTo(2.5);
  });

  it('clamps zoom and treats a stage without room as 1x', () => {
    expect(clampDiagramZoom(100)).toBe(DIAGRAM_VIEWER_MAX_ZOOM);
    expect(clampDiagramZoom(0.0001)).toBe(DIAGRAM_VIEWER_MIN_ZOOM);
    expect(clampDiagramZoom(Number.NaN)).toBe(1);
    expect(fitDiagramZoom({ width: 10, height: 10 }, { width: -48, height: 0 })).toBe(1);
    expect(fillDiagramZoom({ width: 10, height: 10 }, { width: 0, height: 100 })).toBe(1);
  });
});
