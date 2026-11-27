/**
 * Local Claude Code CLI detection, authentication status, live model catalog discovery
 * (via the CLI `initialize` control handshake), billing-guard environment construction,
 * real `rate_limit_event` tracking, and local `~/.claude/projects` transcript usage scanning.
 *
 * Security & billing invariant: `buildClaudeCliEnv()` ALWAYS strips `ANTHROPIC_API_KEY` and
 * `ANTHROPIC_AUTH_TOKEN` so the subscription source never silently bills a pay-as-you-go API key.
 */
import { execFile, spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { homedir } from 'os';
import path = require('path');
import type {
  ClaudeCliModelOption,
  ClaudeCliMutationResult,
  ClaudeCliRateLimitWindow,
  ClaudeCliStatus,
  ClaudeCliStatusResult,
  ClaudeCliUsageSummary,
  LlmProviderConfig,
  LlmSourcePingResult,
} from '../shared';
import {
  CLAUDE_CLI_MODELS,
  emptyClaudeCliUsageSummary,
  inferContextWindowTokens,
  normalizeClaudeCliSettings,
} from '../shared';
import { getAppDataDir } from './paths';

const STATUS_TTL_MS = 60_000;
const EXEC_TIMEOUT_MS = 8_000;
const INIT_PROBE_TIMEOUT_MS = 12_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap transcript files scanned per refresh so huge histories stay fast. */
const MAX_SCAN_TRANSCRIPTS = 300;
const MAX_TRANSCRIPT_BYTES = 12 * 1024 * 1024;

export interface ClaudeCliRateLimitEventInput {
  rateLimitType?: string;
  status?: string;
  utilization?: number;
  resetsAt?: number;
  now?: number;
}

interface PersistedRateLimitState {
  fiveHour?: ClaudeCliRateLimitWindow;
  sevenDay?: ClaudeCliRateLimitWindow;
  rateLimitedUntil?: number;
  rateLimitMessage?: string;
}

export interface ClaudeCliInitProbeResult {
  models: ClaudeCliModelOption[];
  subscriptionType?: string;
  email?: string;
  orgName?: string;
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };
type ExecFn = (file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ExecResult>;
type ResolveExeFn = () => Promise<string | null>;
type InitProbeFn = (cliPath: string, env: NodeJS.ProcessEnv) => Promise<ClaudeCliInitProbeResult | null>;

function defaultExecFile(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: 0 });
          return;
        }
        const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? err.message ?? ''), exitCode: code });
      },
    );
  });
}

async function defaultResolveExecutable(): Promise<string | null> {
  const isWin = process.platform === 'win32';
  const locator = isWin ? 'where' : 'which';
  const res = await defaultExecFile(locator, ['claude'], process.env, 4_000);
  if (res.exitCode === 0) {
    const lines = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      const preferred = isWin ? lines.find((l) => l.toLowerCase().endsWith('.exe')) ?? lines[0] : lines[0];
      return preferred;
    }
  }
  const home = homedir();
  const candidates = isWin
    ? [
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      ]
    : [
        path.join(home, '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Parse the `response` object inside a Claude Code `initialize` `control_response`. */
export function parseClaudeCliInitializeResponse(raw: unknown): ClaudeCliInitProbeResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const envelope = raw as Record<string, unknown>;
  const inner =
    envelope['response'] && typeof envelope['response'] === 'object' && !Array.isArray(envelope['response'])
      ? (envelope['response'] as Record<string, unknown>)
      : envelope;
  const payload =
    inner['response'] && typeof inner['response'] === 'object' && !Array.isArray(inner['response'])
      ? (inner['response'] as Record<string, unknown>)
      : inner;

  const rawModels = Array.isArray(payload['models']) ? payload['models'] : [];
  let defaultResolved = '';
  for (const m of rawModels) {
    if (m && typeof m === 'object' && (m as Record<string, unknown>)['value'] === 'default') {
      const r = (m as Record<string, unknown>)['resolvedModel'];
      if (typeof r === 'string' && r.trim()) {
        defaultResolved = r.trim();
      }
    }
  }

  const models: ClaudeCliModelOption[] = [];
  const seen = new Set<string>();
  for (const item of rawModels) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const value = typeof rec['value'] === 'string' ? rec['value'].trim() : '';
    const resolved = typeof rec['resolvedModel'] === 'string' ? rec['resolvedModel'].trim() : '';
    if (value === 'default') {
      // Skip the synthetic "default" alias; we mark its resolved model as recommended instead.
      continue;
    }
    const id = resolved || value;
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const displayName =
      typeof rec['displayName'] === 'string' && rec['displayName'].trim() ? rec['displayName'].trim() : id;
    const description =
      typeof rec['description'] === 'string' && rec['description'].trim() ? rec['description'].trim() : undefined;
    const rawEfforts = Array.isArray(rec['supportedEffortLevels']) ? rec['supportedEffortLevels'] : [];
    const effortLevels = rawEfforts.filter((e): e is string => typeof e === 'string' && !!e.trim());
    const adaptiveThinking = rec['supportsAdaptiveThinking'] === true;
    const supportsFastMode = rec['supportsFastMode'] === true;
    const contextWindowTokens = inferContextWindowTokens(id, 'anthropic') || 200_000;
    models.push({
      id,
      displayName,
      ...(description ? { description } : {}),
      contextWindowTokens,
      effortLevels,
      adaptiveThinking,
      supportsFastMode,
      ...(defaultResolved && id === defaultResolved ? { recommended: true } : {}),
    });
  }

  const acct =
    payload['account'] && typeof payload['account'] === 'object' && !Array.isArray(payload['account'])
      ? (payload['account'] as Record<string, unknown>)
      : null;

  return {
    models,
    ...(typeof acct?.['subscriptionType'] === 'string' && acct['subscriptionType'].trim()
      ? { subscriptionType: acct['subscriptionType'].trim() }
      : {}),
    ...(typeof acct?.['email'] === 'string' && acct['email'].trim() ? { email: acct['email'].trim() } : {}),
    ...(typeof acct?.['organization'] === 'string' && acct['organization'].trim()
      ? { orgName: acct['organization'].trim() }
      : {}),
  };
}

