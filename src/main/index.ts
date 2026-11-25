/**
 * Electron main process entry: Python sidecar, IPC, workspace watch, and BrowserWindows.
 * Privileged schemes (`nemo-tts`, `nemo-asset`, `valkade-theme`, legacy `clara-theme`) must register before `app.whenReady`.
 */
import { mkdir } from 'fs/promises';
import { app, BrowserWindow } from 'electron';
import { registerPrivilegedSchemes } from './protocol/register-privileged';
import { ensurePythonServer, isPythonHealthy, stopPythonSidecar } from './python/server';
import { getSidecarStartupState, setSidecarStartupState } from './python/sidecar-status';
import { registerNemoTtsStreamProtocol } from './protocol/nemo-tts';
import { registerNemoAssetProtocol } from './protocol/nemo-asset';
import { registerValkAdeThemeAssetProtocol } from './protocol/valkade-theme-asset';
import { loadConfigSync, updateConfig } from './config/load-save';
import { currentAppVersion } from './updater/app-updater';
import { reconcileLostWorkspacesOnStartup } from './ipc/handlers/config-workspaces';
import { setHealthMetricsEnabled, syncPythonLogLevel } from './ipc/handlers/health';
import { getLlamaManagedRuntimeOverrides, reapOrphanManagedLlamaServers, stopAllManagedLlamaServers } from './llama-server-manager';
import { syncRuntimeConfigToPython } from './python/workspace-sync';
import { applyResolvedUserPath } from './runtime/user-path';
import { clearWorkspaceWatcher, refreshWorkspaceWatcherForCurrentConfig } from './workspace/watcher';
import { createMainWindow } from './windows/main-window';
import { runPreBootMigrationPrompt } from './windows/migration-window';
import { registerAllIpc } from './ipc/register-ipc';
import { killAllWorkspacePtySessions } from './ipc/handlers/workspace-pty';
import { envValkade, setEnvValkade } from './env-valkade';
import { configureAppDataDir } from './paths';
import { captureIpcForBrowserBridge, startBrowserBridge } from './dev/browser-bridge';
import { rearmMcpOAuthRefresh } from './mcp-oauth-refresh';
import { startSubagentEventPump, stopSubagentEventPump } from './ipc/handlers/subagent-events';
import { startScreenshotMaintenance, stopScreenshotMaintenance } from './web/screenshot-maintenance';

/**
 * Chromium GPU process often segfaults on Linux Wayland when Vulkan is enabled.
 * Keep native Wayland (x11/XWayland breaks window mapping on Hyprland) but disable
 * hardware GPU. Set VALKADE_ENABLE_GPU=1 to opt in to GPU acceleration.
 */
