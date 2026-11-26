import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import { isViewableImagePath } from './image-viewer-formats';

export type WorkspaceImageAssetUrlOptions = {
  /** Request a downscaled static thumb from the main-process protocol handler. */
  thumb?: boolean;
  /** Optional max edge in CSS pixels (protocol clamps). Ignored unless `thumb` is true. */
  maxEdge?: number;
  /** Optional cache-busting revision counter (appended as `&v=<n>` when > 0). */
  revision?: number;
};

/**
 * Build a `nemo-asset://` URL for a workspace-relative image path.
 * Pass `{ thumb: true }` for gallery strip thumbnails (resized / non-animated).
 */
export function buildWorkspaceImageAssetUrl(
  workspaceRoot: string,
  relativePath: string | null | undefined,
  options?: WorkspaceImageAssetUrlOptions,
): string {
  const root = workspaceRoot.trim();
  const rel = relativePath?.trim();
  if (!root || !rel) {
    return '';
  }
  const norm = normalizePathSlashes(rel).replace(/^\/+/, '');
  if (!norm || !isViewableImagePath(norm)) {
    return '';
  }
  let url =
    `nemo-asset://workspace/?root=${encodeURIComponent(root)}` +
    `&path=${encodeURIComponent(norm)}`;
  if (options?.thumb) {
    url += '&thumb=1';
    const edge = options.maxEdge;
    if (typeof edge === 'number' && Number.isFinite(edge) && edge > 0) {
      url += `&w=${Math.round(edge)}`;
    }
  }
  const rev = options?.revision;
  if (typeof rev === 'number' && Number.isFinite(rev) && rev > 0) {
    url += `&v=${Math.trunc(rev)}`;
  }
  return url;
}
