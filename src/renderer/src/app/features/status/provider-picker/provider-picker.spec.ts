import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  PINNED_ANTHROPIC_PROVIDER_ID,
  PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
  PINNED_LM_STUDIO_PROVIDER_ID,
  PINNED_OPENROUTER_PROVIDER_ID,
  SecretValue,
  type AppConfig,
  type LlamaServerLifecycleEvent,
  type LlamaServerProcessExitEvent,
  type LlamaServerStartResult,
  type LlmProviderConfig,
} from '@shared/index';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicService } from '../../../core/anthropic.service';
import { ElectronService } from '../../../core/electron.service';
import { MODEL_GLOW_MS, ProviderPickerComponent } from './provider-picker';

function makeLocalProvider(
  id: string,
  modelId: string,
  name: string,
  chatRunCommand = 'llama-server -m /models/test.gguf --port {{PORT}}',
): LlmProviderConfig {
  return {
    id,
    name,
    customName: name,
    provider: 'llamacpp',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: SecretValue.of(''),
    models: [
      {
        id: modelId,
        name,
        model: name,
        contextWindowTokens: 32768,
        thinkingMode: 'default',
        samplingPreset: 'provider-default',
        architectureHint: 'auto',
        temperature: 0.7,
        parallelToolCalls: true,
        optimizationPreset: 'generic',
        maxOutputTokens: 0,
        llamaCppManaged: { chatRunCommand, embeddingRunCommand: '' },
      },
    ],
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const providers: LlmProviderConfig[] = [
    makeLocalProvider('local-1', 'm-local-1', 'Qwen3-32B'),
    makeLocalProvider('local-2', 'm-local-2', 'Gemma-4-27B'),
    {
      id: PINNED_LM_STUDIO_PROVIDER_ID,
      name: 'LM Studio',
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: SecretValue.of('lm-studio'),
      models: [
        {
          id: 'm-lms',
          name: 'qwen3-14b',
          model: 'qwen3-14b',
          contextWindowTokens: 32768,
          thinkingMode: 'default',
          samplingPreset: 'provider-default',
          architectureHint: 'auto',
          temperature: 0.7,
          parallelToolCalls: true,
          optimizationPreset: 'generic',
          maxOutputTokens: 0,
        },
      ],
    },
    {
      id: PINNED_ANTHROPIC_PROVIDER_ID,
      name: 'Claude',
      provider: 'anthropic',
      baseUrl: '',
      apiKey: SecretValue.of(''),
      models: [
        {
          id: 'm-claude',
          name: 'Claude Sonnet 4.6',
          model: 'claude-sonnet-4-6',
          contextWindowTokens: 200000,
          thinkingMode: 'default',
          samplingPreset: 'provider-default',
          architectureHint: 'auto',
          temperature: 0.7,
          parallelToolCalls: true,
          optimizationPreset: 'generic',
          maxOutputTokens: 0,
        },
      ],
    },
    {
      id: PINNED_OPENROUTER_PROVIDER_ID,
      name: 'OpenRouter',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: SecretValue.of('sk-or-test-key'),
      models: [
        {
          id: 'm-or',
          name: 'anthropic/claude-sonnet-4.6',
          model: 'anthropic/claude-sonnet-4.6',
          contextWindowTokens: 200000,
          thinkingMode: 'default',
          samplingPreset: 'provider-default',
          architectureHint: 'auto',
          temperature: 0.7,
          parallelToolCalls: true,
          optimizationPreset: 'generic',
          maxOutputTokens: 0,
        },
      ],
    },
    {
      id: PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
      name: 'Custom OpenAI Endpoint',
      provider: 'llamacpp',
      baseUrl: 'http://127.0.0.1:9000/v1',
      apiKey: SecretValue.of(''),
      models: [
        {
          id: 'm-url',
          name: 'vllm/coder',
          model: 'vllm/coder',
          contextWindowTokens: 32768,
          thinkingMode: 'default',
          samplingPreset: 'provider-default',
          architectureHint: 'auto',
          temperature: 0.7,
          parallelToolCalls: true,
          optimizationPreset: 'generic',
          maxOutputTokens: 0,
        },
      ],
    },
  ];
  return {
    activeLlmModelId: 'm-local-1',
    llmProviders: providers,
    modelManager: { customModelsDir: '' },
    ...overrides,
  } as AppConfig;
}

function setup(config: AppConfig = makeConfig(), layout: 'default' | 'status-bar' = 'status-bar') {
  const lifecycle$ = new Subject<LlamaServerLifecycleEvent>();
  const processExit$ = new Subject<LlamaServerProcessExitEvent>();
  const runningPorts = new Map<string, number>();

  const electron = {
    llamaServerLifecycle$: lifecycle$.asObservable(),
    llamaServerProcessExit$: processExit$.asObservable(),
    llamaServerStart: vi.fn(async ({ modelId }: { modelId: string }): Promise<LlamaServerStartResult> => {
      runningPorts.set(modelId, 51420 + runningPorts.size);
      lifecycle$.next({ phase: 'running', modelId });
      return { ok: true };
    }),
    llamaServerStop: vi.fn(async ({ modelId }: { modelId: string }) => {
      runningPorts.delete(modelId);
      lifecycle$.next({ phase: 'stopped', modelId });
      return { ok: true as const };
    }),
    llamaServerStatus: vi.fn(async ({ modelId }: { modelId: string }) => {
      const port = runningPorts.get(modelId);
      return port
        ? { ok: true as const, running: true, modelId, chat: { port, health: 'ok' as const } }
        : { ok: true as const, running: false, modelId, chat: { port: 0, health: 'stopped' as const } };
    }),
    llmSourcePing: vi.fn(async () => ({ ok: true as const })),
    setActiveLlmModel: vi.fn(async (modelId: string) => ({ ...config, activeLlmModelId: modelId })),
    selectLlmSourceModel: vi.fn(async () => config),
    modelManagerListCustomModels: vi.fn(async () => ({ ok: true as const, models: [] })),
    openSettingsWindow: vi.fn(),
    openHealthWindow: vi.fn(),
    anthropicStatus: vi.fn(async () => ({
      ok: true as const,
      status: {
        configured: true,
        storage: 'keychain' as const,
        models: [
          { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', line: 'opus', maxInputTokens: 200000, deprecated: false },
          { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', line: 'sonnet', maxInputTokens: 200000, deprecated: false },
        ],
      },
    })),
    anthropicSetModel: vi.fn(async () => ({ ok: true as const })),
    openRouterListModels: vi.fn(async () => ({
      ok: true as const,
      models: [
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', contextLength: 200000, reasoning: { mandatory: false, supportedEfforts: ['low', 'high'] }, pricing: { prompt: 0.000003, completion: 0.000015 } },
        { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1 Free', contextLength: 128000, reasoning: { mandatory: true, supportedEfforts: [] }, pricing: { prompt: 0, completion: 0 } },
        { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder', contextLength: 256000, pricing: { prompt: 0.0000003, completion: 0.0000012 } },
      ],
    })),
    lmStudioListModels: vi.fn(async () => ({
      ok: true as const,
      origin: 'http://127.0.0.1:1234',
      source: 'v1' as const,
      models: [
        { id: 'qwen3-14b', type: 'llm', publisher: '', arch: 'qwen', compatibility_type: 'gguf', quantization: 'Q4_K_M', state: 'loaded', max_context_length: 32768, loaded_context_length: 32768, instanceId: 'inst-1' },
        { id: 'llama-3.3-70b', type: 'llm', publisher: '', arch: 'llama', compatibility_type: 'gguf', quantization: 'Q4_K_M', state: 'not-loaded', max_context_length: 65536, loaded_context_length: 0 },
      ],
    })),
    lmStudioLoadModel: vi.fn(async () => ({ ok: true as const })),
    lmStudioUnloadModel: vi.fn(async () => ({ ok: true as const })),
    openAiCompatListModels: vi.fn(async () => ({
      ok: true as const,
      models: [{ id: 'vllm/coder', contextLength: 65536 }, { id: 'vllm/fast', contextLength: 32768 }],
    })),
  };

  TestBed.configureTestingModule({
    imports: [ProviderPickerComponent],
    providers: [{ provide: ElectronService, useValue: electron }, AnthropicService],
  });

  const fixture = TestBed.createComponent(ProviderPickerComponent);
  fixture.componentRef.setInput('appConfig', config);
  fixture.componentRef.setInput('layout', layout);
  return { fixture, electron, lifecycle$, processExit$, runningPorts };
}

async function flush(fixture: ComponentFixture<ProviderPickerComponent>): Promise<HTMLElement> {
  fixture.detectChanges();
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ProviderPickerComponent', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('aggregates all managed local llama.cpp sources into one provider and supports multi-instance Start without switching', async () => {
    const cfg = makeConfig();
    const { fixture, electron } = setup(cfg);
    const el = await flush(fixture);

    // Trigger has no standalone Start/Stop button beside it.
    const trigger = el.querySelector('.provider-picker__trigger') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Qwen3-32B');
    trigger.click();
    await flush(fixture);

    // Left rail collapses local-1 and local-2 under one llama.cpp (Local) provider.
    const railNames = Array.from(el.querySelectorAll('.provider-picker__rail-name')).map((n) => n.textContent?.trim());
    expect(railNames).toEqual(['llama.cpp (Local)', 'LM Studio', 'Claude', 'OpenRouter', 'Custom OpenAI Endpoint']);

    // Right pane lists both local models.
    const rows = Array.from(el.querySelectorAll('.provider-picker__row')) as HTMLButtonElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Qwen3-32B');
    expect(rows[1].textContent).toContain('Gemma-4-27B');

    // Focus Gemma-4-27B and click Start (background launch: does NOT call setActiveLlmModel).
    rows[1].click();
    await flush(fixture);
    const startBtn = Array.from(el.querySelectorAll('.provider-picker__footer .provider-picker__btn')).find(
      (b) => b.textContent?.trim() === 'Start',
    ) as HTMLButtonElement;
    startBtn.click();
    await flush(fixture);

    expect(electron.llamaServerStart).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'm-local-2' }));
    expect(electron.setActiveLlmModel).not.toHaveBeenCalled();

    // Start Qwen3-32B too — both run concurrently!
    rows[0].click();
    await flush(fixture);
    const startBtn0 = Array.from(el.querySelectorAll('.provider-picker__footer .provider-picker__btn')).find(
      (b) => b.textContent?.trim() === 'Start',
    ) as HTMLButtonElement;
    startBtn0.click();
    await flush(fixture);

    expect(el.querySelector('.provider-picker__trigger-badge')?.textContent?.trim()).toBe('2 up');

    // Stopping the active model leaves it selected (does not auto-switch).
    const stopBtn = Array.from(el.querySelectorAll('.provider-picker__footer .provider-picker__btn')).find(
      (b) => b.textContent?.trim() === 'Stop',
    ) as HTMLButtonElement;
    stopBtn.click();
    await flush(fixture);

    expect(electron.llamaServerStop).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'm-local-1' }));
    expect(electron.setActiveLlmModel).not.toHaveBeenCalled();
    expect(trigger.textContent).toContain('Qwen3-32B');

    // Focus running Gemma-4-27B and click Switch -> activates it.
    (el.querySelectorAll('.provider-picker__row')[1] as HTMLButtonElement).click();
    await flush(fixture);
    const switchBtn = Array.from(el.querySelectorAll('.provider-picker__footer .provider-picker__btn')).find(
      (b) => b.textContent?.trim() === 'Switch',
    ) as HTMLButtonElement;
    switchBtn.click();
    await flush(fixture);
    expect(electron.setActiveLlmModel).toHaveBeenCalledWith('m-local-2');
  });

  it('shows a concise error notice with an Open Health link when a local server fails to start', async () => {
    const { fixture, electron } = setup();
    electron.llamaServerStart.mockResolvedValueOnce({ ok: false, error: 'CUDA out of memory' });
    const el = await flush(fixture);

    (el.querySelector('.provider-picker__trigger') as HTMLButtonElement).click();
    await flush(fixture);

    const startBtn = Array.from(el.querySelectorAll('.provider-picker__footer .provider-picker__btn')).find(
      (b) => b.textContent?.trim() === 'Start',
    ) as HTMLButtonElement;
    startBtn.click();
    await flush(fixture);

    const strip = el.querySelector('.provider-picker__error-strip');
    expect(strip?.textContent).toContain('An error occurred starting this server.');
    expect(strip?.textContent).not.toContain('CUDA out of memory');

    const healthBtn = el.querySelector('.provider-picker__health-link') as HTMLButtonElement;
    healthBtn.click();
    expect(electron.openHealthWindow).toHaveBeenCalledTimes(1);
  });

  it('browses providers on the left without activating them and swaps immediately on model pick while staying open', async () => {
    const { fixture, electron } = setup();
    const el = await flush(fixture);

    (el.querySelector('.provider-picker__trigger') as HTMLButtonElement).click();
    await flush(fixture);

    // Click Claude on the left rail -> does NOT activate Claude yet.
    const claudeRail = Array.from(el.querySelectorAll('.provider-picker__rail-btn')).find((b) =>
      b.textContent?.includes('Claude'),
    ) as HTMLButtonElement;
    claudeRail.click();
    await flush(fixture);

    expect(electron.setActiveLlmModel).not.toHaveBeenCalled();
    expect(electron.anthropicSetModel).not.toHaveBeenCalled();

    // Pick Claude Opus 4.6 -> activates Claude + model AND keeps panel open.
    const opusRow = Array.from(el.querySelectorAll('.provider-picker__row')).find((r) =>
      r.textContent?.includes('Claude Opus 4.6'),
    ) as HTMLButtonElement;
    opusRow.click();
    await flush(fixture);

    expect(electron.anthropicSetModel).toHaveBeenCalledWith({ modelId: 'claude-opus-4-6' });
    expect(electron.setActiveLlmModel).toHaveBeenCalledWith('m-claude');
    expect(el.querySelector('.provider-picker__panel')).toBeTruthy();
  });

  it('filters OpenRouter models with search, Free, Reasoning, and Recent pills', async () => {
    const { fixture, electron } = setup();
    const el = await flush(fixture);

    (el.querySelector('.provider-picker__trigger') as HTMLButtonElement).click();
    await flush(fixture);

    const orRail = Array.from(el.querySelectorAll('.provider-picker__rail-btn')).find((b) =>
      b.textContent?.includes('OpenRouter'),
    ) as HTMLButtonElement;
    orRail.click();
    await flush(fixture);

    expect(el.querySelectorAll('.provider-picker__row')).toHaveLength(3);

    // Toggle Free filter -> only deepseek-r1:free.
    const freePill = Array.from(el.querySelectorAll('.provider-picker__filter-pill')).find(
      (b) => b.textContent?.trim() === 'Free',
    ) as HTMLButtonElement;
    freePill.click();
    await flush(fixture);
    expect(Array.from(el.querySelectorAll('.provider-picker__row-name')).map((n) => n.textContent?.trim())).toEqual([
      'deepseek/deepseek-r1:free',
    ]);

    // Pick it so it records into Recent, clear Free, toggle Recent.
    (el.querySelector('.provider-picker__row') as HTMLButtonElement).click();
    await flush(fixture);
    expect(electron.selectLlmSourceModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: PINNED_OPENROUTER_PROVIDER_ID, model: 'deepseek/deepseek-r1:free' }),
    );

    freePill.click();
    const recentPill = Array.from(el.querySelectorAll('.provider-picker__filter-pill')).find(
      (b) => b.textContent?.trim() === 'Recent',
    ) as HTMLButtonElement;
    recentPill.click();
    await flush(fixture);

    const recentNames = Array.from(el.querySelectorAll('.provider-picker__row-name')).map((n) => n.textContent?.trim());
    expect(recentNames[0]).toBe('deepseek/deepseek-r1:free');
    expect(recentNames).toContain('anthropic/claude-sonnet-4.6');
  });

  it('supports LM Studio Load / Load & Switch / Unload via Option B action footer', async () => {
    const { fixture, electron } = setup();
    const el = await flush(fixture);

    (el.querySelector('.provider-picker__trigger') as HTMLButtonElement).click();
    await flush(fixture);

    const lmsRail = Array.from(el.querySelectorAll('.provider-picker__rail-btn')).find((b) =>
      b.textContent?.includes('LM Studio'),
    ) as HTMLButtonElement;
    lmsRail.click();
    await flush(fixture);

    // Focus unloaded model (llama-3.3-70b) -> footer shows Load and Load & Switch.
    const unloadedRow = Array.from(el.querySelectorAll('.provider-picker__row')).find((r) =>
      r.textContent?.includes('llama-3.3-70b'),
    ) as HTMLButtonElement;
    unloadedRow.click();
    await flush(fixture);

    const loadSwitchBtn = Array.from(el.querySelectorAll('.provider-picker__footer .provider-picker__btn')).find(
      (b) => b.textContent?.trim() === 'Load & Switch',
    ) as HTMLButtonElement;
    loadSwitchBtn.click();
    await flush(fixture);

    expect(electron.lmStudioLoadModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama-3.3-70b' }));
    expect(electron.selectLlmSourceModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: PINNED_LM_STUDIO_PROVIDER_ID, model: 'llama-3.3-70b' }),
    );
  });

  it('glows the status bar trigger once when the active model changes', async () => {
    vi.useFakeTimers();
    const cfg1 = makeConfig({ activeLlmModelId: 'm-local-1' });
    const { fixture } = setup(cfg1, 'status-bar');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const glowing = () => !!el.querySelector('.provider-picker__trigger.is-glowing');

    expect(glowing()).toBe(false);
    fixture.componentRef.setInput('appConfig', makeConfig({ activeLlmModelId: 'm-local-2' }));
    fixture.detectChanges();
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(glowing()).toBe(true);

    vi.advanceTimersByTime(MODEL_GLOW_MS);
    fixture.detectChanges();
    expect(glowing()).toBe(false);
  });

  it('cancelling a starting local server does not show an error even if processExit fires before llamaServerStart settles', async () => {
    let resolveStart!: (res: LlamaServerStartResult) => void;
    const { fixture, electron, lifecycle$, processExit$ } = setup();
    electron.llamaServerStart.mockImplementationOnce(
      () =>
        new Promise<LlamaServerStartResult>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const el = await flush(fixture);

    (el.querySelector('.provider-picker__trigger') as HTMLButtonElement).click();
    await flush(fixture);

    // Active stopped model shows a single Start button (not redundant Start & Switch).
    const footerLabels = Array.from(el.querySelectorAll('.provider-picker__footer .provider-picker__btn')).map((b) =>
      b.textContent?.trim(),
    );
    expect(footerLabels).toEqual(['Start']);

    const startBtn = el.querySelector('.provider-picker__footer .provider-picker__btn') as HTMLButtonElement;
    startBtn.click();
    lifecycle$.next({ phase: 'downloading', modelId: 'm-local-1' });
    await flush(fixture);

    const cancelBtn = Array.from(el.querySelectorAll('.provider-picker__footer .provider-picker__btn')).find(
      (b) => b.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();

    cancelBtn.click();
    // Simulate process exit firing BEFORE llamaServerStart resolves with failure.
    processExit$.next({ modelId: 'm-local-1', stream: 'chat', code: 1, signal: null });
    await flush(fixture);
    resolveStart({ ok: false, error: 'Start cancelled' });
    await flush(fixture);

    expect(el.querySelector('.provider-picker__error-strip')).toBeNull();
    // Downloading state is cleared once stopped.
    expect(el.querySelector('.provider-picker__row')?.textContent).not.toContain('Downloading');
    const restartBtn = el.querySelector('.provider-picker__footer .provider-picker__btn') as HTMLButtonElement;
    expect(restartBtn.textContent?.trim()).toBe('Start');
    expect(restartBtn.disabled).toBe(false);
  });

  it('completes LM Studio Load & Switch even if the user browses another provider while loading', async () => {
    let resolveLoad!: (res: { ok: true }) => void;
    const { fixture, electron } = setup();
    electron.lmStudioLoadModel.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const el = await flush(fixture);

    (el.querySelector('.provider-picker__trigger') as HTMLButtonElement).click();
    await flush(fixture);

    const lmsRail = Array.from(el.querySelectorAll('.provider-picker__rail-btn')).find((b) =>
      b.textContent?.includes('LM Studio'),
    ) as HTMLButtonElement;
    lmsRail.click();
    await flush(fixture);

    const unloadedRow = Array.from(el.querySelectorAll('.provider-picker__row')).find((r) =>
      r.textContent?.includes('llama-3.3-70b'),
    ) as HTMLButtonElement;
    unloadedRow.click();
    await flush(fixture);

    const loadSwitchBtn = Array.from(el.querySelectorAll('.provider-picker__footer .provider-picker__btn')).find(
      (b) => b.textContent?.trim() === 'Load & Switch',
    ) as HTMLButtonElement;
    loadSwitchBtn.click();
    await flush(fixture);

    // Browse away to Claude while LM Studio is still loading.
    const claudeRail = Array.from(el.querySelectorAll('.provider-picker__rail-btn')).find((b) =>
      b.textContent?.includes('Claude'),
    ) as HTMLButtonElement;
    claudeRail.click();
    await flush(fixture);

    resolveLoad({ ok: true });
    await flush(fixture);

    expect(electron.selectLlmSourceModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: PINNED_LM_STUDIO_PROVIDER_ID, model: 'llama-3.3-70b' }),
    );
  });

  it('defaults blank baseUrl for OpenAI providers to https://api.openai.com/v1 when listing models', async () => {
    const baseCfg = makeConfig();
    const cfg = makeConfig({
      llmProviders: [
        ...baseCfg.llmProviders,
        {
          id: 'openai-1',
          name: 'OpenAI',
          provider: 'openai',
          baseUrl: '',
          apiKey: SecretValue.of('sk-test'),
          models: [
            {
              id: 'm-openai',
              name: 'gpt-4o',
              model: 'gpt-4o',
              contextWindowTokens: 128000,
              thinkingMode: 'default',
              samplingPreset: 'provider-default',
              architectureHint: 'auto',
              temperature: 0.7,
              parallelToolCalls: true,
              optimizationPreset: 'generic',
              maxOutputTokens: 0,
            },
          ],
        },
      ],
    });
    const { fixture, electron } = setup(cfg);
    const el = await flush(fixture);

    (el.querySelector('.provider-picker__trigger') as HTMLButtonElement).click();
    await flush(fixture);

    const openAiRail = Array.from(el.querySelectorAll('.provider-picker__rail-btn')).find(
      (b) => b.querySelector('.provider-picker__rail-name')?.textContent?.trim() === 'OpenAI',
    ) as HTMLButtonElement;
    openAiRail.click();
    await flush(fixture);

    expect(electron.openAiCompatListModels).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' }),
    );
  });

  it('glows the status bar trigger when switching models within OpenRouter', async () => {
    vi.useFakeTimers();
    const cfg1 = makeConfig({ activeLlmModelId: 'm-or' });
    const { fixture } = setup(cfg1, 'status-bar');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const glowing = () => !!el.querySelector('.provider-picker__trigger.is-glowing');

    expect(glowing()).toBe(false);
    const cfg2 = makeConfig({ activeLlmModelId: 'm-or' });
    const orProv = cfg2.llmProviders.find((p) => p.id === PINNED_OPENROUTER_PROVIDER_ID)!;
    orProv.models[0].model = 'qwen/qwen3-coder';
    fixture.componentRef.setInput('appConfig', cfg2);
    fixture.detectChanges();
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(glowing()).toBe(true);

    vi.advanceTimersByTime(MODEL_GLOW_MS);
    fixture.detectChanges();
    expect(glowing()).toBe(false);
  });
});
