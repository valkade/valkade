import { nativeImage, protocol } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { computeThumbDimensions, parseThumbMaxEdge } from '../../shared/nemo-asset-thumb';
import { assertRegisteredWorkspaceDirectory } from '../utils/assert-registered-workspace-dir';
import { resolveSafeWorkspacePath } from '../utils/workspace-safe-path';
import { captureAssetResponse } from '../web/screenshot-assets';

/** Image types servable in the markdown preview / image viewer; anything else 404s. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

const THUMB_CACHE_MAX_ENTRIES = 500;
const THUMB_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const THUMB_ENCODE_CONCURRENCY = 2;
const VERIFIED_ROOT_TTL_MS = 1_000;

/** Formats without an alpha channel: JPEG thumbnails are 5–10× smaller and faster. */
const OPAQUE_THUMB_SOURCE_EXTS = new Set(['jpg', 'jpeg', 'bmp']);

type ThumbCacheEntry = {
  mtimeMs: number;
  size: number;
  maxEdge: number;
  mime: string;
  bytes: Buffer;
};

type EncodedThumb = {
  bytes: Buffer;
  mime: string;
};

/** Byte- and entry-bounded in-memory LRU of resized gallery thumbs (key → entry). */
const thumbCache = new Map<string, ThumbCacheEntry>();
let thumbCacheBytes = 0;

/** Deduplicates simultaneous thumbnail encodes for the same file version + maxEdge. */
const inFlightThumbs = new Map<string, Promise<{ thumb: EncodedThumb | null; rawData?: Buffer }>>();

/** Short-TTL + in-flight cache for workspace root verification during thumbnail bursts. */
const VERIFIED_ROOT_CACHE_MAX_ENTRIES = 64;
const verifiedRootCache = new Map<string, { resolved: string; expiresAt: number }>();
const verifiedRootInFlight = new Map<string, Promise<string>>();

/** Cooperative concurrency queue so bursts of synchronous nativeImage calls never stall main. */
let activeThumbEncodes = 0;
const thumbEncodeWaiters: Array<() => void> = [];

function acquireThumbEncodeSlot(): Promise<void> {
  if (activeThumbEncodes < THUMB_ENCODE_CONCURRENCY) {
    activeThumbEncodes += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    thumbEncodeWaiters.push(resolve);
  });
}

function releaseThumbEncodeSlot(): void {
  const next = thumbEncodeWaiters.shift();
  if (next) {
    // Transfer slot ownership directly so concurrent arrivals cannot exceed THUMB_ENCODE_CONCURRENCY
    // while yielding to the main-process event loop between synchronous nativeImage encodes.
    setImmediate(next);
    return;
  }
  activeThumbEncodes = Math.max(0, activeThumbEncodes - 1);
}

async function resolveVerifiedWorkspaceRoot(rawRoot: string): Promise<string> {
  const key = rawRoot.trim();
  const now = Date.now();
  const cached = verifiedRootCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.resolved;
  }
  const pending = verifiedRootInFlight.get(key);
  if (pending) {
    return pending;
  }
  const promise = assertRegisteredWorkspaceDirectory(key)
    .then((resolved) => {
      const expiresAt = Date.now() + VERIFIED_ROOT_TTL_MS;
      verifiedRootCache.delete(key);
      verifiedRootCache.set(key, { resolved, expiresAt });
      if (verifiedRootCache.size > VERIFIED_ROOT_CACHE_MAX_ENTRIES) {
        const pruneNow = Date.now();
        for (const [k, entry] of verifiedRootCache) {
          if (entry.expiresAt <= pruneNow || verifiedRootCache.size > VERIFIED_ROOT_CACHE_MAX_ENTRIES) {
            verifiedRootCache.delete(k);
          }
          if (verifiedRootCache.size <= VERIFIED_ROOT_CACHE_MAX_ENTRIES) {
            break;
          }
        }
      }
      return resolved;
    })
    .finally(() => {
      verifiedRootInFlight.delete(key);
    });
  verifiedRootInFlight.set(key, promise);
  return promise;
}

