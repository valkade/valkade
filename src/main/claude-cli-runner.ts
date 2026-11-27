/**
 * Claude Code CLI turn runner for ValkAde.
 *
 * Spawns the user's locally installed `claude` binary in bidirectional NDJSON mode
 * (`--output-format stream-json --input-format stream-json --verbose --include-partial-messages`),
 * strips `ANTHROPIC_API_KEY` (billing guard), translates stream events into ValkAde's
 * `ParsedAgentStreamPayload` contract, maps `control_request` (`can_use_tool`) onto ValkAde's
 * native approval and `AskUserQuestion` cards, and snapshots edits into the file journal.
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import path = require('path');
import type {
  AcceptCommandAction,
  AcceptCommandPayload,
  AgentQuestionPayload,
  ClaudeCliSettings,
  LlmProviderConfig,
  ParsedAgentStreamPayload,
  QuestionPrompt,
  ThemeProposalPayload,
} from '../shared';
import {
  CLAUDE_CLI_BRIDGE_READ_TOOLS,
  DEFAULT_CLAUDE_CLI_MODEL_ID,
  findClaudeCliModel,
  normalizeClaudeCliSettings,
} from '../shared';
import { PYTHON_URL } from './constants';
import {
  buildClaudeCliEnv,
  getCachedClaudeCliModels,
  recordClaudeCliRateLimitEvent,
  recordClaudeCliTurnUsage,
  resolveClaudeCliExecutable,
} from './claude-cli-status';
import {
  captureWorkspacePreTurnSnapshot,
  recordClaudeCliTurnDiffsToJournal,
  type ClaudeCliTurnSnapshot,
} from './claude-cli-turn-snapshot';
import { getClaudeCliSessionId, setClaudeCliSessionId } from './conversations-db';
import { getPythonSidecarToken, pythonControlFetch } from './python/http-client';

export interface ClaudeCliTurnOptions {
  conversationId: string;
  userMessageId: string;
  message: string;
  structuredContent?: readonly Record<string, unknown>[];
  provider: LlmProviderConfig;
  modelOverride?: string;
  effortOverride?: string;
  applyMode: boolean;
  autoApplyMode: boolean;
  composerMode: string;
  allowWebAccess: boolean;
  workspaceId?: string | null;
  workspaceRoot: string | null;
  workspaceNotes: string[];
  signal: AbortSignal;
  emit: (payload: ParsedAgentStreamPayload) => void;
}

interface PendingApproval {
  conversationId: string;
  requestId: string;
  toolName: string;
  resolve: (action: AcceptCommandAction, note: string) => void;
}

interface PendingQuestion {
  conversationId: string;
  requestId: string;
  questions: { id: string; prompt: string; optionLabelById: Map<string, string> }[];
  resolve: (
    action: 'submit' | 'cancel',
    answers: { questionId: string; optionId?: string; otherText?: string }[],
  ) => void;
}

const activeChildren = new Map<string, ChildProcess>();
const pendingApprovals = new Map<string, PendingApproval>();
const pendingQuestions = new Map<string, PendingQuestion>();
/** Tool names allowed for the current session per conversation (`confirm_session`). */
const sessionAllowedTools = new Map<string, Set<string>>();

type SpawnFn = typeof spawn;
let spawnImpl: SpawnFn = spawn;

interface ClaudeCliBridgeTestOverrides {
  bridgeUrl?: string;
  sidecarToken?: string;
  drainEvents?: (sessionId: string) => Promise<Array<{ type?: string; themeProposal?: ThemeProposalPayload }>>;
}

let bridgeTestOverrides: ClaudeCliBridgeTestOverrides | null = null;

/** Test hook: inject a mock `spawn` function. */
export function setClaudeCliSpawnForTests(fn: SpawnFn | null): void {
  spawnImpl = fn ?? spawn;
}

/** Test hook: override the local ValkAde MCP bridge URL/token/event-drain handler. */
export function setClaudeCliBridgeForTests(overrides: ClaudeCliBridgeTestOverrides | null): void {
  bridgeTestOverrides = overrides;
}

const READ_ONLY_BRIDGE_TOOL_SET = new Set<string>(CLAUDE_CLI_BRIDGE_READ_TOOLS);

export function isReadOnlyValkadeBridgeTool(toolName: string): boolean {
  return READ_ONLY_BRIDGE_TOOL_SET.has(toolName.trim());
}

/** Build the per-turn `--mcp-config` JSON payload pointing Claude Code at ValkAde's local MCP bridge. */
export function buildValkadeMcpConfig(opts: {
  url: string;
  token: string;
  sessionId: string;
  workspaceRoot: string | null;
  workspaceId?: string | null;
  applyMode: boolean;
  allowWebAccess: boolean;
}): { mcpServers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }> } {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    'X-Valkade-Session-Id': opts.sessionId,
    'X-Valkade-Apply-Mode': opts.applyMode ? '1' : '0',
    'X-Valkade-Allow-Web': opts.allowWebAccess ? '1' : '0',
  };
  if (opts.workspaceRoot?.trim()) {
    headers['X-Valkade-Workspace-Root'] = opts.workspaceRoot.trim();
  }
  if (opts.workspaceId?.trim()) {
    headers['X-Valkade-Workspace-Id'] = opts.workspaceId.trim();
  }
  return {
    mcpServers: {
      valkade: {
        type: 'http',
        url: opts.url,
        headers,
      },
    },
  };
}

async function writeTurnMcpConfigFile(opts: {
  sessionId: string;
  workspaceRoot: string | null;
  workspaceId?: string | null;
  applyMode: boolean;
  allowWebAccess: boolean;
}): Promise<string | null> {
  const token = (bridgeTestOverrides?.sidecarToken ?? getPythonSidecarToken()).trim();
  if (!token) {
    return null;
  }
  const base = PYTHON_URL.endsWith('/') ? PYTHON_URL.slice(0, -1) : PYTHON_URL;
  const url = bridgeTestOverrides?.bridgeUrl ?? `${base}/claude-bridge/mcp`;
  const configObj = buildValkadeMcpConfig({
    url,
    token,
    sessionId: opts.sessionId,
    workspaceRoot: opts.workspaceRoot,
    workspaceId: opts.workspaceId,
    applyMode: opts.applyMode,
    allowWebAccess: opts.allowWebAccess,
  });
  const filePath = path.join(tmpdir(), `valkade-claude-mcp-${randomUUID()}.json`);
  await fs.writeFile(filePath, JSON.stringify(configObj), { encoding: 'utf-8', mode: 0o600 });
  return filePath;
}

