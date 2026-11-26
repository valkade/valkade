import { Subject } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, WorkspaceFilesChangedMessage } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { lucideAppProviders } from '../../../lucide-setup';
import { ImageViewerComponent } from './image-viewer';

describe('ImageViewerComponent', () => {
  let workspaceFilesChanged$: Subject<WorkspaceFilesChangedMessage>;
  let readDirectory: ReturnType<typeof vi.fn>;
  let showWorkspacePathInFileManager: ReturnType<typeof vi.fn>;

  const sampleEntries: FileEntry[] = [
    { name: 'a.png', path: '/ws/photos/a.png', isDirectory: false },
    { name: 'b.png', path: '/ws/photos/b.png', isDirectory: false },
    { name: 'c.svg', path: '/ws/photos/c.svg', isDirectory: false },
  ];

  beforeEach(async () => {
    workspaceFilesChanged$ = new Subject<WorkspaceFilesChangedMessage>();
    readDirectory = vi.fn(async () => sampleEntries);
    showWorkspacePathInFileManager = vi.fn(async () => undefined);

    await TestBed.configureTestingModule({
      imports: [ImageViewerComponent],
      providers: [
        ...lucideAppProviders,
        {
          provide: ElectronService,
          useValue: {
            workspaceFilesChanged$: workspaceFilesChanged$.asObservable(),
            readDirectory,
            showWorkspacePathInFileManager,
          },
        },
      ],
    }).compileComponents();
  });

  function createViewer(opts?: {
    workspacePath?: string;
    relativePath?: string | null;
    active?: boolean;
  }) {
    const fixture = TestBed.createComponent(ImageViewerComponent);
    fixture.componentRef.setInput('workspacePath', opts?.workspacePath ?? '/ws');
    fixture.componentRef.setInput(
      'relativePath',
      opts && 'relativePath' in opts ? opts.relativePath : 'photos/a.png',
    );
    fixture.componentRef.setInput('active', opts?.active ?? true);
    fixture.detectChanges();
    return fixture;
  }

  it('assigns distinct ribbon element IDs across concurrent viewer instances', () => {
    const f1 = createViewer();
    const f2 = createViewer();
    const r1 = (f1.nativeElement as HTMLElement).querySelector('.image-viewer-ribbon') as HTMLElement;
    const r2 = (f2.nativeElement as HTMLElement).querySelector('.image-viewer-ribbon') as HTMLElement;
    expect(r1.id).toBeTruthy();
    expect(r2.id).toBeTruthy();
    expect(r1.id).not.toBe(r2.id);
    f1.destroy();
    f2.destroy();
  });

  it('never renders an <img> with an empty src attribute', () => {
    const fixture = createViewer({ relativePath: null });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('img.image-viewer-img')).toBeNull();
    expect(host.querySelector('.image-viewer-empty')).not.toBeNull();
    fixture.destroy();
  });

  it('disables zoom controls before an image loads and preserves pan around center on zoomIn/zoomOut', async () => {
    const fixture = createViewer();
    await fixture.whenStable();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const zoomInBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!;
    expect(zoomInBtn.disabled).toBe(true);

    const comp = fixture.componentInstance as unknown as {
      onImageLoad: (ev: Event) => void;
      zoom: () => number | null;
      panX: { (): number; set: (v: number) => void };
      panY: { (): number; set: (v: number) => void };
      actualSize: () => void;
      zoomIn: () => void;
      zoomOut: () => void;
    };

    comp.onImageLoad({ target: { naturalWidth: 1000, naturalHeight: 500 } } as unknown as Event);
    fixture.detectChanges();
    expect(zoomInBtn.disabled).toBe(false);

    comp.actualSize();
    comp.panX.set(100);
    comp.panY.set(-40);
    comp.zoomIn();
    expect(comp.zoom()).toBeCloseTo(1.25);
    expect(comp.panX()).toBeCloseTo(125);
    expect(comp.panY()).toBeCloseTo(-50);

    comp.zoomOut();
    expect(comp.zoom()).toBeCloseTo(1);
    expect(comp.panX()).toBeCloseTo(100);
    expect(comp.panY()).toBeCloseTo(-40);
    fixture.destroy();
  });

  it('ignores double-clicks originating from stage navigation buttons', async () => {
    const fixture = createViewer();
    await fixture.whenStable();
    fixture.detectChanges();

    const comp = fixture.componentInstance as unknown as {
      onImageLoad: (ev: Event) => void;
      zoom: () => number | null;
    };
    comp.onImageLoad({ target: { naturalWidth: 1000, naturalHeight: 500 } } as unknown as Event);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const nextBtn = host.querySelector<HTMLButtonElement>('.image-viewer-stage-nav--next')!;
    nextBtn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();
    expect(comp.zoom()).toBeNull();

    const stage = host.querySelector<HTMLElement>('.image-viewer-stage')!;
    stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();
    expect(comp.zoom()).not.toBeNull();
    fixture.destroy();
  });

  it('clears the grid filter on first Escape and exits grid mode on second Escape', async () => {
    const fixture = createViewer();
    await fixture.whenStable();
    fixture.detectChanges();

    const comp = fixture.componentInstance as unknown as {
      setViewMode: (m: 'viewer' | 'grid') => void;
      viewMode: () => 'viewer' | 'grid';
      gridFilter: { (): string; set: (v: string) => void };
    };

    comp.setViewMode('grid');
    comp.gridFilter.set('a.png');
    fixture.detectChanges();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(comp.gridFilter()).toBe('');
    expect(comp.viewMode()).toBe('grid');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(comp.viewMode()).toBe('viewer');
    fixture.destroy();
  });

  it('pauses slideshow auto-play timer while the viewer tab is inactive', async () => {
    vi.useFakeTimers();
    try {
      const fixture = createViewer({ active: true });
      await Promise.resolve();
      await Promise.resolve();
      fixture.detectChanges();

      const navigated: string[] = [];
      fixture.componentInstance.navigateTo.subscribe((e) => navigated.push(e.relativePath));

      const comp = fixture.componentInstance as unknown as {
        toggleAutoPlay: () => void;
        autoPlayIntervalMs: { set: (ms: number) => void };
      };
      comp.autoPlayIntervalMs.set(1000);
      comp.toggleAutoPlay();
      fixture.detectChanges();

      // Mark inactive: timer must pause and not emit navigation events.
      fixture.componentRef.setInput('active', false);
      fixture.detectChanges();
      vi.advanceTimersByTime(3500);
      expect(navigated).toEqual([]);

      // Mark active again: timer resumes.
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();
      vi.advanceTimersByTime(1000);
      expect(navigated).toEqual(['photos/b.png']);
      fixture.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