/** Parse `<configDir>/cache/model-catalog/*-cc.json` into rich per-model capabilities. */
export function parseClaudeCliCachedModelCatalog(raw: unknown): ClaudeCliModelOption[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }
  const root = raw as Record<string, unknown>;
  const catalog =
    root['catalog'] && typeof root['catalog'] === 'object' && !Array.isArray(root['catalog'])
      ? (root['catalog'] as Record<string, unknown>)
      : root;
  const config =
    catalog['config'] && typeof catalog['config'] === 'object' && !Array.isArray(catalog['config'])
      ? (catalog['config'] as Record<string, unknown>)
      : catalog;
  const rawModels = Array.isArray(config['models']) ? config['models'] : [];
  const models: ClaudeCliModelOption[] = [];
  const seen = new Set<string>();

  for (const item of rawModels) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const id = typeof rec['id'] === 'string' ? rec['id'].trim() : '';
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const runtime =
      rec['runtime'] && typeof rec['runtime'] === 'object' && !Array.isArray(rec['runtime'])
        ? (rec['runtime'] as Record<string, unknown>)
        : null;
    const thinking =
      rec['thinking'] && typeof rec['thinking'] === 'object' && !Array.isArray(rec['thinking'])
        ? (rec['thinking'] as Record<string, unknown>)
        : null;
    const noticeObj =
      rec['notice'] && typeof rec['notice'] === 'object' && !Array.isArray(rec['notice'])
        ? (rec['notice'] as Record<string, unknown>)
        : null;

    const displayName =
      typeof rec['name'] === 'string' && rec['name'].trim() ? rec['name'].trim() : id;
    const description =
      typeof rec['description'] === 'string' && rec['description'].trim() ? rec['description'].trim() : undefined;
    const maxInput =
      typeof runtime?.['max_input_tokens'] === 'number' && runtime['max_input_tokens'] > 0
        ? Math.floor(runtime['max_input_tokens'])
        : inferContextWindowTokens(id, 'anthropic') || 200_000;
    const maxOutput =
      typeof runtime?.['max_output_tokens'] === 'number' && runtime['max_output_tokens'] > 0
        ? Math.floor(runtime['max_output_tokens'])
        : undefined;
    const rawEfforts = Array.isArray(runtime?.['effort_levels']) ? runtime!['effort_levels'] : [];
    const effortLevels = rawEfforts.filter((e): e is string => typeof e === 'string' && !!e.trim());
    const defaultEffort =
      typeof runtime?.['default_effort'] === 'string' && runtime['default_effort'].trim()
        ? runtime['default_effort'].trim()
        : undefined;
    const section = rec['section'] === 'main' || rec['section'] === 'overflow' ? rec['section'] : undefined;
    const notice =
      typeof noticeObj?.['text'] === 'string' && noticeObj['text'].trim() ? noticeObj['text'].trim() : undefined;

    models.push({
      id,
      displayName,
      ...(description ? { description } : {}),
      contextWindowTokens: maxInput,
      ...(maxOutput ? { maxOutputTokens: maxOutput } : {}),
      effortLevels,
      ...(defaultEffort ? { defaultEffort } : {}),
      adaptiveThinking: thinking?.['type'] === 'effort' || effortLevels.length > 0,
      supportsFastMode: Boolean(rec['fast_mode']),
      ...(section ? { section } : {}),
      ...(notice ? { notice } : {}),
    });
  }
  return models;
}