async function drainValkadeBridgeEvents(
  sessionId: string,
  emit: (payload: ParsedAgentStreamPayload) => void,
): Promise<void> {
  try {
    let events: Array<{ type?: string; themeProposal?: ThemeProposalPayload }> = [];
    if (bridgeTestOverrides?.drainEvents) {
      events = await bridgeTestOverrides.drainEvents(sessionId);
    } else {
      const res = await pythonControlFetch('/claude-bridge/events/drain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as { events?: unknown };
      if (Array.isArray(data?.events)) {
        events = data.events as Array<{ type?: string; themeProposal?: ThemeProposalPayload }>;
      }
    }
    for (const ev of events) {
      if (ev?.type === 'theme_proposal' && ev.themeProposal) {
        emit({ type: 'theme_proposal', themeProposal: ev.themeProposal });
      }
    }
  } catch (err) {
    console.warn('[claude-cli] Draining ValkAde bridge events failed:', err);
  }
}

/** Kill a child process and its descendants cleanly on Windows and POSIX. */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    return;
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

/** Kill every active Claude CLI subprocess (called on app quit). */
export function killAllClaudeCliProcesses(): void {
  for (const child of activeChildren.values()) {
    killProcessTree(child);
  }
  activeChildren.clear();
  for (const p of pendingApprovals.values()) {
    p.resolve('cancel', '');
  }
  pendingApprovals.clear();
  for (const q of pendingQuestions.values()) {
    q.resolve('cancel', []);
  }
  pendingQuestions.clear();
}

export function hasPendingClaudeCliApproval(conversationId: string, requestId?: string): boolean {
  if (!requestId) {
    return false;
  }
  const entry = pendingApprovals.get(requestId);
  return !!entry && entry.conversationId === conversationId;
}

export function resolveClaudeCliApproval(
  conversationId: string,
  requestId: string,
  action: AcceptCommandAction,
  note = '',
): boolean {
  const entry = pendingApprovals.get(requestId);
  if (!entry || entry.conversationId !== conversationId) {
    return false;
  }
  pendingApprovals.delete(requestId);
  entry.resolve(action, note);
  return true;
}

export function hasPendingClaudeCliQuestion(conversationId: string, requestId?: string): boolean {
  if (!requestId) {
    return false;
  }
  const entry = pendingQuestions.get(requestId);
  return !!entry && entry.conversationId === conversationId;
}

export function resolveClaudeCliQuestion(
  conversationId: string,
  requestId: string,
  action: 'submit' | 'cancel',
  answers: { questionId: string; optionId?: string; otherText?: string }[],
): boolean {
  const entry = pendingQuestions.get(requestId);
  if (!entry || entry.conversationId !== conversationId) {
    return false;
  }
  pendingQuestions.delete(requestId);
  entry.resolve(action, answers);
  return true;
}

/** Build the CLI arguments enforcing ValkAde's mode, web access, approvals, MCP bridge, and session resume. */
export function buildClaudeCliArgs(opts: {
  modelId: string;
  effort: string;
  sessionId: string | null;
  applyMode: boolean;
  autoApplyMode: boolean;
  composerMode: string;
  allowWebAccess: boolean;
  settings: ClaudeCliSettings;
  workspaceNotes: string[];
  mcpConfigPath?: string | null;
}): string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];

  const model = opts.modelId.trim() || DEFAULT_CLAUDE_CLI_MODEL_ID;
  if (model) {
    args.push('--model', model);
  }

  const effort = opts.effort.trim().toLowerCase();
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') {
    args.push('--effort', effort);
  }

  const autoCompact = (opts.settings.autoCompact ?? 'auto').trim().toLowerCase();
  if (autoCompact && autoCompact !== 'auto') {
    args.push('--autocompact', autoCompact);
  }

  if (opts.settings.fastMode) {
    const modelMeta = findClaudeCliModel(model, getCachedClaudeCliModels());
    if (!modelMeta || modelMeta.supportsFastMode) {
      args.push('--settings', JSON.stringify({ fastMode: true }));
    }
  }

  if (opts.sessionId?.trim()) {
    args.push('--resume', opts.sessionId.trim());
  }

  // Attach ValkAde's local MCP bridge alongside Claude Code's own `~/.claude` MCP servers.
  const bridgeActive = Boolean(opts.mcpConfigPath?.trim());
  if (bridgeActive && opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath.trim());
    args.push('--allowedTools', CLAUDE_CLI_BRIDGE_READ_TOOLS.join(','));
  }

  // Tool policy: always disable CronCreate; gate web and write/shell by ValkAde mode.
  const disallowed = new Set<string>(['CronCreate']);
  if (!opts.allowWebAccess) {
    disallowed.add('WebSearch');
    disallowed.add('WebFetch');
    if (bridgeActive) {
      disallowed.add('mcp__valkade__screenshot_webpage');
    }
  }

  const readOnly = !opts.applyMode || opts.composerMode === 'ask';
  if (readOnly) {
    args.push('--permission-mode', 'plan');
    disallowed.add('Edit');
    disallowed.add('Write');
    disallowed.add('NotebookEdit');
    disallowed.add('Bash');
    if (bridgeActive) {
      disallowed.add('mcp__valkade__lsp_rename_symbol');
    }
  } else if (opts.composerMode === 'plan') {
    args.push('--permission-mode', 'plan');
    if (bridgeActive) {
      disallowed.add('mcp__valkade__lsp_rename_symbol');
    }
  } else if (opts.autoApplyMode) {
    args.push('--permission-mode', 'bypassPermissions');
  } else if (opts.settings.routeApprovals) {
    args.push('--permission-mode', 'manual', '--permission-prompts', 'host');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }

  if (disallowed.size > 0) {
    args.push('--disallowedTools', [...disallowed].join(','));
  }

  const promptSections: string[] = [];
  if (bridgeActive) {
    const bridgeLines = [
      'ValkAde workspace tools are attached via the `valkade` MCP server (`mcp__valkade__*`):',
      '- Use `lsp_get_diagnostics`, `lsp_find_definition`, `lsp_find_references`, `lsp_hover`, `lsp_get_document_symbols`, `lsp_workspace_symbols`, `lsp_find_implementations`, `lsp_call_hierarchy`, `lsp_type_hierarchy`' +
        (!readOnly && opts.composerMode !== 'plan' ? ', and `lsp_rename_symbol`' : '') +
        ' for live language-server intelligence.',
      '- Use `check_user_terminals` to inspect output from the user\'s open ValkAde terminal tabs.',
      '- Use `retrieve_workspace_semantic` for conceptual / topic search across the indexed workspace.',
      '- Use `propose_theme` when the user asks to design or restyle a ValkAde UI theme.',
    ];
    if (opts.allowWebAccess) {
      bridgeLines.push('- Use `screenshot_webpage` to capture a public HTTP(S) webpage screenshot.');
    }
    promptSections.push(bridgeLines.join('\n'));
  }
  if (opts.workspaceNotes.length > 0) {
    promptSections.push(['Workspace notes from ValkAde:', ...opts.workspaceNotes.map((n) => `- ${n}`)].join('\n'));
  }
  if (promptSections.length > 0) {
    args.push('--append-system-prompt', promptSections.join('\n\n'));
  }

  return args;
}

