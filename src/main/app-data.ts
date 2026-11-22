/**
 * Stable on-disk app identity under the OS app-data root, plus explicit opt-in
 * migration from earlier Clara Coder folders.
 *
 * Packaged builds use ``{appData}/valkade``. Dev builds (``app.isPackaged === false``)
 * use ``{appData}/valkade-dev`` so config is not scattered by Electron executable /
 * productName changes and so dev state stays separate from packaged state.
 *
 * Startup never migrates legacy folders automatically: it only ensures the target
 * folder exists. Migration runs only after the user explicitly accepts the pre-boot
 * migration prompt (before config, SQLite, or the Python sidecar open), leaving the
 * legacy folder intact as a backup.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import path = require('path');
import { compareAppVersions } from '../shared/app-updater';

export interface LegacyMigrationCandidate {
  /** Legacy folder name under the OS app-data root (e.g. `clara-coder` or `clara-coder-dev`). */
  sourceName: string;
  /** User-facing name of the previous app installation (e.g. `Clara Coder`). */
  sourceLabel: string;
  /** `configSchemaVersion` found in legacy `config.json` (`0` when unversioned), or `null` if absent. */
  schemaVersion: number | null;
  /** `lastAppVersion` found in legacy `config.json`, or `null` for releases before version stamping. */
  previousVersion: string | null;
  /** True when this launch came directly from the in-app updater (`--updated`). */
  isDirectUpdate: boolean;
  /** Number of saved workspaces detected in the legacy config. */
  workspaceCount: number;
  /** True when legacy conversation history was detected. */
  hasConversations: boolean;
  /** True when a legacy `config.json` was detected. */
  hasSettings: boolean;
}

/** Canonical folder name under ``app.getPath('appData')`` for packaged builds. Matches ``desktopName``. */
export const APP_DATA_DIR_NAME = 'valkade';

/** Canonical folder name under ``app.getPath('appData')`` for dev builds. */
export const DEV_APP_DATA_DIR_NAME = 'valkade-dev';

/**
 * Older packaged data-dir names eligible for explicit migration (first match wins).
 * ``clara-coder`` — the Clara Coder packaged data dir; newest, so it goes first.
 * ``nemo-wrapper`` — historical package / hard-coded path.
 * ``Clara Coder`` — Electron ``userData`` when driven by ``productName`` / ``setName``.
 */
export const LEGACY_APP_DATA_DIR_NAMES = ['clara-coder', 'nemo-wrapper', 'Clara Coder'] as const;

/** Older dev data-dir names eligible for explicit dev-to-dev migration. */
export const LEGACY_DEV_APP_DATA_DIR_NAMES = ['clara-coder-dev'] as const;

/** Written into the new dir after an explicit migration; holds the legacy dir name. */
export const MIGRATION_MARKER = '.valkade-migrated-from';

/** Written into the new dir when the user chooses "Start fresh" and declines migration. */
export const MIGRATION_DECLINED_MARKER = '.valkade-migration-declined';

/**
 * Marker names earlier releases wrote. A ``clara-coder`` dir migrated from ``nemo-wrapper``
 * carries ``.clara-coder-migrated-from``; it moves along with the dir and is kept as is.
 */
export const LEGACY_MIGRATION_MARKERS = ['.clara-coder-migrated-from'] as const;

/**
 * Explicit allowlist of app-owned files and directories under ``userData`` to carry over
 * during Clara Coder → ValkAde migration.
 *
 * Using an allowlist instead of a Chromium blocklist guarantees that future Electron /
 * Chromium internal profile databases and locks (e.g. ``declarative_performance_observer.db``,
 * ``DIPS``, ``ShaderCache``, ``Preferences``) are never copied over a live Chromium profile.
 */
export const MIGRATABLE_APP_DATA_ENTRIES = new Set<string>([
  'config.json',
  'config.json.bak',
  'conversations.sqlite',
  'conversations.sqlite-wal',
  'conversations.sqlite-shm',
  'langgraph-checkpoints.sqlite',
  'langgraph-checkpoints.sqlite-wal',
  'langgraph-checkpoints.sqlite-shm',
  'dialog-folder.json',
  'hf-downloads.json',
  'workspaces',
  'conversations',
  'themes',
  'secrets',
  'runtime',
  'java-lsp',
  'models',
  'web-captures',
  'editor-snapshots',
  'workspace-semantic-index',
  'workspace-staging',
  'logs',
  ...LEGACY_MIGRATION_MARKERS,
]);

