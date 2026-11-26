import type { FileEntry } from '@shared/index';
import {
  normalizePathSlashes,
  workspaceRelativePathIfUnderRoot,
} from '../../../utils/workspace-relative-path';
import { isViewableImagePath } from './image-viewer-formats';

/** Workspace-relative parent folder of an image path (`photos/a.png` → `photos`, root image → ``). */
export function parentFolderRelativePath(imageRelativePath: string): string {
  const norm = normalizePathSlashes(imageRelativePath).replace(/^\/+/, '');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(0, i) : '';
}

/** Absolute path of the parent folder for `read-directory` IPC. */
export function parentFolderAbsolutePath(workspaceRoot: string, imageRelativePath: string): string {
  const root = normalizePathSlashes(workspaceRoot).replace(/\/+$/, '');
  const parentRel = parentFolderRelativePath(imageRelativePath);
  if (!parentRel) {
    return root;
  }
  return `${root}/${parentRel}`;
}

/** Absolute on-disk path for a workspace-relative image, or null when inputs are empty. */
export function absolutePathForWorkspaceRelative(
  workspaceRoot: string,
  relativePath: string | null | undefined,
): string | null {
  const root = normalizePathSlashes(workspaceRoot.trim()).replace(/\/+$/, '');
  const rel = relativePath?.trim();
  if (!root || !rel) {
    return null;
  }
  const normRel = normalizePathSlashes(rel).replace(/^\/+/, '');
  if (!normRel) {
    return null;
  }
  return `${root}/${normRel}`;
}

/** Viewable image paths in a directory listing, sorted by filename. */
export function viewableImagesInDirectory(
  entries: readonly FileEntry[],
  workspaceRoot: string,
): string[] {
  const root = workspaceRoot.trim();
  if (!root) {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory || !isViewableImagePath(entry.name)) {
      continue;
    }
    const rel = workspaceRelativePathIfUnderRoot(root, entry.path);
    if (rel !== null) {
      paths.push(normalizePathSlashes(rel));
    }
  }
  paths.sort((a, b) => {
    const nameA = a.slice(a.lastIndexOf('/') + 1);
    const nameB = b.slice(b.lastIndexOf('/') + 1);
    return nameA.localeCompare(nameB);
  });
  return paths;
}

/** Index of `relativePath` in a sorted gallery list, or -1 when missing. */
export function galleryIndexForPath(paths: readonly string[], relativePath: string): number {
  const norm = normalizePathSlashes(relativePath);
  return paths.findIndex((p) => normalizePathSlashes(p) === norm);
}

/** Wrap-aware previous index in a gallery list. */
export function galleryPreviousIndex(currentIndex: number, length: number): number {
  if (length <= 0) {
    return -1;
  }
  return currentIndex <= 0 ? length - 1 : currentIndex - 1;
}

/** Wrap-aware next index in a gallery list. */
export function galleryNextIndex(currentIndex: number, length: number): number {
  if (length <= 0) {
    return -1;
  }
  return currentIndex >= length - 1 ? 0 : currentIndex + 1;
}

/**
 * Whether a workspace-files-changed payload may alter the flat gallery listing for
 * `galleryFolderRel` (`''` = workspace root). Nested paths under other folders are ignored.
 */
export function workspaceChangeAffectsGalleryFolder(
  galleryFolderRel: string,
  paths: readonly string[],
  previousPaths?: readonly string[],
): boolean {
  const folder = normalizePathSlashes(galleryFolderRel).replace(/^\/+/, '');
  const candidates = previousPaths?.length ? [...paths, ...previousPaths] : paths;
  for (const raw of candidates) {
    const p = normalizePathSlashes(raw).replace(/^\/+/, '');
    if (!p || p === '.') {
      return true;
    }
    if (p === folder || parentFolderRelativePath(p) === folder) {
      return true;
    }
  }
  return false;
}

/**
 * After a gallery refresh, keep the current image when still present; otherwise pick a
 * nearby sibling using the pre-refresh index (clamped). Returns null when the gallery is empty.
 */
