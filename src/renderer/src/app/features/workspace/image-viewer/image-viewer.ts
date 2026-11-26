import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  NgZone,
  OnDestroy,
  output,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideAngularModule } from 'lucide-angular';
import type { WorkspaceFilesChangedMessage } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import { populateWorkspacePathDragData } from '../../chat/chat-context-bar/chat-context-file';
import { buildWorkspaceImageAssetUrl } from './image-viewer-asset-url';
import {
  absolutePathForWorkspaceRelative,
  AUTO_PLAY_INTERVAL_OPTIONS_MS,
  clampZoom,
  computeFilmstripVirtualWindow,
  computeFitScale,
  computeGridVirtualWindow,
  computeZoomPanForPointer,
  formatImageExtension,
  galleryIndexForPath,
  galleryNextIndex,
  galleryPreviousIndex,
  IMAGE_VIEWER_MAX_ZOOM,
  IMAGE_VIEWER_MIN_ZOOM,
  imageFileName,
  isVectorOrIconImagePath,
  parentFolderAbsolutePath,
  parentFolderRelativePath,
  pickGalleryPathAfterRefresh,
  shouldCollapseToolbarToRibbon,
  viewableImagesInDirectory,
  workspaceChangeAffectsGalleryFolder,
} from './image-viewer-gallery';
import { isViewableImagePath } from './image-viewer-formats';
import { ImagePreloadCache } from './image-viewer-preloader';

const ZOOM_STEP = 1.25;
const WHEEL_ZOOM_SENSITIVITY = 0.0018;

/** Default / clamp range for the thumbnail gallery strip height (px). */
const DEFAULT_GALLERY_HEIGHT_PX = 84;
const MIN_GALLERY_HEIGHT_PX = 60;
const MAX_GALLERY_HEIGHT_PX = 240;
/** Vertical padding inside `.image-viewer-thumbs` (10px top + 10px bottom). */
const GALLERY_THUMBS_PADDING_Y_PX = 20;
const MIN_THUMB_SIZE_PX = 44;
const MAX_THUMB_SIZE_PX = 216;
const THUMB_GAP_PX = 8;
const THUMB_PAD_X_PX = 12;

/** Contact-sheet grid layout metrics. */
const GRID_PAD_PX = 16;
const GRID_GAP_PX = 10;
const GRID_LABEL_HEIGHT_PX = 28;
const GRID_TILE_TARGET_WIDTH: Record<GridTilePreset, number> = {
  sm: 132,
  md: 178,
  lg: 244,
};

const MAX_FOLDER_CACHE_ENTRIES = 10;

/** Minimum comfortable width reserved for file badge + filename + dimensions before ribbon collapse. */
const TOOLBAR_FILE_MIN_WIDTH_PX = 180;
const TOOLBAR_CHROME_ALLOWANCE_PX = 36;
const TOOLBAR_RIBBON_GAP_PX = 8;
const TOOLBAR_OVERFLOW_HYSTERESIS_PX = 14;

export type StageBackdropMode = 'checker' | 'dark' | 'light';
export type GalleryViewMode = 'viewer' | 'grid';
export type GridTilePreset = 'sm' | 'md' | 'lg';

export interface GalleryItem {
  index: number;
  path: string;
  normalizedPath: string;
  name: string;
  ext: string;
  thumbUrl: string;
  isIconLike: boolean;
}

export interface PositionedFilmstripItem extends GalleryItem {
  offsetX: number;
}

