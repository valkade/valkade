import type { ChatTemplateReasoningCaps } from './chat-template-reasoning';
import type { LlmProviderConfig } from './types/app-config';

/** Valid auto-compaction presets for `claude --autocompact <auto|tokens>`. */
export const CLAUDE_CLI_AUTOCOMPACT_OPTIONS: readonly { id: string; label: string; tokens: number }[] = [
  { id: 'auto', label: 'Auto (CLI default)', tokens: 0 },
  { id: '100k', label: '100K tokens', tokens: 100_000 },
  { id: '150k', label: '150K tokens', tokens: 150_000 },
  { id: '200k', label: '200K tokens', tokens: 200_000 },
  { id: '300k', label: '300K tokens', tokens: 300_000 },
  { id: '500k', label: '500K tokens', tokens: 500_000 },
  { id: '750k', label: '750K tokens', tokens: 750_000 },
  { id: '1000k', label: '1M tokens', tokens: 1_000_000 },
];

const VALID_AUTOCOMPACT_IDS = new Set(CLAUDE_CLI_AUTOCOMPACT_OPTIONS.map((o) => o.id));

/** Settings persisted on the pinned Claude Code (Subscription) source row. */
export interface ClaudeCliSettings {
  /** Optional custom CLAUDE_CONFIG_DIR path (empty = default `~/.claude`). */
  configDir: string;
  /** Auto-compaction window (`auto` or `100k`..`1000k`), passed via `--autocompact`. */
  autoCompact: string;
  /** Request Fast mode on models that advertise `fast_mode` support. */
  fastMode: boolean;
  /** Route tool approvals & AskUserQuestion into ValkAde's native HITL cards. */
  routeApprovals: boolean;
  /** Snapshot workspace changes before/after each turn so ValkAde Turn Review works. */
  captureTurnDiffs: boolean;
  /** Warn before resending a large cold thread after the 1h subscription cache window expires. */
  promptIdleCompaction: boolean;
  /** Attach ValkAde's local MCP bridge (LSP, user terminals, semantic search, screenshots, themes). */
  bridgeWorkspaceTools: boolean;
}

/** Read-only ValkAde MCP bridge tools (auto-allowed even when Auto Run is off). */
export const CLAUDE_CLI_BRIDGE_READ_TOOLS: readonly string[] = [
  'mcp__valkade__lsp_get_diagnostics',
  'mcp__valkade__lsp_hover',
  'mcp__valkade__lsp_find_definition',
  'mcp__valkade__lsp_find_references',
  'mcp__valkade__lsp_get_document_symbols',
  'mcp__valkade__lsp_find_implementations',
  'mcp__valkade__lsp_workspace_symbols',
  'mcp__valkade__lsp_call_hierarchy',
  'mcp__valkade__lsp_type_hierarchy',
  'mcp__valkade__check_user_terminals',
  'mcp__valkade__retrieve_workspace_semantic',
];

/** Mutating or network ValkAde MCP bridge tools (prompt on approval card when Auto Run is off). */
export const CLAUDE_CLI_BRIDGE_MUTATING_TOOLS: readonly string[] = [
  'mcp__valkade__lsp_rename_symbol',
  'mcp__valkade__screenshot_webpage',
  'mcp__valkade__propose_theme',
];

export const DEFAULT_CLAUDE_CLI_SETTINGS: Readonly<ClaudeCliSettings> = Object.freeze({
  configDir: '',
  autoCompact: 'auto',
  fastMode: false,
  routeApprovals: true,
  captureTurnDiffs: true,
  promptIdleCompaction: false,
  bridgeWorkspaceTools: true,
});