/** Short human-readable pill label for a Claude Code built-in or ValkAde MCP bridge tool. */
export function formatClaudeToolLabel(toolName: string): string {
  switch (toolName) {
    case 'Read':
      return 'Read file';
    case 'Write':
      return 'Write file';
    case 'Edit':
    case 'MultiEdit':
      return 'Edit file';
    case 'NotebookEdit':
      return 'Edit notebook';
    case 'Glob':
      return 'Find files';
    case 'Grep':
      return 'Search code';
    case 'Bash':
      return 'Run command';
    case 'WebSearch':
      return 'Web search';
    case 'WebFetch':
      return 'Fetch webpage';
    case 'Agent':
      return 'Sub-agent';
    case 'AskUserQuestion':
      return 'Ask question';
    case 'EnterPlanMode':
      return 'Enter plan mode';
    case 'ExitPlanMode':
      return 'Exit plan mode';
    case 'mcp__valkade__lsp_rename_symbol':
      return 'Rename symbol via LSP';
    case 'mcp__valkade__screenshot_webpage':
      return 'Capture webpage screenshot';
    case 'mcp__valkade__propose_theme':
      return 'Propose ValkAde UI theme';
    default:
      if (toolName.startsWith('mcp__valkade__')) {
        return toolName.slice('mcp__valkade__'.length).replace(/_/g, ' ');
      }
      return toolName || 'Tool';
  }
}

function relativizeIfInWorkspace(raw: string, workspaceRoot: string | null): string {
  const trimmed = raw.trim();
  if (!trimmed || !workspaceRoot) {
    return trimmed;
  }
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : null;
  if (!abs) {
    return trimmed.replace(/\\/g, '/');
  }
  const rel = path.relative(workspaceRoot, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.replace(/\\/g, '/');
  }
  return trimmed;
}

function summarizeToolInput(toolName: string, input: unknown, workspaceRoot: string | null = null): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return '';
  }
  const rec = input as Record<string, unknown>;
  if (toolName === 'Bash' && typeof rec['command'] === 'string') {
    return rec['command'].trim().slice(0, 140);
  }
  if (toolName === 'mcp__valkade__lsp_rename_symbol') {
    const sym = typeof rec['symbol'] === 'string' ? rec['symbol'].trim() : '';
    const next = typeof rec['new_name'] === 'string' ? rec['new_name'].trim() : '';
    const rel = typeof rec['relative_path'] === 'string' ? rec['relative_path'].trim() : '';
    if (sym && next) {
      return `${sym} → ${next}${rel ? ` (${rel})` : ''}`.slice(0, 140);
    }
  }
  if (toolName === 'mcp__valkade__propose_theme') {
    const theme = rec['theme'];
    if (theme && typeof theme === 'object' && !Array.isArray(theme)) {
      const name = typeof (theme as Record<string, unknown>)['name'] === 'string' ? ((theme as Record<string, unknown>)['name'] as string).trim() : '';
      if (name) {
        return name.slice(0, 140);
      }
    }
  }
  for (const key of ['file_path', 'relative_path', 'notebook_path', 'path']) {
    const val = rec[key];
    if (typeof val === 'string' && val.trim()) {
      return relativizeIfInWorkspace(val, workspaceRoot).slice(0, 140);
    }
  }
  for (const key of ['pattern', 'query', 'url', 'description', 'prompt']) {
    const val = rec[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim().slice(0, 140);
    }
  }
  return '';
}