function applyLinuxDisplayWorkarounds(): void {
  if (process.platform !== 'linux') return;
  if (envValkade('ENABLE_GPU') === '1') return;

  const onWayland =
    (process.env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' ||
    Boolean(process.env.WAYLAND_DISPLAY);
  const disableGpu = envValkade('DISABLE_GPU') === '1' || onWayland;

  const ozoneOverride = envValkade('ELECTRON_OZONE_PLATFORM');
  if (ozoneOverride) {
    app.commandLine.appendSwitch('ozone-platform', ozoneOverride);
  } else if (onWayland) {
    app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
    app.commandLine.appendSwitch('ozone-platform', 'wayland');
  }

  if (disableGpu) {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-features', 'Vulkan');
  }
}

applyLinuxDisplayWorkarounds();

// Match the binary / .desktop StartupWMClass on Linux so the window manager
// associates our windows with the `valkade` launcher entry (and its icon).
// macOS keeps the display name for the menu bar; userData is pinned to
// `valkade` separately in configureAppDataDir().
app.setName(process.platform === 'darwin' ? 'ValkAde' : 'valkade');
// Pin userData to ``valkade`` (or ``valkade-dev`` in dev) before IPC/SQLite/config.
// Legacy Clara Coder folders are never migrated automatically; when one is found,
// `runPreBootMigrationPrompt()` prompts the user before config, SQLite, or the sidecar open.
configureAppDataDir();

function extraUserPathFromDisk(): string {
  try {
    return loadConfigSync().workspaceTools?.extraUserPath ?? '';
  } catch {
    return '';
  }
}

let preBootMigrationHandoff = false;
let ipcRegistered = false;

function ensureIpcRegistered(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;
  // Dev-only (`npm run dev:bridge`): must see the ipcMain handlers as they register.
  captureIpcForBrowserBridge();
  registerAllIpc();
}

registerPrivilegedSchemes();

app
  .whenReady()
  .then(async () => {
    // Run explicit opt-in migration before touching config.json, SQLite (`openConversationsDb`
    // inside `registerAllIpc`), or the Python sidecar so Windows never holds open file handles
    // and accepted migrations boot directly with zero restart.
    preBootMigrationHandoff = true;
    const migrationOutcome = await runPreBootMigrationPrompt();
    if (migrationOutcome === 'cancelled') {
      preBootMigrationHandoff = false;
      app.quit();
      return;
    }

    ensureIpcRegistered();

    // Overlap login-shell PATH probe with window creation now that config.json reflects any migration.
    const userPathReady = applyResolvedUserPath({ extraUserPath: extraUserPathFromDisk() }).catch(
      (err) => {
        console.error('[Main] User PATH recovery failed:', err);
      },
    );

    startScreenshotMaintenance();
    // Show UI immediately — packaged Linux launches used to sit dark for up to ~60s
    // while waitForPython polled a sidecar that had already crashed (missing venv deps).
    registerNemoTtsStreamProtocol();
    registerNemoAssetProtocol();
    registerValkAdeThemeAssetProtocol();
    createMainWindow();
    preBootMigrationHandoff = false;
    void startBrowserBridge().catch((err) => {
      console.error('[Main] Browser bridge failed to start:', err);
    });

    // Fire-and-forget: each orphan may take the full CTRL_C grace to unload.
    void reapOrphanManagedLlamaServers().catch((err) => {
      console.error('[Main] Orphan llama-server reap failed:', err);
    });
    await userPathReady;
    let sidecarUp = false;
    try {
      await ensurePythonServer();
      sidecarUp = true;
    } catch (err) {
      console.error('[Main] Python sidecar unavailable — UI already open:', err);
      // Now, not after the syncs below: each waits out its own timeout on a dead sidecar.
      setSidecarStartupState('failed');
    }
    const config = await reconcileLostWorkspacesOnStartup();
    const runningVersion = currentAppVersion();
    if (runningVersion && config.lastAppVersion !== runningVersion) {
      void updateConfig((cfg) => {
        cfg.lastAppVersion = runningVersion;
      }).catch((err) => {
        console.error('[Main] Failed to stamp lastAppVersion:', err);
      });
    }
    // Ensure the Model Manager library root exists (default: ~/ValkAde/models; ~/ClaraCoder/models when it exists).
    const modelsDir = config.modelManager?.customModelsDir?.trim();
    if (modelsDir) {
      setEnvValkade('CUSTOM_MODELS_DIR', modelsDir);
      try {
        await mkdir(modelsDir, { recursive: true });
      } catch (err) {
        console.error('[Main] Could not create custom models directory:', err);
      }
    }
    try {
      await syncPythonLogLevel(config.healthMonitor.logLevel);
      setHealthMetricsEnabled(config.healthMonitor.metricsEnabled);
      await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
      await refreshWorkspaceWatcherForCurrentConfig(config);
    } catch (err) {
      console.error('[Main] Python sync at startup failed:', err);
    }
    // After the config sync, so a workspace opened now talks to a configured sidecar.
    if (sidecarUp) {
      setSidecarStartupState('ready');
    }
    // Refreshes MCP OAuth tokens that expired while the app was closed, then keeps them fresh.
    rearmMcpOAuthRefresh();
    // Sub-agents report on their own channel: they can outlive the chat turn that started them.
    startSubagentEventPump();
  })
  .catch((err) => {
    preBootMigrationHandoff = false;
    console.error(err);
    ensureIpcRegistered();
    createMainWindow();
    // Startup stopped part-way: don't leave the window waiting on a state nothing will settle.
    if (getSidecarStartupState() === 'starting') {
      void isPythonHealthy()
        .catch(() => false)
        .then((healthy) => setSidecarStartupState(healthy ? 'ready' : 'failed'));
    }
    // Waits for a sidecar that comes up later (e.g. after a runtime install).
    startSubagentEventPump();
  });

app.on('activate', () => {
  if (preBootMigrationHandoff) {
    return;
  }
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (preBootMigrationHandoff) {
    return;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  try {
    stopAllManagedLlamaServers();
    killAllWorkspacePtySessions();
    clearWorkspaceWatcher();
    stopSubagentEventPump();
    stopScreenshotMaintenance();
    stopPythonSidecar();
  } catch (err) {
    console.error('[Main] will-quit cleanup failed:', err);
  }
});