export function pickGalleryPathAfterRefresh(
  paths: readonly string[],
  currentRelativePath: string,
  previousIndex: number,
): string | null {
  if (paths.length === 0) {
    return null;
  }
  const currentIndex = galleryIndexForPath(paths, currentRelativePath);
  if (currentIndex >= 0) {
    return paths[currentIndex] ?? null;
  }
  const idx = Math.min(Math.max(previousIndex, 0), paths.length - 1);
  return paths[idx] ?? null;
}

export const AUTO_PLAY_INTERVAL_OPTIONS_MS: readonly number[] = [2000, 3000, 5000, 10000] as const;

export const IMAGE_VIEWER_MIN_ZOOM = 0.1;
export const IMAGE_VIEWER_MAX_ZOOM = 16;

/** Basename of a workspace-relative image path (`photos/hero.png` → `hero.png`). */
export function imageFileName(relativePath: string | null | undefined): string {
  if (!relativePath) {
    return '';
  }
  const norm = normalizePathSlashes(relativePath);
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/** Short uppercase format label (`photos/hero.webp` → `WEBP`, `a.jpeg` → `JPG`). */
export function formatImageExtension(relativePath: string | null | undefined): string {
  const name = imageFileName(relativePath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return '';
  }
  const ext = name.slice(dot + 1).toUpperCase();
  return ext === 'JPEG' ? 'JPG' : ext;
}

/** Vector / icon images read better with `object-fit: contain` inside square thumbnails. */
export function isVectorOrIconImagePath(relativePath: string | null | undefined): boolean {
  const name = imageFileName(relativePath).toLowerCase();
  return name.endsWith('.svg') || name.endsWith('.ico');
}

/** Case-insensitive filename filter for the contact-sheet grid view. */
export function filterGalleryPaths(paths: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...paths];
  }
  return paths.filter((p) => imageFileName(p).toLowerCase().includes(needle));
}

/** Clamp a zoom factor to viewer bounds. */
export function clampZoom(
  zoom: number,
  min = IMAGE_VIEWER_MIN_ZOOM,
  max = IMAGE_VIEWER_MAX_ZOOM,
): number {
  if (!Number.isFinite(zoom)) {
    return 1;
  }
  return Math.min(max, Math.max(min, zoom));
}

/**
 * Scale factor that fits `naturalWidth × naturalHeight` (at `rotationDeg`) inside
 * `stageWidth × stageHeight` without upscaling past 1×.
 */
export function computeFitScale(
  naturalWidth: number,
  naturalHeight: number,
  stageWidth: number,
  stageHeight: number,
  rotationDeg = 0,
): number {
  if (naturalWidth <= 0 || naturalHeight <= 0 || stageWidth <= 0 || stageHeight <= 0) {
    return 1;
  }
  const normalizedRot = ((rotationDeg % 360) + 360) % 360;
  const swapped = normalizedRot === 90 || normalizedRot === 270;
  const effW = swapped ? naturalHeight : naturalWidth;
  const effH = swapped ? naturalWidth : naturalHeight;
  return Math.min(stageWidth / effW, stageHeight / effH, 1);
}

/**
 * Compute updated center-relative pan offsets when zooming around a pointer position
 * relative to the stage center (`pointerOffsetX`, `pointerOffsetY`).
 */
export function computeZoomPanForPointer(params: {
  currentZoom: number;
  nextZoom: number;
  panX: number;
  panY: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
}): { panX: number; panY: number } {
  const { currentZoom, nextZoom, panX, panY, pointerOffsetX, pointerOffsetY } = params;
  if (currentZoom <= 0 || nextZoom <= 0) {
    return { panX, panY };
  }
  const ratio = nextZoom / currentZoom;
  return {
    panX: pointerOffsetX - (pointerOffsetX - panX) * ratio,
    panY: pointerOffsetY - (pointerOffsetY - panY) * ratio,
  };
}

export interface FilmstripVirtualWindow {
  start: number;
  end: number;
  totalWidthPx: number;
}