/** Read the freshest Claude Code (`*-cc.json`) cached model catalog under `<configDir>/cache/model-catalog`. */
export async function readClaudeCliCachedModelCatalog(configDir: string): Promise<ClaudeCliModelOption[]> {
  const baseDir = expandTildePath(configDir) || path.join(homedir(), '.claude');
  const catalogDir = path.join(baseDir, 'cache', 'model-catalog');
  if (!existsSync(catalogDir)) {
    return [];
  }
  let entries;
  try {
    entries = await fs.readdir(catalogDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ccFiles: { filePath: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('-cc.json')) {
      continue;
    }
    const full = path.join(catalogDir, entry.name);
    try {
      const st = await fs.stat(full);
      ccFiles.push({ filePath: full, mtimeMs: st.mtimeMs });
    } catch {
      // skip
    }
  }
  ccFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { filePath } of ccFiles) {
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf-8')) as unknown;
      const parsed = parseClaudeCliCachedModelCatalog(raw);
      if (parsed.length > 0) {
        return parsed;
      }
    } catch {
      // try next file
    }
  }
  return [];
}

/**
 * Merge live CLI `initialize` models with the local `*-cc.json` model-catalog cache so every model
 * gets accurate `max_input_tokens` (1M/200K), `max_output_tokens`, `defaultEffort`, `supportsFastMode`,
 * and `notice`, with `main` models ordered first.
 */
export function mergeClaudeCliModelCatalogs(
  initModels: readonly ClaudeCliModelOption[],
  cacheModels: readonly ClaudeCliModelOption[],
): ClaudeCliModelOption[] {
  if (cacheModels.length === 0) {
    return [...initModels];
  }
  const initById = new Map(initModels.map((m) => [m.id, m] as const));
  const merged: ClaudeCliModelOption[] = [];
  const seen = new Set<string>();

  // Cache order already puts `section: "main"` first, then `"overflow"`.
  for (const cm of cacheModels) {
    const im = initById.get(cm.id);
    seen.add(cm.id);
    merged.push({
      ...cm,
      ...(im?.recommended ? { recommended: true } : {}),
      ...(cm.effortLevels.length === 0 && im?.effortLevels.length ? { effortLevels: im.effortLevels } : {}),
      supportsFastMode: cm.supportsFastMode || im?.supportsFastMode === true,
    });
  }
  // Keep any extra model present only in the live `initialize` handshake.
  for (const im of initModels) {
    if (!seen.has(im.id)) {
      merged.push(im);
    }
  }
  if (!merged.some((m) => m.recommended) && merged.length > 0) {
    merged[0] = { ...merged[0]!, recommended: true };
  }
  return merged;
}

/**
 * Query the local `claude` CLI's `initialize` control handshake (zero LLM API tokens) to retrieve
 * the exact live model list, effort levels, and subscription plan label for this account.
 */
function defaultInitProbe(cliPath: string, env: NodeJS.ProcessEnv): Promise<ClaudeCliInitProbeResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: ClaudeCliInitProbeResult | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve(val);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        cliPath,
        ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'],
        { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
      );
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => finish(null), INIT_PROBE_TIMEOUT_MS);

    let buf = '';
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const msg = JSON.parse(trimmed) as Record<string, unknown>;
          if (msg['type'] === 'control_response') {
            finish(parseClaudeCliInitializeResponse(msg));
            return;
          }
        } catch {
          // ignore non-JSON output
        }
      }
    });

    child.once('error', () => finish(null));
    child.once('close', () => finish(null));

    try {
      child.stdin?.write(
        `${JSON.stringify({
          type: 'control_request',
          request_id: 'valkade_probe_init',
          request: { subtype: 'initialize' },
        })}\n`,
      );
    } catch {
      finish(null);
    }
  });
}

let execFn: ExecFn = defaultExecFile;
let resolveExeFn: ResolveExeFn = defaultResolveExecutable;
let initProbeFn: InitProbeFn = defaultInitProbe;
let usageFilePathOverride: string | null = null;
let skipTranscriptScanForTests = false;

