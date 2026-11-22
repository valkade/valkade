import { promises as fs } from 'fs';
import path = require('path');
import {
  LEGACY_WORKSPACE_META_DIRS,
  WORKSPACE_BUILD_PLANS_DIR,
  WORKSPACE_BUILD_PLANS_REL_DIR,
  WORKSPACE_META_DIR,
} from '../../shared';

const LEGACY_BUILD_PLANS_REL_DIRS = LEGACY_WORKSPACE_META_DIRS.map((dir) => `${dir}/${WORKSPACE_BUILD_PLANS_DIR}`);
const BUILD_PLANS_PREFIX = `${WORKSPACE_BUILD_PLANS_REL_DIR}/`;

/** Map `.clara/build-plans/…` and `.nemo/build-plans/…` onto `.valkade/build-plans/…`. */
export function rewriteLegacyBuildPlanRelativePath(relativePath: string): string {
  const n = (relativePath || '').replace(/\\/g, '/');
  for (const legacyDir of LEGACY_BUILD_PLANS_REL_DIRS) {
    if (n.startsWith(`${legacyDir}/`)) {
      return BUILD_PLANS_PREFIX + n.slice(legacyDir.length + 1);
    }
    if (n === legacyDir) {
      return WORKSPACE_BUILD_PLANS_REL_DIR;
    }
  }
  return n;
}

function rewriteIndexEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') {
    return entry;
  }
  const rec = entry as Record<string, unknown>;
  const rel = typeof rec.relativePath === 'string' ? rec.relativePath : '';
  const next = rewriteLegacyBuildPlanRelativePath(rel);
  if (next === rel) {
    return entry;
  }
  return { ...rec, relativePath: next };
}

async function rewriteBuildPlanIndexFile(indexPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return;
    }
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(data)) {
    return;
  }
  let changed = false;
  const rewritten = data.map((entry) => {
    const next = rewriteIndexEntry(entry);
    if (next !== entry) {
      changed = true;
    }
    return next;
  });
  if (changed) {
    await fs.writeFile(indexPath, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8');
  }
}

async function loadBuildPlanIndexEntries(indexPath: string): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const data = JSON.parse(raw) as unknown;
    return Array.isArray(data) ? data : [];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return [];
    }
    if (err instanceof SyntaxError) {
      return [];
    }
    throw err;
  }
}

function mergeBuildPlanIndexEntries(currentEntries: unknown[], legacyEntries: unknown[]): unknown[] {
  const byId = new Map<string, unknown>();
  const noId: unknown[] = [];
  for (const entry of [...legacyEntries, ...currentEntries]) {
    const rewritten = rewriteIndexEntry(entry);
    if (!rewritten || typeof rewritten !== 'object') {
      noId.push(rewritten);
      continue;
    }
    const id = (rewritten as Record<string, unknown>).id;
    if (typeof id === 'string' && id) {
      byId.set(id, rewritten);
    } else {
      noId.push(rewritten);
    }
  }
  return [...byId.values(), ...noId];
}

async function copyMissingRecursive(src: string, dest: string): Promise<void> {
  const srcStat = await fs.stat(src);
  if (srcStat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      await copyMissingRecursive(path.join(src, entry.name), path.join(dest, entry.name));
    }
    return;
  }
  try {
    await fs.access(dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      throw err;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
}

async function mergeLegacyBuildPlanIndex(legacyRoot: string, currentRoot: string): Promise<void> {
  const legacyIndex = path.join(legacyRoot, WORKSPACE_BUILD_PLANS_DIR, 'index.json');
  const currentIndex = path.join(currentRoot, WORKSPACE_BUILD_PLANS_DIR, 'index.json');
  const [legacyEntries, currentEntries] = await Promise.all([
    loadBuildPlanIndexEntries(legacyIndex),
    loadBuildPlanIndexEntries(currentIndex),
  ]);
  if (legacyEntries.length === 0 && currentEntries.length === 0) {
    return;
  }
  const merged = mergeBuildPlanIndexEntries(currentEntries, legacyEntries);
  await fs.mkdir(path.dirname(currentIndex), { recursive: true });
  await fs.writeFile(currentIndex, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

async function migrateOneLegacyMetaDir(legacy: string, current: string): Promise<void> {
  try {
    const legacyStat = await fs.stat(legacy);
    if (legacyStat.isDirectory()) {
      let currentExists = false;
      try {
        await fs.access(current);
        currentExists = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          throw err;
        }
      }
      if (!currentExists) {
        await fs.rename(legacy, current);
      } else {
        await copyMissingRecursive(legacy, current);
        await mergeLegacyBuildPlanIndex(legacy, current);
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn(`[workspace-meta] Failed to migrate legacy metadata dir ${legacy}:`, err);
    }
  }
}

/**
 * Bring each legacy dir (`.clara`, then `.nemo`) into `{root}/.valkade`, then rewrite
 * `build-plans/index.json` relativePath values.
 * A legacy dir is renamed when `.valkade` does not exist yet. Otherwise its missing files are
 * copied in (no overwrite), `build-plans/index.json` is merged (the current entry wins on an
 * id collision), and the legacy dir is left in place.
 */
export async function migrateLegacyWorkspaceMetaDir(workspaceRoot: string): Promise<void> {
  const root = (workspaceRoot || '').trim();
  if (!root) {
    return;
  }
  const current = path.join(root, WORKSPACE_META_DIR);
  for (const legacyName of LEGACY_WORKSPACE_META_DIRS) {
    await migrateOneLegacyMetaDir(path.join(root, legacyName), current);
  }
  try {
    await rewriteBuildPlanIndexFile(path.join(current, WORKSPACE_BUILD_PLANS_DIR, 'index.json'));
  } catch (err) {
    console.warn('[workspace-meta] Failed to rewrite build-plan index paths:', err);
  }
}
