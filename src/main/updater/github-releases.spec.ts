import { describe, expect, it } from 'vitest';
import { fetchGithubReleases, parseGithubReleases, releaseAssetUrl } from './github-releases';
import type { FetchLike } from './pinned-fetch';

const WIN = { platform: 'win32' as const, arch: 'x64' };
const SHA256 = 'a'.repeat(64);

function apiRelease(tag: string, extra: Record<string, unknown> = {}) {
  const version = tag.replace(/^v/, '');
  return {
    tag_name: tag,
    name: `ValkAde ${version}`,
    body: '## What changed\n* fix',
    draft: false,
    prerelease: version.includes('-'),
    published_at: '2026-10-30T12:00:00Z',
    html_url: 'https://evil.example/not-used',
    assets: [
      { name: `ValkAde-${version}-Windows-x64.exe`, size: 1000, state: 'uploaded', digest: `sha256:${SHA256}` },
      { name: `ValkAde-${version}-Windows-x64.exe.blockmap`, size: 10, state: 'uploaded' },
      { name: 'latest.yml', size: 300, state: 'uploaded' },
    ],
    ...extra,
  };
}

describe('parseGithubReleases', () => {
  it('keeps the platform installer and latest.yml of each release', () => {
    const [r] = parseGithubReleases([apiRelease('v0.6.0')], WIN);
    expect(r!.summary).toMatchObject({
      version: '0.6.0',
      tag: 'v0.6.0',
      name: 'ValkAde 0.6.0',
      prerelease: false,
      htmlUrl: 'https://github.com/valkade/valkade/releases/tag/v0.6.0',
      installer: { fileName: 'ValkAde-0.6.0-Windows-x64.exe', size: 1000 },
    });
    expect(r!.installer).toEqual({ name: 'ValkAde-0.6.0-Windows-x64.exe', size: 1000, sha256: SHA256 });
    expect(r!.updateInfo?.name).toBe('latest.yml');
  });

  it('still matches legacy Clara-Coder installers for releases before the rename', () => {
    const legacy = apiRelease('v0.5.4', {
      name: 'Clara Coder 0.5.4',
      assets: [
        { name: 'Clara-Coder-0.5.4-Windows-x64.exe', size: 950, state: 'uploaded', digest: `sha256:${SHA256}` },
        { name: 'latest.yml', size: 300, state: 'uploaded' },
      ],
    });
    const [r] = parseGithubReleases([legacy], WIN);
    expect(r!.summary.installer).toEqual({ fileName: 'Clara-Coder-0.5.4-Windows-x64.exe', size: 950 });
    expect(r!.installer?.name).toBe('Clara-Coder-0.5.4-Windows-x64.exe');
  });

  it('drops drafts and tags that are not versions', () => {
    const out = parseGithubReleases(
      [apiRelease('dev'), apiRelease('v0.3.0', { draft: true }), apiRelease('v0.2.0-beta.4')],
      WIN,
    );
    expect(out.map((r) => r.summary.version)).toEqual(['0.2.0-beta.4']);
    expect(out[0]!.summary.prerelease).toBe(true);
  });

  it('marks a semver pre-release tag as beta even if GitHub has it as a full release', () => {
    const [r] = parseGithubReleases([apiRelease('v0.2.0-beta.1', { prerelease: false })], WIN);
    expect(r!.summary.prerelease).toBe(true);
  });

  it('lists a release without update metadata but offers no installer', () => {
    const rel = apiRelease('v0.1.1');
    rel.assets = rel.assets.filter((a) => a.name !== 'latest.yml');
    const [r] = parseGithubReleases([rel], WIN);
    expect(r!.summary.installer).toBeNull();
    expect(r!.installer).toBeNull();
  });

  it('ignores assets that are still uploading and malformed digests', () => {
    const rel = apiRelease('v0.2.0');
    rel.assets[0] = { ...rel.assets[0]!, digest: 'sha256:xyz' };
    rel.assets[2] = { ...rel.assets[2]!, state: 'starter' };
    const [r] = parseGithubReleases([rel], WIN);
    expect(r!.installer).toBeNull();
  });

  it('offers no installer on platforms without one', () => {
    const [r] = parseGithubReleases([apiRelease('v0.2.0')], { platform: 'linux', arch: 'x64' });
    expect(r!.summary.installer).toBeNull();
  });

  it('rejects a non-array payload', () => {
    expect(() => parseGithubReleases({ message: 'Not Found' }, WIN)).toThrow(/unexpected/);
  });
});

