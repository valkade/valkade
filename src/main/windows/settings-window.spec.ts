/**
 * Settings tab IPC is queued until the renderer has subscribed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const workArea = vi.hoisted(() => ({ width: 1920, height: 1040 }));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  screen: { getDisplayMatching: vi.fn(() => ({ workAreaSize: workArea })) },
}));

vi.mock('../state', () => {
  const state = {
    mainWindow: null as never,
    settingsWindow: null as never,
  };
  return { mainState: state };
});

vi.mock('../constants', () => ({ DEV_SERVER_URL: '' }));
vi.mock('../utils/app-icon', () => ({ resolveAppIconPath: () => null }));
vi.mock('../utils/harden-browser-window', () => ({
  framelessWindowShapeOptions: () => ({}),
  hardenBrowserWindow: vi.fn(),
  secureWebPreferences: () => ({}),
}));
vi.mock('../utils/reveal-browser-window', () => ({
  attachBrowserWindowRevealFallbacks: vi.fn(),
  returnFocusToParentOnClose: vi.fn(),
  settingsModalParentOptions: (parent: unknown) => ({ parent, modal: false }),
}));

import { BrowserWindow } from 'electron';
import { mainState } from '../state';
import { returnFocusToParentOnClose } from '../utils/reveal-browser-window';
import {
  createSettingsWindow,
  notifySettingsRendererReady,
  parseSettingsWindowTab,
  resetSettingsTabDelivery,
  settingsWindowBounds,
  settingsWindowSize,
  SETTINGS_WINDOW_TABS,
} from './settings-window';

function fakeWin(bounds = { x: 0, y: 0, width: 1920, height: 1080 }) {
  const send = vi.fn();
  const wcListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const winListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    isDestroyed: () => false,
    focus: vi.fn(),
    getBounds: () => bounds,
    setBounds: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!winListeners.has(event)) winListeners.set(event, new Set());
      winListeners.get(event)!.add(cb);
    }),
    removeListener: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      winListeners.get(event)?.delete(cb);
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const cb of winListeners.get(event) ?? []) cb(...args);
    },
    webContents: {
      send,
      isDestroyed: () => false,
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!wcListeners.has(event)) wcListeners.set(event, new Set());
        wcListeners.get(event)!.add(cb);
      }),
      removeListener: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        wcListeners.get(event)?.delete(cb);
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of wcListeners.get(event) ?? []) cb(...args);
      },
    },
  };
}

describe('settings tab delivery', () => {
  beforeEach(() => {
    resetSettingsTabDelivery();
    mainState.mainWindow = fakeWin() as never;
    mainState.settingsWindow = fakeWin() as never;
  });

  it('does not send settings-select-tab before the renderer is ready', () => {
    createSettingsWindow('audio');
    expect(mainState.settingsWindow?.webContents.send).not.toHaveBeenCalledWith(
      'settings-select-tab',
      'audio',
    );
  });

  it('flushes the last queued tab when the renderer becomes ready', () => {
    createSettingsWindow('audio');
    createSettingsWindow('tools');
    notifySettingsRendererReady(mainState.settingsWindow!.webContents);
    expect(mainState.settingsWindow?.webContents.send).toHaveBeenCalledTimes(1);
    expect(mainState.settingsWindow?.webContents.send).toHaveBeenCalledWith(
      'settings-select-tab',
      'tools',
    );
  });

  it('sends immediately after the renderer is ready', () => {
    notifySettingsRendererReady(mainState.settingsWindow!.webContents);
    createSettingsWindow('monaco');
    expect(mainState.settingsWindow?.webContents.send).toHaveBeenCalledWith(
      'settings-select-tab',
      'monaco',
    );
  });

  it('ignores ready from a foreign webContents', () => {
    createSettingsWindow('audio');
    notifySettingsRendererReady({ send: vi.fn() } as never);
    expect(mainState.settingsWindow?.webContents.send).not.toHaveBeenCalledWith(
      'settings-select-tab',
      'audio',
    );
  });

  it('clears any live theme preview in the remaining windows when the window closes', () => {
    mainState.settingsWindow = null as never;
    const handlers = new Map<string, () => void>();
    const created = {
      ...fakeWin(),
      on: vi.fn((event: string, cb: () => void) => void handlers.set(event, cb)),
      removeMenu: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
    };
    vi.mocked(BrowserWindow).mockImplementationOnce(function () {
      return created as never;
    });

    createSettingsWindow('themes');
    expect(mainState.settingsWindow).toBe(created);
    handlers.get('closed')!();
    expect(mainState.settingsWindow).toBeNull();
    expect(mainState.mainWindow?.webContents.send).toHaveBeenCalledWith('theme-preview', null);
  });

  it('hands focus back to the main window when Settings closes', () => {
    mainState.settingsWindow = null as never;
    const created = { ...fakeWin(), on: vi.fn(), removeMenu: vi.fn(), loadFile: vi.fn(), loadURL: vi.fn() };
    vi.mocked(BrowserWindow).mockImplementationOnce(function () {
      return created as never;
    });

    createSettingsWindow();
    expect(returnFocusToParentOnClose).toHaveBeenCalledWith(created, mainState.mainWindow);
  });

  it('closes cleanly on quit, when the main webContents is gone before its window', () => {
    mainState.settingsWindow = null as never;
    const handlers = new Map<string, () => void>();
    const created = {
      ...fakeWin(),
      on: vi.fn((event: string, cb: () => void) => void handlers.set(event, cb)),
      removeMenu: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
    };
    vi.mocked(BrowserWindow).mockImplementationOnce(function () {
      return created as never;
    });

    createSettingsWindow();
    const main = mainState.mainWindow as unknown as ReturnType<typeof fakeWin>;
    main.webContents.isDestroyed = () => true;
    main.webContents.send.mockImplementation(() => {
      throw new TypeError('Object has been destroyed');
    });
    expect(() => handlers.get('closed')!()).not.toThrow();
    expect(mainState.settingsWindow).toBeNull();
  });
});

describe('parseSettingsWindowTab', () => {
  it('accepts every tab the Settings menus list', () => {
    for (const tab of SETTINGS_WINDOW_TABS) {
      expect(parseSettingsWindowTab(tab.id)).toBe(tab.id);
    }
    expect(parseSettingsWindowTab('mcp')).toBe('mcp');
  });

  it('rejects unknown and non-string values', () => {
    expect(parseSettingsWindowTab('help')).toBeUndefined();
    expect(parseSettingsWindowTab(undefined)).toBeUndefined();
    expect(parseSettingsWindowTab(3)).toBeUndefined();
  });
});

describe('settings window size, centering, and modal input lock', () => {
  beforeEach(() => {
    resetSettingsTabDelivery();
    mainState.mainWindow = fakeWin({ x: 0, y: 0, width: 1920, height: 1080 }) as never;
    mainState.settingsWindow = null as never;
    workArea.width = 1920;
    workArea.height = 1040;
    vi.mocked(BrowserWindow).mockClear();
  });

  function createdOptions(): Record<string, unknown> {
    vi.mocked(BrowserWindow).mockImplementationOnce(function () {
      return { ...fakeWin(), on: vi.fn(), removeMenu: vi.fn(), loadFile: vi.fn(), loadURL: vi.fn() } as never;
    });
    createSettingsWindow();
    return vi.mocked(BrowserWindow).mock.calls[0][0] as Record<string, unknown>;
  }

  it('opens parented without OS modal beep, fixed in the center of the main window', () => {
    expect(createdOptions()).toMatchObject({
      parent: mainState.mainWindow,
      modal: false,
      x: 120,
      y: 50,
      width: 1680,
      height: 980,
      movable: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
    });
  });

  it('centers inside a smaller main window with a blurred inset halo', () => {
    mainState.mainWindow = fakeWin({ x: 200, y: 100, width: 1200, height: 800 }) as never;
    expect(createdOptions()).toMatchObject({
      width: 1104,
      height: 704,
      x: 248,
      y: 148,
      movable: false,
      resizable: false,
    });
  });

  it('fits a display smaller than its design size', () => {
    workArea.width = 1366;
    workArea.height = 728;
    mainState.mainWindow = fakeWin({ x: 0, y: 0, width: 1366, height: 728 }) as never;
    expect(createdOptions()).toMatchObject({
      width: 1270,
      height: 632,
      x: 48,
      y: 48,
      resizable: false,
    });
  });

  it('blocks main-window keyboard input while Settings is open and restores it on close', () => {
    const main = fakeWin({ x: 0, y: 0, width: 1920, height: 1080 });
    mainState.mainWindow = main as never;
    const handlers = new Map<string, () => void>();
    const created = {
      ...fakeWin(),
      on: vi.fn((event: string, cb: () => void) => void handlers.set(event, cb)),
      removeMenu: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
    };
    vi.mocked(BrowserWindow).mockImplementationOnce(function () {
      return created as never;
    });

    createSettingsWindow();
    const inputEvt = { preventDefault: vi.fn() };
    main.webContents.emit('before-input-event', inputEvt);
    expect(inputEvt.preventDefault).toHaveBeenCalledTimes(1);

    // Clicking / focusing the main window silently redirects focus back to Settings.
    main.emit('focus');
    expect(created.focus).toHaveBeenCalledTimes(1);

    // Once Settings begins closing, focus is allowed to return to the main window.
    handlers.get('close')!();
    main.emit('focus');
    expect(created.focus).toHaveBeenCalledTimes(1);

    handlers.get('closed')!();
    const afterCloseEvt = { preventDefault: vi.fn() };
    main.webContents.emit('before-input-event', afterCloseEvt);
    expect(afterCloseEvt.preventDefault).not.toHaveBeenCalled();
  });

  it('clamps centered bounds to multi-monitor workArea coordinates', () => {
    expect(
      settingsWindowBounds(
        { x: -1200, y: 0, width: 1200, height: 800 },
        { x: -1280, y: 0, width: 1280, height: 1024 },
      ),
    ).toEqual({ x: -1152, y: 48, width: 1104, height: 704 });
  });

  it('falls back to the design size when the display is unknown', () => {
    expect(settingsWindowSize(null)).toEqual({ width: 1680, height: 980 });
    expect(settingsWindowSize({ width: 0, height: 0 })).toEqual({ width: 1680, height: 980 });
    expect(settingsWindowSize({ width: 2560.5, height: 900.9 })).toEqual({ width: 1680, height: 900 });
  });

  it('does not shrink Settings when the main window minimizes and re-centers on restore', () => {
    let minimized = false;
    let currentMainBounds = { x: 100, y: 50, width: 1400, height: 900 };
    const main = {
      ...fakeWin(currentMainBounds),
      isMinimized: () => minimized,
      getBounds: () => currentMainBounds,
    };
    mainState.mainWindow = main as never;

    const handlers = new Map<string, () => void>();
    const created = {
      ...fakeWin({ x: 148, y: 98, width: 1304, height: 804 }),
      setResizable: vi.fn(),
      on: vi.fn((event: string, cb: () => void) => void handlers.set(event, cb)),
      removeMenu: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
    };
    vi.mocked(BrowserWindow).mockImplementationOnce(function () {
      return created as never;
    });

    createSettingsWindow();

    // Windows reports tiny off-screen bounds while minimized; Settings must ignore them.
    minimized = true;
    currentMainBounds = { x: -32000, y: -32000, width: 160, height: 28 };
    main.emit('resize');
    main.emit('move');
    expect(created.setBounds).not.toHaveBeenCalled();

    // Restoring to new bounds re-centers and toggles resizable cleanly around setBounds.
    minimized = false;
    currentMainBounds = { x: 200, y: 80, width: 1200, height: 800 };
    main.emit('restore');
    expect(created.setResizable).toHaveBeenNthCalledWith(1, true);
    expect(created.setBounds).toHaveBeenCalledWith({ x: 248, y: 128, width: 1104, height: 704 });
    expect(created.setResizable).toHaveBeenNthCalledWith(2, false);

    // Listeners are removed once Settings closes.
    handlers.get('closed')!();
    created.setBounds.mockClear();
    main.emit('maximize');
    main.emit('unmaximize');
    main.emit('restore');
    expect(created.setBounds).not.toHaveBeenCalled();
  });
});