/** Build a compact unified diff for Claude Code `Edit` / `Write` calls so ValkAde renders inline diffs. */
export function buildClaudeEditToolDiff(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const rec = input as Record<string, unknown>;
  const maxLines = 120;

  if (toolName === 'Edit') {
    const oldStr = typeof rec['old_string'] === 'string' ? rec['old_string'] : '';
    const newStr = typeof rec['new_string'] === 'string' ? rec['new_string'] : '';
    if (!oldStr && !newStr) {
      return undefined;
    }
    const oldLines = oldStr ? oldStr.replace(/\r\n/g, '\n').split('\n') : [];
    const newLines = newStr ? newStr.replace(/\r\n/g, '\n').split('\n') : [];
    const out: string[] = [`@@ -1,${oldLines.length} +1,${newLines.length} @@`];
    let emitted = 0;
    for (const l of oldLines) {
      if (emitted >= maxLines) {
        out.push(`\\ Diff cut: ${oldLines.length + newLines.length - emitted} more lines`);
        return out.join('\n');
      }
      out.push(`-${l}`);
      emitted += 1;
    }
    for (const l of newLines) {
      if (emitted >= maxLines) {
        out.push(`\\ Diff cut: ${oldLines.length + newLines.length - emitted} more lines`);
        return out.join('\n');
      }
      out.push(`+${l}`);
      emitted += 1;
    }
    return out.join('\n');
  }

  if (toolName === 'Write') {
    const content = typeof rec['content'] === 'string' ? rec['content'] : '';
    if (!content) {
      return undefined;
    }
    const newLines = content.replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [`@@ -0,0 +1,${newLines.length} @@`];
    const shown = newLines.slice(0, maxLines);
    for (const l of shown) {
      out.push(`+${l}`);
    }
    if (newLines.length > maxLines) {
      out.push(`\\ Diff cut: ${newLines.length - maxLines} more lines (+${newLines.length - maxLines} -0)`);
    }
    return out.join('\n');
  }

  return undefined;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)['text'] === 'string') {
        parts.push((item as Record<string, unknown>)['text'] as string);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function buildAcceptCommandFromControl(
  requestId: string,
  toolName: string,
  input: unknown,
): AcceptCommandPayload {
  const rec = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const commandText =
    toolName === 'Bash' && typeof rec['command'] === 'string'
      ? rec['command']
      : summarizeToolInput(toolName, input) || JSON.stringify(rec).slice(0, 300);

  const details: string[] = [`Claude Code tool: ${toolName}`];
  if (typeof rec['description'] === 'string' && rec['description'].trim()) {
    details.push(rec['description'].trim());
  }
  if (typeof rec['file_path'] === 'string' && rec['file_path'].trim()) {
    details.push(`Path: ${rec['file_path'].trim()}`);
  }

  return {
    version: 1,
    requestId,
    kind: 'claude_cli_tool',
    title: `Claude Code wants to ${formatClaudeToolLabel(toolName).toLowerCase()}`,
    message: `Approve this ${toolName} action from Claude Code, or deny it to keep working without running it.`,
    confirmLabel: 'Allow',
    confirmSessionLabel: `Allow ${toolName} this session`,
    cancelLabel: 'Deny',
    commandText,
    details,
  };
}

function buildAgentQuestionFromControl(
  requestId: string,
  input: unknown,
): { payload: AgentQuestionPayload; meta: PendingQuestion['questions'] } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const rec = input as Record<string, unknown>;
  const rawQuestions = Array.isArray(rec['questions']) ? rec['questions'] : [];
  if (rawQuestions.length === 0) {
    return null;
  }

  const prompts: QuestionPrompt[] = [];
  const meta: PendingQuestion['questions'] = [];

  rawQuestions.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return;
    }
    const q = raw as Record<string, unknown>;
    const promptText = typeof q['question'] === 'string' ? q['question'].trim() : '';
    if (!promptText) {
      return;
    }
    const qid = `cc-q-${idx + 1}`;
    const rawOpts = Array.isArray(q['options']) ? q['options'] : [];
    const optionLabelById = new Map<string, string>();
    const options = rawOpts
      .map((opt, oi) => {
        if (!opt || typeof opt !== 'object' || Array.isArray(opt)) {
          return null;
        }
        const o = opt as Record<string, unknown>;
        const label = typeof o['label'] === 'string' ? o['label'].trim() : '';
        if (!label) {
          return null;
        }
        const oid = `${qid}-opt-${oi + 1}`;
        optionLabelById.set(oid, label);
        const description = typeof o['description'] === 'string' && o['description'].trim() ? o['description'].trim() : undefined;
        return { id: oid, label, ...(description ? { description } : {}) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    prompts.push({
      id: qid,
      prompt: promptText,
      options,
      allowOther: true,
    });
    meta.push({ id: qid, prompt: promptText, optionLabelById });
  });

  if (prompts.length === 0) {
    return null;
  }

  return {
    payload: {
      version: 1,
      requestId,
      title: 'Claude Code has a question',
      message: 'Select an option or enter your own answer so Claude Code can continue.',
      submitLabel: 'Submit answers',
      cancelLabel: 'Cancel',
      questions: prompts,
    },
    meta,
  };
}

/** Detect rate-limit messaging in a Claude Code error result and estimate reset timestamp. */
export function parseClaudeRateLimitReset(text: string, now: number = Date.now()): { limited: boolean; resetAt: number } {
  const lower = text.toLowerCase();
  const isLimited =
    lower.includes('rate limit') ||
    lower.includes('usage limit') ||
    lower.includes('5-hour') ||
    lower.includes('5 hour') ||
    lower.includes('too many requests') ||
    lower.includes('overloaded');
  if (!isLimited) {
    return { limited: false, resetAt: 0 };
  }
  const hm = lower.match(/(\d+)\s*h(?:ours?)?\s*(?:(\d+)\s*m)?/);
  if (hm) {
    const hours = Number.parseInt(hm[1], 10) || 0;
    const mins = Number.parseInt(hm[2] || '0', 10) || 0;
    const ms = (hours * 60 + mins) * 60_000;
    if (ms > 0) {
      return { limited: true, resetAt: now + ms };
    }
  }
  const mOnly = lower.match(/(\d+)\s*min(?:ute)?s?/);
  if (mOnly) {
    const mins = Number.parseInt(mOnly[1], 10) || 30;
    return { limited: true, resetAt: now + mins * 60_000 };
  }
  // Default 60-minute backoff indicator when exact reset isn't stated.
  return { limited: true, resetAt: now + 60 * 60_000 };
}

const ATTACHED_IMAGE_HINT_RE = /^Attached image:\s*(.+?)\s*\(use read_workspace_image\b/i;
const DATA_IMAGE_URL_RE = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i;
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

function imageMediaTypeForPath(filePath: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

function normalizeImageMediaType(raw: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  const lower = raw.trim().toLowerCase();
  if (lower === 'image/jpg' || lower === 'image/jpeg') return 'image/jpeg';
  if (lower === 'image/png' || lower === 'image/gif' || lower === 'image/webp') return lower;
  return null;
}

/**
 * Convert ValkAde `message` + `structuredContent` (workspace image attachments, inline `image_url`
 * data URLs, and attached file/folder hints) into Claude Code NDJSON `user` message content.
 */
export async function buildClaudeUserMessageContent(
  message: string,
  structuredContent: readonly Record<string, unknown>[] | undefined,
  workspaceRoot: string | null,
): Promise<string | Array<Record<string, unknown>>> {
  if (!structuredContent || structuredContent.length === 0) {
    return message;
  }

  const blocks: Array<Record<string, unknown>> = [];
  const trimmedMsg = (message || '').trim();
  let sawUserText = false;
  const resolvedRoot = workspaceRoot?.trim() ? path.resolve(workspaceRoot.trim()) : null;

  for (const part of structuredContent) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const kind = typeof part['type'] === 'string' ? part['type'].trim().toLowerCase() : '';

    if (kind === 'image_url') {
      const imgObj =
        part['image_url'] && typeof part['image_url'] === 'object' && !Array.isArray(part['image_url'])
          ? (part['image_url'] as Record<string, unknown>)
          : null;
      const url = typeof imgObj?.['url'] === 'string' ? imgObj['url'].trim() : '';
      const m = DATA_IMAGE_URL_RE.exec(url);
      if (m) {
        const mediaType = normalizeImageMediaType(m[1]!);
        const data = m[2]!.replace(/\s+/g, '');
        if (mediaType && data) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data },
          });
        }
      }
      continue;
    }

    if (kind === 'text') {
      const rawText = typeof part['text'] === 'string' ? part['text'] : '';
      const trimmed = rawText.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmedMsg && trimmed === trimmedMsg) {
        sawUserText = true;
      }

      const imgMatch = ATTACHED_IMAGE_HINT_RE.exec(trimmed);
      if (imgMatch && resolvedRoot) {
        const rel = imgMatch[1]!.trim();
        const candidate = path.resolve(resolvedRoot, rel);
        const relCheck = path.relative(resolvedRoot, candidate);
        const insideWorkspace =
          relCheck === '' || (!relCheck.startsWith('..') && !path.isAbsolute(relCheck));
        const mediaType = insideWorkspace ? imageMediaTypeForPath(candidate) : null;
        if (insideWorkspace && mediaType) {
          try {
            const st = await fs.stat(candidate);
            if (st.isFile() && st.size > 0 && st.size <= MAX_INLINE_IMAGE_BYTES) {
              const buf = await fs.readFile(candidate);
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') },
              });
              blocks.push({ type: 'text', text: `Attached image: ${rel}` });
              continue;
            }
          } catch (err) {
            console.warn('[claude-cli] Failed to read attached workspace image:', rel, err);
          }
        }
        // Fallback when unreadable, oversized, or unsupported format (e.g. .bmp): pass clean path hint.
        blocks.push({ type: 'text', text: `Attached image: ${rel}` });
        continue;
      }

      blocks.push({ type: 'text', text: rawText });
    }
  }

  if (trimmedMsg && !sawUserText) {
    blocks.unshift({ type: 'text', text: message });
  }

  return blocks.length > 0 ? blocks : message;
}