let cachedStatus: { configDirKey: string; fetchedAt: number; result: ClaudeCliStatusResult } | null = null;
let cachedLiveModels: ClaudeCliModelOption[] = [...CLAUDE_CLI_MODELS];
let rateLimitCache: PersistedRateLimitState | null = null;
let rateLimitLoaded = false;

/** Test hook: inject fake CLI runner / executable resolver / initialize probe / usage file path. */
export function configureClaudeCliStatusForTests(opts: {
  exec?: ExecFn | null;
  resolveExe?: ResolveExeFn | null;
  initProbe?: InitProbeFn | null;
  usageFilePath?: string | null;
  skipTranscriptScan?: boolean;
}): void {
  execFn = opts.exec ?? defaultExecFile;
  resolveExeFn = opts.resolveExe ?? defaultResolveExecutable;
  initProbeFn = opts.initProbe ?? defaultInitProbe;
  usageFilePathOverride = opts.usageFilePath ?? null;
  skipTranscriptScanForTests = opts.skipTranscriptScan ?? false;
  cachedStatus = null;
  cachedLiveModels = [...CLAUDE_CLI_MODELS];
  rateLimitCache = null;
  rateLimitLoaded = false;
}

export function resetClaudeCliStatusCache(): void {
  cachedStatus = null;
}

/** Return the most recently probed live Claude CLI model list (falls back to built-in defaults). */
export function getCachedClaudeCliModels(): readonly ClaudeCliModelOption[] {
  return cachedLiveModels;
}

/** Expand a leading `~` or `~/` using the current user's home directory. */
export function expandTildePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed === '~') {
    return homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/**
 * Build the subprocess environment for Claude Code CLI subscription mode.
 *
 * Strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` (case-insensitively) so Claude Code
 * always bills the user's subscription instead of silently falling back to a pay-as-you-go key.
 */
export function buildClaudeCliEnv(
  configDir?: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) {
      continue;
    }
    const upper = k.toUpperCase();
    if (upper === 'ANTHROPIC_API_KEY' || upper === 'ANTHROPIC_AUTH_TOKEN') {
      continue;
    }
    env[k] = v;
  }
  const expanded = expandTildePath(configDir ?? '');
  if (expanded) {
    env['CLAUDE_CONFIG_DIR'] = expanded;
  } else {
    for (const k of Object.keys(env)) {
      if (k.toUpperCase() === 'CLAUDE_CONFIG_DIR') {
        delete env[k];
      }
    }
  }
  return env;
}

function usageFilePath(): string | null {
  if (usageFilePathOverride) {
    return usageFilePathOverride;
  }
  try {
    return path.join(getAppDataDir(), 'claude-cli-usage.json');
  } catch {
    return null;
  }
}

async function ensureRateLimitLoaded(): Promise<PersistedRateLimitState> {
  if (rateLimitLoaded && rateLimitCache) {
    return rateLimitCache;
  }
  rateLimitLoaded = true;
  const file = usageFilePath();
  if (!file) {
    rateLimitCache = {};
    return rateLimitCache;
  }
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedRateLimitState>;
    rateLimitCache = {
      ...(parsed.fiveHour ? { fiveHour: parsed.fiveHour } : {}),
      ...(parsed.sevenDay ? { sevenDay: parsed.sevenDay } : {}),
      ...(typeof parsed.rateLimitedUntil === 'number' ? { rateLimitedUntil: parsed.rateLimitedUntil } : {}),
      ...(typeof parsed.rateLimitMessage === 'string' ? { rateLimitMessage: parsed.rateLimitMessage } : {}),
    };
  } catch {
    rateLimitCache = {};
  }
  return rateLimitCache;
}

async function persistRateLimit(data: PersistedRateLimitState): Promise<void> {
  const file = usageFilePath();
  if (!file) {
    return;
  }
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[claude-cli] Failed to persist rate-limit state:', err);
  }
}

function normalizeRateWindow(win: ClaudeCliRateLimitWindow | undefined, now: number): ClaudeCliRateLimitWindow {
  if (!win) {
    return { status: 'unknown' };
  }
  // If a previously observed window has already passed its reset timestamp, clear stale utilization/reject state.
  if (typeof win.resetsAt === 'number' && win.resetsAt > 0 && win.resetsAt <= now) {
    return { status: 'unknown' };
  }
  return { ...win };
}

