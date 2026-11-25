import type {
  AppConfig,
  LlmProviderConfig,
  ModelManagerFileEntry,
} from '@shared/index';
import {
  anthropicSourceLabel,
  isPinnedAnthropicProviderId,
  isPinnedLlamaServerUrlProviderId,
  isPinnedLmStudioProviderId,
  isPinnedOpenRouterProviderId,
  managedLlamaSourceDisplayName,
  openRouterSourceLabel,
} from '@shared/index';

/** Virtual left-rail id for the unified local managed llama.cpp provider. */
export const LOCAL_LLAMACPP_RAIL_ID = '__local-llamacpp__';

const RECENT_OPENROUTER_STORAGE_KEY = 'valkade.providerPicker.recentOpenRouter';
const MAX_RECENT_OPENROUTER = 15;

export type ProviderRailGroup = 'Local' | 'Cloud' | 'Custom';

export interface ProviderRailItem {
  /** Rail key: `LOCAL_LLAMACPP_RAIL_ID` for unified local llama.cpp, else `LlmProviderConfig.id`. */
  id: string;
  label: string;
  group: ProviderRailGroup;
  kind: 'local-llamacpp' | 'lmstudio' | 'anthropic' | 'openrouter' | 'openai' | 'openai-compatible' | 'remote-llamacpp';
  /** Underlying config entry (null for unified local llama.cpp). */
  provider: LlmProviderConfig | null;
}

/** True when `provider` is a managed local llama.cpp source (not the pinned remote URL row). */
export function isManagedLocalLlamaProvider(provider: LlmProviderConfig): boolean {
  return provider.provider === 'llamacpp' && !isPinnedLlamaServerUrlProviderId(provider.id);
}

/** All configured managed local llama.cpp providers in config order. */
export function managedLocalLlamaProviders(config: AppConfig | null): LlmProviderConfig[] {
  if (!config) {
    return [];
  }
  return config.llmProviders.filter(isManagedLocalLlamaProvider);
}

/**
 * Builds the left-rail provider list from every configured chat provider in `AppConfig`.
 * All managed local llama.cpp sources collapse into a single `llama.cpp (Local)` entry.
 */
export function buildProviderRailItems(config: AppConfig | null): ProviderRailItem[] {
  if (!config) {
    return [];
  }
  const chatProviders = config.llmProviders.filter((p) => p.provider !== 'python-t2i' && p.models.length > 0);
  const localManaged = chatProviders.filter(isManagedLocalLlamaProvider);
  const lmStudio = chatProviders.filter((p) => isPinnedLmStudioProviderId(p.id) || p.provider === 'lmstudio');
  const anthropic = chatProviders.filter((p) => isPinnedAnthropicProviderId(p.id) || p.provider === 'anthropic');
  const openRouter = chatProviders.filter((p) => isPinnedOpenRouterProviderId(p.id) || p.provider === 'openrouter');
  const openAi = chatProviders.filter((p) => p.provider === 'openai');
  const remoteLlama = chatProviders.filter((p) => isPinnedLlamaServerUrlProviderId(p.id));
  const compat = chatProviders.filter((p) => p.provider === 'openai-compatible');

  const seen = new Set<string>();
  const items: ProviderRailItem[] = [];
  const pushProvider = (
    p: LlmProviderConfig,
    group: ProviderRailGroup,
    kind: ProviderRailItem['kind'],
  ): void => {
    if (seen.has(p.id)) {
      return;
    }
    seen.add(p.id);
    items.push({ id: p.id, label: p.name, group, kind, provider: p });
  };

  if (localManaged.length > 0) {
    items.push({
      id: LOCAL_LLAMACPP_RAIL_ID,
      label: 'llama.cpp (Local)',
      group: 'Local',
      kind: 'local-llamacpp',
      provider: null,
    });
  }
  for (const p of lmStudio) {
    pushProvider(p, 'Local', 'lmstudio');
  }
  for (const p of anthropic) {
    pushProvider(p, 'Cloud', 'anthropic');
  }
  for (const p of openRouter) {
    pushProvider(p, 'Cloud', 'openrouter');
  }
  for (const p of openAi) {
    pushProvider(p, 'Cloud', 'openai');
  }
  for (const p of remoteLlama) {
    pushProvider(p, 'Custom', 'remote-llamacpp');
  }
  for (const p of compat) {
    pushProvider(p, 'Custom', 'openai-compatible');
  }

  return items;
}

/** Resolves which left-rail item owns `provider`. */
export function railIdForProvider(provider: LlmProviderConfig | null): string {
  if (!provider) {
    return '';
  }
  return isManagedLocalLlamaProvider(provider) ? LOCAL_LLAMACPP_RAIL_ID : provider.id;
}

/** Short trigger provider prefix + model display label for the currently active provider. */
export function formatActiveTriggerLabel(
  provider: LlmProviderConfig | null,
  inventory: ModelManagerFileEntry[],
): { providerLabel: string; modelLabel: string } {
  if (!provider) {
    return { providerLabel: '', modelLabel: 'Select model' };
  }
  if (isManagedLocalLlamaProvider(provider)) {
    return {
      providerLabel: 'llama.cpp',
      modelLabel: managedLlamaSourceDisplayName(provider, inventory),
    };
  }
  if (provider.provider === 'openrouter') {
    const full = openRouterSourceLabel(provider);
    const prefix = `${provider.name} · `;
    return {
      providerLabel: provider.name,
      modelLabel: full.startsWith(prefix) ? full.slice(prefix.length) : (provider.models[0]?.model?.trim() || 'Choose model'),
    };
  }
  if (provider.provider === 'anthropic') {
    const full = anthropicSourceLabel(provider);
    const prefix = `${provider.name} · `;
    return {
      providerLabel: provider.name,
      modelLabel: full.startsWith(prefix) ? full.slice(prefix.length) : (provider.models[0]?.model?.trim() || 'Choose model'),
    };
  }
  const profile = provider.models[0];
  const model = (profile?.model ?? '').trim();
  return {
    providerLabel: provider.name,
    modelLabel: model || 'Choose model',
  };
}

/** Compact context window badge: `32K ctx`, `1M ctx`, or empty when unset. */
export function formatContextShort(tokens: number | undefined): string {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) {
    return '';
  }
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M ctx`;
  }
  if (tokens >= 1024 && tokens % 1024 === 0) {
    return `${tokens / 1024}K ctx`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K ctx`;
  }
  return `${tokens} ctx`;
}

export function loadRecentOpenRouterModels(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_OPENROUTER_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .slice(0, MAX_RECENT_OPENROUTER);
  } catch {
    return [];
  }
}

export function saveRecentOpenRouterModels(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(
      RECENT_OPENROUTER_STORAGE_KEY,
      JSON.stringify(ids.slice(0, MAX_RECENT_OPENROUTER)),
    );
  } catch {
    // Storage may be unavailable in restricted contexts.
  }
}

export function recordRecentOpenRouterModel(current: readonly string[], modelId: string): string[] {
  const id = modelId.trim();
  if (!id) {
    return [...current];
  }
  const next = [id, ...current.filter((entry) => entry !== id)].slice(0, MAX_RECENT_OPENROUTER);
  saveRecentOpenRouterModels(next);
  return next;
}
