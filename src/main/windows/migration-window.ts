/**
 * Pre-boot branded ValkAde migration prompt window (Option A).
 *
 * Runs inside `app.whenReady()` *before* opening `config.json`, SQLite databases,
 * the Python sidecar, or the main window. Because nothing has opened handles in
 * `{appData}/valkade` yet, accepted migrations copy directly into place and boot
 * straight into the main window with zero restart.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path = require('path');
import {
  APP_DATA_DIR_NAME,
  DEV_APP_DATA_DIR_NAME,
  declineLegacyAppDataMigration,
  detectPendingLegacyMigration,
  isDirectAppUpdate,
  migrateLegacyAppDataDirAsync,
  type LegacyMigrationCandidate,
} from '../app-data';
import { APP_CONFIG_SCHEMA_VERSION } from '../config/defaults';
import { rewriteMigratedConfigPaths } from '../config/load-save';
import { reencryptMigratedWindowsSecrets } from '../migrate-secrets';
import { discardRelocatedRuntimeVenv } from '../paths';
import { currentAppVersion } from '../updater/app-updater';
import { resolveAppIconPath } from '../utils/app-icon';
import {
  framelessWindowShapeOptions,
  hardenBrowserWindow,
  secureWebPreferences,
} from '../utils/harden-browser-window';
import { attachBrowserWindowRevealFallbacks } from '../utils/reveal-browser-window';

export type PreBootMigrationOutcome = 'none' | 'migrated' | 'declined' | 'cancelled';

const CHANNEL_ACCEPT = 'valkade-migration:accept';
const CHANNEL_DECLINE = 'valkade-migration:decline';
const CHANNEL_CANCEL = 'valkade-migration:cancel';
const CHANNEL_PROGRESS = 'valkade-migration:progress';

function migrationPreloadPath(): string {
  return path.join(__dirname, '..', '..', 'preload', 'migration-preload.js');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildDetectedItems(candidate: LegacyMigrationCandidate): string[] {
  const items: string[] = [];
  if (candidate.workspaceCount > 0) {
    items.push(
      `${candidate.workspaceCount} ${candidate.workspaceCount === 1 ? 'workspace' : 'workspaces'}`,
    );
  }
  if (candidate.hasConversations) {
    items.push('Conversation history');
  }
  if (candidate.hasSettings) {
    items.push('Settings & providers');
  }
  if (items.length === 0) {
    items.push('Previous app data');
  }
  return items;
}

/**
 * Pure HTML builder for the pre-boot migration window. Uses ValkAde's dark graphite
 * palette (`#141417` / `#1c1c21`), gold winged-V emblem, and electric blue primary action.
 */
