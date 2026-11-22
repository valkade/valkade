import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_DATA_DIR_NAME,
  DEV_APP_DATA_DIR_NAME,
  LEGACY_APP_DATA_DIR_NAMES,
  LEGACY_DEV_APP_DATA_DIR_NAMES,
  MIGRATION_DECLINED_MARKER,
  MIGRATION_MARKER,
  declineLegacyAppDataMigration,
  detectPendingLegacyMigration,
  ensureAppDataDir,
  isDirectAppUpdate,
  isVersionOnOrBefore,
  migrateLegacyAppDataDir,
  migrateLegacyAppDataDirAsync,
  readAppDataMigrationMarker,
  resolveAppDataDir,
  type MigrateLegacyAppDataProgress,
} from './app-data';
import { rewriteMigratedConfigPaths } from './config/load-save';

describe('app-data explicit migration', () => {
  let root: string;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    root = mkdtempSync(path.join(tmpdir(), 'valkade-app-data-'));
    return root;
  }

  function seed(name: string, config: string): string {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'config.json'), config, 'utf-8');
    return dir;
  }

  it('uses the valkade names and lists clara-coder / clara-coder-dev as the first legacy dirs', () => {
    expect(APP_DATA_DIR_NAME).toBe('valkade');
    expect(DEV_APP_DATA_DIR_NAME).toBe('valkade-dev');
    expect(LEGACY_APP_DATA_DIR_NAMES).toEqual(['clara-coder', 'nemo-wrapper', 'Clara Coder']);
    expect(LEGACY_DEV_APP_DATA_DIR_NAMES).toEqual(['clara-coder-dev']);
    expect(MIGRATION_MARKER).toBe('.valkade-migrated-from');
    expect(MIGRATION_DECLINED_MARKER).toBe('.valkade-migration-declined');
  });

  it('resolves canonical packaged and dev paths', () => {
    const r = makeRoot();
    expect(resolveAppDataDir(r)).toBe(path.join(r, APP_DATA_DIR_NAME));
    expect(resolveAppDataDir(r, true)).toBe(path.join(r, DEV_APP_DATA_DIR_NAME));
  });

  it('ensureAppDataDir creates target without auto-migrating legacy folders', () => {
    const r = makeRoot();
    const legacy = seed('clara-coder', '{"ok":true}');
    const target = ensureAppDataDir(r);
    expect(target).toBe(path.join(r, 'valkade'));
    expect(readdirSync(target)).toEqual([]);
    expect(readFileSync(path.join(legacy, 'config.json'), 'utf-8')).toBe('{"ok":true}');
  });

  it('detects --updated direct updater launches and compares versions accurately', () => {
    expect(isDirectAppUpdate(['ValkAde.exe', '--updated'])).toBe(true);
    expect(isDirectAppUpdate(['ValkAde.exe'])).toBe(false);
    expect(isVersionOnOrBefore(null, '0.5.4')).toBe(true);
    expect(isVersionOnOrBefore(undefined, '0.5.4')).toBe(true);
    expect(isVersionOnOrBefore('0.5.3', '0.5.4')).toBe(true);
    expect(isVersionOnOrBefore('0.5.4', '0.5.4')).toBe(true);
    expect(isVersionOnOrBefore('0.5.5', '0.5.4')).toBe(false);
    expect(isVersionOnOrBefore('0.6.0-beta.1', '0.5.4')).toBe(false);
  });

  it('detects legacy packaged data on or before current release with summary counts', () => {
    const r = makeRoot();
    const legacy = seed(
      'clara-coder',
      JSON.stringify({
        configSchemaVersion: 10,
        workspaces: [{ id: 'w1' }, { id: 'w2' }],
      }),
    );
    writeFileSync(path.join(legacy, 'conversations.sqlite'), 'sqlite-bytes', 'utf-8');

    const candidate = detectPendingLegacyMigration({
      appDataRoot: r,
      isDev: false,
      currentVersion: '0.5.4',
      maxSchemaVersion: 10,
      directUpdate: true,
    });

    expect(candidate).toEqual({
      sourceName: 'clara-coder',
      sourceLabel: 'Clara Coder',
      schemaVersion: 10,
      previousVersion: null,
      isDirectUpdate: true,
      workspaceCount: 2,
      hasConversations: true,
      hasSettings: true,
    });
  });

  it('detects clara-coder-dev in dev mode without touching packaged clara-coder', () => {
    const r = makeRoot();
    seed('clara-coder', JSON.stringify({ configSchemaVersion: 10, workspaces: [{ id: 'prod' }] }));

    // Only packaged dir exists — dev must not offer it.
    expect(
      detectPendingLegacyMigration({
        appDataRoot: r,
        isDev: true,
        currentVersion: '0.5.4',
        maxSchemaVersion: 10,
      }),
    ).toBeNull();

    seed('clara-coder-dev', JSON.stringify({ configSchemaVersion: 9, workspaces: [{ id: 'dev' }] }));
    const devCandidate = detectPendingLegacyMigration({
      appDataRoot: r,
      isDev: true,
      currentVersion: '0.5.4',
      maxSchemaVersion: 10,
    });
    expect(devCandidate).toMatchObject({
      sourceName: 'clara-coder-dev',
      sourceLabel: 'Clara Coder (dev)',
      schemaVersion: 9,
      workspaceCount: 1,
    });
  });

  it('skips legacy folders created by a newer schema or newer app version', () => {
    const r = makeRoot();
    seed('clara-coder', JSON.stringify({ configSchemaVersion: 99, workspaces: [] }));
    expect(
      detectPendingLegacyMigration({
        appDataRoot: r,
        isDev: false,
        currentVersion: '0.5.4',
        maxSchemaVersion: 10,
      }),
    ).toBeNull();

    writeFileSync(
      path.join(r, 'clara-coder', 'config.json'),
      JSON.stringify({ configSchemaVersion: 10, lastAppVersion: '0.6.0', workspaces: [] }),
      'utf-8',
    );
    expect(
      detectPendingLegacyMigration({
        appDataRoot: r,
        isDev: false,
        currentVersion: '0.5.4',
        maxSchemaVersion: 10,
      }),
    ).toBeNull();

    writeFileSync(
      path.join(r, 'clara-coder', 'config.json'),
      JSON.stringify({ configSchemaVersion: 10, lastAppVersion: '0.5.4', workspaces: [] }),
      'utf-8',
    );
    expect(
      detectPendingLegacyMigration({
        appDataRoot: r,
        isDev: false,
        currentVersion: '0.5.4',
        maxSchemaVersion: 10,
      })?.previousVersion,
    ).toBe('0.5.4');
  });

  it('ignores empty or Chromium-only legacy folders and falls through to nemo-wrapper', () => {
    const r = makeRoot();
    mkdirSync(path.join(r, 'clara-coder', 'Cache'), { recursive: true });
    writeFileSync(path.join(r, 'clara-coder', 'Preferences'), '{}', 'utf-8');
    seed('nemo-wrapper', JSON.stringify({ configSchemaVersion: 5 }));

    const candidate = detectPendingLegacyMigration({
      appDataRoot: r,
      isDev: false,
      currentVersion: '0.5.4',
      maxSchemaVersion: 10,
    });
    expect(candidate?.sourceName).toBe('nemo-wrapper');
  });

  it('stops offering migration once declined or already migrated', () => {
    const r = makeRoot();
    seed('clara-coder', JSON.stringify({ configSchemaVersion: 10 }));

    declineLegacyAppDataMigration(r, false);
    expect(existsSync(path.join(r, 'valkade', MIGRATION_DECLINED_MARKER))).toBe(true);
    expect(
      detectPendingLegacyMigration({
        appDataRoot: r,
        isDev: false,
        currentVersion: '0.5.4',
        maxSchemaVersion: 10,
      }),
    ).toBeNull();
  });

  it('copies clara-coder into valkade, skips Chromium cache/lock entries, clears stale WALs, rewrites paths, and keeps legacy as backup', () => {
    const r = makeRoot();
    const legacy = seed(
      'clara-coder',
      JSON.stringify({
        configSchemaVersion: 10,
        modelManager: { customModelsDir: path.join(r, 'clara-coder', 'models') },
      }),
    );
    mkdirSync(path.join(legacy, 'runtime', 'python-venv'), { recursive: true });
    mkdirSync(path.join(legacy, 'Cache'), { recursive: true });
    writeFileSync(path.join(legacy, 'Cache', 'blob'), 'ignored', 'utf-8');
    writeFileSync(path.join(legacy, 'Preferences'), '{}', 'utf-8');
    writeFileSync(path.join(legacy, 'conversations.sqlite'), 'real-db', 'utf-8');
    writeFileSync(path.join(legacy, '.clara-coder-migrated-from'), 'nemo-wrapper\n', 'utf-8');

    // Simulate a fresh ValkAde boot that already created empty config + WAL files.
    const target = ensureAppDataDir(r);
    writeFileSync(path.join(target, 'config.json'), '{"fresh":true}', 'utf-8');
    writeFileSync(path.join(target, 'conversations.sqlite'), 'empty-db', 'utf-8');
    writeFileSync(path.join(target, 'conversations.sqlite-wal'), 'stale-wal', 'utf-8');

    const result = migrateLegacyAppDataDir(r, false, {
      sourceName: 'clara-coder',
      rewriteConfig: rewriteMigratedConfigPaths,
    });

    expect(result).toMatchObject({
      migrated: true,
      from: legacy,
      sourceName: 'clara-coder',
      method: 'copy',
    });
    expect(result.target).toBe(target);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(path.join(target, 'Cache'))).toBe(false);
    expect(existsSync(path.join(target, 'Preferences'))).toBe(false);
    expect(existsSync(path.join(target, 'conversations.sqlite-wal'))).toBe(false);
    expect(readFileSync(path.join(target, 'conversations.sqlite'), 'utf-8')).toBe('real-db');
    expect(existsSync(path.join(target, 'runtime', 'python-venv'))).toBe(true);
    expect(readFileSync(path.join(target, MIGRATION_MARKER), 'utf-8')).toBe('clara-coder\n');
    expect(readAppDataMigrationMarker(target)).toBe('clara-coder');
    expect(readFileSync(path.join(target, '.clara-coder-migrated-from'), 'utf-8')).toBe('nemo-wrapper\n');

    const migratedConfig = JSON.parse(readFileSync(path.join(target, 'config.json'), 'utf-8'));
    expect(migratedConfig.modelManager.customModelsDir).toBe(path.join(target, 'models'));

    // After migration, detection returns null.
    expect(
      detectPendingLegacyMigration({
        appDataRoot: r,
        isDev: false,
        currentVersion: '0.5.4',
        maxSchemaVersion: 10,
      }),
    ).toBeNull();
  });

  it('migrates clara-coder-dev into valkade-dev in dev mode and rejects packaged names', () => {
    const r = makeRoot();
    seed('clara-coder', '{"from":"prod"}');
    const legacyDev = seed('clara-coder-dev', '{"from":"dev"}');

    const bad = migrateLegacyAppDataDir(r, true, { sourceName: 'clara-coder' });
    expect(bad.migrated).toBe(false);
    expect(bad.error).toContain('Unsupported legacy data folder');

    const ok = migrateLegacyAppDataDir(r, true, { sourceName: 'clara-coder-dev' });
    expect(ok).toMatchObject({ migrated: true, from: legacyDev, sourceName: 'clara-coder-dev', method: 'copy' });
    expect(readFileSync(path.join(r, DEV_APP_DATA_DIR_NAME, 'config.json'), 'utf-8')).toBe('{"from":"dev"}');
    expect(existsSync(legacyDev)).toBe(true);
  });

  it('migrateLegacyAppDataDirAsync copies entries with progress, skips Chromium ephemerals, and rewrites paths', async () => {
    const r = makeRoot();
    const legacy = seed(
      'clara-coder',
      JSON.stringify({
        configSchemaVersion: 10,
        modelManager: { customModelsDir: path.join(r, 'clara-coder', 'models') },
      }),
    );
    mkdirSync(path.join(legacy, 'Cache'), { recursive: true });
    writeFileSync(path.join(legacy, 'Cache', 'ignored'), 'x', 'utf-8');
    writeFileSync(path.join(legacy, 'declarative_performance_observer.db'), 'chromium-locked', 'utf-8');
    writeFileSync(path.join(legacy, 'config.json.lock.1234.candidate'), 'stale-lock', 'utf-8');
    writeFileSync(path.join(legacy, 'conversations.sqlite'), 'async-db', 'utf-8');

    const target = ensureAppDataDir(r);
    writeFileSync(path.join(target, 'conversations.sqlite-wal'), 'stale-wal', 'utf-8');

    const progressEvents: MigrateLegacyAppDataProgress[] = [];
    const result = await migrateLegacyAppDataDirAsync(r, false, {
      sourceName: 'clara-coder',
      rewriteConfig: rewriteMigratedConfigPaths,
      onProgress: (p) => progressEvents.push(p),
    });

    expect(result).toMatchObject({
      migrated: true,
      from: legacy,
      sourceName: 'clara-coder',
      method: 'copy',
    });
    expect(existsSync(path.join(target, 'Cache'))).toBe(false);
    expect(existsSync(path.join(target, 'declarative_performance_observer.db'))).toBe(false);
    expect(existsSync(path.join(target, 'config.json.lock.1234.candidate'))).toBe(false);
    expect(existsSync(path.join(target, 'conversations.sqlite-wal'))).toBe(false);
    expect(readFileSync(path.join(target, 'conversations.sqlite'), 'utf-8')).toBe('async-db');
    expect(readFileSync(path.join(target, MIGRATION_MARKER), 'utf-8')).toBe('clara-coder\n');
    const migratedConfig = JSON.parse(readFileSync(path.join(target, 'config.json'), 'utf-8'));
    expect(migratedConfig.modelManager.customModelsDir).toBe(path.join(target, 'models'));

    expect(progressEvents.length).toBe(3);
    expect(progressEvents[progressEvents.length - 1]).toEqual({ entry: 'done', completed: 2, total: 2 });
  });
});