/**
 * Scan `<configDir>/projects/<project>/*.jsonl` transcripts modified within the last 7 days to
 * compute real local Claude Code usage across all sessions (ValkAde, CLI terminal, etc.).
 */
export async function scanClaudeCliProjectUsage(
  configDir: string,
  now: number = Date.now(),
): Promise<{
  window5hTurns: number;
  window5hTokens: number;
  window5hCacheReadTokens: number;
  weeklyTurns: number;
  weeklyTokens: number;
  weeklyCacheReadTokens: number;
}> {
  const empty = {
    window5hTurns: 0,
    window5hTokens: 0,
    window5hCacheReadTokens: 0,
    weeklyTurns: 0,
    weeklyTokens: 0,
    weeklyCacheReadTokens: 0,
  };
  const baseDir = expandTildePath(configDir) || path.join(homedir(), '.claude');
  const projectsDir = path.join(baseDir, 'projects');
  if (!existsSync(projectsDir)) {
    return empty;
  }

  const cutoff7d = now - SEVEN_DAYS_MS;
  const cutoff5h = now - FIVE_HOURS_MS;

  const recentFiles: { filePath: string; mtimeMs: number }[] = [];
  const queue: string[] = [projectsDir];

  while (queue.length > 0 && recentFiles.length < MAX_SCAN_TRANSCRIPTS * 2) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = await fs.stat(full);
          if (st.mtimeMs >= cutoff7d && st.size <= MAX_TRANSCRIPT_BYTES) {
            recentFiles.push({ filePath: full, mtimeMs: st.mtimeMs });
          }
        } catch {
          // skip unreadable file
        }
      }
    }
  }

  recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const filesToRead = recentFiles.slice(0, MAX_SCAN_TRANSCRIPTS);

  // Deduplicate streamed partial assistant rows for the same message id (take last / max usage).
  const seenMsgUsage = new Map<
    string,
    { ts: number; billableTokens: number; cacheReadTokens: number }
  >();
  let fallbackCounter = 0;

  for (const { filePath } of filesToRead) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.includes('"usage"')) {
        continue;
      }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const tsStr = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : '';
      const ts = tsStr ? Date.parse(tsStr) : Number.NaN;
      if (!Number.isFinite(ts) || ts < cutoff7d) {
        continue;
      }
      const message =
        obj['message'] && typeof obj['message'] === 'object' && !Array.isArray(obj['message'])
          ? (obj['message'] as Record<string, unknown>)
          : null;
      const usage =
        message?.['usage'] && typeof message['usage'] === 'object' && !Array.isArray(message['usage'])
          ? (message['usage'] as Record<string, unknown>)
          : null;
      if (!usage) {
        continue;
      }
      const inTok = typeof usage['input_tokens'] === 'number' ? Math.max(0, usage['input_tokens']) : 0;
      const cacheCreate =
        typeof usage['cache_creation_input_tokens'] === 'number'
          ? Math.max(0, usage['cache_creation_input_tokens'])
          : 0;
      const cacheRead =
        typeof usage['cache_read_input_tokens'] === 'number' ? Math.max(0, usage['cache_read_input_tokens']) : 0;
      const outTok = typeof usage['output_tokens'] === 'number' ? Math.max(0, usage['output_tokens']) : 0;
      const billable = inTok + cacheCreate + outTok;
      if (billable === 0 && cacheRead === 0) {
        continue;
      }
      const msgId =
        (typeof message?.['id'] === 'string' && message['id'].trim()) ||
        (typeof obj['requestId'] === 'string' && obj['requestId'].trim()) ||
        `anon-${++fallbackCounter}`;
      const prev = seenMsgUsage.get(msgId);
      if (
        !prev ||
        billable > prev.billableTokens ||
        (billable === prev.billableTokens && cacheRead >= prev.cacheReadTokens)
      ) {
        seenMsgUsage.set(msgId, { ts, billableTokens: billable, cacheReadTokens: cacheRead });
      }
    }
  }

  let window5hTurns = 0;
  let window5hTokens = 0;
  let window5hCacheReadTokens = 0;
  let weeklyTurns = 0;
  let weeklyTokens = 0;
  let weeklyCacheReadTokens = 0;

  for (const row of seenMsgUsage.values()) {
    weeklyTurns += 1;
    weeklyTokens += row.billableTokens;
    weeklyCacheReadTokens += row.cacheReadTokens;
    if (row.ts >= cutoff5h) {
      window5hTurns += 1;
      window5hTokens += row.billableTokens;
      window5hCacheReadTokens += row.cacheReadTokens;
    }
  }

  return {
    window5hTurns,
    window5hTokens,
    window5hCacheReadTokens,
    weeklyTurns,
    weeklyTokens,
    weeklyCacheReadTokens,
  };
}