export function normalizeClaudeCliSettings(raw: unknown): ClaudeCliSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_CLAUDE_CLI_SETTINGS };
  }
  const obj = raw as Record<string, unknown>;
  const configDir = typeof obj['configDir'] === 'string' ? obj['configDir'].trim() : '';
  const rawAuto = typeof obj['autoCompact'] === 'string' ? obj['autoCompact'].trim().toLowerCase() : 'auto';
  const autoCompact = VALID_AUTOCOMPACT_IDS.has(rawAuto) ? rawAuto : 'auto';
  return {
    configDir,
    autoCompact,
    fastMode: obj['fastMode'] === true,
    routeApprovals: typeof obj['routeApprovals'] === 'boolean' ? obj['routeApprovals'] : true,
    captureTurnDiffs: typeof obj['captureTurnDiffs'] === 'boolean' ? obj['captureTurnDiffs'] : true,
    promptIdleCompaction: typeof obj['promptIdleCompaction'] === 'boolean' ? obj['promptIdleCompaction'] : false,
    bridgeWorkspaceTools: typeof obj['bridgeWorkspaceTools'] === 'boolean' ? obj['bridgeWorkspaceTools'] : true,
  };
}

/** One selectable Claude model reported by the local Claude Code catalog / CLI. */
export interface ClaudeCliModelOption {
  /** Resolved model id passed to `--model` (e.g. `claude-opus-5-5`). */
  id: string;
  displayName: string;
  description?: string;
  /** Fixed max input context window (e.g. `1_000_000` or `200_000`). */
  contextWindowTokens: number;
  /** Fixed max output tokens (e.g. `128_000` or `64_000`). */
  maxOutputTokens?: number;
  effortLevels: readonly string[];
  defaultEffort?: string;
  adaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  section?: 'main' | 'overflow';
  notice?: string;
  recommended?: boolean;
}

export const DEFAULT_CLAUDE_CLI_MODEL_ID = 'claude-opus-5-5';

/** Fallback catalog used only before the local Claude Code catalog cache / CLI probe loads. */
export const CLAUDE_CLI_MODELS: readonly ClaudeCliModelOption[] = [
  {
    id: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: 'For complex work and everyday tasks',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    adaptiveThinking: true,
    supportsFastMode: true,
    section: 'main',
    recommended: true,
  },
  {
    id: 'claude-fable-5-2',
    displayName: 'Fable 5.2',
    description: 'For your toughest challenges',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    adaptiveThinking: true,
    supportsFastMode: true,
    section: 'main',
  },
  {
    id: 'claude-sonnet-5-5',
    displayName: 'Sonnet 5.5',
    description: 'Most efficient for simpler tasks',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    adaptiveThinking: true,
    supportsFastMode: false,
    section: 'main',
  },
  {
    id: 'claude-haiku-5-5',
    displayName: 'Haiku 5.5',
    description: 'Fastest for quick answers',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    adaptiveThinking: true,
    supportsFastMode: false,
    section: 'main',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku 4.5',
    description: 'Fastest for quick answers',
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    effortLevels: [],
    adaptiveThinking: false,
    supportsFastMode: false,
    section: 'overflow',
  },
];

export function findClaudeCliModel(
  modelId: string,
  catalog: readonly ClaudeCliModelOption[] = CLAUDE_CLI_MODELS,
): ClaudeCliModelOption | undefined {
  const id = (modelId || '').trim();
  if (!id) {
    return undefined;
  }
  return catalog.find((m) => m.id === id) ?? CLAUDE_CLI_MODELS.find((m) => m.id === id);
}

/** Real rate-limit window status emitted by Claude Code `rate_limit_event` frames. */
export interface ClaudeCliRateLimitWindow {
  status: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown';
  /** Exact 0-100 percentage ONLY when Anthropic reported a real utilization value. */
  utilizationPercent?: number;
  /** Exact Unix ms reset timestamp reported by Anthropic, when present. */
  resetsAt?: number;
  /** Unix ms when this rate-limit event was last received. */
  observedAt?: number;
}

/**
 * Subscription usage & rate-limit summary combining:
 * 1. Real Anthropic `rate_limit_event` windows (`fiveHour` / `sevenDay`) observed from CLI streams.
 * 2. Real local Claude Code transcript usage scanned from `<configDir>/projects/*.jsonl` (5h & 7d).
 */