/** Target files cleared before copying migrated SQLite/config data so stale WAL/SHM cannot collide. */
const TARGET_CLEANUP_FILES = [
  'config.json',
  'config.json.bak',
  'config.json.lock',
  'conversations.sqlite',
  'conversations.sqlite-wal',
  'conversations.sqlite-shm',
  'langgraph-checkpoints.sqlite',
  'langgraph-checkpoints.sqlite-wal',
  'langgraph-checkpoints.sqlite-shm',
] as const;

/** Legacy app-data directory names for the current runtime mode (dev stays isolated from packaged). */
export function legacyAppDataDirNames(isDev = false): readonly string[] {
  return isDev ? LEGACY_DEV_APP_DATA_DIR_NAMES : LEGACY_APP_DATA_DIR_NAMES;
}

/** True when this process was launched directly by the in-app updater (`--updated`). */
export function isDirectAppUpdate(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--updated');
}

/**
 * True when `candidateVersion` is absent (pre-version-stamping release <= v0.5.4)
 * or compares on or before `currentVersion`.
 */
export function isVersionOnOrBefore(
  candidateVersion: string | null | undefined,
  currentVersion: string,
): boolean {
  const trimmed = typeof candidateVersion === 'string' ? candidateVersion.trim() : '';
  if (!trimmed) return true;
  if (!currentVersion.trim()) return true;
  return compareAppVersions(trimmed, currentVersion) <= 0;
}

/** Legacy dir name recorded by the newest migration marker in ``dir`` (current name first), or null. */
export function readAppDataMigrationMarker(dir: string): string | null {
  for (const name of [MIGRATION_MARKER, ...LEGACY_MIGRATION_MARKERS]) {
    try {
      const value = readFileSync(path.join(dir, name), 'utf-8').trim();
      if (value) return value;
    } catch {
      /* missing */
    }
  }
  return null;
}

export function resolveAppDataDir(appDataRoot: string, isDev = false): string {
  return path.join(appDataRoot, isDev ? DEV_APP_DATA_DIR_NAME : APP_DATA_DIR_NAME);
}

/**
 * Ensure ``{appDataRoot}/valkade`` (packaged) or ``{appDataRoot}/valkade-dev`` (dev)
 * exists without touching any legacy folders.
 */
export function ensureAppDataDir(appDataRoot: string, isDev = false): string {
  const target = resolveAppDataDir(appDataRoot, isDev);
  mkdirSync(target, { recursive: true });
  return target;
}

function dirHasEntries(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isNonEmptyFile(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function displayLabelForLegacyDir(sourceName: string, isDev: boolean): string {
  if (sourceName === 'clara-coder-dev') return 'Clara Coder (dev)';
  if (sourceName === 'nemo-wrapper') return isDev ? 'Clara Coder (dev)' : 'Clara Coder (legacy)';
  return 'Clara Coder';
}

export interface DetectLegacyMigrationOptions {
  appDataRoot: string;
  isDev?: boolean;
  /** Running app semver (e.g. `0.5.4`). Legacy folders stamped with a newer version are skipped. */
  currentVersion: string;
  /** Max configSchemaVersion this build understands. Newer schemas are skipped. */
  maxSchemaVersion: number;
  /** True when launched directly via the in-app updater (`--updated`). */
  directUpdate?: boolean;
}

/**
 * Inspect the OS app-data root for an earlier Clara Coder folder on or before the current
 * release that has not yet been migrated or explicitly declined.
 */
export function detectPendingLegacyMigration(
  options: DetectLegacyMigrationOptions,
): LegacyMigrationCandidate | null {
  const isDev = options.isDev ?? false;
  const target = resolveAppDataDir(options.appDataRoot, isDev);

  if (
    existsSync(path.join(target, MIGRATION_MARKER)) ||
    existsSync(path.join(target, MIGRATION_DECLINED_MARKER))
  ) {
    return null;
  }

  for (const sourceName of legacyAppDataDirNames(isDev)) {
    const legacy = path.join(options.appDataRoot, sourceName);
    if (legacy === target || !isDirectory(legacy) || !dirHasEntries(legacy)) {
      continue;
    }

    const configPath = path.join(legacy, 'config.json');
    const hasConfigFile = isNonEmptyFile(configPath);
    const hasConversationsDb = isNonEmptyFile(path.join(legacy, 'conversations.sqlite'));
    const hasCheckpointsDb = isNonEmptyFile(path.join(legacy, 'langgraph-checkpoints.sqlite'));
    const hasLegacyConversationsDir = dirHasEntries(path.join(legacy, 'conversations'));
    const hasWorkspacesDir = dirHasEntries(path.join(legacy, 'workspaces'));

    // Ignore empty shells or Chromium-only folders with no actual Clara Coder data.
    if (
      !hasConfigFile &&
      !hasConversationsDb &&
      !hasCheckpointsDb &&
      !hasLegacyConversationsDir &&
      !hasWorkspacesDir
    ) {
      continue;
    }

    let schemaVersion: number | null = null;
    let previousVersion: string | null = null;
    let workspaceCount = 0;
    let hasSettings = false;

    if (hasConfigFile) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const rec = parsed as Record<string, unknown>;
          const rawSchema = rec['configSchemaVersion'];
          schemaVersion =
            typeof rawSchema === 'number' && Number.isFinite(rawSchema) ? rawSchema : 0;
          if (schemaVersion > options.maxSchemaVersion) {
            // Created by a newer release than this build — do not offer to migrate.
            continue;
          }
          const rawPrevVersion = rec['lastAppVersion'];
          if (typeof rawPrevVersion === 'string' && rawPrevVersion.trim()) {
            previousVersion = rawPrevVersion.trim();
            if (!isVersionOnOrBefore(previousVersion, options.currentVersion)) {
              // Stamped by a newer release — do not offer to migrate.
              continue;
            }
          }
          workspaceCount = Array.isArray(rec['workspaces']) ? rec['workspaces'].length : 0;
          hasSettings = true;
        }
      } catch {
        // Corrupt config.json: still allow migration if SQLite/workspace data exists.
        if (!hasConversationsDb && !hasCheckpointsDb && !hasLegacyConversationsDir && !hasWorkspacesDir) {
          continue;
        }
      }
    }

    return {
      sourceName,
      sourceLabel: displayLabelForLegacyDir(sourceName, isDev),
      schemaVersion,
      previousVersion,
      isDirectUpdate: options.directUpdate ?? false,
      workspaceCount,
      hasConversations: hasConversationsDb || hasCheckpointsDb || hasLegacyConversationsDir,
      hasSettings,
    };
  }

  return null;
}

