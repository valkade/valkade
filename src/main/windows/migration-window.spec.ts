import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyMigrationCandidate } from '../app-data';

const mocks = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const winListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let lastWindow: FakeWindow | null = null;

  interface FakeWindow {
    webContents: { send: ReturnType<typeof vi.fn> };
    destroyed: boolean;
    isDestroyed: () => boolean;
    destroy: ReturnType<typeof vi.fn>;
    removeMenu: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => void;
  }

  function createFakeWindow(): FakeWindow {
    winListeners.clear();
    const w: FakeWindow = {
      webContents: { send: vi.fn() },
      destroyed: false,
      isDestroyed: () => w.destroyed,
      destroy: vi.fn(() => {
        if (!w.destroyed) {
          w.destroyed = true;
          w.emit('closed');
        }
      }),
      removeMenu: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const list = winListeners.get(event) ?? [];
        list.push(cb);
        winListeners.set(event, list);
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of winListeners.get(event) ?? []) {
          cb(...args);
        }
      },
    };
    lastWindow = w;
    return w;
  }

  return {
    ipcHandlers,
    getLastWindow: () => lastWindow,
    resetLastWindow: () => {
      lastWindow = null;
    },
    BrowserWindow: vi.fn(function () {
      return createFakeWindow();
    }),
    ipcMain: {
      handle: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        ipcHandlers.set(channel, fn);
      }),
      removeHandler: vi.fn((channel: string) => {
        ipcHandlers.delete(channel);
      }),
    },
    app: {
      isPackaged: true,
      getPath: vi.fn(() => '/mock/appdata'),
    },
    detectPendingLegacyMigration: vi.fn(),
    migrateLegacyAppDataDirAsync: vi.fn(),
    declineLegacyAppDataMigration: vi.fn(),
    isDirectAppUpdate: vi.fn(() => false),
    reencryptMigratedWindowsSecrets: vi.fn(() => ({
      configSecretsReencrypted: 0,
      anthropicKeyReencrypted: false,
    })),
    discardRelocatedRuntimeVenv: vi.fn(),
    currentAppVersion: vi.fn(() => '0.5.4'),
    hardenBrowserWindow: vi.fn(),
    attachBrowserWindowRevealFallbacks: vi.fn(),
    resolveAppIconPath: vi.fn(() => '/mock/icon.png'),
  };
});

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  ipcMain: mocks.ipcMain,
}));

vi.mock('../app-data', async () => {
  const actual = await vi.importActual<typeof import('../app-data')>('../app-data');
  return {
    ...actual,
    detectPendingLegacyMigration: mocks.detectPendingLegacyMigration,
    migrateLegacyAppDataDirAsync: mocks.migrateLegacyAppDataDirAsync,
    declineLegacyAppDataMigration: mocks.declineLegacyAppDataMigration,
    isDirectAppUpdate: mocks.isDirectAppUpdate,
  };
});

vi.mock('../paths', () => ({
  discardRelocatedRuntimeVenv: mocks.discardRelocatedRuntimeVenv,
}));

vi.mock('../migrate-secrets', () => ({
  reencryptMigratedWindowsSecrets: mocks.reencryptMigratedWindowsSecrets,
}));

vi.mock('../updater/app-updater', () => ({
  currentAppVersion: mocks.currentAppVersion,
}));

vi.mock('../utils/app-icon', () => ({
  resolveAppIconPath: mocks.resolveAppIconPath,
}));

vi.mock('../utils/harden-browser-window', () => ({
  framelessWindowShapeOptions: () => ({ roundedCorners: false }),
  hardenBrowserWindow: mocks.hardenBrowserWindow,
  secureWebPreferences: (preload: string) => ({
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: false,
    webSecurity: true,
    preload,
  }),
}));

vi.mock('../utils/reveal-browser-window', () => ({
  attachBrowserWindowRevealFallbacks: mocks.attachBrowserWindowRevealFallbacks,
}));

import { renderMigrationWindowHtml, runPreBootMigrationPrompt } from './migration-window';

function sampleCandidate(overrides: Partial<LegacyMigrationCandidate> = {}): LegacyMigrationCandidate {
  return {
    sourceName: 'clara-coder',
    sourceLabel: 'Clara Coder',
    schemaVersion: 10,
    previousVersion: '0.5.4',
    isDirectUpdate: false,
    workspaceCount: 3,
    hasConversations: true,
    hasSettings: true,
    ...overrides,
  };
}

describe('renderMigrationWindowHtml', () => {
  it('renders detected summary, technical details, and direct-update badge safely', () => {
    const html = renderMigrationWindowHtml(
      sampleCandidate({
        isDirectUpdate: true,
        sourceName: 'clara-coder',
        workspaceCount: 2,
      }),
      'valkade',
    );
    expect(html).toContain('DIRECT UPDATE DETECTED');
    expect(html).toContain('Migrate from Clara Coder?');
    expect(html).toContain('2 workspaces');
    expect(html).toContain('Conversation history');
    expect(html).toContain('Settings &amp; providers');
    expect(html).toContain('Source: clara-coder · Target: valkade');
    expect(html).toContain('Previous version: 0.5.4');
    expect(html).toContain('Updater flag: --updated');
  });

  it('escapes HTML characters in candidate metadata and shows non-update badge when false', () => {
    const html = renderMigrationWindowHtml(
      sampleCandidate({
        sourceLabel: 'Clara <Coder> & Dev',
        sourceName: 'clara-coder-dev',
        isDirectUpdate: false,
        workspaceCount: 1,
        hasConversations: false,
        previousVersion: null,
      }),
      'valkade-dev',
    );
    expect(html).toContain('PREVIOUS INSTALLATION FOUND');
    expect(html).toContain('Migrate from Clara &lt;Coder&gt; &amp; Dev?');
    expect(html).toContain('1 workspace');
    expect(html).not.toContain('Conversation history');
    expect(html).not.toContain('Updater flag');
  });
});

