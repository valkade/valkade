import { BrowserWindow, screen, type WebContents } from 'electron';
import path = require('path');
import { DEV_SERVER_URL } from '../constants';
import { mainState } from '../state';
import { resolveAppIconPath } from '../utils/app-icon';
import {
  framelessWindowShapeOptions,
  hardenBrowserWindow,
  secureWebPreferences,
} from '../utils/harden-browser-window';
import {
  attachBrowserWindowRevealFallbacks,
  returnFocusToParentOnClose,
  settingsModalParentOptions,
} from '../utils/reveal-browser-window';
import { broadcastThemePreview } from '../ipc/handlers/theme-broadcast';
import { isSettingsTab, type SettingsTab as SettingsWindowTab } from '../../shared/settings-tabs';

export { SETTINGS_TAB_ENTRIES as SETTINGS_WINDOW_TABS } from '../../shared/settings-tabs';
export type { SettingsTab as SettingsWindowTab } from '../../shared/settings-tabs';

export function parseSettingsWindowTab(value: unknown): SettingsWindowTab | undefined {
  return isSettingsTab(value) ? value : undefined;
}

function preloadPath(): string {
  return path.join(__dirname, '..', '..', 'preload', 'preload.js');
}

function rendererIndexHtml(): string {
  return path.join(__dirname, '..', '..', 'renderer', 'browser', 'index.html');
}

function settingsHash(tab?: SettingsWindowTab): string {
  return tab ? `/settings?tab=${tab}` : '/settings';
}

let settingsRendererReady = false;
let pendingSettingsTab: SettingsWindowTab | undefined;

export function resetSettingsTabDelivery(): void {
  settingsRendererReady = false;
  pendingSettingsTab = undefined;
}

function sendSettingsTabNow(sw: BrowserWindow, tab: SettingsWindowTab): void {
  if (!sw.isDestroyed()) {
    sw.webContents.send('settings-select-tab', tab);
  }
}

function queueSettingsWindowTab(sw: BrowserWindow, tab: SettingsWindowTab): void {
  pendingSettingsTab = tab;
  if (settingsRendererReady) {
    sendSettingsTabNow(sw, tab);
  }
}

/** Flush a queued tab once SettingsStore has subscribed to `settings-select-tab`. */
export function notifySettingsRendererReady(sender: WebContents): void {
  const sw = mainState.settingsWindow;
  if (!sw || sw.isDestroyed() || sender !== sw.webContents) {
    return;
  }
  settingsRendererReady = true;
  if (pendingSettingsTab) {
    sendSettingsTabNow(sw, pendingSettingsTab);
  }
}

const SETTINGS_WINDOW_WIDTH = 1680;
const SETTINGS_WINDOW_HEIGHT = 980;
const SETTINGS_MAIN_INSET_PX = 48;
const SETTINGS_MIN_WIDTH = 960;
const SETTINGS_MIN_HEIGHT = 600;

export type WindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * The Settings window's base size. It cannot be resized, so on a display smaller than the design
 * size it takes the display's work area instead of hanging off the screen.
 */
export function settingsWindowSize(workArea: { width: number; height: number } | null): {
  width: number;
  height: number;
} {
  if (!workArea || workArea.width <= 0 || workArea.height <= 0) {
    return { width: SETTINGS_WINDOW_WIDTH, height: SETTINGS_WINDOW_HEIGHT };
  }
  return {
    width: Math.min(SETTINGS_WINDOW_WIDTH, Math.floor(workArea.width)),
    height: Math.min(SETTINGS_WINDOW_HEIGHT, Math.floor(workArea.height)),
  };
}

/**
 * Fixed bounds centered over `mainBounds`, inset slightly so the blurred main window frames the
 * dialog and clamped to `workArea` so it never clips off-screen.
 */
export function settingsWindowBounds(
  mainBounds: WindowRect | null,
  workArea: WindowRect | null,
): { x?: number; y?: number; width: number; height: number } {
  let { width, height } = settingsWindowSize(workArea);
  if (!mainBounds || mainBounds.width <= 0 || mainBounds.height <= 0) {
    return { width, height };
  }

  const mainW = Math.floor(mainBounds.width);
  const mainH = Math.floor(mainBounds.height);
  const insetW = Math.max(Math.min(SETTINGS_MIN_WIDTH, mainW), mainW - SETTINGS_MAIN_INSET_PX * 2);
  const insetH = Math.max(Math.min(SETTINGS_MIN_HEIGHT, mainH), mainH - SETTINGS_MAIN_INSET_PX * 2);
  width = Math.min(width, insetW);
  height = Math.min(height, insetH);

  let x = Math.round(mainBounds.x + (mainBounds.width - width) / 2);
  let y = Math.round(mainBounds.y + (mainBounds.height - height) / 2);

  if (workArea && workArea.width > 0 && workArea.height > 0) {
    const maxX = workArea.x + Math.max(0, Math.floor(workArea.width) - width);
    const maxY = workArea.y + Math.max(0, Math.floor(workArea.height) - height);
    x = Math.min(maxX, Math.max(workArea.x, x));
    y = Math.min(maxY, Math.max(workArea.y, y));
  }

  return { x, y, width, height };
}

function safeGetBounds(win: BrowserWindow): WindowRect | null {
  try {
    return win.getBounds();
  } catch {
    return null;
  }
}