/** Clear internal protocol caches (used by unit tests). */
export function clearNemoAssetCachesForTests(): void {
  thumbCache.clear();
  thumbCacheBytes = 0;
  inFlightThumbs.clear();
  verifiedRootCache.clear();
  verifiedRootInFlight.clear();
  activeThumbEncodes = 0;
  thumbEncodeWaiters.length = 0;
}

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

/** Match optional namespace prefix + script|foreignObject (e.g. `s:script`, `svg:foreignObject`). */
const DANGEROUS_SVG_TAG = '(?:[\\w-]+:)?(?:script|foreignObject)';

/**
 * Strip active content from SVG bytes before serving over `nemo-asset://`.
 * Removes namespaced/plain `<script>` / `<foreignObject>`, `on*` handlers (any case),
 * entity-encoded `javascript:` / `data:` URIs, and SMIL attrs that can set scripted hrefs.
 */
export function sanitizeSvg(bytes: Buffer): Buffer {
  let svg = bytes.toString('utf8');

  svg = stripDangerousSvgTags(svg);

  // Event-handler attributes: onclick, ONCLICK, OnLoad, onerror, …
  svg = svg.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+)/gi, '');

  // Decode entities so javascript&#58; / &#106;avascript: are visible to URI scrubbers.
  // Re-strip tags/handlers in case decoding reconstituted markup.
  svg = decodeHtmlEntities(svg);
  svg = stripDangerousSvgTags(svg);
  svg = svg.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+)/gi, '');

  // javascript: / data: in common URL-bearing attributes (quoted)
  svg = svg.replace(
    /(\s(?:href|xlink:href|src|poster)\s*=\s*)(["'])\s*(?:javascript|data)\s*:[\s\S]*?\2/gi,
    '$1$2$2',
  );
  // Unquoted javascript: / data: attribute values
  svg = svg.replace(
    /(\s(?:href|xlink:href|src|poster)\s*=\s*)(?:javascript|data)\s*:[^\s>]*/gi,
    '$1""',
  );

  // SMIL: attributeName targeting href can animate a scripted URI into place
  svg = svg.replace(/\s+attributeName\s*=\s*(["'])\s*(?:xlink:)?href\s*\1/gi, '');
  svg = svg.replace(/\s+attributeName\s*=\s*(?:xlink:)?href\b/gi, '');
  // Neutralize to/values/from/by carrying javascript: / data:
  svg = svg.replace(
    /(\s(?:to|values|from|by)\s*=\s*)(["'])[\s\S]*?(?:javascript|data)\s*:[\s\S]*?\2/gi,
    '$1$2$2',
  );
  svg = svg.replace(
    /(\s(?:to|values|from|by)\s*=\s*)(?:javascript|data)\s*:[^\s>]*/gi,
    '$1""',
  );

  // CSS url(javascript:…) / url(data:…) — balanced-paren aware
  svg = stripDangerousCssUrls(svg);

  return Buffer.from(svg, 'utf8');
}

/** Self-closing first so open-tag match does not swallow until a later close tag. */
function stripDangerousSvgTags(svg: string): string {
  svg = svg.replace(new RegExp(`<${DANGEROUS_SVG_TAG}\\b[^>]*\\/>`, 'gi'), '');
  svg = svg.replace(
    new RegExp(`<${DANGEROUS_SVG_TAG}\\b[^>]*>[\\s\\S]*?<\\/${DANGEROUS_SVG_TAG}\\s*>`, 'gi'),
    '',
  );
  return svg;
}

/** Decode numeric / common named entities used in URI-scheme bypasses. */
function decodeHtmlEntities(input: string): string {
  let out = input.replace(/&#x([0-9a-fA-F]+);?/g, (_, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : '';
  });
  out = out.replace(/&#([0-9]+);?/g, (_, dec: string) => {
    const code = Number.parseInt(dec, 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : '';
  });
  out = out.replace(/&colon;/gi, ':');
  out = out.replace(/&tab;/gi, '\t');
  out = out.replace(/&newline;/gi, '\n');
  return out;
}

/** Replace `url(javascript:…)` / `url(data:…)` with `none`, including nested `()`. */
function stripDangerousCssUrls(input: string): string {
  const re = /url\s*\(\s*(['"]?)\s*(?:javascript|data)\s*:/gi;
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    out += input.slice(last, match.index);
    out += 'none';
    const openParen = input.indexOf('(', match.index);
    let depth = 1;
    let i = openParen + 1;
    while (i < input.length && depth > 0) {
      const ch = input[i];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
      i++;
    }
    last = i;
    re.lastIndex = i;
  }
  out += input.slice(last);
  return out;
}

function prepareAssetBytes(data: Buffer, mime: string): Buffer {
  return mime === 'image/svg+xml' ? sanitizeSvg(data) : data;
}

/** Response headers for every nemo-asset payload; SVG gets a tight CSP. */
function assetResponseHeaders(mime: string, etag?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (etag) {
    headers['ETag'] = etag;
  }
  if (mime === 'image/svg+xml') {
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
  }
  return headers;
}

function buildAssetEtag(mtimeMs: number, size: number, maxEdge: number | null): string {
  return `"${Math.trunc(mtimeMs)}-${size}-${maxEdge ?? 'full'}"`;
}

function ifNoneMatchMatches(headerValue: string | null, etag: string): boolean {
  if (!headerValue) {
    return false;
  }
  const trimmed = headerValue.trim();
  if (trimmed === '*') {
    return true;
  }
  for (const part of trimmed.split(',')) {
    const candidate = part.trim().replace(/^W\//, '');
    if (candidate === etag) {
      return true;
    }
  }
  return false;
}

function rememberThumb(cacheKey: string, entry: ThumbCacheEntry): void {
  if (entry.bytes.byteLength > THUMB_CACHE_MAX_BYTES) {
    return;
  }
  const existing = thumbCache.get(cacheKey);
  if (existing) {
    thumbCacheBytes -= existing.bytes.byteLength;
    thumbCache.delete(cacheKey);
  }
  thumbCache.set(cacheKey, entry);
  thumbCacheBytes += entry.bytes.byteLength;
  while (
    thumbCache.size > THUMB_CACHE_MAX_ENTRIES ||
    (thumbCacheBytes > THUMB_CACHE_MAX_BYTES && thumbCache.size > 1)
  ) {
    const oldestKey = thumbCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    const oldest = thumbCache.get(oldestKey);
    if (oldest) {
      thumbCacheBytes -= oldest.bytes.byteLength;
    }
    thumbCache.delete(oldestKey);
  }
}

/**
 * Downscale / freeze (GIF→PNG) for gallery thumbs. Uses JPEG for opaque source formats
 * (`jpg`, `jpeg`, `bmp`) for 5–10× smaller payloads and faster encode/decode, and PNG
 * for alpha-capable formats. Returns null when nativeImage cannot decode (e.g. SVG).
 */
export function encodeWorkspaceImageThumbWithMime(
  data: Buffer,
  maxEdge: number,
  sourceExt?: string,
): EncodedThumb | null {
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) {
    return null;
  }
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) {
    return null;
  }
  const target = computeThumbDimensions(width, height, maxEdge);
  const resized =
    target.width === width && target.height === height
      ? image
      : image.resize({
          width: target.width,
          height: target.height,
          quality: maxEdge <= 128 ? 'good' : 'better',
        });
  const normalizedExt = sourceExt?.replace(/^\./, '').toLowerCase() ?? '';
  if (OPAQUE_THUMB_SOURCE_EXTS.has(normalizedExt) && typeof resized.toJPEG === 'function') {
    const jpg = resized.toJPEG(82);
    const bytes = Buffer.isBuffer(jpg) ? jpg : Buffer.from(jpg);
    if (bytes.byteLength === 0) {
      return null;
    }
    return { bytes, mime: 'image/jpeg' };
  }
  const png = resized.toPNG();
  const bytes = Buffer.isBuffer(png) ? png : Buffer.from(png);
  if (bytes.byteLength === 0) {
    return null;
  }
  return { bytes, mime: 'image/png' };
}

/**
 * Downscale / freeze (GIF→PNG) for gallery thumbs. Returns null when nativeImage
 * cannot decode the buffer (e.g. SVG) so the caller can fall back to the original.
 */
export function encodeWorkspaceImageThumb(
  data: Buffer,
  maxEdge: number,
): Buffer | null {
  return encodeWorkspaceImageThumbWithMime(data, maxEdge)?.bytes ?? null;
}

async function generateThumbDeduplicated(
  abs: string,
  ext: string,
  mtimeMs: number,
  size: number,
  maxEdge: number,
): Promise<{ thumb: EncodedThumb | null; rawData?: Buffer }> {
  const inflightKey = `${abs}|${maxEdge}|${mtimeMs}|${size}`;
  const existing = inFlightThumbs.get(inflightKey);
  if (existing) {
    return existing;
  }

  const work = (async (): Promise<{ thumb: EncodedThumb | null; rawData?: Buffer }> => {
    const data = await fs.readFile(abs);
    // Skip nativeImage for SVG directly (it is never raster-decoded by nativeImage).
    if (ext === 'svg') {
      return { thumb: null, rawData: data };
    }
    await acquireThumbEncodeSlot();
    try {
      const thumb = encodeWorkspaceImageThumbWithMime(data, maxEdge, ext);
      return thumb ? { thumb } : { thumb: null, rawData: data };
    } finally {
      releaseThumbEncodeSlot();
    }
  })();

  inFlightThumbs.set(inflightKey, work);
  try {
    return await work;
  } finally {
    inFlightThumbs.delete(inflightKey);
  }
}

/**
 * Registers `nemo-asset://workspace/?root=<abs>&path=<rel>[&thumb=1|&w=128]` to serve
 * workspace image files. Thumbnail params return a small static JPEG/PNG when decodable.
 * The root must be a registered workspace and the relative path may not escape it.
 */
export function registerNemoAssetProtocol(): void {
  protocol.handle('nemo-asset', async (request) => {
    let root: string;
    let relPath: string;
    let maxEdge: number | null;
    try {
      const url = new URL(request.url);
      if (url.hostname === 'capture') return captureAssetResponse(request.url);
      root = url.searchParams.get('root') ?? '';
      relPath = url.searchParams.get('path') ?? '';
      maxEdge = parseThumbMaxEdge(url.searchParams.get('thumb'), url.searchParams.get('w'));
    } catch {
      return notFound();
    }
    if (!root.trim() || !relPath.trim()) {
      return notFound();
    }

    const ext = path.extname(relPath).replace(/^\./, '').toLowerCase();
    const mime = IMAGE_MIME_BY_EXT[ext];
    if (!mime) {
      return notFound();
    }

    try {
      const workspaceRoot = await resolveVerifiedWorkspaceRoot(root);
      const abs = resolveSafeWorkspacePath(workspaceRoot, relPath);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        return notFound();
      }

      const etag = buildAssetEtag(stat.mtimeMs, stat.size, maxEdge);
      const ifNoneMatch = request.headers.get('if-none-match');
      if (ifNoneMatchMatches(ifNoneMatch, etag)) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': 'no-cache',
          },
        });
      }

      if (maxEdge != null) {
        const cacheKey = `${abs}|${maxEdge}`;
        const cached = thumbCache.get(cacheKey);
        if (
          cached &&
          cached.mtimeMs === stat.mtimeMs &&
          cached.size === stat.size &&
          cached.maxEdge === maxEdge
        ) {
          thumbCache.delete(cacheKey);
          thumbCache.set(cacheKey, cached);
          return new Response(new Uint8Array(cached.bytes), {
            status: 200,
            headers: assetResponseHeaders(cached.mime, etag),
          });
        }

        const { thumb, rawData } = await generateThumbDeduplicated(
          abs,
          ext,
          stat.mtimeMs,
          stat.size,
          maxEdge,
        );
        if (thumb) {
          rememberThumb(cacheKey, {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            maxEdge,
            mime: thumb.mime,
            bytes: thumb.bytes,
          });
          return new Response(new Uint8Array(thumb.bytes), {
            status: 200,
            headers: assetResponseHeaders(thumb.mime, etag),
          });
        }
        // Undecodable as raster (often SVG) — serve sanitized original bytes.
        const fallback = prepareAssetBytes(rawData ?? (await fs.readFile(abs)), mime);
        return new Response(new Uint8Array(fallback), {
          status: 200,
          headers: assetResponseHeaders(mime, etag),
        });
      }

      const data = prepareAssetBytes(await fs.readFile(abs), mime);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: assetResponseHeaders(mime, etag),
      });
    } catch {
      return notFound();
    }
  });
}
