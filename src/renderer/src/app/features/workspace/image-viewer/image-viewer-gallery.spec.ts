import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@shared/index';
import {
  absolutePathForWorkspaceRelative,
  clampZoom,
  computeFilmstripVirtualWindow,
  computeFitScale,
  computeGridVirtualWindow,
  computeZoomPanForPointer,
  filterGalleryPaths,
  formatImageExtension,
  galleryIndexForPath,
  galleryNextIndex,
  galleryPreviousIndex,
  imageFileName,
  isVectorOrIconImagePath,
  parentFolderAbsolutePath,
  parentFolderRelativePath,
  pickGalleryPathAfterRefresh,
  shouldCollapseToolbarToRibbon,
  viewableImagesInDirectory,
  workspaceChangeAffectsGalleryFolder,
} from './image-viewer-gallery';

describe('parentFolderRelativePath', () => {
  it('returns parent folder for nested images', () => {
    expect(parentFolderRelativePath('photos/vacation/img.png')).toBe('photos/vacation');
  });

  it('returns empty string for workspace-root images', () => {
    expect(parentFolderRelativePath('logo.png')).toBe('');
  });

  it('normalizes slashes', () => {
    expect(parentFolderRelativePath('photos\\a.jpg')).toBe('photos');
  });
});

describe('parentFolderAbsolutePath', () => {
  it('joins workspace root with parent folder', () => {
    expect(parentFolderAbsolutePath('/ws', 'photos/a.png')).toBe('/ws/photos');
  });

  it('returns workspace root for root-level images', () => {
    expect(parentFolderAbsolutePath('/ws/', 'logo.png')).toBe('/ws');
  });
});

describe('absolutePathForWorkspaceRelative', () => {
  it('joins workspace root with the image relative path', () => {
    expect(absolutePathForWorkspaceRelative('/ws', 'photos/a.png')).toBe('/ws/photos/a.png');
  });

  it('returns null when root or relative path is missing', () => {
    expect(absolutePathForWorkspaceRelative('', 'a.png')).toBeNull();
    expect(absolutePathForWorkspaceRelative('/ws', null)).toBeNull();
    expect(absolutePathForWorkspaceRelative('/ws', '  ')).toBeNull();
  });
});

describe('viewableImagesInDirectory', () => {
  const root = '/ws';

  it('filters directories and non-viewable files', () => {
    const entries: FileEntry[] = [
      { name: 'readme.txt', path: '/ws/photos/readme.txt', isDirectory: false },
      { name: 'a.png', path: '/ws/photos/a.png', isDirectory: false },
      { name: 'nested', path: '/ws/photos/nested', isDirectory: true },
      { name: 'b.jpg', path: '/ws/photos/b.jpg', isDirectory: false },
      { name: 'icon.svg', path: '/ws/photos/icon.svg', isDirectory: false },
    ];
    expect(viewableImagesInDirectory(entries, root)).toEqual([
      'photos/a.png',
      'photos/b.jpg',
      'photos/icon.svg',
    ]);
  });

  it('sorts by filename', () => {
    const entries: FileEntry[] = [
      { name: 'z.png', path: '/ws/z.png', isDirectory: false },
      { name: 'a.png', path: '/ws/a.png', isDirectory: false },
    ];
    expect(viewableImagesInDirectory(entries, root)).toEqual(['a.png', 'z.png']);
  });
});

describe('galleryIndexForPath', () => {
  const paths = ['photos/a.png', 'photos/b.png'];

  it('finds current image index', () => {
    expect(galleryIndexForPath(paths, 'photos/b.png')).toBe(1);
  });

  it('returns -1 when path is missing', () => {
    expect(galleryIndexForPath(paths, 'photos/c.png')).toBe(-1);
  });
});

describe('gallery wrap navigation', () => {
  it('wraps previous from first to last', () => {
    expect(galleryPreviousIndex(0, 3)).toBe(2);
  });

  it('wraps next from last to first', () => {
    expect(galleryNextIndex(2, 3)).toBe(0);
  });
});

