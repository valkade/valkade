/**
 * Tests for security/nemo-asset-svg — SVG sanitizer (strips active content
 * before serving workspace images over nemo-asset://).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockNativeImage = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
}));
const mockProtocolHandle = vi.hoisted(() => vi.fn());
const mockAssertRegisteredWorkspaceDirectory = vi.hoisted(() => vi.fn());
const mockResolveSafeWorkspacePath = vi.hoisted(() => vi.fn());
const mockFs = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('electron', () => ({
  nativeImage: mockNativeImage,
  protocol: { handle: mockProtocolHandle },
}));
vi.mock('fs', () => ({
  promises: mockFs,
}));
vi.mock('../utils/assert-registered-workspace-dir', () => ({
  assertRegisteredWorkspaceDirectory: mockAssertRegisteredWorkspaceDirectory,
}));
vi.mock('../utils/workspace-safe-path', () => ({
  resolveSafeWorkspacePath: mockResolveSafeWorkspacePath,
}));

import {
  clearNemoAssetCachesForTests,
  encodeWorkspaceImageThumbWithMime,
  registerNemoAssetProtocol,
  sanitizeSvg,
} from './nemo-asset';

function svg(body: string): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`, 'utf8');
}

function out(b: Buffer): string {
  return b.toString('utf8');
}

describe('sanitizeSvg — script / foreignObject', () => {
  it('strips a plain <script> block', () => {
    const s = svg('<script>alert(1)</script><rect/>');
    expect(out(sanitizeSvg(s))).not.toContain('script');
    expect(out(sanitizeSvg(s))).toContain('<rect');
  });

  it('strips a self-closing <script/>', () => {
    const s = svg('<script/>');
    expect(out(sanitizeSvg(s))).not.toContain('script');
  });

  it('strips namespaced <s:script> and <svg:foreignObject>', () => {
    const s = svg('<s:script>alert(1)</s:script><svg:foreignObject/>');
    const r = out(sanitizeSvg(s));
    expect(r).not.toContain('script');
    expect(r).not.toContain('foreignObject');
  });
});

describe('sanitizeSvg — event handlers', () => {
  it('strips onclick / ONCLICK / OnLoad (case-insensitive)', () => {
    const s = svg('<rect onclick="alert(1)" ONCLICK="alert(2)" OnLoad="x"/>');
    expect(out(sanitizeSvg(s))).not.toMatch(/onclick/i);
    expect(out(sanitizeSvg(s))).not.toMatch(/onload/i);
  });
});

describe('sanitizeSvg — URI schemes', () => {
  it('strips javascript: in href (quoted)', () => {
    const s = svg('<a href="javascript:alert(1)"/>');
    expect(out(sanitizeSvg(s))).not.toContain('javascript');
  });

  it('strips data: in xlink:href (quoted)', () => {
    const s = svg('<a xlink:href="data:text/html,<script>"/>');
    expect(out(sanitizeSvg(s))).not.toContain('data:');
  });

  it('strips unquoted javascript: in href', () => {
    const s = svg('<a href=javascript:alert(1)/>');
    expect(out(sanitizeSvg(s))).not.toContain('javascript');
  });

  it('strips entity-encoded javascript&#58; in href', () => {
    const s = svg('<a href="javascript&#58;alert(1)"/>');
    expect(out(sanitizeSvg(s))).not.toMatch(/javascript/i);
  });

  it('strips &#106;avascript: in href', () => {
    const s = svg('<a href="&#106;avascript:alert(1)"/>');
    expect(out(sanitizeSvg(s))).not.toMatch(/javascript/i);
  });
});

describe('sanitizeSvg — SMIL', () => {
  it('strips attributeName targeting href (scripted URI animation)', () => {
    const s = svg('<animate attributeName="xlink:href" to="javascript:alert(1)"/>');
    const r = out(sanitizeSvg(s));
    expect(r).not.toMatch(/attributeName/i);
  });

  it('strips to/values/from/by carrying javascript:', () => {
    const s = svg('<animate to="javascript:alert(1)" values="javascript:alert(2)"/>');
    expect(out(sanitizeSvg(s))).not.toContain('javascript');
  });
});

describe('sanitizeSvg — CSS url()', () => {
  it('strips url(javascript:…) and url(data:…)', () => {
    const s = svg('<rect style="background:url(javascript:alert(1))"/>');
    expect(out(sanitizeSvg(s))).not.toContain('javascript');
  });
});

describe('sanitizeSvg — benign preserved', () => {
  it('keeps a benign rect with a fill', () => {
    const s = svg('<rect width="10" height="10" fill="red"/>');
    const r = out(sanitizeSvg(s));
    expect(r).toContain('<rect');
    expect(r).toContain('fill="red"');
  });
});

describe('nemo-asset thumbnail encoding & caching', () => {
  beforeEach(() => {
    clearNemoAssetCachesForTests();
    vi.clearAllMocks();
  });

  it('encodes opaque JPEG sources as image/jpeg and PNG sources as image/png', () => {
    const resizedMock = {
      toJPEG: vi.fn(() => Buffer.from('jpg-bytes')),
      toPNG: vi.fn(() => Buffer.from('png-bytes')),
    };
    const imgMock = {
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 400 }),
      resize: vi.fn(() => resizedMock),
      toJPEG: vi.fn(() => Buffer.from('jpg-bytes')),
      toPNG: vi.fn(() => Buffer.from('png-bytes')),
    };
    mockNativeImage.createFromBuffer.mockReturnValue(imgMock);

    const jpgThumb = encodeWorkspaceImageThumbWithMime(Buffer.from('raw'), 128, 'jpg');
    expect(jpgThumb).toEqual({ bytes: Buffer.from('jpg-bytes'), mime: 'image/jpeg' });
    expect(imgMock.resize).toHaveBeenCalledWith({ width: 128, height: 64, quality: 'good' });

    const pngThumb = encodeWorkspaceImageThumbWithMime(Buffer.from('raw'), 256, 'png');
    expect(pngThumb).toEqual({ bytes: Buffer.from('png-bytes'), mime: 'image/png' });
    expect(imgMock.resize).toHaveBeenCalledWith({ width: 256, height: 128, quality: 'better' });
  });

  it('returns ETag and responds 304 Not Modified when If-None-Match matches', async () => {
    let handler: ((req: Request) => Promise<Response>) | undefined;
    mockProtocolHandle.mockImplementation((_scheme: string, fn: (req: Request) => Promise<Response>) => {
      handler = fn;
    });
    mockAssertRegisteredWorkspaceDirectory.mockResolvedValue('/ws');
    mockResolveSafeWorkspacePath.mockReturnValue('/ws/a.png');
    mockFs.stat.mockResolvedValue({ isFile: () => true, mtimeMs: 1700000000123, size: 420 });
    mockFs.readFile.mockResolvedValue(Buffer.from('png-full'));

    registerNemoAssetProtocol();
    expect(handler).toBeDefined();

    const url = 'nemo-asset://workspace/?root=%2Fws&path=a.png';
    const first = await handler!(new Request(url));
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(mockFs.readFile).toHaveBeenCalledTimes(1);

    const second = await handler!(new Request(url, { headers: { 'If-None-Match': etag! } }));
    expect(second.status).toBe(304);
    expect(mockFs.readFile).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent workspace-root checks and thumbnail encodes', async () => {
    let handler: ((req: Request) => Promise<Response>) | undefined;
    mockProtocolHandle.mockImplementation((_scheme: string, fn: (req: Request) => Promise<Response>) => {
      handler = fn;
    });
    mockAssertRegisteredWorkspaceDirectory.mockResolvedValue('/ws');
    mockResolveSafeWorkspacePath.mockReturnValue('/ws/photo.jpg');
    mockFs.stat.mockResolvedValue({ isFile: () => true, mtimeMs: 1700000000999, size: 1024 });
    mockFs.readFile.mockResolvedValue(Buffer.from('raw-jpg'));

    const resizedMock = {
      toJPEG: vi.fn(() => Buffer.from('thumb-jpg')),
      toPNG: vi.fn(() => Buffer.from('thumb-png')),
    };
    mockNativeImage.createFromBuffer.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 300 }),
      resize: () => resizedMock,
      toJPEG: resizedMock.toJPEG,
      toPNG: resizedMock.toPNG,
    });

    registerNemoAssetProtocol();
    const url = 'nemo-asset://workspace/?root=%2Fws&path=photo.jpg&thumb=1&w=128';
    const [r1, r2, r3] = await Promise.all([
      handler!(new Request(url)),
      handler!(new Request(url)),
      handler!(new Request(url)),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r1.headers.get('content-type')).toBe('image/jpeg');
    expect(mockAssertRegisteredWorkspaceDirectory).toHaveBeenCalledTimes(1);
    expect(mockNativeImage.createFromBuffer).toHaveBeenCalledTimes(1);
  });
});