export interface ClaudeCliUsageSummary {
  /** Real 5-hour rate-limit state reported by Claude Code (`rate_limit_event`), if observed. */
  fiveHour: ClaudeCliRateLimitWindow;
  /** Real 7-day rate-limit state reported by Claude Code (`rate_limit_event`), if observed. */
  sevenDay: ClaudeCliRateLimitWindow;
  /** Assistant turns across local Claude Code transcripts in the last 5 hours. */
  window5hTurns: number;
  /** Uncached input + cache-creation + output tokens in the last 5 hours. */
  window5hTokens: number;
  /** Prompt-cache read tokens in the last 5 hours. */
  window5hCacheReadTokens: number;
  /** Assistant turns across local Claude Code transcripts in the last 7 days. */
  weeklyTurns: number;
  /** Uncached input + cache-creation + output tokens in the last 7 days. */
  weeklyTokens: number;
  /** Prompt-cache read tokens in the last 7 days. */
  weeklyCacheReadTokens: number;
  /** Unix ms when local transcripts were last scanned (0 if never). */
  updatedAt: number;
}

export function emptyClaudeCliUsageSummary(): ClaudeCliUsageSummary {
  return {
    fiveHour: { status: 'unknown' },
    sevenDay: { status: 'unknown' },
    window5hTurns: 0,
    window5hTokens: 0,
    window5hCacheReadTokens: 0,
    weeklyTurns: 0,
    weeklyTokens: 0,
    weeklyCacheReadTokens: 0,
    updatedAt: 0,
  };
}

/** What Settings and the composer see about the local Claude Code CLI installation & session. */
export interface ClaudeCliStatus {
  installed: boolean;
  cliPath: string;
  cliVersion: string;
  loggedIn: boolean;
  authMethod: string;
  email: string;
  orgName: string;
  subscriptionType: string;
  /** Effective config directory reported by CLI or custom CLAUDE_CONFIG_DIR. */
  configDir: string;
  /** Live models merged from `<configDir>/cache/model-catalog/*-cc.json` and CLI `initialize`. */
  models: ClaudeCliModelOption[];
  /** Always true in subscription mode: ANTHROPIC_API_KEY is stripped from spawned CLI env. */
  billingGuardActive: boolean;
  /** Unix ms when a detected rate limit resets, if currently limited. */
  rateLimitedUntil?: number;
  /** Human-readable rate-limit banner detail, if currently limited. */
  rateLimitMessage?: string;
  usage: ClaudeCliUsageSummary;
  checkedAt?: number;
  error?: string;
}

export type ClaudeCliStatusResult =
  | { ok: true; status: ClaudeCliStatus }
  | { ok: false; error: string; status: ClaudeCliStatus };

export type ClaudeCliMutationResult = { ok: true; status?: ClaudeCliStatus } | { ok: false; error: string };

export function claudeCliReasoningCaps(
  modelId?: string,
  catalog: readonly ClaudeCliModelOption[] = CLAUDE_CLI_MODELS,
): ChatTemplateReasoningCaps {
  const model = findClaudeCliModel(modelId ?? '', catalog) ?? catalog[0] ?? CLAUDE_CLI_MODELS[0];
  return {
    enableThinking: false,
    reasoningEffortValues: model?.effortLevels.length ? [...model.effortLevels] : null,
    adaptiveThinking: model?.adaptiveThinking === true,
    serverCompaction: true,
    vision: true,
  };
}

/** Source picker label for the Claude Code row: ``Claude Code · Opus 5.5`` or just ``Claude Code``. */
export function claudeCliSourceLabel(
  provider: LlmProviderConfig,
  catalog: readonly ClaudeCliModelOption[] = CLAUDE_CLI_MODELS,
): string {
  const profile = provider.models[0];
  const modelId = (profile?.model ?? '').trim();
  if (!modelId) {
    return provider.name;
  }
  const found = findClaudeCliModel(modelId, catalog);
  const name = (found?.displayName ?? profile?.name ?? '').trim();
  const short = name && name !== provider.name ? name.replace(/^Claude\s+/i, '') : modelId;
  return `${provider.name} · ${short}`;
}
