/**
 * Claude Code (Subscription) source IPC: CLI status probe, model/effort selection,
 * `CLAUDE_CONFIG_DIR` & bridge toggles, and launching `claude auth login`.
 */
import { ipcMain, type BrowserWindow } from 'electron';
import type {
  AppConfig,
  ClaudeCliMutationResult,
  ClaudeCliSettings,
  ClaudeCliStatusResult,
  LlmReasoningEffort,
} from '../../../shared';
import {
  PINNED_CLAUDE_CLI_PROVIDER_ID,
  findClaudeCliModel,
  normalizeClaudeCliSettings,
} from '../../../shared';
import {
  getCachedClaudeCliModels,
  getClaudeCliStatus,
  launchClaudeCliLogin,
  resetClaudeCliStatusCache,
} from '../../claude-cli-status';
import { loadConfig, updateConfig } from '../../config/load-save';
import { getLlamaManagedRuntimeOverrides } from '../../llama-server-manager';
import { syncRuntimeConfigToPython } from '../../python/workspace-sync';
import { mainState } from '../../state';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';

const VALID_EFFORTS = new Set<string>(['', 'low', 'medium', 'high', 'xhigh', 'max']);

function sendIfAlive(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    win.webContents.send(channel, payload);
  } catch {
    // Window can close between check and send.
  }
}

function broadcastConfig(config: AppConfig): void {
  sendIfAlive(mainState.mainWindow, 'config-updated', config);
  sendIfAlive(mainState.settingsWindow, 'config-updated', config);
  sendIfAlive(mainState.healthWindow, 'config-updated', config);
  sendIfAlive(mainState.dependenciesWindow, 'config-updated', config);
}

async function publish(config: AppConfig): Promise<void> {
  await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
  broadcastConfig(config);
}

async function currentClaudeCliSettings(): Promise<ClaudeCliSettings> {
  const cfg = await loadConfig();
  const provider = cfg.llmProviders.find((p) => p.id === PINNED_CLAUDE_CLI_PROVIDER_ID);
  return normalizeClaudeCliSettings(provider?.claudeCli);
}

export function registerClaudeCliIpc(): void {
  ipcMain.handle(
    'claude-cli:status',
    async (event, payload?: { refresh?: boolean }): Promise<ClaudeCliStatusResult> => {
      assertTrustedAppRenderer(event);
      const settings = await currentClaudeCliSettings();
      const res = await getClaudeCliStatus({ refresh: payload?.refresh === true, configDir: settings.configDir });
      // Sync the saved profile's contextWindowTokens if the live catalog reports a different fixed size (e.g. 1M).
      const cfg = await loadConfig();
      const provider = cfg.llmProviders.find((p) => p.id === PINNED_CLAUDE_CLI_PROVIDER_ID);
      const profile = provider?.models[0];
      if (profile && res.status.models.length > 0) {
        const matched = findClaudeCliModel(profile.model, res.status.models);
        if (matched && matched.contextWindowTokens > 0 && profile.contextWindowTokens !== matched.contextWindowTokens) {
          const updated = await updateConfig((c) => {
            const p = c.llmProviders.find((x) => x.id === PINNED_CLAUDE_CLI_PROVIDER_ID);
            if (p?.models[0]) {
              p.models[0].contextWindowTokens = matched.contextWindowTokens;
            }
          });
          await publish(updated);
        }
      }
      return res;
    },
  );

  ipcMain.handle(
    'claude-cli:set-model',
    async (event, payload: { modelId?: unknown }): Promise<ClaudeCliMutationResult> => {
      assertTrustedAppRenderer(event);
      const modelId = typeof payload?.modelId === 'string' ? payload.modelId.trim() : '';
      if (!modelId) {
        return { ok: false, error: 'Missing Claude Code model id.' };
      }
      const liveCatalog = getCachedClaudeCliModels();
      const model = findClaudeCliModel(modelId, liveCatalog);
      const displayName = model?.displayName ?? modelId;
      const contextWindowTokens = model?.contextWindowTokens ?? 200_000;
      const config = await updateConfig((cfg) => {
        const provider = cfg.llmProviders.find((p) => p.id === PINNED_CLAUDE_CLI_PROVIDER_ID);
        const profile = provider?.models[0];
        if (!profile) {
          return;
        }
        profile.model = model?.id ?? modelId;
        profile.name = displayName;
        profile.contextWindowTokens = contextWindowTokens;
      });
      await publish(config);
      return { ok: true };
    },
  );

  ipcMain.handle(
    'claude-cli:set-effort',
    async (event, payload: { effort?: unknown }): Promise<ClaudeCliMutationResult> => {
      assertTrustedAppRenderer(event);
      const effort = typeof payload?.effort === 'string' ? payload.effort.trim().toLowerCase() : '';
      if (!VALID_EFFORTS.has(effort)) {
        return { ok: false, error: `Unsupported effort level: ${effort}` };
      }
      const config = await updateConfig((cfg) => {
        const provider = cfg.llmProviders.find((p) => p.id === PINNED_CLAUDE_CLI_PROVIDER_ID);
        const profile = provider?.models[0];
        if (!profile) {
          return;
        }
        profile.reasoningEffort = effort as LlmReasoningEffort;
      });
      await publish(config);
      return { ok: true };
    },
  );

  ipcMain.handle(
    'claude-cli:update-settings',
    async (event, payload: { settings?: Partial<ClaudeCliSettings> }): Promise<ClaudeCliMutationResult> => {
      assertTrustedAppRenderer(event);
      const patch = payload?.settings && typeof payload.settings === 'object' ? payload.settings : {};
      let nextSettings: ClaudeCliSettings = await currentClaudeCliSettings();
      const config = await updateConfig((cfg) => {
        const provider = cfg.llmProviders.find((p) => p.id === PINNED_CLAUDE_CLI_PROVIDER_ID);
        if (!provider) {
          return;
        }
        const merged = normalizeClaudeCliSettings({
          ...normalizeClaudeCliSettings(provider.claudeCli),
          ...patch,
        });
        provider.claudeCli = merged;
        nextSettings = merged;
      });
      resetClaudeCliStatusCache();
      await publish(config);
      const statusRes = await getClaudeCliStatus({ refresh: true, configDir: nextSettings.configDir });
      return { ok: true, status: statusRes.status };
    },
  );

  ipcMain.handle('claude-cli:login', async (event): Promise<ClaudeCliMutationResult> => {
    assertTrustedAppRenderer(event);
    const settings = await currentClaudeCliSettings();
    return launchClaudeCliLogin(settings.configDir);
  });
}