/** Work area of the display the main window is on (Settings opens centered over it); null when unknown. */
function workAreaOf(win: BrowserWindow): WindowRect | null {
  try {
    const display = screen.getDisplayMatching(win.getBounds());
    if (display.workArea && display.workArea.width > 0 && display.workArea.height > 0) {
      return display.workArea;
    }
    if (display.workAreaSize && display.workAreaSize.width > 0 && display.workAreaSize.height > 0) {
      return { x: 0, y: 0, width: display.workAreaSize.width, height: display.workAreaSize.height };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Modal, fixed-center settings dialog (Angular `#/settings`). Reuses preload; notifies the main
 * window when shown/hidden so it blurs and blocks input while Settings is open.
 * Optional `tab` opens (or switches) a settings category from the titlebar menu.
 */
export function createSettingsWindow(tab?: SettingsWindowTab): void {
  const mainWindow = mainState.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const notifyVisibility = (isOpen: boolean): void => {
    // On quit the main window's webContents can be gone before the window itself.
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('settings-window-visibility-changed', isOpen);
  };

  const mainIsMinimized = (): boolean =>
    typeof mainWindow.isMinimized === 'function' && mainWindow.isMinimized();

  const effectiveMainBounds = (): WindowRect | null =>
    mainIsMinimized() ? null : safeGetBounds(mainWindow);

  const centerOnMain = (sw: BrowserWindow): void => {
    if (sw.isDestroyed() || mainWindow.isDestroyed() || mainIsMinimized()) return;
    const next = settingsWindowBounds(safeGetBounds(mainWindow), workAreaOf(mainWindow));
    if (typeof next.x !== 'number' || typeof next.y !== 'number' || typeof sw.setBounds !== 'function') {
      return;
    }
    const current = safeGetBounds(sw);
    if (
      current &&
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
    ) {
      return;
    }
    const sizeChanged = !current || current.width !== next.width || current.height !== next.height;
    if (sizeChanged && typeof sw.setResizable === 'function') {
      sw.setResizable(true);
      try {
        sw.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height });
      } finally {
        if (!sw.isDestroyed()) {
          sw.setResizable(false);
        }
      }
      return;
    }
    sw.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height });
  };

  if (mainState.settingsWindow && !mainState.settingsWindow.isDestroyed()) {
    notifyVisibility(true);
    centerOnMain(mainState.settingsWindow);
    if (tab) {
      queueSettingsWindowTab(mainState.settingsWindow, tab);
    }
    mainState.settingsWindow.focus();
    return;
  }

  resetSettingsTabDelivery();

  const icon = resolveAppIconPath();
  const parentOpts = settingsModalParentOptions(mainWindow);
  const initialBounds = settingsWindowBounds(effectiveMainBounds(), workAreaOf(mainWindow));
  mainState.settingsWindow = new BrowserWindow({
    ...initialBounds,
    ...parentOpts,
    frame: false,
    ...framelessWindowShapeOptions(),
    movable: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'ValkAde — Settings',
    ...(icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preloadPath()),
  });

  const sw = mainState.settingsWindow;
  let closing = false;
  hardenBrowserWindow(sw);
  sw.removeMenu();
  attachBrowserWindowRevealFallbacks(sw);
  // Mark closing before returnFocusToParentOnClose runs on `close` so focus redirection does not
  // bounce focus back onto the closing Settings window.
  sw.on('close', () => {
    closing = true;
  });
  returnFocusToParentOnClose(sw, mainWindow);
  notifyVisibility(true);

  // Silent modal lock: block keyboard input to the main window, keep Settings centered over it,
  // and immediately redirect any main-window focus back to Settings without triggering the OS
  // disabled-window beep.
  const blockMainInput = (event: Electron.Event): void => {
    if (!closing && mainState.settingsWindow === sw && !sw.isDestroyed()) {
      event.preventDefault();
    }
  };
  const onMainGeometryChanged = (): void => centerOnMain(sw);
  const onMainFocus = (): void => {
    if (!closing && !parentOpts.modal && mainState.settingsWindow === sw && !sw.isDestroyed()) {
      sw.focus();
    }
  };

  if (!mainWindow.webContents.isDestroyed() && typeof mainWindow.webContents.on === 'function') {
    mainWindow.webContents.on('before-input-event', blockMainInput);
  }
  if (typeof mainWindow.on === 'function') {
    mainWindow.on('move', onMainGeometryChanged);
    mainWindow.on('resize', onMainGeometryChanged);
    mainWindow.on('maximize', onMainGeometryChanged);
    mainWindow.on('unmaximize', onMainGeometryChanged);
    mainWindow.on('restore', onMainGeometryChanged);
    if (!parentOpts.modal) {
      mainWindow.on('focus', onMainFocus);
    }
  }

  const hash = settingsHash(tab);
  if (DEV_SERVER_URL) {
    sw.loadURL(`${DEV_SERVER_URL}/#${hash}`);
  } else {
    sw.loadFile(rendererIndexHtml(), { hash });
  }

  sw.on('closed', () => {
    if (!mainWindow.isDestroyed()) {
      if (!mainWindow.webContents.isDestroyed() && typeof mainWindow.webContents.removeListener === 'function') {
        mainWindow.webContents.removeListener('before-input-event', blockMainInput);
      }
      if (typeof mainWindow.removeListener === 'function') {
        mainWindow.removeListener('move', onMainGeometryChanged);
        mainWindow.removeListener('resize', onMainGeometryChanged);
        mainWindow.removeListener('maximize', onMainGeometryChanged);
        mainWindow.removeListener('unmaximize', onMainGeometryChanged);
        mainWindow.removeListener('restore', onMainGeometryChanged);
        mainWindow.removeListener('focus', onMainFocus);
      }
    }
    resetSettingsTabDelivery();
    notifyVisibility(false);
    mainState.settingsWindow = null;
    // The renderer is gone before any Angular teardown can run, so a live theme preview
    // started from Settings → Themes would otherwise stay painted in every other window.
    broadcastThemePreview(null);
  });
}