export function renderMigrationWindowHtml(
  candidate: LegacyMigrationCandidate,
  targetDirName: string,
): string {
  const sourceLabel = escapeHtml(candidate.sourceLabel);
  const sourceName = escapeHtml(candidate.sourceName);
  const targetName = escapeHtml(targetDirName);
  const badgeText = candidate.isDirectUpdate
    ? 'DIRECT UPDATE DETECTED'
    : 'PREVIOUS INSTALLATION FOUND';
  const badgeClass = candidate.isDirectUpdate ? 'badge badge--amber' : 'badge badge--blue';
  const leadCopy = candidate.isDirectUpdate
    ? `You just updated from ${sourceLabel} to ValkAde. Choose whether to carry over your existing workspaces, conversations, and settings.`
    : `Existing ${sourceLabel} data was found on this computer. Choose whether to carry over your workspaces, conversations, and settings into ValkAde.`;

  const chipsHtml = buildDetectedItems(candidate)
    .map((item) => `<span class="chip">${escapeHtml(item)}</span>`)
    .join('');

  const detailParts: string[] = [
    `Source: ${candidate.sourceName}`,
    `Target: ${targetDirName}`,
  ];
  if (candidate.previousVersion) {
    detailParts.push(`Previous version: ${candidate.previousVersion}`);
  }
  if (candidate.schemaVersion !== null) {
    detailParts.push(`Config schema: v${candidate.schemaVersion}`);
  }
  if (candidate.isDirectUpdate) {
    detailParts.push('Updater flag: --updated');
  }
  const technicalDetails = escapeHtml(detailParts.join(' · '));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <title>ValkAde — Data Migration</title>
  <style>
    :root {
      --bg: #141417;
      --surface: #1c1c21;
      --deep: #0f0f11;
      --fg: #e4e4e7;
      --muted: #8b8b96;
      --border: #34343c;
      --border-subtle: #26262c;
      --primary: #4da3ff;
      --primary-hover: #6ab3ff;
      --on-primary: #0a0f1a;
      --amber: #ffb35c;
      --error: #ff6b6b;
      --mono: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--sans);
      font-size: 13.5px;
      line-height: 1.5;
      user-select: none;
      overflow: hidden;
    }
    .frame {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      border: 1px solid var(--border);
      background: var(--bg);
    }
    .titlebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 36px;
      padding: 0 8px 0 14px;
      background: linear-gradient(90deg, #1c1c21 0%, #0f0f11 100%);
      border-bottom: 1px solid var(--border-subtle);
      -webkit-app-region: drag;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 9px;
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .brand strong {
      color: var(--fg);
      font-weight: 600;
    }
    .close-btn {
      -webkit-app-region: no-drag;
      width: 28px;
      height: 24px;
      border: 0;
      background: transparent;
      color: var(--muted);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .close-btn:hover:not(:disabled) {
      background: rgba(255, 107, 107, 0.16);
      color: var(--fg);
    }
    .close-btn:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 20px 22px 18px;
      gap: 14px;
    }
    .badge {
      align-self: flex-start;
      font-family: var(--mono);
      font-size: 10.5px;
      letter-spacing: 0.08em;
      padding: 3px 8px;
      border: 1px solid var(--border);
    }
    .badge--blue {
      color: var(--primary);
      border-color: rgba(77, 163, 255, 0.35);
      background: rgba(77, 163, 255, 0.08);
    }
    .badge--amber {
      color: var(--amber);
      border-color: rgba(255, 179, 92, 0.4);
      background: rgba(255, 179, 92, 0.09);
    }
    h1 {
      margin: 0;
      font-size: 19px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--fg);
    }
    .lead {
      margin: 0;
      color: #c6c6ce;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border-subtle);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      font-family: var(--mono);
      font-size: 11.5px;
      padding: 3px 8px;
      background: var(--deep);
      border: 1px solid var(--border);
      color: var(--fg);
    }
    .note {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
    .note code {
      font-family: var(--mono);
      color: var(--fg);
      background: var(--deep);
      padding: 1px 4px;
    }
    details {
      font-size: 12px;
      color: var(--muted);
    }
    summary {
      cursor: pointer;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
    }
    summary:hover { color: var(--fg); }
    .details-body {
      margin: 6px 0 0;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      word-break: break-word;
      user-select: text;
    }
    .progress-wrap {
      display: none;
      flex-direction: column;
      gap: 6px;
    }
    .progress-wrap.visible {
      display: flex;
    }
    .progress-label {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .progress-track {
      width: 100%;
      height: 5px;
      background: var(--border-subtle);
      overflow: hidden;
    }
    .progress-fill {
      width: 12%;
      height: 100%;
      background: var(--primary);
      transition: width 140ms ease-out;
    }
    .error-banner {
      display: none;
      padding: 9px 11px;
      border: 1px solid rgba(255, 107, 107, 0.45);
      background: rgba(255, 107, 107, 0.1);
      color: var(--error);
      font-size: 12px;
      user-select: text;
    }
    .error-banner.visible {
      display: block;
    }
    .actions {
      margin-top: auto;
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding-top: 6px;
      border-top: 1px solid var(--border-subtle);
    }
    button.action {
      font-family: var(--sans);
      font-size: 13px;
      font-weight: 600;
      padding: 9px 16px;
      border: 1px solid var(--border);
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;
    }
    button.action:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    button.action--secondary {
      background: var(--surface);
      color: var(--fg);
    }
    button.action--secondary:hover:not(:disabled) {
      background: #25252c;
      border-color: #46464f;
    }
    button.action--primary {
      background: var(--primary);
      border-color: var(--primary);
      color: var(--on-primary);
    }
    button.action--primary:hover:not(:disabled) {
      background: var(--primary-hover);
      border-color: var(--primary-hover);
    }
    button:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
    }
  </style>
</head>
<body>
  <div class="frame">
    <div class="titlebar">
      <div class="brand">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="18" height="18" aria-hidden="true">
          <rect width="64" height="64" rx="14" fill="#0e0d0c"/>
          <polygon points="12,12.5 22,14.5 30.5,41 30.5,52 26,52" fill="#f6f2e9"/>
          <polygon points="32.5,41 38.5,25 45.5,14.5 56.5,9.5 53.2,16.5 46.5,21.5 32.5,45.2" fill="#ffde82"/>
          <polygon points="32.5,47.2 45.2,24.5 55,19.5 51.5,26 44.2,30.8 32.5,50.2" fill="#f5a826"/>
          <polygon points="33.2,52 43.8,33.5 51.5,29.5 48,35.2 41.2,40 35.5,52" fill="#f5a826"/>
          <polygon points="37.5,51.5 43.8,41.5 48.2,38.8 45,44.2 39,51.5" fill="#c46d12"/>
        </svg>
        <span><strong>VALKADE</strong> · DATA MIGRATION</span>
      </div>
      <button id="btn-close" class="close-btn" type="button" title="Close and exit" aria-label="Close and exit">&times;</button>
    </div>
    <main class="content">
      <div class="${badgeClass}">${badgeText}</div>
      <h1>Migrate from ${sourceLabel}?</h1>
      <p class="lead">${leadCopy}</p>
      <section class="card" aria-label="Detected data">
        <div class="chips">${chipsHtml}</div>
        <p class="note">
          Your original <code>${sourceName}</code> folder stays untouched as a backup.
          Copied paths inside <code>config.json</code> are updated automatically for <code>${targetName}</code>.
        </p>
      </section>
      <details>
        <summary>Technical details</summary>
        <p class="details-body">${technicalDetails}</p>
      </details>
      <div id="progress-wrap" class="progress-wrap" role="status" aria-live="polite">
        <div id="progress-label" class="progress-label">Preparing migration…</div>
        <div class="progress-track"><div id="progress-fill" class="progress-fill"></div></div>
      </div>
      <div id="error-banner" class="error-banner" role="alert"></div>
      <div class="actions">
        <button id="btn-fresh" class="action action--secondary" type="button">Start Fresh</button>
        <button id="btn-migrate" class="action action--primary" type="button">Migrate to ValkAde</button>
      </div>
    </main>
  </div>
  <script>
    (function () {
      const api = window.valkadeMigration;
      const btnMigrate = document.getElementById('btn-migrate');
      const btnFresh = document.getElementById('btn-fresh');
      const btnClose = document.getElementById('btn-close');
      const progressWrap = document.getElementById('progress-wrap');
      const progressLabel = document.getElementById('progress-label');
      const progressFill = document.getElementById('progress-fill');
      const errorBanner = document.getElementById('error-banner');
      let busy = false;

      function setBusy(nextBusy) {
        busy = nextBusy;
        btnMigrate.disabled = nextBusy;
        btnFresh.disabled = nextBusy;
        btnClose.disabled = nextBusy;
      }

      function showError(message) {
        errorBanner.textContent = message;
        errorBanner.classList.add('visible');
      }

      function clearError() {
        errorBanner.textContent = '';
        errorBanner.classList.remove('visible');
      }

      if (api && typeof api.onProgress === 'function') {
        api.onProgress(function (p) {
          progressWrap.classList.add('visible');
          const pct = p.total > 0 ? Math.min(100, Math.max(8, Math.round((p.completed / p.total) * 100))) : 100;
          progressFill.style.width = pct + '%';
          progressLabel.textContent = p.entry === 'done'
            ? 'Finalizing ValkAde launch…'
            : 'Copying ' + p.entry + ' (' + Math.min(p.completed + 1, p.total) + '/' + p.total + ')…';
        });
      }

      btnMigrate.addEventListener('click', async function () {
        if (busy || !api) return;
        clearError();
        setBusy(true);
        btnMigrate.textContent = 'Migrating…';
        progressWrap.classList.add('visible');
        progressLabel.textContent = 'Copying data into ValkAde…';
        try {
          const res = await api.accept();
          if (!res || !res.ok) {
            showError((res && res.error) || 'Migration failed. Your original folder was not modified.');
            setBusy(false);
            btnMigrate.textContent = 'Retry Migration';
            progressWrap.classList.remove('visible');
          }
        } catch (err) {
          showError(err && err.message ? err.message : 'Migration failed unexpectedly.');
          setBusy(false);
          btnMigrate.textContent = 'Retry Migration';
          progressWrap.classList.remove('visible');
        }
      });

      btnFresh.addEventListener('click', async function () {
        if (busy || !api) return;
        clearError();
        setBusy(true);
        try {
          await api.decline();
        } catch (err) {
          showError(err && err.message ? err.message : 'Could not save choice.');
          setBusy(false);
        }
      });

      btnClose.addEventListener('click', function () {
        if (busy || !api) return;
        void api.cancel();
      });

      window.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !busy && api) {
          event.preventDefault();
          void api.cancel();
        }
      });

      btnMigrate.focus();
    })();
  </script>