export interface PositionedGridItem extends GalleryItem {
  gridThumbUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const AUTO_PLAY_SELECT_OPTIONS: readonly { id: string; label: string }[] =
  AUTO_PLAY_INTERVAL_OPTIONS_MS.map((intervalMs) => ({
    id: String(intervalMs),
    label: `${intervalMs / 1000}s`,
  }));

let nextImageViewerRibbonId = 1;

@Component({
  selector: 'app-image-viewer',
  imports: [LucideAngularModule, PillSelectComponent],
  templateUrl: './image-viewer.html',
  styleUrl: './image-viewer.css',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageViewerComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly ribbonId = `image-viewer-controls-ribbon-${nextImageViewerRibbonId++}`;

  private readonly toolbarRef = viewChild<ElementRef<HTMLElement>>('toolbarHeader');
  private readonly toolbarUtilitiesRef = viewChild<ElementRef<HTMLElement>>('toolbarUtilities');
  private readonly ribbonInnerRef = viewChild<ElementRef<HTMLElement>>('ribbonInner');
  private readonly stageRef = viewChild<ElementRef<HTMLElement>>('stageViewport');
  private readonly filmstripRef = viewChild<ElementRef<HTMLElement>>('filmstripViewport');
  private readonly gridRef = viewChild<ElementRef<HTMLElement>>('gridViewport');
  private readonly gridSearchInputRef = viewChild<ElementRef<HTMLInputElement>>('gridSearchInput');

  readonly workspacePath = input<string>('');
  readonly relativePath = input<string | null>(null);
  /** True when the image tab panel is visible and should receive keyboard shortcuts. */
  readonly active = input(false);

  readonly navigateTo = output<{ relativePath: string }>();

  protected readonly intervalOptions = AUTO_PLAY_SELECT_OPTIONS;

  /** null = fit to window; a number = explicit zoom factor (1 === actual size). */
  protected readonly zoom = signal<number | null>(null);
  protected readonly panX = signal(0);
  protected readonly panY = signal(0);
  protected readonly backdrop = signal<StageBackdropMode>('checker');
  protected readonly viewMode = signal<GalleryViewMode>('viewer');
  protected readonly filmstripVisible = signal(true);
  protected readonly isPanning = signal(false);
  protected readonly isResizingGallery = signal(false);
  protected readonly copiedPath = signal(false);
  protected readonly toolbarOverflowing = signal(false);
  protected readonly ribbonExpanded = signal(false);

  protected readonly loadError = signal(false);
  protected readonly imageLoading = signal(false);
  protected readonly displayedSrc = signal('');
  protected readonly naturalWidth = signal(0);
  protected readonly naturalHeight = signal(0);

  protected readonly galleryPaths = signal<string[]>([]);
  protected readonly galleryLoading = signal(false);
  protected readonly galleryRevision = signal(0);
  protected readonly autoPlayEnabled = signal(false);
  protected readonly autoPlayIntervalMs = signal(3000);
  protected readonly autoPlayCycle = signal(0);
  protected readonly galleryHeightPx = signal(DEFAULT_GALLERY_HEIGHT_PX);

  protected readonly gridFilter = signal('');
  protected readonly gridTilePreset = signal<GridTilePreset>('md');

  // Viewport geometry updated outside NgZone via ResizeObserver / rAF-coalesced scroll listeners.
  protected readonly stageWidthPx = signal(0);
  protected readonly stageHeightPx = signal(0);
  protected readonly filmstripViewportWidth = signal(0);
  protected readonly filmstripScrollLeft = signal(0);
  protected readonly gridViewportWidth = signal(0);
  protected readonly gridViewportHeight = signal(0);
  protected readonly gridScrollTop = signal(0);

  private readonly preloader = new ImagePreloadCache(8);
  private readonly folderPathsCache = new Map<string, string[]>();

  private galleryFolderKey: string | null = null;
  private galleryLoadGeneration = 0;
  private imageSwapGeneration = 0;
  private autoPlayTimer: ReturnType<typeof setInterval> | null = null;
  private autoPlayTimerGeneration = 0;
  private copiedPathTimer: ReturnType<typeof setTimeout> | null = null;
  private loadingIndicatorTimer: ReturnType<typeof setTimeout> | null = null;

  private galleryDrag: { startY: number; startH: number } | null = null;
  private galleryDragRaf: number | null = null;
  private pendingGalleryHeight: number | null = null;

  private panDrag: {
    pointerId: number;
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
  } | null = null;
  private panRaf: number | null = null;
  private pendingPan: { x: number; y: number } | null = null;

  private filmstripScrollRaf: number | null = null;
  private gridScrollRaf: number | null = null;
  private toolbarMeasureRaf: number | null = null;
  private toolbarResizeObserver: ResizeObserver | null = null;
  private stageResizeObserver: ResizeObserver | null = null;
  private filmstripResizeObserver: ResizeObserver | null = null;
  private gridResizeObserver: ResizeObserver | null = null;
  private toolbarElAttached: HTMLElement | null = null;
  private stageElAttached: HTMLElement | null = null;
  private filmstripElAttached: HTMLElement | null = null;
  private gridElAttached: HTMLElement | null = null;

  private readonly keydownHandler = (event: KeyboardEvent) => this.onWindowKeydown(event);
  private readonly boundGalleryDragMove = (e: PointerEvent) => this.onGalleryResizeMove(e);
  private readonly boundGalleryDragUp = () => this.endGalleryDrag();
  private readonly boundStageWheel = (e: WheelEvent) => this.onStageWheel(e);
  private readonly boundStagePointerDown = (e: PointerEvent) => this.onStagePointerDown(e);
  private readonly boundStagePointerMove = (e: PointerEvent) => this.onStagePointerMove(e);
  private readonly boundStagePointerUp = (e: PointerEvent) => this.onStagePointerUp(e);
  private readonly boundFilmstripScroll = () => this.onFilmstripScroll();
  private readonly boundFilmstripWheel = (e: WheelEvent) => this.onFilmstripWheel(e);
  private readonly boundGridScroll = () => this.onGridScroll();

  protected readonly normalizedRelativePath = computed(() => {
    const rel = this.relativePath();
    return rel ? normalizePathSlashes(rel) : '';
  });

  protected readonly fileName = computed(() => imageFileName(this.relativePath()));

  protected readonly fileExtLabel = computed(() => formatImageExtension(this.relativePath()));

  protected readonly folderBreadcrumb = computed(() => {
    const rel = this.relativePath();
    return rel ? parentFolderRelativePath(rel) : '';
  });

  protected readonly imageSrc = computed(() =>
    buildWorkspaceImageAssetUrl(this.workspacePath(), this.relativePath(), {
      revision: this.galleryRevision(),
    }),
  );

  protected readonly isFit = computed(() => this.zoom() === null);

  protected readonly canZoom = computed(
    () => !!this.imageSrc() && !this.loadError() && this.naturalWidth() > 0 && this.naturalHeight() > 0,
  );

  protected readonly fitScale = computed(() =>
    computeFitScale(
      this.naturalWidth(),
      this.naturalHeight(),
      Math.max(1, this.stageWidthPx()),
      Math.max(1, this.stageHeightPx()),
    ),
  );

  protected readonly autoPlayProgressKey = computed(
    () => `${this.normalizedRelativePath()}|${this.autoPlayIntervalMs()}|${this.autoPlayCycle()}`,
  );

  /** True when the main image is rendered via GPU `translate3d + scale`. */
  protected readonly usesGpuTransform = computed(
    () => this.naturalWidth() > 0 && this.naturalHeight() > 0 && !this.isFit(),
  );

  protected readonly effectiveZoom = computed(() => {
    const explicit = this.zoom();
    return explicit !== null ? explicit : this.fitScale();
  });

  protected readonly zoomPercent = computed(() => {
    const z = this.zoom();
    return z === null ? null : Math.round(z * 100);
  });

  protected readonly zoomReadoutLabel = computed(() => {
    const pct = this.zoomPercent();
    if (pct !== null) {
      return `${pct}%`;
    }
    const fitPct = Math.round(this.fitScale() * 100);
    return this.naturalWidth() > 0 && fitPct < 100 ? `Fit · ${fitPct}%` : 'Fit';
  });

  protected readonly imageTransformStyle = computed(() => {
    if (!this.usesGpuTransform()) {
      return null;
    }
    const x = Math.round(this.panX() * 100) / 100;
    const y = Math.round(this.panY() * 100) / 100;
    const scale = this.effectiveZoom();
    return `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  });

  protected readonly hasGallery = computed(() => this.galleryPaths().length > 1);

  protected readonly showThumbCaptions = computed(() => this.thumbSizePx() >= 96);

  protected readonly thumbSizePx = computed(() => {
    const raw = this.galleryHeightPx() - GALLERY_THUMBS_PADDING_Y_PX;
    return Math.min(MAX_THUMB_SIZE_PX, Math.max(MIN_THUMB_SIZE_PX, raw));
  });

  /** Stepped protocol max-edge so small height drags do not thrash thumb URLs. */
  protected readonly thumbMaxEdge = computed(() => {
    const needed = this.thumbSizePx() * 2;
    if (needed <= 128) {
      return 128;
    }
    if (needed <= 256) {
      return 256;
    }
    return 512;
  });

  protected readonly gridThumbMaxEdge = computed(() =>
    this.gridTilePreset() === 'lg' ? 512 : 256,
  );

  /** Precomputed gallery items — avoids repeated URL/path formatting inside templates. */
  protected readonly galleryItems = computed<readonly GalleryItem[]>(() => {
    const paths = this.galleryPaths();
    const root = this.workspacePath();
    const maxEdge = this.thumbMaxEdge();
    const revision = this.galleryRevision();
    return paths.map((path, index) => ({
      index,
      path,
      normalizedPath: normalizePathSlashes(path),
      name: imageFileName(path),
      ext: formatImageExtension(path),
      thumbUrl: buildWorkspaceImageAssetUrl(root, path, {
        thumb: true,
        maxEdge,
        revision,
      }),
      isIconLike: isVectorOrIconImagePath(path),
    }));
  });

  protected readonly currentGalleryIndex = computed(() => {
    const rel = this.relativePath();
    if (!rel) {
      return -1;
    }
    return galleryIndexForPath(this.galleryPaths(), rel);
  });

  protected readonly galleryCounterLabel = computed(() => {
    const total = this.galleryPaths().length;
    const index = this.currentGalleryIndex();
    if (total <= 1 || index < 0) {
      return '';
    }
    return `${index + 1} / ${total}`;
  });

  /** Horizontal virtual window for the bottom filmstrip. */
  protected readonly filmstripWindow = computed(() =>
    computeFilmstripVirtualWindow({
      itemCount: this.galleryItems().length,
      itemSizePx: this.thumbSizePx(),
      gapPx: THUMB_GAP_PX,
      viewportWidthPx: Math.max(0, this.filmstripViewportWidth() - THUMB_PAD_X_PX * 2),
      scrollLeftPx: this.filmstripScrollLeft(),
      overscan: 8,
    }),
  );

  protected readonly visibleFilmstripItems = computed<readonly PositionedFilmstripItem[]>(() => {
    const items = this.galleryItems();
    const win = this.filmstripWindow();
    const stride = this.thumbSizePx() + THUMB_GAP_PX;
    const out: PositionedFilmstripItem[] = [];
    for (let i = win.start; i < win.end; i++) {
      const item = items[i];
      if (!item) continue;
      out.push({
        ...item,
        offsetX: i * stride,
      });
    }
    return out;
  });

  /** Filtered items for the contact-sheet grid view. */
  protected readonly filteredGridItems = computed<readonly GalleryItem[]>(() => {
    const items = this.galleryItems();
    const needle = this.gridFilter().trim().toLowerCase();
    if (!needle) {
      return items;
    }
    return items.filter((item) => item.name.toLowerCase().includes(needle));
  });

  protected readonly gridLayout = computed(() => {
    const rawW = this.gridViewportWidth();
    const availW = rawW > 0 ? Math.max(80, rawW - GRID_PAD_PX * 2) : 200;
    const target = GRID_TILE_TARGET_WIDTH[this.gridTilePreset()];
    const columns = Math.max(1, Math.floor((availW + GRID_GAP_PX) / (target + GRID_GAP_PX)));
    const cellWidth = Math.floor((availW - (columns - 1) * GRID_GAP_PX) / columns);
    const cellHeight = Math.round(cellWidth * 0.78) + GRID_LABEL_HEIGHT_PX;
    return { columns, cellWidth, cellHeight };
  });

  protected readonly gridWindow = computed(() => {
    const { columns, cellHeight } = this.gridLayout();
    const rawH = this.gridViewportHeight();
    return computeGridVirtualWindow({
      itemCount: this.filteredGridItems().length,
      columns,
      rowHeightPx: cellHeight,
      gapPx: GRID_GAP_PX,
      viewportHeightPx: rawH > 0 ? Math.max(80, rawH - GRID_PAD_PX * 2) : 200,
      scrollTopPx: this.gridScrollTop(),
      overscanRows: 3,
    });
  });

  protected readonly visibleGridItems = computed<readonly PositionedGridItem[]>(() => {
    const items = this.filteredGridItems();
    const win = this.gridWindow();
    const { columns, cellWidth, cellHeight } = this.gridLayout();
    const root = this.workspacePath();
    const maxEdge = this.gridThumbMaxEdge();
    const revision = this.galleryRevision();
    const colStride = cellWidth + GRID_GAP_PX;
    const rowStride = cellHeight + GRID_GAP_PX;
    const out: PositionedGridItem[] = [];
    for (let i = win.startIndex; i < win.endIndex; i++) {
      const item = items[i];
      if (!item) continue;
      const col = i % columns;
      const row = Math.floor(i / columns);
      out.push({
        ...item,
        gridThumbUrl:
          maxEdge === this.thumbMaxEdge()
            ? item.thumbUrl
            : buildWorkspaceImageAssetUrl(root, item.path, {
                thumb: true,
                maxEdge,
                revision,
              }),
        x: col * colStride,
        y: row * rowStride,
        width: cellWidth,
        height: cellHeight,
      });
    }
    return out;
  });

  protected readonly backdropLabel = computed(() => {
    switch (this.backdrop()) {
      case 'checker':
        return 'Checker';
      case 'dark':
        return 'Dark';
      case 'light':
        return 'Light';
    }
  });

  /** Short status badge shown on the collapsed ribbon toggle when a non-default mode is active. */
  protected readonly ribbonStatusBadge = computed(() => {
    if (this.viewMode() === 'grid') {
      return 'Grid';
    }
    const pct = this.zoomPercent();
    if (pct !== null) {
      return `${pct}%`;
    }
    return '';
  });

  constructor() {
    // Reset per-image view transforms whenever the target file changes.
    effect(() => {
      this.relativePath();
      this.zoom.set(null);
      this.panX.set(0);
      this.panY.set(0);
      this.loadError.set(false);
    });

    // Zero-flicker image swap & decode orchestration.
    effect(() => {
      const targetUrl = this.imageSrc();
      this.syncDisplayedImage(targetUrl);
    });

    // Load / refresh directory listing when workspace or folder changes.
    effect(() => {
      const root = this.workspacePath().trim();
      const rel = this.relativePath();
      void this.loadGalleryForImage(root, rel);
    });

    // Return to viewer mode if the folder no longer has multiple images.
    effect(() => {
      if (!this.hasGallery() && this.viewMode() === 'grid') {
        this.viewMode.set('viewer');
      }
    });

    // Preload immediate adjacent full-res images for instant next/prev & slideshow transitions.
    effect(() => {
      if (!this.hasGallery() || this.viewMode() !== 'viewer') {
        return;
      }
      const paths = this.galleryPaths();
      const idx = this.currentGalleryIndex();
      if (idx < 0 || paths.length <= 1) {
        return;
      }
      const root = this.workspacePath();
      const rev = this.galleryRevision();
      const nextIdx = galleryNextIndex(idx, paths.length);
      const prevIdx = galleryPreviousIndex(idx, paths.length);
      const targets = [paths[nextIdx], paths[prevIdx]];
      if (this.autoPlayEnabled() && paths.length > 2) {
        targets.push(paths[galleryNextIndex(nextIdx, paths.length)]);
      }
      for (const p of targets) {
        if (!p) continue;
        const url = buildWorkspaceImageAssetUrl(root, p, { revision: rev });
        if (url) {
          void this.preloader.preload(url);
        }
      }
    });

    // Keyboard shortcut listener synced to tab activation.
    effect(() => {
      this.active();
      this.syncKeyboardListener();
    });

    // Auto-play timer synced to state.
    effect(() => {
      this.active();
      this.autoPlayEnabled();
      this.autoPlayIntervalMs();
      this.relativePath();
      this.loadError();
      this.hasGallery();
      this.viewMode();
      this.syncAutoPlayTimer();
    });

    // Center active thumbnail in the virtualized filmstrip whenever selection changes.
    effect(() => {
      const index = this.currentGalleryIndex();
      const visible = this.filmstripVisible();
      const mode = this.viewMode();
      if (index >= 0 && visible && mode === 'viewer') {
        queueMicrotask(() => this.scrollActiveThumbnailIntoView(index));
      }
    });

    // Attach/detach toolbar ResizeObserver outside NgZone to detect control overflow.
    effect(() => {
      const el = this.toolbarRef()?.nativeElement ?? null;
      this.attachToolbarListeners(el);
    });

    // Re-measure toolbar overflow whenever control clusters appear/disappear or change labels.
    effect(() => {
      this.hasGallery();
      this.galleryLoading();
      this.viewMode();
      this.relativePath();
      this.zoomReadoutLabel();
      this.backdropLabel();
      this.scheduleToolbarOverflowCheck();
    });

    // Attach/detach stage ResizeObserver & pointer/wheel listeners outside NgZone.
    effect(() => {
      const el = this.stageRef()?.nativeElement ?? null;
      this.attachStageListeners(el);
    });

    // Attach/detach filmstrip ResizeObserver & scroll/wheel listeners outside NgZone.
    effect(() => {
      const el = this.filmstripRef()?.nativeElement ?? null;
      this.attachFilmstripListeners(el);
    });

    // Attach/detach contact-sheet grid ResizeObserver & scroll listeners outside NgZone.
    effect(() => {
      const el = this.gridRef()?.nativeElement ?? null;
      this.attachGridListeners(el);
    });

    this.electron.workspaceFilesChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.onWorkspaceFilesChanged(event));
  }

  ngOnDestroy(): void {
    this.galleryLoadGeneration += 1;
    this.imageSwapGeneration += 1;
    this.stopAutoPlay();
    this.endGalleryDrag();
    this.clearTimers();
    this.detachToolbarListeners();
    this.detachStageListeners();
    this.detachFilmstripListeners();
    this.detachGridListeners();
    this.preloader.invalidate();
    this.folderPathsCache.clear();
    window.removeEventListener('keydown', this.keydownHandler);
  }

  // ── View & Transform Actions ──────────────────────────────────────────────

  protected fitToWindow(): void {
    this.zoom.set(null);
    this.panX.set(0);
    this.panY.set(0);
  }

  protected actualSize(): void {
    if (!this.canZoom()) {
      return;
    }
    this.zoom.set(1);
    this.panX.set(0);
    this.panY.set(0);
  }

  protected toggleFitOrActual(): void {
    if (!this.canZoom()) {
      return;
    }
    if (this.isFit()) {
      const target = this.fitScale() >= 0.98 ? 2 : 1;
      this.zoom.set(target);
      this.panX.set(0);
      this.panY.set(0);
    } else {
      this.fitToWindow();
    }
  }

  protected zoomIn(): void {
    this.stepZoomAroundCenter(ZOOM_STEP);
  }

  protected zoomOut(): void {
    this.stepZoomAroundCenter(1 / ZOOM_STEP);
  }

  private stepZoomAroundCenter(multiplier: number): void {
    if (!this.canZoom()) {
      return;
    }
    const currentZoom = this.effectiveZoom();
    const nextZoom = clampZoom(
      currentZoom * multiplier,
      IMAGE_VIEWER_MIN_ZOOM,
      IMAGE_VIEWER_MAX_ZOOM,
    );
    const nextPan = computeZoomPanForPointer({
      currentZoom,
      nextZoom,
      panX: this.panX(),
      panY: this.panY(),
      pointerOffsetX: 0,
      pointerOffsetY: 0,
    });
    this.zoom.set(nextZoom);
    this.panX.set(nextPan.panX);
    this.panY.set(nextPan.panY);
  }

  protected cycleBackdrop(): void {
    this.backdrop.update((current) => {
      if (current === 'checker') return 'dark';
      if (current === 'dark') return 'light';
      return 'checker';
    });
  }

  protected setViewMode(mode: GalleryViewMode): void {
    if (mode === 'grid' && !this.hasGallery()) {
      return;
    }
    this.viewMode.set(mode);
    if (mode === 'grid') {
      this.autoPlayEnabled.set(false);
    }
  }

  protected toggleFilmstrip(): void {
    this.filmstripVisible.update((v) => !v);
  }

  protected toggleRibbon(): void {
    if (!this.toolbarOverflowing()) {
      return;
    }
    this.ribbonExpanded.update((open) => !open);
  }

  protected setGridTilePreset(preset: GridTilePreset): void {
    this.gridTilePreset.set(preset);
  }

  protected onGridFilterInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.gridFilter.set(input?.value ?? '');
    const gridEl = this.gridRef()?.nativeElement;
    if (gridEl) {
      gridEl.scrollTop = 0;
      this.gridScrollTop.set(0);
    }
  }

  protected clearGridFilter(): void {
    this.gridFilter.set('');
    const gridEl = this.gridRef()?.nativeElement;
    if (gridEl) {
      gridEl.scrollTop = 0;
      this.gridScrollTop.set(0);
    }
    this.gridSearchInputRef()?.nativeElement.focus();
  }

  protected onStageDoubleClick(event?: MouseEvent): void {
    const target = event?.target as HTMLElement | null;
    if (target?.closest('button') || !this.canZoom()) {
      return;
    }
    this.toggleFitOrActual();
  }

  // ── Gallery Navigation & Auto-play ────────────────────────────────────────

  protected showPrevious(): void {
    this.navigateGalleryByOffset(-1);
  }

  protected showNext(): void {
    this.navigateGalleryByOffset(1);
  }

  protected onThumbnailClick(path: string): void {
    this.navigateToPath(path);
  }

  protected onGridCardClick(path: string): void {
    this.viewMode.set('viewer');
    this.navigateToPath(path);
  }

  protected toggleAutoPlay(): void {
    if (!this.hasGallery()) {
      return;
    }
    if (this.viewMode() === 'grid') {
      this.viewMode.set('viewer');
    }
    this.autoPlayEnabled.update((enabled) => !enabled);
    if (!this.autoPlayEnabled()) {
      this.stopAutoPlay();
    }
  }

  protected onAutoPlayIntervalChange(id: string): void {
    const value = Number(id);
    if (Number.isFinite(value) && value > 0) {
      this.autoPlayIntervalMs.set(value);
    }
  }

  // ── Utility Actions ───────────────────────────────────────────────────────

  protected async revealInFileManager(): Promise<void> {
    const abs = absolutePathForWorkspaceRelative(this.workspacePath(), this.relativePath());
    if (!abs) {
      return;
    }
    await this.electron.showWorkspacePathInFileManager(abs);
  }

  protected async copyRelativePath(): Promise<void> {
    const rel = this.normalizedRelativePath();
    if (!rel) {
      return;
    }
    try {
      await navigator.clipboard.writeText(rel);
      this.copiedPath.set(true);
      if (this.copiedPathTimer !== null) {
        clearTimeout(this.copiedPathTimer);
      }
      this.copiedPathTimer = setTimeout(() => {
        this.copiedPathTimer = null;
        this.copiedPath.set(false);
      }, 1500);
    } catch {
      // Clipboard API unavailable in headless / restricted contexts.
    }
  }

  /** Drag main image (in Fit mode) or gallery thumb onto chat using shared workspace-path mime. */
  protected onWorkspaceImageDragStart(
    event: DragEvent,
    relativePath: string | null | undefined,
  ): void {
    const absolutePath = absolutePathForWorkspaceRelative(this.workspacePath(), relativePath);
    if (!absolutePath || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    populateWorkspacePathDragData(event.dataTransfer, absolutePath);
  }

  // ── Image Element Callbacks ───────────────────────────────────────────────

  protected onImageLoad(event: Event): void {
    const img = event.target as HTMLImageElement;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      this.naturalWidth.set(img.naturalWidth);
      this.naturalHeight.set(img.naturalHeight);
    }
    this.loadError.set(false);
    this.finishLoadingIndicator();
  }

  protected onImageError(): void {
    this.loadError.set(true);
    this.finishLoadingIndicator();
    this.autoPlayEnabled.set(false);
  }

  // ── Filmstrip Resize Handle (outside NgZone + rAF coalesced) ──────────────

  protected onGalleryResizeHandleDown(ev: PointerEvent): void {
    if (!this.hasGallery()) {
      return;
    }
    ev.preventDefault();
    this.endGalleryDrag();
    this.galleryDrag = { startY: ev.clientY, startH: this.galleryHeightPx() };
    this.isResizingGallery.set(true);
    this.zone.runOutsideAngular(() => {
      window.addEventListener('pointermove', this.boundGalleryDragMove);
      window.addEventListener('pointerup', this.boundGalleryDragUp);
      window.addEventListener('pointercancel', this.boundGalleryDragUp);
    });
  }

  private onGalleryResizeMove(ev: PointerEvent): void {
    const drag = this.galleryDrag;
    if (!drag) {
      return;
    }
    const delta = drag.startY - ev.clientY;
    this.pendingGalleryHeight = Math.min(
      MAX_GALLERY_HEIGHT_PX,
      Math.max(MIN_GALLERY_HEIGHT_PX, Math.round(drag.startH + delta)),
    );
    if (this.galleryDragRaf === null) {
      this.galleryDragRaf = requestAnimationFrame(() => {
        this.galleryDragRaf = null;
        if (this.pendingGalleryHeight !== null) {
          this.galleryHeightPx.set(this.pendingGalleryHeight);
        }
      });
    }
  }

  private endGalleryDrag(): void {
    if (this.galleryDragRaf !== null) {
      cancelAnimationFrame(this.galleryDragRaf);
      this.galleryDragRaf = null;
    }
    if (this.galleryDrag) {
      window.removeEventListener('pointermove', this.boundGalleryDragMove);
      window.removeEventListener('pointerup', this.boundGalleryDragUp);
      window.removeEventListener('pointercancel', this.boundGalleryDragUp);
      this.galleryDrag = null;
      this.pendingGalleryHeight = null;
      this.isResizingGallery.set(false);
    }
  }

  // ── Toolbar Overflow & Expandable Ribbon Measurement (outside NgZone) ────

  private attachToolbarListeners(el: HTMLElement | null): void {
    if (this.toolbarElAttached === el) {
      return;
    }
    this.detachToolbarListeners();
    if (!el) {
      return;
    }
    this.toolbarElAttached = el;
    this.zone.runOutsideAngular(() => {
      if (typeof ResizeObserver !== 'undefined') {
        this.toolbarResizeObserver = new ResizeObserver(() => {
          this.scheduleToolbarOverflowCheck();
        });
        this.toolbarResizeObserver.observe(el);
      }
      this.scheduleToolbarOverflowCheck();
    });
  }

  private detachToolbarListeners(): void {
    if (this.toolbarMeasureRaf !== null) {
      cancelAnimationFrame(this.toolbarMeasureRaf);
      this.toolbarMeasureRaf = null;
    }
    this.toolbarResizeObserver?.disconnect();
    this.toolbarResizeObserver = null;
    this.toolbarElAttached = null;
  }

  private scheduleToolbarOverflowCheck(): void {
    if (!this.toolbarElAttached || typeof requestAnimationFrame === 'undefined') {
      return;
    }
    if (this.toolbarMeasureRaf !== null) {
      return;
    }
    this.zone.runOutsideAngular(() => {
      this.toolbarMeasureRaf = requestAnimationFrame(() => {
        this.toolbarMeasureRaf = null;
        this.measureToolbarOverflow();
      });
    });
  }

  private measureToolbarOverflow(): void {
    const toolbarEl = this.toolbarElAttached;
    const ribbonInner = this.ribbonInnerRef()?.nativeElement;
    if (!toolbarEl || !ribbonInner) {
      return;
    }
    const toolbarWidthPx = toolbarEl.clientWidth;
    if (toolbarWidthPx <= 0) {
      return;
    }

    let controlsWidthPx = 0;
    let visibleGroups = 0;
    for (const child of Array.from(ribbonInner.children)) {
      const w = (child as HTMLElement).offsetWidth;
      if (w > 0) {
        controlsWidthPx += w;
        visibleGroups += 1;
      }
    }
    if (visibleGroups > 1) {
      controlsWidthPx += (visibleGroups - 1) * TOOLBAR_RIBBON_GAP_PX;
    }

    const utilitiesWidthPx = this.toolbarUtilitiesRef()?.nativeElement.offsetWidth ?? 0;
    const totalInlineControlsPx =
      controlsWidthPx + (utilitiesWidthPx > 0 ? utilitiesWidthPx + TOOLBAR_RIBBON_GAP_PX : 0);

    const currentlyOverflowing = this.toolbarOverflowing();
    const shouldOverflow = shouldCollapseToolbarToRibbon({
      toolbarWidthPx,
      fileMinWidthPx: TOOLBAR_FILE_MIN_WIDTH_PX,
      controlsWidthPx: totalInlineControlsPx,
      chromeAllowancePx: TOOLBAR_CHROME_ALLOWANCE_PX,
      hysteresisPx: TOOLBAR_OVERFLOW_HYSTERESIS_PX,
      currentlyOverflowing,
    });

    if (shouldOverflow !== currentlyOverflowing) {
      this.toolbarOverflowing.set(shouldOverflow);
      if (!shouldOverflow) {
        this.ribbonExpanded.set(false);
      }
    }
  }

  // ── Stage Wheel-to-Zoom & Drag-to-Pan (outside NgZone + rAF) ─────────────

  private attachStageListeners(el: HTMLElement | null): void {
    if (this.stageElAttached === el) {
      return;
    }
    this.detachStageListeners();
    if (!el) {
      return;
    }
    this.stageElAttached = el;
    this.zone.runOutsideAngular(() => {
      el.addEventListener('wheel', this.boundStageWheel, { passive: false });
      el.addEventListener('pointerdown', this.boundStagePointerDown);
      if (typeof ResizeObserver !== 'undefined') {
        this.stageResizeObserver = new ResizeObserver((entries) => {
          const rect = entries[0]?.contentRect;
          if (!rect) return;
          const w = Math.round(rect.width);
          const h = Math.round(rect.height);
          if (w !== this.stageWidthPx() || h !== this.stageHeightPx()) {
            this.stageWidthPx.set(w);
            this.stageHeightPx.set(h);
          }
        });
        this.stageResizeObserver.observe(el);
      }
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
      const padX = style
        ? (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
        : 0;
      const padY = style
        ? (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
        : 0;
      const contentW = Math.round(Math.max(0, el.clientWidth - padX));
      const contentH = Math.round(Math.max(0, el.clientHeight - padY));
      if (contentW > 0 || contentH > 0) {
        this.stageWidthPx.set(contentW);
        this.stageHeightPx.set(contentH);
      }
    });
  }

  private detachStageListeners(): void {
    const el = this.stageElAttached;
    if (el) {
      el.removeEventListener('wheel', this.boundStageWheel);
      el.removeEventListener('pointerdown', this.boundStagePointerDown);
      this.stageElAttached = null;
    }
    this.endPanDrag();
    this.stageResizeObserver?.disconnect();
    this.stageResizeObserver = null;
  }

  private onStageWheel(ev: WheelEvent): void {
    if (this.loadError() || !this.imageSrc() || this.naturalWidth() <= 0) {
      return;
    }
    ev.preventDefault();
    const el = this.stageElAttached;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const pointerOffsetX = ev.clientX - (rect.left + rect.width / 2);
    const pointerOffsetY = ev.clientY - (rect.top + rect.height / 2);

    const currentZoom = this.effectiveZoom();
    // Normalize line-based wheel deltas so mice & trackpads feel consistent.
    const deltaY = ev.deltaMode === 1 ? ev.deltaY * 24 : ev.deltaY;
    const factor = Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);
    const nextZoom = clampZoom(currentZoom * factor, IMAGE_VIEWER_MIN_ZOOM, IMAGE_VIEWER_MAX_ZOOM);
    if (Math.abs(nextZoom - currentZoom) < 0.0005) {
      return;
    }
    const nextPan = computeZoomPanForPointer({
      currentZoom,
      nextZoom,
      panX: this.panX(),
      panY: this.panY(),
      pointerOffsetX,
      pointerOffsetY,
    });
    this.zoom.set(nextZoom);
    this.panX.set(nextPan.panX);
    this.panY.set(nextPan.panY);
  }

  private onStagePointerDown(ev: PointerEvent): void {
    // Only pan with primary mouse button when zoomed in; in Fit mode native drag-to-chat works.
    if (ev.button !== 0 || this.isFit() || this.loadError()) {
      return;
    }
    const target = ev.target as HTMLElement | null;
    if (target?.closest('button')) {
      return;
    }
    ev.preventDefault();
    const el = this.stageElAttached;
    try {
      el?.setPointerCapture(ev.pointerId);
    } catch {
      // Ignore synthetic events without active pointer id.
    }
    this.panDrag = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      startPanX: this.panX(),
      startPanY: this.panY(),
    };
    this.isPanning.set(true);
    window.addEventListener('pointermove', this.boundStagePointerMove);
    window.addEventListener('pointerup', this.boundStagePointerUp);
    window.addEventListener('pointercancel', this.boundStagePointerUp);
  }

  private onStagePointerMove(ev: PointerEvent): void {
    const drag = this.panDrag;
    if (!drag || ev.pointerId !== drag.pointerId) {
      return;
    }
    this.pendingPan = {
      x: drag.startPanX + (ev.clientX - drag.startX),
      y: drag.startPanY + (ev.clientY - drag.startY),
    };
    if (this.panRaf === null) {
      this.panRaf = requestAnimationFrame(() => {
        this.panRaf = null;
        if (this.pendingPan) {
          this.panX.set(this.pendingPan.x);
          this.panY.set(this.pendingPan.y);
        }
      });
    }
  }

  private onStagePointerUp(ev: PointerEvent): void {
    if (!this.panDrag || ev.pointerId !== this.panDrag.pointerId) {
      return;
    }
    this.endPanDrag();
  }

  private endPanDrag(): void {
    if (this.panRaf !== null) {
      cancelAnimationFrame(this.panRaf);
      this.panRaf = null;
    }
    if (this.panDrag) {
      try {
        this.stageElAttached?.releasePointerCapture(this.panDrag.pointerId);
      } catch {
        // Ignore if capture was already released.
      }
      window.removeEventListener('pointermove', this.boundStagePointerMove);
      window.removeEventListener('pointerup', this.boundStagePointerUp);
      window.removeEventListener('pointercancel', this.boundStagePointerUp);
      this.panDrag = null;
      this.pendingPan = null;
      this.isPanning.set(false);
    }
  }

  // ── Filmstrip Virtual Scroll Listeners (outside NgZone) ──────────────────

  private attachFilmstripListeners(el: HTMLElement | null): void {
    if (this.filmstripElAttached === el) {
      return;
    }
    this.detachFilmstripListeners();
    if (!el) {
      return;
    }
    this.filmstripElAttached = el;
    this.zone.runOutsideAngular(() => {
      el.addEventListener('scroll', this.boundFilmstripScroll, { passive: true });
      el.addEventListener('wheel', this.boundFilmstripWheel, { passive: false });
      if (typeof ResizeObserver !== 'undefined') {
        this.filmstripResizeObserver = new ResizeObserver((entries) => {
          const w = Math.round(entries[0]?.contentRect.width ?? el.clientWidth);
          if (w !== this.filmstripViewportWidth()) {
            this.filmstripViewportWidth.set(w);
          }
        });
        this.filmstripResizeObserver.observe(el);
      }
      this.filmstripViewportWidth.set(el.clientWidth);
      this.filmstripScrollLeft.set(el.scrollLeft);
    });
    const idx = this.currentGalleryIndex();
    if (idx >= 0) {
      queueMicrotask(() => this.scrollActiveThumbnailIntoView(idx, 'instant'));
    }
  }

  private detachFilmstripListeners(): void {
    if (this.filmstripScrollRaf !== null) {
      cancelAnimationFrame(this.filmstripScrollRaf);
      this.filmstripScrollRaf = null;
    }
    const el = this.filmstripElAttached;
    if (el) {
      el.removeEventListener('scroll', this.boundFilmstripScroll);
      el.removeEventListener('wheel', this.boundFilmstripWheel);
      this.filmstripElAttached = null;
    }
    this.filmstripResizeObserver?.disconnect();
    this.filmstripResizeObserver = null;
  }

  private onFilmstripScroll(): void {
    if (this.filmstripScrollRaf !== null) {
      return;
    }
    this.filmstripScrollRaf = requestAnimationFrame(() => {
      this.filmstripScrollRaf = null;
      const el = this.filmstripElAttached;
      if (el) {
        this.filmstripScrollLeft.set(el.scrollLeft);
      }
    });
  }

  /** Translate vertical mouse wheel over the filmstrip into smooth horizontal scrolling. */
  private onFilmstripWheel(ev: WheelEvent): void {
    const el = this.filmstripElAttached;
    if (!el) {
      return;
    }
    if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX) && ev.deltaY !== 0) {
      ev.preventDefault();
      const deltaPx =
        ev.deltaMode === 1
          ? ev.deltaY * 24
          : ev.deltaMode === 2
            ? ev.deltaY * Math.max(1, el.clientWidth)
            : ev.deltaY;
      el.scrollLeft += deltaPx;
    }
  }

  // ── Contact-Sheet Grid Virtual Scroll Listeners (outside NgZone) ─────────

  private attachGridListeners(el: HTMLElement | null): void {
    if (this.gridElAttached === el) {
      return;
    }
    this.detachGridListeners();
    if (!el) {
      return;
    }
    this.gridElAttached = el;
    this.zone.runOutsideAngular(() => {
      el.addEventListener('scroll', this.boundGridScroll, { passive: true });
      if (typeof ResizeObserver !== 'undefined') {
        this.gridResizeObserver = new ResizeObserver((entries) => {
          const rect = entries[0]?.contentRect;
          if (!rect) return;
          const w = Math.round(rect.width);
          const h = Math.round(rect.height);
          if (w !== this.gridViewportWidth() || h !== this.gridViewportHeight()) {
            this.gridViewportWidth.set(w);
            this.gridViewportHeight.set(h);
          }
        });
        this.gridResizeObserver.observe(el);
      }
      this.gridViewportWidth.set(el.clientWidth);
      this.gridViewportHeight.set(el.clientHeight);
      this.gridScrollTop.set(el.scrollTop);
    });
  }

  private detachGridListeners(): void {
    if (this.gridScrollRaf !== null) {
      cancelAnimationFrame(this.gridScrollRaf);
      this.gridScrollRaf = null;
    }
    const el = this.gridElAttached;
    if (el) {
      el.removeEventListener('scroll', this.boundGridScroll);
      this.gridElAttached = null;
    }
    this.gridResizeObserver?.disconnect();
    this.gridResizeObserver = null;
  }

  private onGridScroll(): void {
    if (this.gridScrollRaf !== null) {
      return;
    }
    this.gridScrollRaf = requestAnimationFrame(() => {
      this.gridScrollRaf = null;
      const el = this.gridElAttached;
      if (el) {
        this.gridScrollTop.set(el.scrollTop);
      }
    });
  }

  // ── Zero-Flicker Image Swap ──────────────────────────────────────────────

  private syncDisplayedImage(targetUrl: string): void {
    const gen = ++this.imageSwapGeneration;
    this.finishLoadingIndicator();

    if (!targetUrl) {
      this.displayedSrc.set('');
      this.naturalWidth.set(0);
      this.naturalHeight.set(0);
      this.loadError.set(false);
      return;
    }

    const cached = this.preloader.get(targetUrl);
    if (cached) {
      this.displayedSrc.set(targetUrl);
      this.naturalWidth.set(cached.naturalWidth);
      this.naturalHeight.set(cached.naturalHeight);
      this.loadError.set(false);
      return;
    }

    // First image on an empty stage: mount directly onto <img>.
    if (!this.displayedSrc()) {
      this.naturalWidth.set(0);
      this.naturalHeight.set(0);
      this.displayedSrc.set(targetUrl);
      this.scheduleLoadingIndicator();
      return;
    }

    // Switching from an already-displayed image: decode off-DOM first to eliminate blank flashes.
    this.scheduleLoadingIndicator();
    void this.preloader.preload(targetUrl).then((record) => {
      if (gen !== this.imageSwapGeneration) {
        return;
      }
      this.finishLoadingIndicator();
      if (record) {
        this.displayedSrc.set(targetUrl);
        this.naturalWidth.set(record.naturalWidth);
        this.naturalHeight.set(record.naturalHeight);
        this.loadError.set(false);
      } else {
        this.displayedSrc.set(targetUrl);
        this.naturalWidth.set(0);
        this.naturalHeight.set(0);
        this.loadError.set(true);
        this.autoPlayEnabled.set(false);
      }
    });
  }

  private scheduleLoadingIndicator(): void {
    this.finishLoadingIndicator();
    // Only show the subtle loading bar if decoding takes longer than 140ms.
    this.loadingIndicatorTimer = setTimeout(() => {
      this.loadingIndicatorTimer = null;
      this.imageLoading.set(true);
    }, 140);
  }

  private finishLoadingIndicator(): void {
    if (this.loadingIndicatorTimer !== null) {
      clearTimeout(this.loadingIndicatorTimer);
      this.loadingIndicatorTimer = null;
    }
    this.imageLoading.set(false);
  }

  private clearTimers(): void {
    this.finishLoadingIndicator();
    if (this.copiedPathTimer !== null) {
      clearTimeout(this.copiedPathTimer);
      this.copiedPathTimer = null;
    }
  }

  // ── Directory & Workspace File Watcher Sync ──────────────────────────────

  private onWorkspaceFilesChanged(event: WorkspaceFilesChangedMessage): void {
    const root = this.workspacePath().trim();
    if (!root || !this.workspaceRootsEqual(root, event.workspacePath)) {
      return;
    }
    // Evict any cached folder listings affected by this workspace change so returning to
    // another folder later does not briefly hydrate stale thumbnails.
    const rootPrefix = `${root}|`;
    for (const key of Array.from(this.folderPathsCache.keys())) {
      if (!key.startsWith(rootPrefix)) continue;
      const cachedFolder = key.slice(rootPrefix.length);
      if (workspaceChangeAffectsGalleryFolder(cachedFolder, event.paths, event.previousPaths)) {
        this.folderPathsCache.delete(key);
      }
    }

    const rel = this.relativePath()?.trim();
    if (!rel) {
      return;
    }
    const galleryFolder = parentFolderRelativePath(rel);
    if (!workspaceChangeAffectsGalleryFolder(galleryFolder, event.paths, event.previousPaths)) {
      return;
    }
    this.preloader.invalidate();
    this.galleryRevision.update((v) => v + 1);
    void this.loadGalleryForImage(root, rel, { force: true });
  }

  private workspaceRootsEqual(a: string, b: string): boolean {
    const x = normalizePathSlashes(a).replace(/\/+$/, '').toLowerCase();
    const y = normalizePathSlashes(b).replace(/\/+$/, '').toLowerCase();
    return x.length > 0 && x === y;
  }

  private rememberFolderPaths(folderKey: string, paths: string[]): void {
    if (this.folderPathsCache.has(folderKey)) {
      this.folderPathsCache.delete(folderKey);
    }
    this.folderPathsCache.set(folderKey, paths);
    while (this.folderPathsCache.size > MAX_FOLDER_CACHE_ENTRIES) {
      const oldest = this.folderPathsCache.keys().next().value;
      if (oldest === undefined) break;
      this.folderPathsCache.delete(oldest);
    }
  }

  private async loadGalleryForImage(
    workspaceRoot: string,
    imageRelativePath: string | null,
    options?: { force?: boolean },
  ): Promise<void> {
    const root = workspaceRoot.trim();
    const rel = imageRelativePath?.trim();
    if (!root || !rel) {
      this.galleryLoadGeneration += 1;
      this.galleryPaths.set([]);
      this.galleryFolderKey = null;
      this.autoPlayEnabled.set(false);
      return;
    }

    const parentRel = parentFolderRelativePath(rel);
    const folderKey = `${root}|${parentRel}`;
    if (!options?.force && folderKey === this.galleryFolderKey) {
      return;
    }

    const previousFolderKey = this.galleryFolderKey;
    const previousIndex = this.currentGalleryIndex();
    this.galleryFolderKey = folderKey;
    if (previousFolderKey !== null && previousFolderKey !== folderKey) {
      this.autoPlayEnabled.set(false);
      this.gridFilter.set('');
    }

    // Instant hydration when returning to a previously visited folder (e.g. switching tabs).
    const cachedPaths = !options?.force ? this.folderPathsCache.get(folderKey) : undefined;
    if (cachedPaths) {
      this.galleryPaths.set(cachedPaths);
    }

    const generation = ++this.galleryLoadGeneration;
    if (!cachedPaths) {
      this.galleryLoading.set(true);
    }
    try {
      const parentAbs = parentFolderAbsolutePath(root, rel);
      const entries = await this.electron.readDirectory(parentAbs);
      if (generation !== this.galleryLoadGeneration) {
        return;
      }
      const paths = viewableImagesInDirectory(entries, root);
      // Prefer the path currently displayed — user may have navigated siblings during the load.
      const currentRel = this.relativePath()?.trim() ?? rel;
      if (parentFolderRelativePath(currentRel) !== parentRel) {
        return;
      }
      this.rememberFolderPaths(folderKey, paths);
      this.galleryPaths.set(paths);

      // Only auto-navigate to a sibling image when the active file is itself a
      // viewable image. When a non-image file is open in a folder that also
      // contains images, the viewer is hidden but still mounted.
      if (!isViewableImagePath(currentRel)) {
        return;
      }
      if (galleryIndexForPath(paths, currentRel) >= 0) {
        return;
      }
      const nextPath = pickGalleryPathAfterRefresh(paths, currentRel, previousIndex);
      if (nextPath) {
        this.navigateToPath(nextPath);
      } else {
        this.autoPlayEnabled.set(false);
      }
    } catch {
      if (generation !== this.galleryLoadGeneration) {
        return;
      }
      this.galleryPaths.set([]);
      this.autoPlayEnabled.set(false);
    } finally {
      if (generation === this.galleryLoadGeneration) {
        this.galleryLoading.set(false);
      }
    }
  }

  private navigateGalleryByOffset(offset: -1 | 1): void {
    const paths = this.galleryPaths();
    const currentIndex = this.currentGalleryIndex();
    if (paths.length <= 1 || currentIndex < 0) {
      return;
    }
    const nextIndex =
      offset < 0
        ? galleryPreviousIndex(currentIndex, paths.length)
        : galleryNextIndex(currentIndex, paths.length);
    const nextPath = paths[nextIndex];
    if (nextPath) {
      this.navigateToPath(nextPath);
    }
  }

  private navigateToPath(path: string): void {
    const rel = this.relativePath();
    if (!rel || normalizePathSlashes(rel) === normalizePathSlashes(path)) {
      return;
    }
    this.navigateTo.emit({ relativePath: normalizePathSlashes(path) });
    this.restartAutoPlayTimer();
  }

  // ── Keyboard Shortcuts ───────────────────────────────────────────────────

  private syncKeyboardListener(): void {
    window.removeEventListener('keydown', this.keydownHandler);
    if (this.active()) {
      window.addEventListener('keydown', this.keydownHandler);
    }
  }

  private onWindowKeydown(event: KeyboardEvent): void {
    if (!this.active()) {
      return;
    }
    const target = event.target;
    const inEditable =
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT');

    if (event.key === 'Escape') {
      if (this.toolbarOverflowing() && this.ribbonExpanded()) {
        event.preventDefault();
        this.ribbonExpanded.set(false);
      } else if (this.viewMode() === 'grid' && this.gridFilter()) {
        event.preventDefault();
        this.clearGridFilter();
      } else if (this.viewMode() === 'grid') {
        event.preventDefault();
        this.viewMode.set('viewer');
      } else if (this.autoPlayEnabled()) {
        event.preventDefault();
        this.autoPlayEnabled.set(false);
      } else if (!this.isFit()) {
        event.preventDefault();
        this.fitToWindow();
      }
      return;
    }

    if (inEditable || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    switch (event.key) {
      case 'ArrowLeft':
        if (this.hasGallery() && this.viewMode() === 'viewer') {
          event.preventDefault();
          this.showPrevious();
        }
        break;
      case 'ArrowRight':
        if (this.hasGallery() && this.viewMode() === 'viewer') {
          event.preventDefault();
          this.showNext();
        }
        break;
      case 'Home':
        if (this.hasGallery() && this.viewMode() === 'viewer') {
          const first = this.galleryPaths()[0];
          if (first) {
            event.preventDefault();
            this.navigateToPath(first);
          }
        }
        break;
      case 'End':
        if (this.hasGallery() && this.viewMode() === 'viewer') {
          const paths = this.galleryPaths();
          const last = paths[paths.length - 1];
          if (last) {
            event.preventDefault();
            this.navigateToPath(last);
          }
        }
        break;
      case '+':
      case '=':
        if (this.viewMode() === 'viewer') {
          event.preventDefault();
          this.zoomIn();
        }
        break;
      case '-':
        if (this.viewMode() === 'viewer') {
          event.preventDefault();
          this.zoomOut();
        }
        break;
      case '0':
        if (this.viewMode() === 'viewer') {
          event.preventDefault();
          this.fitToWindow();
        }
        break;
      case '1':
        if (this.viewMode() === 'viewer') {
          event.preventDefault();
          this.actualSize();
        }
        break;
      case ' ':
        if (this.hasGallery() && this.viewMode() === 'viewer') {
          event.preventDefault();
          this.toggleAutoPlay();
        }
        break;
      case 'g':
      case 'G':
        if (this.hasGallery()) {
          event.preventDefault();
          this.setViewMode(this.viewMode() === 'grid' ? 'viewer' : 'grid');
        }
        break;
      case 'f':
      case 'F':
        if (this.hasGallery() && this.viewMode() === 'viewer') {
          event.preventDefault();
          this.toggleFilmstrip();
        }
        break;
      case 'b':
      case 'B':
        if (this.viewMode() === 'viewer') {
          event.preventDefault();
          this.cycleBackdrop();
        }
        break;
    }
  }

  // ── Slideshow Timer ──────────────────────────────────────────────────────

  private syncAutoPlayTimer(): void {
    this.stopAutoPlay();
    if (
      !this.active() ||
      !this.autoPlayEnabled() ||
      !this.hasGallery() ||
      this.viewMode() !== 'viewer' ||
      this.loadError() ||
      !this.relativePath()
    ) {
      return;
    }
    untracked(() => this.autoPlayCycle.update((n) => n + 1));
    const generation = this.autoPlayTimerGeneration;
    this.autoPlayTimer = setInterval(() => {
      if (generation !== this.autoPlayTimerGeneration || !this.autoPlayEnabled()) {
        return;
      }
      this.zone.run(() => this.showNext());
    }, this.autoPlayIntervalMs());
  }

  private restartAutoPlayTimer(): void {
    if (!this.autoPlayEnabled()) {
      return;
    }
    this.syncAutoPlayTimer();
  }

  private stopAutoPlay(): void {
    this.autoPlayTimerGeneration += 1;
    if (this.autoPlayTimer !== null) {
      clearInterval(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
  }

  /** Mathematically center the active thumbnail inside the virtualized filmstrip. */
  private scrollActiveThumbnailIntoView(index: number, behavior: ScrollBehavior = 'smooth'): void {
    const el = this.filmstripElAttached ?? this.filmstripRef()?.nativeElement;
    if (!el || index < 0) {
      return;
    }
    const thumbSize = this.thumbSizePx();
    const stride = thumbSize + THUMB_GAP_PX;
    const itemCenter = THUMB_PAD_X_PX + index * stride + thumbSize / 2;
    const targetLeft = Math.max(0, itemCenter - el.clientWidth / 2);
    const totalScrollWidth = this.filmstripWindow().totalWidthPx + THUMB_PAD_X_PX * 2;
    const maxLeft = Math.max(0, Math.max(el.scrollWidth, totalScrollWidth) - el.clientWidth);
    const clamped = Math.min(maxLeft, targetLeft);
    // Avoid micro-scrolling if the active tile is already comfortably within the middle 60%.
    const margin = el.clientWidth * 0.2;
    const itemLeft = THUMB_PAD_X_PX + index * stride;
    const itemRight = itemLeft + thumbSize;
    if (itemLeft >= el.scrollLeft + margin && itemRight <= el.scrollLeft + el.clientWidth - margin) {
      return;
    }
    const effectiveBehavior: ScrollBehavior =
      behavior === 'smooth' && Math.abs(clamped - el.scrollLeft) > Math.max(1, el.clientWidth) * 2
        ? 'instant'
        : behavior;
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ left: clamped, behavior: effectiveBehavior });
    } else {
      el.scrollLeft = clamped;
    }
    // For instant jumps update the virtual window immediately; for smooth scrolls let the
    // native scroll listener track el.scrollLeft so intermediate tiles stay rendered.
    if (effectiveBehavior !== 'smooth' || typeof el.scrollTo !== 'function') {
      this.filmstripScrollLeft.set(clamped);
    }
  }
}
