import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export type BrowserWindowRevealOptions = {
  /** Focus after show (default true). */
  focus?: boolean;
  /** Hard fallback delay in ms when ready-to-show never fires (default 3000). */
  fallbackDelayMs?: number;
  /** Delay after did-finish-load before revealing if still hidden (default 500). */
  loadRevealDelayMs?: number;
};

/**
 * Show a BrowserWindow when `ready-to-show` is skipped (common on Linux Wayland + disable-gpu).
 * Mirrors the main window reveal logic so satellite windows (settings, health) map reliably.
 */
export function attachBrowserWindowRevealFallbacks(
  win: BrowserWindow,
  options: BrowserWindowRevealOptions = {},
): void {
  const focus = options.focus !== false;
  const fallbackDelayMs = options.fallbackDelayMs ?? 3000;
  const loadRevealDelayMs = options.loadRevealDelayMs ?? 500;
  let revealed = false;

  const reveal = (): void => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    try {
      if (!win.isVisible()) {
        win.show();
      }
      if (focus) {
        win.focus();
      }
    } catch (err) {
      console.error('[Main] Failed to reveal BrowserWindow:', err);
    }
  };

  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        reveal();
      }
    }, loadRevealDelayMs);
  });
  setTimeout(reveal, fallbackDelayMs);

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[Main] Renderer failed to load:', code, description, url);
    reveal();
  });
}

/**
 * Focus `parent` while `child` is closing. On Windows, destroying the active owned window otherwise
 * activates whatever app was next in z-order, sending the main window behind it. Runs on `close`
 * (not `closed`) so the app still owns the foreground and is allowed to move focus. Skipped when
 * the child was not active, so closing it never steals focus from another app.
 */
export function returnFocusToParentOnClose(child: BrowserWindow, parent: BrowserWindow | null | undefined): void {
  if (!parent) return;
  child.on('close', () => {
    if (!child.isFocused() || parent.isDestroyed() || !parent.isVisible() || parent.isMinimized()) {
      return;
    }
    parent.focus();
  });
}

/**
 * Parent/modal options for non-modal satellite BrowserWindows (Dependencies, Health, Updater).
 * Non-modal on every platform so the main window stays interactive while they are open.
 */
export function settingsWindowParentOptions(
  mainWindow: BrowserWindow,
): Pick<BrowserWindowConstructorOptions, 'parent' | 'modal'> {
  return { parent: mainWindow, modal: false };
}

/**
 * Parent/modal options for the Settings dialog.
 * Keeps `parent: mainWindow` so Settings stays layered above the main window in OS z-order,
 * with `modal: false` so Windows does not disable the parent HWND (which plays the system
 * "ding" beep on clicks) and Linux Wayland frameless modals stay reliable. Input blocking is
 * enforced silently via main-process `before-input-event` + focus redirect and the renderer's
 * `inert` + full-window blur backdrop.
 */
export function settingsModalParentOptions(
  mainWindow: BrowserWindow,
): Pick<BrowserWindowConstructorOptions, 'parent' | 'modal'> {
  return { parent: mainWindow, modal: false };
}