const CLAUDE_TITLE_SYSTEM_PROMPT =
  'You output a single very short title for a chat thread. ' +
  'Rules: maximum 8 words; no quotation marks; no newlines; ' +
  'concise topic label. Output only the title text, nothing else.';

const TITLE_PER_TURN_CHAR_LIMIT = 800;
const TITLE_MAX_TRANSCRIPT_CHARS = 8_000;
const TITLE_TIMEOUT_MS = 20_000;

export function sanitizeClaudeSuggestedTitle(raw: string): string {
  const first = (raw || '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) {
    return '';
  }
  const stripped = first.replace(/^["'\[\(]+|["\'\]\)]+$/g, '').trim();
  return stripped.replace(/\s+/g, ' ').slice(0, 120);
}

/** Generate a short conversation title using the user's Claude Code subscription (zero API key). */
export async function suggestClaudeCliConversationTitle(opts: {
  messages: readonly { role: string; text?: string }[];
  provider: LlmProviderConfig;
  modelOverride?: string;
}): Promise<string> {
  const lines: string[] = [];
  let total = 0;
  for (const m of opts.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') {
      continue;
    }
    const body = (m.text ?? '').trim().slice(0, TITLE_PER_TURN_CHAR_LIMIT);
    if (!body) {
      continue;
    }
    const chunk = `${m.role === 'user' ? 'User' : 'Assistant'}: ${body}`;
    if (total + chunk.length + 1 > TITLE_MAX_TRANSCRIPT_CHARS) {
      break;
    }
    lines.push(chunk);
    total += chunk.length + 1;
  }
  if (lines.length === 0) {
    return '';
  }

  const cliPath = await resolveClaudeCliExecutable();
  if (!cliPath) {
    return '';
  }

  const settings = normalizeClaudeCliSettings(opts.provider.claudeCli);
  const catalog = getCachedClaudeCliModels();
  const haiku =
    catalog.find((m) => m.id === 'claude-haiku-5-5') ??
    catalog.find((m) => m.id === 'claude-haiku-4-5-20251001') ??
    catalog.find((m) => /haiku/i.test(m.id));
  const titleModel =
    haiku?.id ??
    (opts.modelOverride || opts.provider.models[0]?.model || DEFAULT_CLAUDE_CLI_MODEL_ID).trim();

  const args = [
    '-p',
    '--output-format',
    'text',
    '--no-session-persistence',
    '--tools',
    '',
    '--model',
    titleModel,
    '--system-prompt',
    CLAUDE_TITLE_SYSTEM_PROMPT,
  ];
  const env = buildClaudeCliEnv(settings.configDir);
  const prompt = `Conversation excerpt:\n\n${lines.join('\n')}`;

  return new Promise<string>((resolve) => {
    let settled = false;
    let out = '';
    const done = (val: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    let child: ChildProcess;
    try {
      child = spawnImpl(cliPath, args, {
        cwd: homedir(),
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      done('');
      return;
    }

    const timer = setTimeout(() => {
      killProcessTree(child);
      done('');
    }, TITLE_TIMEOUT_MS);

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      if (out.length < 4_096) {
        out += chunk;
      }
    });
    child.once('error', () => done(''));
    child.once('close', (code) => {
      done(code === 0 ? sanitizeClaudeSuggestedTitle(out) : '');
    });

    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      // ignore
    }
  });
}

function writeJsonLine(child: ChildProcess, obj: Record<string, unknown>): void {
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
    return;
  }
  try {
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  } catch (err) {
    console.warn('[claude-cli] Failed to write stdin line:', err);
  }
}

