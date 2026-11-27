import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClaudeCliEnv,
  configureClaudeCliStatusForTests,
  expandTildePath,
  getClaudeCliStatus,
  mergeClaudeCliModelCatalogs,
  parseClaudeAuthStatusJson,
  parseClaudeCliCachedModelCatalog,
  parseClaudeCliInitializeResponse,
  parseClaudeVersion,
  pingClaudeCli,
  readClaudeCliCachedModelCatalog,
  recordClaudeCliRateLimitEvent,
  recordClaudeCliTurnUsage,
  scanClaudeCliProjectUsage,
} from './claude-cli-status';
import { createPinnedClaudeCliProvider } from './config/defaults';

describe('claude-cli-status', () => {
  let tmpDir: string;
  let usagePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(tmpdir(), 'valkade-claude-cli-status-'));
    usagePath = path.join(tmpDir, 'claude-cli-usage.json');
    configureClaudeCliStatusForTests({ usageFilePath: usagePath, skipTranscriptScan: true });
  });

  afterEach(async () => {
    configureClaudeCliStatusForTests({});
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN in buildClaudeCliEnv', () => {
    const env = buildClaudeCliEnv('~/.claude_work', {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-should-be-stripped',
      anthropic_api_key: 'sk-ant-lowercase-stripped',
      ANTHROPIC_AUTH_TOKEN: 'tok-stripped',
      OTHER_VAR: 'keep',
    });
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['anthropic_api_key']).toBeUndefined();
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(env['OTHER_VAR']).toBe('keep');
    expect(env['CLAUDE_CONFIG_DIR']).toBe(expandTildePath('~/.claude_work'));
  });

  it('clears CLAUDE_CONFIG_DIR when no custom configDir is set', () => {
    const env = buildClaudeCliEnv('', {
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/some/inherited/dir',
    });
    expect(env['CLAUDE_CONFIG_DIR']).toBeUndefined();
  });

  it('parses claude --version, auth status JSON, and live initialize models', () => {
    expect(parseClaudeVersion('2.1.292 (Claude Code)\n')).toBe('2.1.292');
    const auth = parseClaudeAuthStatusJson(
      '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "email": "dev@valkade.ai",\n  "subscriptionType": "max",\n  "configDirectory": "C:\\\\Users\\\\dev\\\\.claude"\n}',
    );
    expect(auth?.loggedIn).toBe(true);

    const parsedInit = parseClaudeCliInitializeResponse({
      type: 'control_response',
      response: {
        subtype: 'success',
        response: {
          account: { subscriptionType: 'Claude Ultra', email: 'dev@valkade.ai' },
          models: [
            { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default' },
            {
              value: 'opus',
              resolvedModel: 'claude-opus-5-5',
              displayName: 'Opus 5.5',
              description: 'Best everyday',
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsAdaptiveThinking: true,
            },
            {
              value: 'fable',
              resolvedModel: 'claude-fable-5-1',
              displayName: 'Fable 5.1',
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
            { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
          ],
        },
      },
    });
    expect(parsedInit?.subscriptionType).toBe('Claude Ultra');
    expect(parsedInit?.models.map((m) => m.id)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-haiku-4-5-20251001',
    ]);
    expect(parsedInit?.models[0]?.recommended).toBe(true);
    expect(parsedInit?.models[0]?.effortLevels).toContain('xhigh');
  });

  it('reports not-installed when claude executable is absent', async () => {
    configureClaudeCliStatusForTests({
      resolveExe: async () => null,
      usageFilePath: usagePath,
      skipTranscriptScan: true,
    });
    const res = await getClaudeCliStatus({ refresh: true });
    expect(res.ok).toBe(false);
    expect(res.status.installed).toBe(false);
    expect(res.status.loggedIn).toBe(false);
    expect(res.status.billingGuardActive).toBe(true);
  });

  it('populates live CLI models, plan name, and passes pingClaudeCli when signed in', async () => {
    configureClaudeCliStatusForTests({
      resolveExe: async () => 'C:\\bin\\claude.exe',
      exec: async (_file, args) => {
        if (args[0] === '--version') {
          return { stdout: '2.1.292 (Claude Code)', stderr: '', exitCode: 0 };
        }
        return {
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: 'claude.ai',
            email: 'dev@valkade.ai',
            subscriptionType: 'max',
            configDirectory: tmpDir,
          }),
          stderr: '',
          exitCode: 0,
        };
      },
      initProbe: async () => ({
        subscriptionType: 'Claude Ultra',
        models: [
          {
            id: 'claude-opus-5-5',
            displayName: 'Opus 5.5',
            contextWindowTokens: 200_000,
            effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            recommended: true,
          },
          {
            id: 'claude-fable-5-1',
            displayName: 'Fable 5.1',
            contextWindowTokens: 200_000,
            effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
      }),
      usageFilePath: usagePath,
      skipTranscriptScan: true,
    });

    const res = await getClaudeCliStatus({ refresh: true });
    expect(res.ok).toBe(true);
    expect(res.status.subscriptionType).toBe('Claude Ultra');
    expect(res.status.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-fable-5-1']);

    const ping = await pingClaudeCli(createPinnedClaudeCliProvider());
    expect(ping).toEqual({ ok: true });
  });

  it('scans local Claude Code project JSONL transcripts and deduplicates streamed message ids', async () => {
    const projDir = path.join(tmpDir, 'projects', 'demo-proj');
    await fs.mkdir(projDir, { recursive: true });
    const now = Date.now();
    const recentIso = new Date(now - 30 * 60_000).toISOString();
    const olderIso = new Date(now - 2 * 24 * 60 * 60_000).toISOString();
    const lines = [
      // Two partial rows for same message id — should count once with max usage.
      JSON.stringify({
        timestamp: recentIso,
        message: {
          id: 'msg-1',
          usage: { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 50_000, output_tokens: 40 },
        },
      }),
      JSON.stringify({
        timestamp: recentIso,
        message: {
          id: 'msg-1',
          usage: { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 50_000, output_tokens: 120 },
        },
      }),
      JSON.stringify({
        timestamp: olderIso,
        message: {
          id: 'msg-2',
          usage: { input_tokens: 20, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100_000, output_tokens: 200 },
        },
      }),
    ];
    await fs.writeFile(path.join(projDir, 'session.jsonl'), `${lines.join('\n')}\n`, 'utf-8');

    const scanned = await scanClaudeCliProjectUsage(tmpDir, now);
    expect(scanned.window5hTurns).toBe(1);
    expect(scanned.window5hTokens).toBe(630);
    expect(scanned.window5hCacheReadTokens).toBe(50_000);
    expect(scanned.weeklyTurns).toBe(2);
    expect(scanned.weeklyTokens).toBe(630 + 1220);
    expect(scanned.weeklyCacheReadTokens).toBe(150_000);
  });

  it('records real rate_limit_event utilization and resetsAt timestamps', async () => {
    const now = Date.now();
    const resetSec = Math.floor((now + 2 * 60 * 60_000) / 1000);
    await recordClaudeCliRateLimitEvent({
      rateLimitType: 'five_hour',
      status: 'allowed_warning',
      utilization: 0.82,
      resetsAt: resetSec,
      now,
    });
    configureClaudeCliStatusForTests({
      resolveExe: async () => null,
      usageFilePath: usagePath,
      skipTranscriptScan: true,
    });
    const res = await getClaudeCliStatus({ refresh: true });
    expect(res.status.usage.fiveHour.status).toBe('allowed_warning');
    expect(res.status.usage.fiveHour.utilizationPercent).toBe(82);
    expect(res.status.usage.fiveHour.resetsAt).toBe(resetSec * 1000);
  });

  it('clears rejected rate-limit window after a successful turn and preserves active rejection across unrelated window events', async () => {
    configureClaudeCliStatusForTests({
      resolveExe: async () => null,
      usageFilePath: usagePath,
      skipTranscriptScan: true,
    });
    const now = Date.now();
    const until = now + 45 * 60_000;
    await recordClaudeCliTurnUsage({
      rateLimitedUntil: until,
      rateLimitMessage: '5-hour limit reached',
      now,
    });

    // An unrelated seven_day allowed event must not wipe the active fiveHour rejection.
    await recordClaudeCliRateLimitEvent({
      rateLimitType: 'seven_day',
      status: 'allowed',
      utilization: 0.25,
      resetsAt: Math.floor((now + 3 * 24 * 60 * 60_000) / 1000),
      now,
    });
    const stillLimited = await getClaudeCliStatus({ refresh: true });
    expect(stillLimited.status.rateLimitedUntil).toBe(until);
    expect(stillLimited.status.usage.fiveHour.status).toBe('rejected');

    // A successful turn clears both rateLimitedUntil and the rejected fiveHour window.
    await recordClaudeCliTurnUsage({ clearRateLimit: true, now: now + 1000 });
    const cleared = await getClaudeCliStatus({ refresh: true });
    expect(cleared.status.rateLimitedUntil).toBeUndefined();
    expect(cleared.status.usage.fiveHour.status).toBe('unknown');

    // A rejected seven_day window also sets rateLimitedUntil.
    const sevenResetSec = Math.floor((now + 2 * 60 * 60_000) / 1000);
    await recordClaudeCliRateLimitEvent({
      rateLimitType: 'seven_day',
      status: 'rejected',
      utilization: 1,
      resetsAt: sevenResetSec,
      now,
    });
    const weeklyLimited = await getClaudeCliStatus({ refresh: true });
    expect(weeklyLimited.status.rateLimitedUntil).toBe(sevenResetSec * 1000);
  });

  it('parses, reads, and merges Claude Code model-catalog *-cc.json cache with 1M/200K metadata', async () => {
    const cacheDir = path.join(tmpDir, 'cache', 'model-catalog');
    await fs.mkdir(cacheDir, { recursive: true });
    const rawCatalog = {
      catalog: {
        config: {
          models: [
            {
              id: 'claude-opus-5-5',
              name: 'Opus 5.5',
              description: 'For complex work',
              section: 'main',
              fast_mode: { enabled: true },
              thinking: { type: 'effort' },
              runtime: {
                max_input_tokens: 1_000_000,
                max_output_tokens: 128_000,
                effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
                default_effort: 'medium',
              },
            },
            {
              id: 'claude-haiku-4-5-20251001',
              name: 'Haiku 4.5',
              description: 'Fastest for quick answers',
              section: 'overflow',
              fast_mode: false,
              notice: { text: 'Older Haiku generation' },
              runtime: {
                max_input_tokens: 200_000,
                max_output_tokens: 64_000,
                effort_levels: [],
              },
            },
          ],
        },
      },
    };
    await fs.writeFile(path.join(cacheDir, 'org123-cc.json'), JSON.stringify(rawCatalog), 'utf-8');

    const direct = parseClaudeCliCachedModelCatalog(rawCatalog);
    expect(direct).toHaveLength(2);
    expect(direct[0]).toMatchObject({
      id: 'claude-opus-5-5',
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      defaultEffort: 'medium',
      supportsFastMode: true,
      section: 'main',
    });
    expect(direct[1]).toMatchObject({
      id: 'claude-haiku-4-5-20251001',
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsFastMode: false,
      section: 'overflow',
      notice: 'Older Haiku generation',
    });

    const fromDisk = await readClaudeCliCachedModelCatalog(tmpDir);
    expect(fromDisk.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5-20251001']);

    const merged = mergeClaudeCliModelCatalogs(
      [
        {
          id: 'claude-opus-5-5',
          displayName: 'Opus 5.5',
          contextWindowTokens: 200_000,
          effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          recommended: true,
        },
        {
          id: 'claude-custom-preview',
          displayName: 'Custom Preview',
          contextWindowTokens: 200_000,
          effortLevels: ['medium'],
        },
      ],
      fromDisk,
    );
    expect(merged.map((m) => m.id)).toEqual([
      'claude-opus-5-5',
      'claude-haiku-4-5-20251001',
      'claude-custom-preview',
    ]);
    expect(merged[0]?.contextWindowTokens).toBe(1_000_000);
    expect(merged[0]?.maxOutputTokens).toBe(128_000);
    expect(merged[0]?.recommended).toBe(true);
    expect(merged[0]?.supportsFastMode).toBe(true);
  });
});