/** Record that the user explicitly chose to start fresh without migrating legacy data. */
export function declineLegacyAppDataMigration(appDataRoot: string, isDev = false): void {
  const target = ensureAppDataDir(appDataRoot, isDev);
  writeFileSync(path.join(target, MIGRATION_DECLINED_MARKER), `${new Date().toISOString()}\n`, 'utf-8');
}

export type AppDataMigrationResult = {
  target: string;
  migrated: boolean;
  from?: string;
  sourceName?: string;
  method?: 'copy';
  error?: string;
};

export interface MigrateLegacyAppDataProgress {
  /** Current top-level entry being copied (or `'config.json'` when rewriting paths). */
  entry: string;
  /** 0-based count of entries completed so far. */
  completed: number;
  /** Total entries to copy. */
  total: number;
}

export interface MigrateLegacyAppDataOptions {
  /** Specific legacy dir name to migrate (validated against allowed legacy names for this mode). */
  sourceName?: string;
  /** Optional raw-config path rewriter applied to the copied `config.json`. */
  rewriteConfig?: (
    rawConfig: Record<string, unknown>,
    newDir: string,
    legacyDirs: readonly string[],
  ) => Record<string, unknown>;
  /** Optional progress callback for async pre-boot migration UI. */
  onProgress?: (progress: MigrateLegacyAppDataProgress) => void;
}

/**
 * Explicitly migrate user data from a legacy Clara Coder directory into ``{appDataRoot}/valkade``
 * (packaged) or ``{appDataRoot}/valkade-dev`` (dev).
 *
 * Uses a safe copy that skips live Chromium cache/lock entries and leaves the legacy directory
 * untouched as a backup. Must run before config, SQLite, or the Python sidecar open.
 */