</body>
</html>`;
}

/**
 * Inspect for an eligible legacy Clara Coder data folder and, if found, present the
 * pre-boot ValkAde Migration Window before any config, SQLite DB, or sidecar opens.
 */
export async function runPreBootMigrationPrompt(): Promise<PreBootMigrationOutcome> {
  const isDev = !app.isPackaged;
  const appDataRoot = app.getPath('appData');
  const candidate = detectPendingLegacyMigration({
    appDataRoot,
    isDev,
    currentVersion: currentAppVersion(),
    maxSchemaVersion: APP_CONFIG_SCHEMA_VERSION,
    directUpdate: isDirectAppUpdate(),
  });

  if (!candidate) {
    return 'none';
  }

  const targetDirName = isDev ? DEV_APP_DATA_DIR_NAME : APP_DATA_DIR_NAME;
  const html = renderMigrationWindowHtml(candidate, targetDirName);
  const icon = resolveAppIconPath();

  const win = new BrowserWindow({
    width: 540,
    height: 440,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    center: true,
    frame: false,
    ...framelessWindowShapeOptions(),
    show: false,
    backgroundColor: '#141417',
    title: 'ValkAde — Data Migration',
    ...(icon ? { icon } : {}),
    webPreferences: secureWebPreferences(migrationPreloadPath()),
  });

  hardenBrowserWindow(win);
  win.removeMenu();
  attachBrowserWindowRevealFallbacks(win);

  return new Promise<PreBootMigrationOutcome>((resolve) => {
    let settled = false;
    let migrating = false;
    let finalOutcome: PreBootMigrationOutcome = 'cancelled';

    const cleanupIpc = (): void => {
      ipcMain.removeHandler(CHANNEL_ACCEPT);
      ipcMain.removeHandler(CHANNEL_DECLINE);
      ipcMain.removeHandler(CHANNEL_CANCEL);
    };

    const finish = (outcome: PreBootMigrationOutcome, closeWindow: boolean): void => {
      if (settled) return;
      settled = true;
      finalOutcome = outcome;
      cleanupIpc();
      if (closeWindow && !win.isDestroyed()) {
        win.destroy();
      }
      resolve(outcome);
    };

    const assertSender = (sender: Electron.WebContents): void => {
      if (win.isDestroyed() || sender !== win.webContents) {
        throw new Error('Unauthorized migration prompt IPC sender');
      }
    };

    win.on('close', (event) => {
      if (migrating && !settled) {
        event.preventDefault();
      }
    });

    win.on('closed', () => {
      if (!settled) {
        finish(finalOutcome, false);
      }
    });

    ipcMain.handle(CHANNEL_ACCEPT, async (event) => {
      assertSender(event.sender);
      if (migrating || settled) {
        return { ok: false, error: 'Migration is already in progress.' };
      }
      migrating = true;
      try {
        const result = await migrateLegacyAppDataDirAsync(appDataRoot, isDev, {
          sourceName: candidate.sourceName,
          rewriteConfig: rewriteMigratedConfigPaths,
          onProgress: (progress) => {
            if (!win.isDestroyed()) {
              win.webContents.send(CHANNEL_PROGRESS, progress);
            }
          },
        });
        if (!result.migrated) {
          migrating = false;
          return {
            ok: false,
            error: result.error || 'Could not migrate data from Clara Coder.',
          };
        }
        console.log(
          `[app-data] Migrated app data (${result.method}) from ${result.from} → ${result.target}`,
        );
        if (result.from) {
          reencryptMigratedWindowsSecrets(result.from, result.target);
        }
        discardRelocatedRuntimeVenv(
          path.join(result.target, 'runtime', 'python-venv'),
          appDataRoot,
          isDev,
        );
        migrating = false;
        finish('migrated', true);
        return { ok: true };
      } catch (err) {
        migrating = false;
        const message = err instanceof Error ? err.message : String(err);
        console.error('[app-data] Pre-boot migration failed:', err);
        return { ok: false, error: message };
      }
    });

    ipcMain.handle(CHANNEL_DECLINE, (event) => {
      assertSender(event.sender);
      if (migrating || settled) return;
      declineLegacyAppDataMigration(appDataRoot, isDev);
      finish('declined', true);
    });

    ipcMain.handle(CHANNEL_CANCEL, (event) => {
      assertSender(event.sender);
      if (migrating || settled) return;
      finish('cancelled', true);
    });

    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    void win.loadURL(dataUrl).catch((err) => {
      console.error('[app-data] Failed to load pre-boot migration window:', err);
      finish('cancelled', true);
    });
  });
}