describe('releaseAssetUrl', () => {
  it('builds the download URL from the pinned repo, encoding tag and name', () => {
    expect(releaseAssetUrl('v0.6.0', 'ValkAde-0.6.0-Windows-x64.exe')).toBe(
      'https://github.com/valkade/valkade/releases/download/v0.6.0/ValkAde-0.6.0-Windows-x64.exe',
    );
    expect(releaseAssetUrl('v1/../x', 'a b')).toBe('https://github.com/valkade/valkade/releases/download/v1%2F..%2Fx/a%20b');
  });
});

const RELEASES_API = 'https://api.github.com/repos/valkade/valkade/releases?per_page=100';
const MOVED_API = 'https://api.github.com/repositories/123/releases?per_page=100';

/** Fake fetch: each URL in `redirects` answers 301 to its value; anything else serves one release. */
function apiFetch(redirects: Record<string, string>): FetchLike & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const to = redirects[url];
    if (to !== undefined) return new Response('moved', { status: 301, headers: { location: to } });
    return new Response(JSON.stringify([apiRelease('v0.6.0')]), { status: 200 });
  };
  return Object.assign(f, { calls });
}

describe('fetchGithubReleases', () => {
  it('follows a redirect to the repository id after a rename, keeping the API headers', async () => {
    const f = apiFetch({ [RELEASES_API]: MOVED_API });
    const out = await fetchGithubReleases(f, WIN, 'valkade-test');
    expect(out.map((r) => r.summary.version)).toEqual(['0.6.0']);
    expect(f.calls.map((c) => c.url)).toEqual([RELEASES_API, MOVED_API]);
    for (const { init } of f.calls) {
      expect(init?.redirect).toBe('manual');
      expect(init?.headers).toMatchObject({
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'valkade-test',
      });
    }
  });

  it('resolves a relative Location against api.github.com', async () => {
    const f = apiFetch({ [RELEASES_API]: '/repositories/123/releases?per_page=100' });
    await fetchGithubReleases(f, WIN, 'valkade-test');
    expect(f.calls.map((c) => c.url)).toEqual([RELEASES_API, MOVED_API]);
  });

  it.each([
    ['another host', 'https://evil.example/releases', /untrusted host evil\.example/],
    ['github.com', 'https://github.com/valkade/valkade/releases', /untrusted host github\.com/],
    ['plain HTTP', 'http://api.github.com/repositories/123/releases', /non-HTTPS/],
  ])('refuses a redirect to %s', async (_label, to, error) => {
    const f = apiFetch({ [RELEASES_API]: to });
    await expect(fetchGithubReleases(f, WIN, 'valkade-test')).rejects.toThrow(error);
    expect(f.calls).toHaveLength(1);
  });

  it('gives up on a redirect loop', async () => {
    const f = apiFetch({ [RELEASES_API]: MOVED_API, [MOVED_API]: RELEASES_API });
    await expect(fetchGithubReleases(f, WIN, 'valkade-test')).rejects.toThrow(/too many/);
    expect(f.calls).toHaveLength(6);
  });

  it('gives up after five redirects', async () => {
    const chain: Record<string, string> = {};
    let from = RELEASES_API;
    for (let i = 1; i <= 6; i++) {
      const to = `https://api.github.com/repositories/${i}/releases`;
      chain[from] = to;
      from = to;
    }
    await expect(fetchGithubReleases(apiFetch(chain), WIN, 'valkade-test')).rejects.toThrow(/too many/);
  });

  it('accepts exactly five redirects', async () => {
    const chain: Record<string, string> = {};
    let from = RELEASES_API;
    for (let i = 1; i <= 5; i++) {
      const to = `https://api.github.com/repositories/${i}/releases`;
      chain[from] = to;
      from = to;
    }
    const out = await fetchGithubReleases(apiFetch(chain), WIN, 'valkade-test');
    expect(out).toHaveLength(1);
  });

  it('fails on a redirect without a Location header', async () => {
    const f: FetchLike = async () => new Response(null, { status: 302 });
    await expect(fetchGithubReleases(f, WIN, 'valkade-test')).rejects.toThrow(/without a Location/);
  });
});
