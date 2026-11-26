/**
 * Bounded LRU preloader that fetches and decodes adjacent full-resolution gallery
 * images off-DOM so stepping through images or auto-playing has zero decode flicker.
 */
export interface DecodedImageRecord {
  url: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Keep a strong reference to the decoded HTMLImageElement so Chromium retains the decoded bitmap. */
  element: HTMLImageElement;
}

export class ImagePreloadCache {
  private readonly decoded = new Map<string, DecodedImageRecord>();
  private readonly inFlight = new Map<string, Promise<DecodedImageRecord | null>>();

  constructor(private readonly maxEntries = 8) {}

  get(url: string): DecodedImageRecord | undefined {
    const hit = this.decoded.get(url);
    if (!hit) {
      return undefined;
    }
    // Refresh LRU order.
    this.decoded.delete(url);
    this.decoded.set(url, hit);
    return hit;
  }

  /** Preload and decode `url` if not already decoded or in flight. */
  preload(url: string): Promise<DecodedImageRecord | null> {
    if (!url || typeof Image === 'undefined') {
      return Promise.resolve(null);
    }
    const cached = this.get(url);
    if (cached) {
      return Promise.resolve(cached);
    }
    const pending = this.inFlight.get(url);
    if (pending) {
      return pending;
    }

    const promise = new Promise<DecodedImageRecord | null>((resolve) => {
      const img = new Image();
      img.decoding = 'async';

      const finishLoaded = () => {
        const record: DecodedImageRecord = {
          url,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          element: img,
        };
        this.remember(record);
        resolve(record);
      };

      const finishError = () => {
        resolve(null);
      };

      img.onload = () => {
        if (typeof img.decode === 'function') {
          img.decode().then(finishLoaded, finishLoaded);
        } else {
          finishLoaded();
        }
      };
      img.onerror = finishError;
      img.src = url;
    }).finally(() => {
      this.inFlight.delete(url);
    });

    this.inFlight.set(url, promise);
    return promise;
  }

  invalidate(url?: string): void {
    if (url === undefined) {
      this.decoded.clear();
      return;
    }
    this.decoded.delete(url);
  }

  private remember(record: DecodedImageRecord): void {
    if (this.decoded.has(record.url)) {
      this.decoded.delete(record.url);
    }
    this.decoded.set(record.url, record);
    while (this.decoded.size > this.maxEntries) {
      const oldest = this.decoded.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.decoded.delete(oldest);
    }
  }
}