describe('workspaceChangeAffectsGalleryFolder', () => {
  it('matches sibling files in the gallery folder', () => {
    expect(workspaceChangeAffectsGalleryFolder('photos', ['photos/b.png'])).toBe(true);
  });

  it('matches workspace-root gallery for root-level files', () => {
    expect(workspaceChangeAffectsGalleryFolder('', ['logo.png'])).toBe(true);
  });

  it('ignores nested paths under other folders', () => {
    expect(workspaceChangeAffectsGalleryFolder('photos', ['photos/nested/x.png'])).toBe(false);
    expect(workspaceChangeAffectsGalleryFolder('photos', ['other/a.png'])).toBe(false);
  });

  it('treats "." as a full-tree refresh', () => {
    expect(workspaceChangeAffectsGalleryFolder('photos', ['.'])).toBe(true);
  });

  it('matches previousPaths for renames out of the folder', () => {
    expect(
      workspaceChangeAffectsGalleryFolder('photos', ['elsewhere/a.png'], ['photos/a.png']),
    ).toBe(true);
  });

  it('matches when the gallery folder path itself changes', () => {
    expect(workspaceChangeAffectsGalleryFolder('photos', ['photos'], undefined)).toBe(true);
  });
});

describe('pickGalleryPathAfterRefresh', () => {
  const paths = ['photos/a.png', 'photos/b.png', 'photos/c.png'];

  it('keeps the current path when still present', () => {
    expect(pickGalleryPathAfterRefresh(paths, 'photos/b.png', 1)).toBe('photos/b.png');
  });

  it('picks a nearby sibling when the current path was removed', () => {
    const remaining = ['photos/a.png', 'photos/c.png'];
    expect(pickGalleryPathAfterRefresh(remaining, 'photos/b.png', 1)).toBe('photos/c.png');
  });

  it('clamps to the last sibling when the removed index was at the end', () => {
    const remaining = ['photos/a.png', 'photos/b.png'];
    expect(pickGalleryPathAfterRefresh(remaining, 'photos/c.png', 2)).toBe('photos/b.png');
  });

  it('returns null for an empty gallery', () => {
    expect(pickGalleryPathAfterRefresh([], 'photos/a.png', 0)).toBeNull();
  });
});

describe('image metadata & filtering helpers', () => {
  it('extracts filenames, format badges, and icon-like types', () => {
    expect(imageFileName('docs/media/banner.jpeg')).toBe('banner.jpeg');
    expect(formatImageExtension('docs/media/banner.jpeg')).toBe('JPG');
    expect(formatImageExtension('logo.svg')).toBe('SVG');
    expect(formatImageExtension('noext')).toBe('');
    expect(isVectorOrIconImagePath('icons/app.svg')).toBe(true);
    expect(isVectorOrIconImagePath('favicon.ico')).toBe(true);
    expect(isVectorOrIconImagePath('photo.png')).toBe(false);
  });

  it('filters gallery paths case-insensitively by filename', () => {
    const paths = ['a/Hero.png', 'a/Thumb.webp', 'a/banner-hero.jpg'];
    expect(filterGalleryPaths(paths, '')).toEqual(paths);
    expect(filterGalleryPaths(paths, 'HERO')).toEqual(['a/Hero.png', 'a/banner-hero.jpg']);
    expect(filterGalleryPaths(paths, 'missing')).toEqual([]);
  });
});