describe('runPreBootMigrationPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ipcHandlers.clear();
    mocks.resetLastWindow();
    mocks.app.isPackaged = true;
  });

  it('returns none immediately without creating a window when no legacy data is pending', async () => {
    mocks.detectPendingLegacyMigration.mockReturnValue(null);
    const outcome = await runPreBootMigrationPrompt();
    expect(outcome).toBe('none');
    expect(mocks.BrowserWindow).not.toHaveBeenCalled();
  });

  it('copies data asynchronously, discards relocated venv, cleans up IPC, and resolves migrated on accept', async () => {
    mocks.detectPendingLegacyMigration.mockReturnValue(sampleCandidate());
    mocks.migrateLegacyAppDataDirAsync.mockImplementation(async (_root, _isDev, opts) => {
      opts?.onProgress?.({ entry: 'config.json', completed: 0, total: 1 });
      return {
        target: '/mock/appdata/valkade',
        migrated: true,
        from: '/mock/appdata/clara-coder',
        sourceName: 'clara-coder',
        method: 'copy',
      };
    });

    const promise = runPreBootMigrationPrompt();
    const win = mocks.getLastWindow()!;
    expect(win).toBeTruthy();
    expect(win.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^data:text\/html;charset=utf-8,/));

    // Unauthorized sender must be rejected.
    const acceptHandler = mocks.ipcHandlers.get('valkade-migration:accept')!;
    await expect(acceptHandler({ sender: {} })).rejects.toThrow('Unauthorized');

    const res = await acceptHandler({ sender: win.webContents });
    expect(res).toEqual({ ok: true });
    expect(await promise).toBe('migrated');
    expect(win.webContents.send).toHaveBeenCalledWith('valkade-migration:progress', {
      entry: 'config.json',
      completed: 0,
      total: 1,
    });
    expect(mocks.reencryptMigratedWindowsSecrets).toHaveBeenCalledWith(
      '/mock/appdata/clara-coder',
      '/mock/appdata/valkade',
    );
    expect(mocks.discardRelocatedRuntimeVenv).toHaveBeenCalledWith(
      expect.stringContaining('python-venv'),
      '/mock/appdata',
      false,
    );
    expect(mocks.ipcHandlers.size).toBe(0);
  });

  it('writes decline marker and resolves declined when the user picks Start Fresh', async () => {
    mocks.app.isPackaged = false;
    mocks.detectPendingLegacyMigration.mockReturnValue(
      sampleCandidate({ sourceName: 'clara-coder-dev', sourceLabel: 'Clara Coder (dev)' }),
    );

    const promise = runPreBootMigrationPrompt();
    const win = mocks.getLastWindow()!;
    const declineHandler = mocks.ipcHandlers.get('valkade-migration:decline')!;
    declineHandler({ sender: win.webContents });

    expect(await promise).toBe('declined');
    expect(mocks.declineLegacyAppDataMigration).toHaveBeenCalledWith('/mock/appdata', true);
    expect(mocks.ipcHandlers.size).toBe(0);
  });

  it('resolves cancelled without writing a decline marker when closed or cancelled', async () => {
    mocks.detectPendingLegacyMigration.mockReturnValue(sampleCandidate());

    const promise = runPreBootMigrationPrompt();
    const win = mocks.getLastWindow()!;
    const cancelHandler = mocks.ipcHandlers.get('valkade-migration:cancel')!;
    cancelHandler({ sender: win.webContents });

    expect(await promise).toBe('cancelled');
    expect(mocks.declineLegacyAppDataMigration).not.toHaveBeenCalled();
    expect(mocks.ipcHandlers.size).toBe(0);
  });

  it('keeps the window open and returns the error when migration fails so the user can retry or start fresh', async () => {
    mocks.detectPendingLegacyMigration.mockReturnValue(sampleCandidate());
    mocks.migrateLegacyAppDataDirAsync.mockResolvedValueOnce({
      target: '/mock/appdata/valkade',
      migrated: false,
      error: 'Disk full',
    });

    const promise = runPreBootMigrationPrompt();
    const win = mocks.getLastWindow()!;
    const acceptHandler = mocks.ipcHandlers.get('valkade-migration:accept')!;

    const firstAttempt = await acceptHandler({ sender: win.webContents });
    expect(firstAttempt).toEqual({ ok: false, error: 'Disk full' });
    expect(win.isDestroyed()).toBe(false);

    // User can then choose Start Fresh cleanly.
    const declineHandler = mocks.ipcHandlers.get('valkade-migration:decline')!;
    declineHandler({ sender: win.webContents });
    expect(await promise).toBe('declined');
  });
});