/** Record a real `rate_limit_event` frame emitted by Claude Code `stream-json`. */
export async function recordClaudeCliRateLimitEvent(
  event: ClaudeCliRateLimitEventInput,
): Promise<void> {
  const now = event.now ?? Date.now();
  const data = await ensureRateLimitLoaded();

  const rawStatus = (event.status ?? '').trim();
  const status: ClaudeCliRateLimitWindow['status'] =
    rawStatus === 'allowed' || rawStatus === 'allowed_warning' || rawStatus === 'rejected'
      ? rawStatus
      : 'unknown';

  // Anthropic emits utilization as 0..1 float (or occasionally 0..100). Normalize cleanly to 0..100.
  let utilizationPercent: number | undefined;
  if (typeof event.utilization === 'number' && Number.isFinite(event.utilization) && event.utilization >= 0) {
    utilizationPercent =
      event.utilization <= 1 ? Math.round(event.utilization * 100) : Math.min(100, Math.round(event.utilization));
  }

  // Anthropic emits resetsAt as Unix epoch seconds (or ms if > 1e12).
  let resetsAt: number | undefined;
  if (typeof event.resetsAt === 'number' && Number.isFinite(event.resetsAt) && event.resetsAt > 0) {
    resetsAt = event.resetsAt > 1e12 ? event.resetsAt : event.resetsAt * 1000;
  }

  const win: ClaudeCliRateLimitWindow = {
    status,
    ...(utilizationPercent !== undefined ? { utilizationPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    observedAt: now,
  };

  const kind = (event.rateLimitType ?? '').trim().toLowerCase();
  if (kind.includes('seven') || kind.includes('7d') || kind.includes('weekly')) {
    data.sevenDay = win;
  } else {
    data.fiveHour = win;
  }

  if (status === 'rejected') {
    data.rateLimitedUntil = resetsAt && resetsAt > now ? resetsAt : now + 60 * 60_000;
    data.rateLimitMessage = 'Claude subscription limit reached.';
  } else if (status === 'allowed') {
    const active5h = normalizeRateWindow(data.fiveHour, now);
    const active7d = normalizeRateWindow(data.sevenDay, now);
    const otherRejectedUntil =
      active5h.status === 'rejected'
        ? active5h.resetsAt
        : active7d.status === 'rejected'
          ? active7d.resetsAt
          : undefined;
    if (otherRejectedUntil && otherRejectedUntil > now) {
      data.rateLimitedUntil = otherRejectedUntil;
    } else if (active5h.status !== 'rejected' && active7d.status !== 'rejected') {
      delete data.rateLimitedUntil;
      delete data.rateLimitMessage;
    }
  }

  await persistRateLimit(data);
  if (cachedStatus) {
    cachedStatus.result.status = {
      ...cachedStatus.result.status,
      usage: {
        ...cachedStatus.result.status.usage,
        fiveHour: normalizeRateWindow(data.fiveHour, now),
        sevenDay: normalizeRateWindow(data.sevenDay, now),
      },
      rateLimitedUntil:
        typeof data.rateLimitedUntil === 'number' && data.rateLimitedUntil > now ? data.rateLimitedUntil : undefined,
      rateLimitMessage:
        typeof data.rateLimitedUntil === 'number' && data.rateLimitedUntil > now ? data.rateLimitMessage : undefined,
    };
  }
}

/** Record a rate-limit error (or clear it after a successful turn). */
export async function recordClaudeCliTurnUsage(opts: {
  rateLimitedUntil?: number;
  rateLimitMessage?: string;
  clearRateLimit?: boolean;
  now?: number;
}): Promise<void> {
  const now = opts.now ?? Date.now();
  const data = await ensureRateLimitLoaded();
  let changed = false;

  if (opts.rateLimitedUntil && opts.rateLimitedUntil > now) {
    data.rateLimitedUntil = opts.rateLimitedUntil;
    data.rateLimitMessage = opts.rateLimitMessage || 'Subscription rate limit reached.';
    data.fiveHour = {
      status: 'rejected',
      utilizationPercent: 100,
      resetsAt: opts.rateLimitedUntil,
      observedAt: now,
    };
    changed = true;
  } else if (opts.clearRateLimit) {
    if (data.rateLimitedUntil || data.rateLimitMessage) {
      delete data.rateLimitedUntil;
      delete data.rateLimitMessage;
      changed = true;
    }
    if (data.fiveHour?.status === 'rejected') {
      delete data.fiveHour;
      changed = true;
    }
    if (data.sevenDay?.status === 'rejected') {
      delete data.sevenDay;
      changed = true;
    }
  }

  if (changed) {
    await persistRateLimit(data);
  }
  // Invalidate cached status so next Settings refresh rescans the newly written Claude transcript.
  cachedStatus = null;
}

/** Parse version string like `"2.1.292 (Claude Code)"` into `"2.1.292"`. */
export function parseClaudeVersion(raw: string): string {
  const match = raw.trim().match(/(\d+\.\d+\.\d+(?:[-+][^\s)]+)?)/);
  return match ? match[1] : raw.trim().split(/\r?\n/)[0] ?? '';
}

interface RawAuthStatus {
  loggedIn?: unknown;
  authMethod?: unknown;
  email?: unknown;
  orgName?: unknown;
  subscriptionType?: unknown;
  configDirectory?: unknown;
}

/** Parse JSON emitted by `claude auth status`. */
export function parseClaudeAuthStatusJson(raw: string): RawAuthStatus | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RawAuthStatus) : null;
  } catch {
    return null;
  }
}