describe('zoom, fit scale, and cursor-anchored pan helpers', () => {
  it('clamps zoom to viewer bounds', () => {
    expect(clampZoom(0.01)).toBe(0.1);
    expect(clampZoom(100)).toBe(16);
    expect(clampZoom(2.5)).toBe(2.5);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('computes fit scale accounting for 90-degree rotation without upscaling', () => {
    expect(computeFitScale(1000, 500, 500, 500, 0)).toBeCloseTo(0.5);
    expect(computeFitScale(1000, 500, 500, 250, 90)).toBeCloseTo(0.25);
    expect(computeFitScale(200, 100, 800, 600, 0)).toBe(1);
  });

  it('preserves the image point under the pointer when zooming', () => {
    const next = computeZoomPanForPointer({
      currentZoom: 1,
      nextZoom: 2,
      panX: 0,
      panY: 0,
      pointerOffsetX: 100,
      pointerOffsetY: -50,
    });
    expect(next).toEqual({ panX: -100, panY: 50 });
  });
});

describe('virtualization windows', () => {
  it('computes a bounded horizontal window for large filmstrips', () => {
    const win = computeFilmstripVirtualWindow({
      itemCount: 2000,
      itemSizePx: 64,
      gapPx: 8,
      viewportWidthPx: 720,
      scrollLeftPx: 7200,
      overscan: 6,
    });
    // Stride = 72, scrollLeft 7200 -> firstVisible = 100, visibleCount = 11
    expect(win.start).toBe(94);
    expect(win.end).toBe(117);
    expect(win.totalWidthPx).toBe(2000 * 64 + 1999 * 8);
  });

  it('computes a bounded vertical row window for contact-sheet grids', () => {
    const win = computeGridVirtualWindow({
      itemCount: 500,
      columns: 5,
      rowHeightPx: 160,
      gapPx: 10,
      viewportHeightPx: 510,
      scrollTopPx: 1700,
      overscanRows: 2,
    });
    // rowStride = 170, firstRow = 10, visibleRows = 4 -> startRow 8 (idx 40), endRow 16 (idx 80)
    expect(win.startIndex).toBe(40);
    expect(win.endIndex).toBe(80);
    expect(win.totalHeightPx).toBe(100 * 160 + 99 * 10);
  });

  it('clamps empty galleries cleanly', () => {
    expect(
      computeFilmstripVirtualWindow({
        itemCount: 0,
        itemSizePx: 64,
        gapPx: 8,
        viewportWidthPx: 500,
        scrollLeftPx: 0,
      }),
    ).toEqual({ start: 0, end: 0, totalWidthPx: 0 });
    expect(
      computeGridVirtualWindow({
        itemCount: 0,
        columns: 4,
        rowHeightPx: 150,
        gapPx: 10,
        viewportHeightPx: 500,
        scrollTopPx: 0,
      }),
    ).toEqual({ startIndex: 0, endIndex: 0, totalHeightPx: 0 });
  });
});

describe('shouldCollapseToolbarToRibbon', () => {
  it('stays inline when toolbar width fits file identity and controls', () => {
    expect(
      shouldCollapseToolbarToRibbon({
        toolbarWidthPx: 920,
        fileMinWidthPx: 180,
        controlsWidthPx: 640,
        chromeAllowancePx: 32,
        hysteresisPx: 14,
        currentlyOverflowing: false,
      }),
    ).toBe(false);
  });

  it('collapses to ribbon when toolbar width falls below needed width', () => {
    expect(
      shouldCollapseToolbarToRibbon({
        toolbarWidthPx: 840,
        fileMinWidthPx: 180,
        controlsWidthPx: 640,
        chromeAllowancePx: 32,
        hysteresisPx: 14,
        currentlyOverflowing: false,
      }),
    ).toBe(true);
  });

  it('applies hysteresis before returning to inline mode', () => {
    // Needed = 180 + 640 + 32 = 852; with hysteresis 14 -> stays overflowing until >= 866
    expect(
      shouldCollapseToolbarToRibbon({
        toolbarWidthPx: 860,
        fileMinWidthPx: 180,
        controlsWidthPx: 640,
        chromeAllowancePx: 32,
        hysteresisPx: 14,
        currentlyOverflowing: true,
      }),
    ).toBe(true);

    expect(
      shouldCollapseToolbarToRibbon({
        toolbarWidthPx: 868,
        fileMinWidthPx: 180,
        controlsWidthPx: 640,
        chromeAllowancePx: 32,
        hysteresisPx: 14,
        currentlyOverflowing: true,
      }),
    ).toBe(false);
  });

  it('returns false when layout measurements are not ready yet', () => {
    expect(
      shouldCollapseToolbarToRibbon({
        toolbarWidthPx: 0,
        fileMinWidthPx: 180,
        controlsWidthPx: 640,
        currentlyOverflowing: false,
      }),
    ).toBe(false);
  });
});