export function migrateLegacyAppDataDir(
  appDataRoot: string,
  isDev = false,
  options?: MigrateLegacyAppDataOptions,
): AppDataMigrationResult {
  const target = ensureAppDataDir(appDataRoot, isDev);
  const allowedNames = legacyAppDataDirNames(isDev);
  const candidateNames = options?.sourceName
    ? allowedNames.filter((name) => name === options.sourceName)
    : allowedNames;

  if (options?.sourceName && candidateNames.length === 0) {
    return {
      target,
      migrated: false,
      error: `Unsupported legacy data folder: ${options.sourceName}`,
    };
  }

  const legacyDirs = allowedNames.map((name) => path.join(appDataRoot, name));

  for (const legacyName of candidateNames) {
    const legacy = path.join(appDataRoot, legacyName);
    if (legacy === target || !isDirectory(legacy) || !dirHasEntries(legacy)) {
      continue;
    }

    try {
      // Remove fresh-boot SQLite WAL/SHM and config files in target so copied DBs open cleanly.
      for (const rel of TARGET_CLEANUP_FILES) {
        rmSync(path.join(target, rel), { force: true });
      }

      for (const entry of readdirSync(legacy)) {
        if (!MIGRATABLE_APP_DATA_ENTRIES.has(entry)) {
          continue;
        }
        const src = path.join(legacy, entry);
        const dst = path.join(target, entry);
        cpSync(src, dst, { recursive: true, force: true });
      }

      if (options?.rewriteConfig) {
        const targetConfigPath = path.join(target, 'config.json');
        if (existsSync(targetConfigPath)) {
          try {
            const parsed: unknown = JSON.parse(readFileSync(targetConfigPath, 'utf-8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const rewritten = options.rewriteConfig(
                parsed as Record<string, unknown>,
                target,
                legacyDirs,
              );
              if (rewritten !== parsed) {
                writeFileSync(targetConfigPath, JSON.stringify(rewritten, null, 2), 'utf-8');
              }
            }
          } catch (rewriteErr) {
            console.warn('[app-data] Could not rewrite legacy paths in migrated config.json:', rewriteErr);
          }
        }
      }

      rmSync(path.join(target, MIGRATION_DECLINED_MARKER), { force: true });
      writeFileSync(path.join(target, MIGRATION_MARKER), `${legacyName}\n`, 'utf-8');
      return {
        target,
        migrated: true,
        from: legacy,
        sourceName: legacyName,
        method: 'copy',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[app-data] Failed to migrate ${legacy} → ${target}:`, err);
      return { target, migrated: false, from: legacy, sourceName: legacyName, error: message };
    }
  }

  return { target, migrated: false, error: 'No eligible Clara Coder data folder was found to migrate.' };
}

/**
 * Async variant of {@link migrateLegacyAppDataDir} for the pre-boot migration window so
 * copying large runtime / database folders never freezes the Electron UI thread.
 */
export async function migrateLegacyAppDataDirAsync(
  appDataRoot: string,
  isDev = false,
  options?: MigrateLegacyAppDataOptions,
): Promise<AppDataMigrationResult> {
  const target = ensureAppDataDir(appDataRoot, isDev);
  const allowedNames = legacyAppDataDirNames(isDev);
  const candidateNames = options?.sourceName
    ? allowedNames.filter((name) => name === options.sourceName)
    : allowedNames;

  if (options?.sourceName && candidateNames.length === 0) {
    return {
      target,
      migrated: false,
      error: `Unsupported legacy data folder: ${options.sourceName}`,
    };
  }

  const legacyDirs = allowedNames.map((name) => path.join(appDataRoot, name));

  for (const legacyName of candidateNames) {
    const legacy = path.join(appDataRoot, legacyName);
    if (legacy === target || !isDirectory(legacy) || !dirHasEntries(legacy)) {
      continue;
    }

    try {
      for (const rel of TARGET_CLEANUP_FILES) {
        await fsp.rm(path.join(target, rel), { force: true });
      }

      const allEntries = await fsp.readdir(legacy);
      const entries = allEntries.filter((entry) => MIGRATABLE_APP_DATA_ENTRIES.has(entry));
      const total = entries.length;

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        options?.onProgress?.({ entry, completed: i, total });
        const src = path.join(legacy, entry);
        const dst = path.join(target, entry);
        await fsp.cp(src, dst, { recursive: true, force: true });
      }

      if (options?.rewriteConfig) {
        const targetConfigPath = path.join(target, 'config.json');
        if (existsSync(targetConfigPath)) {
          try {
            const parsed: unknown = JSON.parse(await fsp.readFile(targetConfigPath, 'utf-8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const rewritten = options.rewriteConfig(
                parsed as Record<string, unknown>,
                target,
                legacyDirs,
              );
              if (rewritten !== parsed) {
                await fsp.writeFile(targetConfigPath, JSON.stringify(rewritten, null, 2), 'utf-8');
              }
            }
          } catch (rewriteErr) {
            console.warn('[app-data] Could not rewrite legacy paths in migrated config.json:', rewriteErr);
          }
        }
      }

      await fsp.rm(path.join(target, MIGRATION_DECLINED_MARKER), { force: true });
      await fsp.writeFile(path.join(target, MIGRATION_MARKER), `${legacyName}\n`, 'utf-8');
      options?.onProgress?.({ entry: 'done', completed: total, total });
      return {
        target,
        migrated: true,
        from: legacy,
        sourceName: legacyName,
        method: 'copy',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[app-data] Failed to migrate ${legacy} → ${target}:`, err);
      return { target, migrated: false, from: legacy, sourceName: legacyName, error: message };
    }
  }

  return { target, migrated: false, error: 'No eligible Clara Coder data folder was found to migrate.' };
}