export async function resolveClaudeCliExecutable(): Promise<string | null> {
  return resolveExeFn();
}

/** Probe the locally installed Claude Code CLI, its live model list, auth state, and real usage. */
export async function getClaudeCliStatus(opts?: {
  refresh?: boolean;
  configDir?: string;
}): Promise<ClaudeCliStatusResult> {
  const configDir = (opts?.configDir ?? '').trim();
  const now = Date.now();
  const rlData = await ensureRateLimitLoaded();
  const fiveHour = normalizeRateWindow(rlData.fiveHour, now);
  const sevenDay = normalizeRateWindow(rlData.sevenDay, now);
  const rejectedUntil = Math.max(
    fiveHour.status === 'rejected' && fiveHour.resetsAt && fiveHour.resetsAt > now ? fiveHour.resetsAt : 0,
    sevenDay.status === 'rejected' && sevenDay.resetsAt && sevenDay.resetsAt > now ? sevenDay.resetsAt : 0,
  );
  const rateLimitedUntil =
    typeof rlData.rateLimitedUntil === 'number' && rlData.rateLimitedUntil > now
      ? rlData.rateLimitedUntil
      : rejectedUntil > now
        ? rejectedUntil
        : undefined;
  const rateLimitMessage = rateLimitedUntil ? rlData.rateLimitMessage : undefined;

  if (
    !opts?.refresh &&
    cachedStatus &&
    cachedStatus.configDirKey === configDir &&
    now - cachedStatus.fetchedAt < STATUS_TTL_MS
  ) {
    const updated: ClaudeCliStatus = {
      ...cachedStatus.result.status,
      usage: {
        ...cachedStatus.result.status.usage,
        fiveHour,
        sevenDay,
      },
      rateLimitedUntil,
      rateLimitMessage,
    };
    return cachedStatus.result.ok
      ? { ok: true, status: updated }
      : { ok: false, error: cachedStatus.result.error, status: updated };
  }

  const cliPath = await resolveExeFn();
  if (!cliPath) {
    const status: ClaudeCliStatus = {
      installed: false,
      cliPath: '',
      cliVersion: '',
      loggedIn: false,
      authMethod: '',
      email: '',
      orgName: '',
      subscriptionType: '',
      configDir: configDir || '~/.claude',
      models: [...CLAUDE_CLI_MODELS],
      billingGuardActive: true,
      rateLimitedUntil,
      rateLimitMessage,
      usage: { ...emptyClaudeCliUsageSummary(), fiveHour, sevenDay },
      checkedAt: now,
      error: 'Claude Code CLI (`claude`) was not found on PATH. Install Claude Code and click Re-check.',
    };
    const result: ClaudeCliStatusResult = { ok: false, error: status.error!, status };
    cachedStatus = { configDirKey: configDir, fetchedAt: now, result };
    return result;
  }

  const env = buildClaudeCliEnv(configDir);
  const [verRes, authRes] = await Promise.all([
    execFn(cliPath, ['--version'], env, EXEC_TIMEOUT_MS),
    execFn(cliPath, ['auth', 'status'], env, EXEC_TIMEOUT_MS),
  ]);

  const cliVersion = parseClaudeVersion(verRes.stdout || verRes.stderr);
  const auth = parseClaudeAuthStatusJson(authRes.stdout);

  const loggedIn = auth?.loggedIn === true;
  const authMethod = typeof auth?.authMethod === 'string' ? auth.authMethod : '';
  let email = typeof auth?.email === 'string' ? auth.email : '';
  let orgName = typeof auth?.orgName === 'string' ? auth.orgName : '';
  let subscriptionType = typeof auth?.subscriptionType === 'string' ? auth.subscriptionType : '';
  const reportedDir =
    typeof auth?.configDirectory === 'string' && auth.configDirectory.trim()
      ? auth.configDirectory.trim()
      : configDir || '~/.claude';

  // Run the local CLI `initialize` handshake & transcript usage scan in parallel when signed in.
  let models: ClaudeCliModelOption[] = [...CLAUDE_CLI_MODELS];
  let scanned = {
    window5hTurns: 0,
    window5hTokens: 0,
    window5hCacheReadTokens: 0,
    weeklyTurns: 0,
    weeklyTokens: 0,
    weeklyCacheReadTokens: 0,
  };

  if (loggedIn) {
    const [initInfo, cacheModels, transcriptUsage] = await Promise.all([
      initProbeFn(cliPath, env),
      skipTranscriptScanForTests ? Promise.resolve([] as ClaudeCliModelOption[]) : readClaudeCliCachedModelCatalog(reportedDir),
      skipTranscriptScanForTests ? Promise.resolve(scanned) : scanClaudeCliProjectUsage(reportedDir, now),
    ]);
    scanned = transcriptUsage;
    const mergedModels = mergeClaudeCliModelCatalogs(initInfo?.models ?? [], cacheModels);
    if (mergedModels.length > 0) {
      models = mergedModels;
      cachedLiveModels = [...models];
    }
    if (initInfo) {
      if (initInfo.subscriptionType) {
        subscriptionType = initInfo.subscriptionType;
      }
      if (initInfo.email && !email) {
        email = initInfo.email;
      }
      if (initInfo.orgName && !orgName) {
        orgName = initInfo.orgName;
      }
    }
  }

  let error = '';
  if (!auth && authRes.exitCode !== 0) {
    error = (authRes.stderr || authRes.stdout || 'Failed to read Claude CLI auth status.').trim();
  }

  const usage: ClaudeCliUsageSummary = {
    fiveHour,
    sevenDay,
    ...scanned,
    updatedAt: now,
  };

  const status: ClaudeCliStatus = {
    installed: true,
    cliPath,
    cliVersion,
    loggedIn,
    authMethod,
    email,
    orgName,
    subscriptionType,
    configDir: reportedDir,
    models,
    billingGuardActive: true,
    rateLimitedUntil,
    rateLimitMessage,
    usage,
    checkedAt: now,
    ...(error ? { error } : {}),
  };

  const result: ClaudeCliStatusResult = error ? { ok: false, error, status } : { ok: true, status };
  cachedStatus = { configDirKey: configDir, fetchedAt: now, result };
  return result;
}

