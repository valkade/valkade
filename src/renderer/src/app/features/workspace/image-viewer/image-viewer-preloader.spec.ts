import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImagePreloadCache } from './image-viewer-preloader';

class FakeImage {
  static instances: FakeImage[] = [];

  decoding = '';
  naturalWidth = 640;
  naturalHeight = 480;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = '';

  constructor() {
    FakeImage.instances.push(this);
  }

  get src(): string {
    return this._src;
  }

  set src(value: string) {
    this._src = value;
  }

  decode(): Promise<void> {
    return Promise.resolve();
  }

  triggerLoad(width = 640, height = 480): void {
    this.naturalWidth = width;
    this.naturalHeight = height;
    this.onload?.();
  }

  triggerError(): void {
    this.onerror?.();
  }
}

describe('ImagePreloadCache', () => {
  const OriginalImage = globalThis.Image;

  beforeEach(() => {
    FakeImage.instances = [];
    (globalThis as unknown as { Image: typeof Image }).Image = FakeImage as unknown as typeof Image;
  });

  afterEach(() => {
    (globalThis as unknown as { Image: typeof Image }).Image = OriginalImage;
  });

  it('deduplicates concurrent preloads and serves subsequent hits from LRU cache', async () => {
    const cache = new ImagePreloadCache(2);
    const p1 = cache.preload('nemo-asset://workspace/?root=%2Fws&path=a.png');
    const p2 = cache.preload('nemo-asset://workspace/?root=%2Fws&path=a.png');
    expect(FakeImage.instances).toHaveLength(1);

    FakeImage.instances[0]!.triggerLoad(800, 600);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(r1?.naturalWidth).toBe(800);
    expect(r1?.naturalHeight).toBe(600);

    const hit = await cache.preload('nemo-asset://workspace/?root=%2Fws&path=a.png');
    expect(hit).toBe(r1);
    expect(FakeImage.instances).toHaveLength(1);
  });

  it('evicts the least recently used entry when exceeding maxEntries', async () => {
    const cache = new ImagePreloadCache(2);
    const pa = cache.preload('url-a');
    FakeImage.instances[0]!.triggerLoad();
    await pa;

    const pb = cache.preload('url-b');
    FakeImage.instances[1]!.triggerLoad();
    await pb;

    // Touch url-a so url-b becomes oldest.
    expect(cache.get('url-a')).toBeDefined();

    const pc = cache.preload('url-c');
    FakeImage.instances[2]!.triggerLoad();
    await pc;

    expect(cache.get('url-a')).toBeDefined();
    expect(cache.get('url-b')).toBeUndefined();
    expect(cache.get('url-c')).toBeDefined();
  });

  it('prevents an invalidated in-flight preload from repopulating stale pixels', async () => {
    const cache = new ImagePreloadCache(4);
    const stalePromise = cache.preload('url-a');
    const staleImg = FakeImage.instances[0]!;
    const unrelatedPromise = cache.preload('url-b');
    const unrelatedImg = FakeImage.instances[1]!;

    // Invalidate only url-a while both are in flight.
    cache.invalidate('url-a');

    // Start a fresh reload for url-a before the stale one completes.
    const freshPromise = cache.preload('url-a');
    const freshImg = FakeImage.instances[2]!;

    staleImg.triggerLoad(100, 100);
    expect(await stalePromise).toBeNull();
    expect(cache.get('url-a')).toBeUndefined();

    // Unrelated url-b was not affected by single-URL invalidation.
    unrelatedImg.triggerLoad(300, 200);
    expect((await unrelatedPromise)?.naturalWidth).toBe(300);

    // Fresh url-a populates cache cleanly.
    freshImg.triggerLoad(1200, 900);
    const fresh = await freshPromise;
    expect(fresh?.naturalWidth).toBe(1200);
    expect(cache.get('url-a')?.naturalWidth).toBe(1200);
  });

  it('returns null when an image fails to load', async () => {
    const cache = new ImagePreloadCache(4);
    const p = cache.preload('url-bad');
    FakeImage.instances[0]!.triggerError();
    expect(await p).toBeNull();
    expect(cache.get('url-bad')).toBeUndefined();
  });
});
