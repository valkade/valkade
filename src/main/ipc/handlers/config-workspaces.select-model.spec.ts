import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../shared';

const { handlers, state, syncRuntimeConfigToPython } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>(),
  syncRuntimeConfigToPython: vi.fn(async () => undefined),
  state: {
    mainWindow: null as unknown,
    settingsWindow: null as unknown,
    dependenciesWindow: null as unknown,
    healthWindow: null as unknown,
    updaterWindow: null as unknown,
  },
}));

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) =>
      handlers.set(channel, handler),
    on: vi.fn(),
  },
}));
vi.mock('../../state', () => ({ mainState: state }));
vi.mock('../../paths', () => ({ getConfigPath: () => `${process.env.VALKADE_TEST_CONFIG_DIR}/config.json` }));
vi.mock('../../llama-server-manager', () => ({ getLlamaManagedRuntimeOverrides: vi.fn(() => ({})) }));
vi.mock('../../python/workspace-sync', () => ({ syncRuntimeConfigToPython }));
vi.mock('../../runtime/user-path', () => ({}));
vi.mock('../../workspace/watcher', () => ({}));
vi.mock('./lsp-status', () => ({}));
vi.mock('../../workspace/system-prompt', () => ({}));
vi.mock('../../menu/recent-conversations', () => ({}));
vi.mock('../../menu/application-menu', () => ({}));
vi.mock('./health', () => ({}));
vi.mock('../../workspace/lost-workspace', () => ({}));
vi.mock('../../web/screenshot-maintenance', () => ({}));

class FakeContents extends EventEmitter {
  readonly send = vi.fn();
  readonly mainFrame = {};
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return false;
  }
}

describe('select-llm-source-model IPC', () => {
  let dir: string;
  let mainContents: FakeContents;
  let settingsContents: FakeContents;

  beforeEach(async () => {
    vi.resetModules();
    handlers.clear();
    syncRuntimeConfigToPython.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'valkade-select-model-ipc-'));
    process.env.VALKADE_TEST_CONFIG_DIR = dir;
    mainContents = new FakeContents(1);
    settingsContents = new FakeContents(2);
    state.mainWindow = { webContents: mainContents, isDestroyed: () => false };
    state.settingsWindow = { webContents: settingsContents, isDestroyed: () => false };
    state.dependenciesWindow = null;
    state.healthWindow = null;
    state.updaterWindow = null;
    const { registerConfigWorkspacesIpc } = await import('./config-workspaces');
    registerConfigWorkspacesIpc();
  });

  afterEach(() => {
    delete process.env.VALKADE_TEST_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('atomically updates provider model metadata, activates its preset, syncs Python, and broadcasts config', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        activeLlmModelId: 'm-local',
        llmProviders: [
          {
            id: 'local-1',
            name: 'Local',
            provider: 'llamacpp',
            baseUrl: 'http://127.0.0.1:8080/v1',
            apiKey: '',
            models: [{ id: 'm-local', name: 'Local', model: 'local.gguf', contextWindowTokens: 32768 }],
          },
          {
            id: 'openrouter-default',
            name: 'OpenRouter',
            provider: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'sk-or-test',
            models: [{ id: 'm-or', name: 'OpenRouter', model: 'old/model', contextWindowTokens: 64000 }],
          },
        ],
      }),
      'utf8',
    );

    const handler = handlers.get('select-llm-source-model');
    expect(handler).toBeTruthy();

    const updated = (await handler!(
      { sender: mainContents, senderFrame: mainContents.mainFrame },
      {
        providerId: 'openrouter-default',
        model: 'google/gemini-2.5-pro',
        name: 'Google: Gemini 2.5 Pro',
        contextWindowTokens: 1000000,
      },
    )) as AppConfig;

    const orProv = updated.llmProviders.find((p) => p.id === 'openrouter-default');
    expect(orProv?.models[0]?.id).toBeTruthy();
    expect(updated.activeLlmModelId).toBe(orProv?.models[0]?.id);
    expect(orProv?.models[0]?.model).toBe('google/gemini-2.5-pro');
    expect(orProv?.models[0]?.name).toBe('Google: Gemini 2.5 Pro');
    expect(orProv?.models[0]?.contextWindowTokens).toBe(1000000);
    expect(syncRuntimeConfigToPython).toHaveBeenCalledTimes(1);
    expect(mainContents.send).toHaveBeenCalledWith('config-updated', updated);
    expect(settingsContents.send).toHaveBeenCalledWith('config-updated', updated);

    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as AppConfig;
    expect(onDisk.activeLlmModelId).toBe(orProv?.models[0]?.id);
  });

  it('returns null when the provider id does not exist', async () => {
    const handler = handlers.get('select-llm-source-model');
    const result = await handler!(
      { sender: mainContents, senderFrame: mainContents.mainFrame },
      { providerId: 'missing', model: 'foo/bar' },
    );
    expect(result).toBeNull();
    expect(syncRuntimeConfigToPython).not.toHaveBeenCalled();
  });

  it('updates profile.name to the new model id when name is omitted and model changes', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        activeLlmModelId: 'm-url',
        llmProviders: [
          {
            id: 'llama-server-url-default',
            name: 'Custom OpenAI Endpoint',
            provider: 'llamacpp',
            baseUrl: 'http://127.0.0.1:9000/v1',
            apiKey: '',
            models: [{ id: 'm-url', name: 'vllm/coder', model: 'vllm/coder', contextWindowTokens: 32768 }],
          },
        ],
      }),
      'utf8',
    );

    const handler = handlers.get('select-llm-source-model');
    const updated = (await handler!(
      { sender: mainContents, senderFrame: mainContents.mainFrame },
      { providerId: 'llama-server-url-default', model: 'vllm/fast' },
    )) as AppConfig;

    const urlProv = updated.llmProviders.find((p) => p.id === 'llama-server-url-default');
    expect(urlProv?.models[0]?.model).toBe('vllm/fast');
    expect(urlProv?.models[0]?.name).toBe('vllm/fast');
  });

  it('rejects python-t2i providers', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        activeLlmModelId: 'm-local',
        llmProviders: [
          {
            id: 't2i-1',
            name: 'Image Gen',
            provider: 'python-t2i',
            baseUrl: '',
            apiKey: '',
            models: [{ id: 'm-t2i', name: 'Flux', model: 'flux', contextWindowTokens: 0 }],
          },
        ],
      }),
      'utf8',
    );

    const handler = handlers.get('select-llm-source-model');
    const result = await handler!(
      { sender: mainContents, senderFrame: mainContents.mainFrame },
      { providerId: 't2i-1', model: 'flux-2' },
    );
    expect(result).toBeNull();
    expect(syncRuntimeConfigToPython).not.toHaveBeenCalled();
  });
});