/**
 * Trigger the official `claude auth login` flow in a detached child process so the user signs in
 * directly through Claude Code (browser OAuth). ValkAde never sees credentials or tokens.
 */
export async function launchClaudeCliLogin(configDir?: string): Promise<ClaudeCliMutationResult> {
  const cliPath = await resolveExeFn();
  if (!cliPath) {
    return { ok: false, error: 'Claude Code CLI (`claude`) was not found on PATH.' };
  }
  const env = buildClaudeCliEnv(configDir);
  try {
    const child = spawn(cliPath, ['auth', 'login'], {
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    resetClaudeCliStatusCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Composer Send-gate ping for the Claude Code subscription source. */
export async function pingClaudeCli(provider: LlmProviderConfig): Promise<LlmSourcePingResult> {
  const settings = normalizeClaudeCliSettings(provider.claudeCli);
  const res = await getClaudeCliStatus({ refresh: false, configDir: settings.configDir });
  if (!res.status.installed) {
    return { ok: false, error: 'Install Claude Code CLI (`claude`) to send with Claude Code' };
  }
  if (!res.status.loggedIn) {
    return { ok: false, error: 'Sign in with `claude auth login` in Settings to use Claude Code' };
  }
  if (res.status.rateLimitedUntil && res.status.rateLimitedUntil > Date.now()) {
    const mins = Math.max(1, Math.ceil((res.status.rateLimitedUntil - Date.now()) / 60_000));
    return { ok: false, error: `Claude subscription limit reached (resets in ~${mins}m)` };
  }
  return { ok: true };
}