/** Compute the horizontal virtual window `[start, end)` for a uniform-width filmstrip. */
export function computeFilmstripVirtualWindow(params: {
  itemCount: number;
  itemSizePx: number;
  gapPx: number;
  viewportWidthPx: number;
  scrollLeftPx: number;
  overscan?: number;
}): FilmstripVirtualWindow {
  const { itemCount, itemSizePx, gapPx, viewportWidthPx, scrollLeftPx } = params;
  const overscan = Math.max(0, params.overscan ?? 8);
  if (itemCount <= 0 || itemSizePx <= 0) {
    return { start: 0, end: 0, totalWidthPx: 0 };
  }
  const stride = itemSizePx + Math.max(0, gapPx);
  const totalWidthPx = itemCount * itemSizePx + Math.max(0, itemCount - 1) * Math.max(0, gapPx);
  const safeViewport = Math.max(viewportWidthPx, stride);
  const safeScroll = Math.max(0, scrollLeftPx);
  const firstVisible = Math.floor(safeScroll / stride);
  const visibleCount = Math.ceil(safeViewport / stride) + 1;
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(itemCount, firstVisible + visibleCount + overscan);
  return { start, end, totalWidthPx };
}

export interface GridVirtualWindow {
  startIndex: number;
  endIndex: number;
  totalHeightPx: number;
}

/** Compute the row-based virtual window `[startIndex, endIndex)` for the contact-sheet grid. */
export function computeGridVirtualWindow(params: {
  itemCount: number;
  columns: number;
  rowHeightPx: number;
  gapPx: number;
  viewportHeightPx: number;
  scrollTopPx: number;
  overscanRows?: number;
}): GridVirtualWindow {
  const { itemCount, rowHeightPx, gapPx, viewportHeightPx, scrollTopPx } = params;
  const columns = Math.max(1, Math.floor(params.columns));
  const overscanRows = Math.max(0, params.overscanRows ?? 3);
  if (itemCount <= 0 || rowHeightPx <= 0) {
    return { startIndex: 0, endIndex: 0, totalHeightPx: 0 };
  }
  const totalRows = Math.ceil(itemCount / columns);
  const rowStride = rowHeightPx + Math.max(0, gapPx);
  const totalHeightPx = totalRows * rowHeightPx + Math.max(0, totalRows - 1) * Math.max(0, gapPx);
  const safeViewport = Math.max(viewportHeightPx, rowStride);
  const safeScroll = Math.max(0, scrollTopPx);
  const firstRow = Math.floor(safeScroll / rowStride);
  const visibleRows = Math.ceil(safeViewport / rowStride) + 1;
  const startRow = Math.max(0, firstRow - overscanRows);
  const endRow = Math.min(totalRows, firstRow + visibleRows + overscanRows);
  return {
    startIndex: startRow * columns,
    endIndex: Math.min(itemCount, endRow * columns),
    totalHeightPx,
  };
}

/**
 * Decide whether the image viewer's top toolbar should collapse its controls into
 * an expandable ribbon. Applies hysteresis so resizing on the threshold never flickers.
 */
export function shouldCollapseToolbarToRibbon(params: {
  toolbarWidthPx: number;
  fileMinWidthPx: number;
  controlsWidthPx: number;
  chromeAllowancePx?: number;
  hysteresisPx?: number;
  currentlyOverflowing: boolean;
}): boolean {
  const { toolbarWidthPx, fileMinWidthPx, controlsWidthPx, currentlyOverflowing } = params;
  if (toolbarWidthPx <= 0 || controlsWidthPx <= 0) {
    return false;
  }
  const chrome = Math.max(0, params.chromeAllowancePx ?? 32);
  const hysteresis = Math.max(0, params.hysteresisPx ?? 14);
  const needed = Math.max(0, fileMinWidthPx) + controlsWidthPx + chrome;
  return currentlyOverflowing
    ? toolbarWidthPx < needed + hysteresis
    : toolbarWidthPx < needed;
}