/** Execute one chat turn through the local Claude Code CLI and stream ValkAde events. */
export async function runClaudeCliChatTurn(opts: ClaudeCliTurnOptions): Promise<'completed' | 'aborted' | 'error'> {
  const settings = normalizeClaudeCliSettings(opts.provider.claudeCli);
  const cliPath = await resolveClaudeCliExecutable();
  if (!cliPath) {
    opts.emit({
      type: 'status',
      status: {
        id: 'claude-cli-missing',
        label: 'Claude Code CLI not found',
        detail: 'Install `claude` and sign in via Settings → Sources → Claude Code.',
        state: 'error',
        source: 'agent',
      },
    });
    opts.emit({
      type: 'chunk',
      delta: 'Error: Claude Code CLI (`claude`) was not found on PATH. Install Claude Code and re-check in Settings.',
    });
    return 'error';
  }

  const profile = opts.provider.models[0];
  const modelId = (opts.modelOverride ?? profile?.model ?? DEFAULT_CLAUDE_CLI_MODEL_ID).trim();
  const effort = (opts.effortOverride ?? profile?.reasoningEffort ?? 'high').trim();
  const existingSessionId = getClaudeCliSessionId(opts.conversationId);

  let mcpConfigPath: string | null = null;
  if (settings.bridgeWorkspaceTools) {
    try {
      mcpConfigPath = await writeTurnMcpConfigFile({
        sessionId: opts.conversationId,
        workspaceRoot: opts.workspaceRoot,
        workspaceId: opts.workspaceId,
        applyMode: opts.applyMode && opts.composerMode !== 'ask' && opts.composerMode !== 'plan',
        allowWebAccess: opts.allowWebAccess,
      });
    } catch (err) {
      console.warn('[claude-cli] Failed to prepare ValkAde MCP bridge config:', err);
    }
  }

  const cleanupMcpConfig = async (): Promise<void> => {
    if (!mcpConfigPath) {
      return;
    }
    const target = mcpConfigPath;
    mcpConfigPath = null;
    await fs.unlink(target).catch(() => {});
  };

  const args = buildClaudeCliArgs({
    modelId,
    effort,
    sessionId: existingSessionId,
    applyMode: opts.applyMode,
    autoApplyMode: opts.autoApplyMode,
    composerMode: opts.composerMode,
    allowWebAccess: opts.allowWebAccess,
    settings,
    workspaceNotes: opts.workspaceNotes,
    mcpConfigPath,
  });

  const env = buildClaudeCliEnv(settings.configDir);
  const cwd = opts.workspaceRoot?.trim() || homedir();

  let snapshot: ClaudeCliTurnSnapshot | null = null;
  if (settings.captureTurnDiffs && opts.workspaceRoot?.trim() && opts.applyMode && opts.composerMode !== 'ask') {
    try {
      snapshot = await captureWorkspacePreTurnSnapshot(opts.workspaceRoot);
    } catch (err) {
      console.warn('[claude-cli] Pre-turn snapshot failed:', err);
    }
  }

  if (opts.signal.aborted) {
    await cleanupMcpConfig();
    return 'aborted';
  }

  const child = spawnImpl(cliPath, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeChildren.set(opts.conversationId, child);

  let stderrBuf = '';
  let stdoutBuf = '';
  let streamedAnyText = false;
  let sawResult = false;
  let turnFailed = false;
  let batchSeq = 0;
  let currentBatchId = '';
  const toolInfoById = new Map<
    string,
    { name: string; detail: string; startedAt: number; toolBatch: string; toolDiff?: string }
  >();

  const onAbort = (): void => {
    killProcessTree(child);
  };
  opts.signal.addEventListener('abort', onAbort, { once: true });

  const handleControlRequest = async (msg: Record<string, unknown>): Promise<void> => {
    const requestId = typeof msg['request_id'] === 'string' ? msg['request_id'] : '';
    const req =
      msg['request'] && typeof msg['request'] === 'object' && !Array.isArray(msg['request'])
        ? (msg['request'] as Record<string, unknown>)
        : null;
    if (!requestId || !req) {
      return;
    }

    const subtype = typeof req['subtype'] === 'string' ? req['subtype'] : '';
    if (subtype !== 'can_use_tool') {
      writeJsonLine(child, {
        type: 'control_response',
        request_id: requestId,
        response: { subtype: 'success' },
      });
      return;
    }

    const toolName = typeof req['tool_name'] === 'string' ? req['tool_name'] : 'Tool';
    const input = req['input'];

    if (snapshot) {
      await snapshot.captureBeforeToolEdit(toolName, input);
    }

    // Special case: AskUserQuestion maps to ValkAde's native agent_question card.
    if (toolName === 'AskUserQuestion') {
      const built = buildAgentQuestionFromControl(requestId, input);
      if (built) {
        const result = await new Promise<{
          action: 'submit' | 'cancel';
          answers: { questionId: string; optionId?: string; otherText?: string }[];
        }>((resolve) => {
          pendingQuestions.set(requestId, {
            conversationId: opts.conversationId,
            requestId,
            questions: built.meta,
            resolve: (action, answers) => resolve({ action, answers }),
          });
          opts.emit({ type: 'agent_question', agentQuestion: built.payload });
        });

        if (result.action === 'cancel' || opts.signal.aborted) {
          writeJsonLine(child, {
            type: 'control_response',
            request_id: requestId,
            response: { subtype: 'success', behavior: 'deny', message: 'User cancelled the question prompt.' },
          });
          return;
        }

        const answersMap: Record<string, string> = {};
        for (const q of built.meta) {
          const ans = result.answers.find((a) => a.questionId === q.id);
          if (!ans) {
            continue;
          }
          const picked =
            (ans.otherText && ans.otherText.trim()) ||
            (ans.optionId ? q.optionLabelById.get(ans.optionId) : '') ||
            '';
          if (picked) {
            answersMap[q.prompt] = picked;
          }
        }
        const updatedInput =
          input && typeof input === 'object' && !Array.isArray(input)
            ? { ...(input as Record<string, unknown>), answers: answersMap }
            : { answers: answersMap };
        writeJsonLine(child, {
          type: 'control_response',
          request_id: requestId,
          response: { subtype: 'success', behavior: 'allow', updatedInput },
        });
        return;
      }
    }

    // Read-only ValkAde MCP bridge tools are always auto-allowed, even when Auto Run is off.
    if (isReadOnlyValkadeBridgeTool(toolName)) {
      writeJsonLine(child, {
        type: 'control_response',
        request_id: requestId,
        response: { subtype: 'success', behavior: 'allow', updatedInput: input ?? {} },
      });
      return;
    }

    // Session-remembered tool approvals pass straight through.
    const allowedSet = sessionAllowedTools.get(opts.conversationId);
    if (allowedSet?.has(toolName)) {
      writeJsonLine(child, {
        type: 'control_response',
        request_id: requestId,
        response: { subtype: 'success', behavior: 'allow', updatedInput: input ?? {} },
      });
      return;
    }

    const card = buildAcceptCommandFromControl(requestId, toolName, input);
    const decision = await new Promise<{ action: AcceptCommandAction; note: string }>((resolve) => {
      pendingApprovals.set(requestId, {
        conversationId: opts.conversationId,
        requestId,
        toolName,
        resolve: (action, note) => resolve({ action, note }),
      });
      opts.emit({ type: 'accept_command', acceptCommand: card });
    });

    if (opts.signal.aborted) {
      return;
    }

    if (decision.action === 'confirm' || decision.action === 'confirm_session') {
      if (decision.action === 'confirm_session') {
        let set = sessionAllowedTools.get(opts.conversationId);
        if (!set) {
          set = new Set<string>();
          sessionAllowedTools.set(opts.conversationId, set);
        }
        set.add(toolName);
      }
      writeJsonLine(child, {
        type: 'control_response',
        request_id: requestId,
        response: { subtype: 'success', behavior: 'allow', updatedInput: input ?? {} },
      });
    } else {
      const reason = decision.note.trim() || `User denied ${toolName} in ValkAde.`;
      writeJsonLine(child, {
        type: 'control_response',
        request_id: requestId,
        response: { subtype: 'success', behavior: 'deny', message: reason },
      });
    }
  };

  const handleLine = async (rawLine: string): Promise<void> => {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof msg['type'] === 'string' ? msg['type'] : '';

    if (type === 'system' && msg['subtype'] === 'init') {
      const sid = typeof msg['session_id'] === 'string' ? msg['session_id'].trim() : '';
      if (sid) {
        setClaudeCliSessionId(opts.conversationId, sid);
      }
      return;
    }

    if (type === 'control_request') {
      await handleControlRequest(msg);
      return;
    }

    if (type === 'rate_limit_event') {
      const info =
        msg['rate_limit_info'] && typeof msg['rate_limit_info'] === 'object' && !Array.isArray(msg['rate_limit_info'])
          ? (msg['rate_limit_info'] as Record<string, unknown>)
          : null;
      if (info) {
        await recordClaudeCliRateLimitEvent({
          rateLimitType: typeof info['rateLimitType'] === 'string' ? info['rateLimitType'] : undefined,
          status: typeof info['status'] === 'string' ? info['status'] : undefined,
          utilization: typeof info['utilization'] === 'number' ? info['utilization'] : undefined,
          resetsAt: typeof info['resetsAt'] === 'number' ? info['resetsAt'] : undefined,
        });
      }
      return;
    }

    if (type === 'stream_event') {
      const ev =
        msg['event'] && typeof msg['event'] === 'object' && !Array.isArray(msg['event'])
          ? (msg['event'] as Record<string, unknown>)
          : null;
      if (!ev) {
        return;
      }
      const evType = typeof ev['type'] === 'string' ? ev['type'] : '';
      if (evType === 'content_block_delta') {
        const delta =
          ev['delta'] && typeof ev['delta'] === 'object' && !Array.isArray(ev['delta'])
            ? (ev['delta'] as Record<string, unknown>)
            : null;
        if (!delta) {
          return;
        }
        if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text']) {
          streamedAnyText = true;
          opts.emit({ type: 'chunk', delta: delta['text'] });
        } else if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string' && delta['thinking']) {
          opts.emit({ type: 'chunk', delta: delta['thinking'], streamTag: 'thinking' });
        }
      } else if (evType === 'message_start') {
        currentBatchId = `cc-batch-${++batchSeq}`;
      } else if (evType === 'content_block_start') {
        const block =
          ev['content_block'] && typeof ev['content_block'] === 'object' && !Array.isArray(ev['content_block'])
            ? (ev['content_block'] as Record<string, unknown>)
            : null;
        if (block?.['type'] === 'tool_use') {
          const id = typeof block['id'] === 'string' ? block['id'] : `tool-${Date.now()}`;
          const name = typeof block['name'] === 'string' ? block['name'] : 'Tool';
          const toolBatch = currentBatchId || `cc-batch-${++batchSeq}`;
          const prev = toolInfoById.get(id);
          toolInfoById.set(id, {
            name,
            detail: prev?.detail ?? '',
            startedAt: prev?.startedAt ?? Date.now(),
            toolBatch,
          });
          opts.emit({
            type: 'status',
            status: {
              id,
              label: name,
              detail: prev?.detail ?? '',
              state: 'running',
              source: 'tool',
              toolBatch,
            },
          });
        }
      }
      return;
    }

    if (type === 'assistant') {
      const message =
        msg['message'] && typeof msg['message'] === 'object' && !Array.isArray(msg['message'])
          ? (msg['message'] as Record<string, unknown>)
          : null;
      const content = Array.isArray(message?.['content']) ? message!['content'] : [];
      const assistantBatch = currentBatchId || `cc-batch-${++batchSeq}`;
      for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          continue;
        }
        const b = block as Record<string, unknown>;
        if (b['type'] === 'tool_use') {
          const id = typeof b['id'] === 'string' ? b['id'] : `tool-${Date.now()}`;
          const name = typeof b['name'] === 'string' ? b['name'] : 'Tool';
          const detail = summarizeToolInput(name, b['input'], opts.workspaceRoot);
          const toolDiff = buildClaudeEditToolDiff(name, b['input']);
          const prev = toolInfoById.get(id);
          const startedAt = prev?.startedAt ?? Date.now();
          const toolBatch = prev?.toolBatch || assistantBatch;
          toolInfoById.set(id, { name, detail, startedAt, toolBatch, toolDiff });
          if (snapshot) {
            await snapshot.captureBeforeToolEdit(name, b['input']);
          }
          opts.emit({
            type: 'status',
            status: {
              id,
              label: name,
              detail,
              state: 'running',
              source: 'tool',
              toolBatch,
            },
          });
        } else if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'] && !streamedAnyText) {
          streamedAnyText = true;
          opts.emit({ type: 'chunk', delta: b['text'] });
        }
      }
      return;
    }

    if (type === 'user') {
      const message =
        msg['message'] && typeof msg['message'] === 'object' && !Array.isArray(msg['message'])
          ? (msg['message'] as Record<string, unknown>)
          : null;
      const content = Array.isArray(message?.['content']) ? message!['content'] : [];
      for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          continue;
        }
        const b = block as Record<string, unknown>;
        if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
          const id = b['tool_use_id'];
          const info = toolInfoById.get(id);
          const isErr = b['is_error'] === true;
          const resultText = extractToolResultText(b['content']).trim();
          const durationMs = info ? Math.max(0, Date.now() - info.startedAt) : undefined;
          const detail =
            isErr && resultText
              ? `${info?.detail ? `${info.detail} — ` : ''}${resultText.slice(0, 140)}`
              : info?.detail ?? '';
          if (
            resultText &&
            !isErr &&
            (info?.name === 'Read' ||
              info?.name === 'Grep' ||
              info?.name === 'Glob' ||
              info?.name === 'Bash' ||
              info?.name?.startsWith('mcp__valkade__'))
          ) {
            opts.emit({
              type: 'tool_read_chunk',
              statusId: id,
              delta: resultText.slice(0, 4_000),
            });
          }
          if (!isErr && info?.name === 'mcp__valkade__propose_theme') {
            await drainValkadeBridgeEvents(opts.conversationId, opts.emit);
          }
          opts.emit({
            type: 'status',
            status: {
              id,
              label: info?.name ?? 'Tool',
              detail,
              state: isErr ? 'error' : 'complete',
              source: 'tool',
              ...(info?.toolBatch ? { toolBatch: info.toolBatch } : {}),
              ...(!isErr && info?.toolDiff ? { toolDiff: info.toolDiff } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          });
        }
      }
      return;
    }

    if (type === 'result') {
      sawResult = true;
      const sid = typeof msg['session_id'] === 'string' ? msg['session_id'].trim() : '';
      if (sid) {
        setClaudeCliSessionId(opts.conversationId, sid);
      }
      const usage =
        msg['usage'] && typeof msg['usage'] === 'object' && !Array.isArray(msg['usage'])
          ? (msg['usage'] as Record<string, unknown>)
          : null;
      const inTok = typeof usage?.['input_tokens'] === 'number' ? usage['input_tokens'] : 0;
      const outTok = typeof usage?.['output_tokens'] === 'number' ? usage['output_tokens'] : 0;
      const cacheRead = typeof usage?.['cache_read_input_tokens'] === 'number' ? usage['cache_read_input_tokens'] : 0;
      const cacheCreate =
        typeof usage?.['cache_creation_input_tokens'] === 'number' ? usage['cache_creation_input_tokens'] : 0;
      const durationMs = typeof msg['duration_ms'] === 'number' ? msg['duration_ms'] : undefined;

      if (inTok > 0 || outTok > 0 || cacheRead > 0) {
        const promptTotal = inTok + cacheRead + cacheCreate;
        opts.emit({
          type: 'token_usage',
          inputTokens: promptTotal,
          outputTokens: outTok,
          totalTokens: promptTotal + outTok,
          ...(durationMs && durationMs > 0 ? { generationMs: durationMs } : {}),
        });
      }

      const isError = msg['is_error'] === true || msg['subtype'] === 'error_during_execution';
      const resultText = typeof msg['result'] === 'string' ? msg['result'].trim() : '';
      const rateLimit = isError ? parseClaudeRateLimitReset(resultText || stderrBuf) : { limited: false, resetAt: 0 };

      await recordClaudeCliTurnUsage({
        ...(rateLimit.limited
          ? {
              rateLimitedUntil: rateLimit.resetAt,
              rateLimitMessage: resultText || 'Claude subscription rate limit reached.',
            }
          : { clearRateLimit: !isError }),
      });

      if (isError) {
        turnFailed = true;
        const detail = resultText || 'Claude Code returned an error.';
        opts.emit({
          type: 'status',
          status: {
            id: 'claude-cli-error',
            label: rateLimit.limited ? 'Claude subscription limit reached' : 'Claude Code error',
            detail,
            state: 'error',
            source: 'agent',
          },
        });
        if (!streamedAnyText) {
          opts.emit({ type: 'chunk', delta: detail });
        }
      } else if (resultText && !streamedAnyText) {
        streamedAnyText = true;
        opts.emit({ type: 'chunk', delta: resultText });
      }

      // Close stdin so the persistent stream-json process terminates cleanly after this turn.
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
    }
  };

  let chain: Promise<void> = Promise.resolve();
  child.stdout?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      chain = chain.then(() => handleLine(line));
    }
  });

  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderrBuf.length < 16_384) {
      stderrBuf += chunk;
    }
  });

  // Send the user prompt (with any attached images / workspace file blocks) over NDJSON stdin.
  const userContent = await buildClaudeUserMessageContent(
    opts.message,
    opts.structuredContent,
    opts.workspaceRoot,
  );
  writeJsonLine(child, {
    type: 'user',
    message: { role: 'user', content: userContent },
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('error', (err) => {
      stderrBuf += err.message;
      resolve(1);
    });
    child.once('close', (code) => {
      resolve(code);
    });
  });

  if (stdoutBuf.trim()) {
    chain = chain.then(() => handleLine(stdoutBuf));
  }
  await chain;

  const hadMcpBridge = Boolean(mcpConfigPath);
  await cleanupMcpConfig();
  if (hadMcpBridge && !opts.signal.aborted) {
    await drainValkadeBridgeEvents(opts.conversationId, opts.emit);
  }

  opts.signal.removeEventListener('abort', onAbort);
  if (activeChildren.get(opts.conversationId) === child) {
    activeChildren.delete(opts.conversationId);
  }
  // Clean up any unanswered cards tied to this conversation.
  for (const [reqId, p] of pendingApprovals.entries()) {
    if (p.conversationId === opts.conversationId) {
      pendingApprovals.delete(reqId);
    }
  }
  for (const [reqId, q] of pendingQuestions.entries()) {
    if (q.conversationId === opts.conversationId) {
      pendingQuestions.delete(reqId);
    }
  }

  if (snapshot) {
    try {
      await recordClaudeCliTurnDiffsToJournal(snapshot, opts.conversationId, opts.userMessageId);
    } catch (err) {
      console.warn('[claude-cli] Post-turn diff journal failed:', err);
    }
  }

  if (opts.signal.aborted) {
    return 'aborted';
  }

  if (turnFailed || (!sawResult && exitCode !== 0)) {
    if (!sawResult) {
      const msg = stderrBuf.trim() || `Claude Code exited with code ${exitCode ?? 'unknown'}.`;
      const rl = parseClaudeRateLimitReset(msg);
      if (rl.limited) {
        await recordClaudeCliTurnUsage({ rateLimitedUntil: rl.resetAt, rateLimitMessage: msg });
      }
      opts.emit({
        type: 'status',
        status: {
          id: 'claude-cli-exit',
          label: rl.limited ? 'Claude subscription limit reached' : 'Claude Code failed',
          detail: msg,
          state: 'error',
          source: 'agent',
        },
      });
      if (!streamedAnyText) {
        opts.emit({ type: 'chunk', delta: `Error: ${msg}` });
      }
    }
    return 'error';
  }

  return 'completed';
}
