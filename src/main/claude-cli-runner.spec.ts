import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_CLI_BRIDGE_READ_TOOLS,
  DEFAULT_CLAUDE_CLI_SETTINGS,
  claudeCliReasoningCaps,
  toolPillLabel,
  type ParsedAgentStreamPayload,
  type ThemeProposalPayload,
} from '../shared';
import { subagentSource } from '../shared/subagent-sources';
import {
  buildClaudeCliArgs,
  buildClaudeUserMessageContent,
  buildValkadeMcpConfig,
  hasPendingClaudeCliApproval,
  hasPendingClaudeCliQuestion,
  isReadOnlyValkadeBridgeTool,
  parseClaudeRateLimitReset,
  resolveClaudeCliApproval,
  resolveClaudeCliQuestion,
  runClaudeCliChatTurn,
  sanitizeClaudeSuggestedTitle,
  setClaudeCliBridgeForTests,
  setClaudeCliSpawnForTests,
  suggestClaudeCliConversationTitle,
} from './claude-cli-runner';
import { configureClaudeCliStatusForTests } from './claude-cli-status';
import { createPinnedClaudeCliProvider } from './config/defaults';

function createFakeChildProcess(): {
  child: ChildProcess;
  stdinLines: string[];
  stdout: PassThrough;
  stderr: PassThrough;
  finish: (code?: number) => void;
} {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinLines: string[] = [];
  let buf = '';
  stdin.on('data', (chunk) => {
    buf += chunk.toString('utf-8');
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      if (line.trim()) {
        stdinLines.push(line.trim());
      }
    }
  });
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: 42424,
    kill: () => true,
  }) as unknown as ChildProcess;
  return {
    child,
    stdinLines,
    stdout,
    stderr,
    finish: (code = 0) => {
      stdout.end();
      stderr.end();
      emitter.emit('close', code);
    },
  };
}

describe('claude-cli-runner', () => {
  afterEach(() => {
    setClaudeCliSpawnForTests(null);
    setClaudeCliBridgeForTests(null);
    configureClaudeCliStatusForTests({});
  });

  it('builds read-only Ask args disallowing edit/write/bash and web when web access is off', () => {
    const args = buildClaudeCliArgs({
      modelId: 'claude-sonnet-4-6',
      effort: 'high',
      sessionId: 'sess-123',
      applyMode: false,
      autoApplyMode: false,
      composerMode: 'ask',
      allowWebAccess: false,
      settings: { ...DEFAULT_CLAUDE_CLI_SETTINGS },
      workspaceNotes: ['Use vitest'],
    });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-123');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    const disallowed = args[args.indexOf('--disallowedTools') + 1] ?? '';
    expect(disallowed).toContain('Edit');
    expect(disallowed).toContain('MultiEdit');
    expect(disallowed).toContain('Write');
    expect(disallowed).toContain('Bash');
    expect(disallowed).toContain('PowerShell');
    expect(disallowed).toContain('WebSearch');
    expect(disallowed).toContain('CronCreate');
    expect(args).toContain('--append-system-prompt');
  });

  it('omits --effort for models that do not support reasoning effort (e.g. Haiku 4.5)', () => {
    const args = buildClaudeCliArgs({
      modelId: 'claude-haiku-4-5-20251001',
      effort: 'high',
      sessionId: null,
      applyMode: true,
      autoApplyMode: true,
      composerMode: 'agent',
      allowWebAccess: false,
      settings: { ...DEFAULT_CLAUDE_CLI_SETTINGS },
      workspaceNotes: [],
    });
    expect(args).not.toContain('--effort');
  });

  it('excludes claude-cli from Python LangGraph subagent sources', () => {
    expect(subagentSource(createPinnedClaudeCliProvider(), 'Claude Code')).toBeNull();
  });

  it('builds manual + host permission-prompt args in Editor mode when routeApprovals is enabled', () => {
    const args = buildClaudeCliArgs({
      modelId: 'claude-opus-4-6',
      effort: 'max',
      sessionId: null,
      applyMode: true,
      autoApplyMode: false,
      composerMode: 'agent',
      allowWebAccess: true,
      settings: { ...DEFAULT_CLAUDE_CLI_SETTINGS, routeApprovals: true },
      workspaceNotes: [],
    });
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('manual');
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('host');
    const disallowed = args[args.indexOf('--disallowedTools') + 1] ?? '';
    expect(disallowed).toBe('CronCreate');
  });

  it('passes --autocompact and fastMode settings only when enabled and supported', () => {
    const opusArgs = buildClaudeCliArgs({
      modelId: 'claude-opus-5-5',
      effort: 'high',
      sessionId: null,
      applyMode: true,
      autoApplyMode: true,
      composerMode: 'agent',
      allowWebAccess: false,
      settings: { ...DEFAULT_CLAUDE_CLI_SETTINGS, autoCompact: '300k', fastMode: true },
      workspaceNotes: [],
    });
    expect(opusArgs[opusArgs.indexOf('--autocompact') + 1]).toBe('300k');
    expect(opusArgs[opusArgs.indexOf('--settings') + 1]).toBe('{"fastMode":true}');

    const sonnetArgs = buildClaudeCliArgs({
      modelId: 'claude-sonnet-5-5',
      effort: 'medium',
      sessionId: null,
      applyMode: true,
      autoApplyMode: true,
      composerMode: 'agent',
      allowWebAccess: false,
      settings: { ...DEFAULT_CLAUDE_CLI_SETTINGS, autoCompact: 'auto', fastMode: true },
      workspaceNotes: [],
    });
    expect(sonnetArgs).not.toContain('--autocompact');
    expect(sonnetArgs).not.toContain('--settings');
  });

  it('parses rate limit reset durations', () => {
    const now = 1_700_000_000_000;
    expect(parseClaudeRateLimitReset('Normal error', now).limited).toBe(false);
    const res = parseClaudeRateLimitReset('5-hour usage limit reached; resets in 1h 30m', now);
    expect(res.limited).toBe(true);
    expect(res.resetAt).toBe(now + 90 * 60_000);
    // "5 hour" window label must not be mistaken for a 5-hour countdown when actual reset is in minutes.
    const resMins = parseClaudeRateLimitReset('Your 5 hour usage limit resets in 20 minutes.', now);
    expect(resMins.limited).toBe(true);
    expect(resMins.resetAt).toBe(now + 20 * 60_000);
  });

  it('streams text, tool pills, approval cards, AskUserQuestion, and token usage end-to-end', async () => {
    const fake = createFakeChildProcess();
    configureClaudeCliStatusForTests({ resolveExe: async () => '/usr/local/bin/claude' });
    setClaudeCliSpawnForTests((() => fake.child) as unknown as typeof import('child_process').spawn);

    const emitted: ParsedAgentStreamPayload[] = [];
    const controller = new AbortController();
    const provider = createPinnedClaudeCliProvider();
    provider.claudeCli = { ...DEFAULT_CLAUDE_CLI_SETTINGS, captureTurnDiffs: false };

    const turnPromise = runClaudeCliChatTurn({
      conversationId: 'conv-1',
      userMessageId: 'msg-1',
      message: 'Check status',
      provider,
      applyMode: true,
      autoApplyMode: false,
      composerMode: 'agent',
      allowWebAccess: false,
      workspaceRoot: null,
      workspaceNotes: [],
      signal: controller.signal,
      emit: (p) => {
        emitted.push(p);
        if (p.type === 'accept_command') {
          expect(hasPendingClaudeCliApproval('conv-1', p.acceptCommand.requestId)).toBe(true);
          resolveClaudeCliApproval('conv-1', p.acceptCommand.requestId, 'confirm', '');
        } else if (p.type === 'agent_question') {
          expect(hasPendingClaudeCliQuestion('conv-1', p.agentQuestion.requestId)).toBe(true);
          const q = p.agentQuestion.questions[0]!;
          resolveClaudeCliQuestion('conv-1', p.agentQuestion.requestId, 'submit', [
            { questionId: q.id, optionId: q.options[0]!.id },
          ]);
        }
      },
    });

    // Give spawn a tick, then feed NDJSON events from Claude Code.
    await new Promise((r) => setTimeout(r, 15));
    fake.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-abc' })}\n`);
    fake.stdout.write(
      `${JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Checking...' } },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'req-bash-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git status' } },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'req-q-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which mode?',
                options: [{ label: 'Fast' }, { label: 'Thorough' }],
              },
            ],
          },
        },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-edit-1',
              name: 'Edit',
              input: { file_path: 'src/app.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
            },
          ],
        },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-edit-1', content: 'Edited src/app.ts', is_error: false }],
        },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'All good!' } },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'sid-abc',
        usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 500 },
      })}\n`,
    );
    await new Promise((r) => setTimeout(r, 30));
    fake.finish(0);

    const outcome = await turnPromise;
    expect(outcome).toBe('completed');
    expect(emitted.some((e) => e.type === 'chunk' && e.streamTag === 'thinking')).toBe(true);
    expect(emitted.some((e) => e.type === 'chunk' && e.delta === 'All good!')).toBe(true);
    expect(emitted.some((e) => e.type === 'accept_command')).toBe(true);
    expect(emitted.some((e) => e.type === 'agent_question')).toBe(true);
    expect(emitted.some((e) => e.type === 'token_usage' && e.outputTokens === 300)).toBe(true);
    const editDone = emitted.find(
      (e) => e.type === 'status' && e.status.id === 'tu-edit-1' && e.status.state === 'complete',
    );
    expect(editDone && editDone.type === 'status' ? editDone.status.source : '').toBe('tool');
    expect(editDone && editDone.type === 'status' ? editDone.status.label : '').toBe('Edit');
    expect(editDone && editDone.type === 'status' ? editDone.status.toolDiff : '').toContain('-const a = 1;');
    expect(editDone && editDone.type === 'status' ? editDone.status.toolDiff : '').toContain('+const a = 2;');

    // Verify stdin received user prompt + both control_responses.
    const parsedStdin = fake.stdinLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsedStdin[0]?.['type']).toBe('user');
    const bashResp = parsedStdin.find((m) => m['request_id'] === 'req-bash-1');
    expect((bashResp?.['response'] as Record<string, unknown>)?.['behavior']).toBe('allow');
    const qResp = parsedStdin.find((m) => m['request_id'] === 'req-q-1');
    expect(((qResp?.['response'] as Record<string, unknown>)?.['updatedInput'] as Record<string, unknown>)?.['answers']).toEqual({
      'Which mode?': 'Fast',
    });
  });

  it('wires ValkAde MCP bridge config, auto-allows read-only bridge tools, prompts on mutating ones, and drains theme proposals', async () => {
    const cfg = buildValkadeMcpConfig({
      url: 'http://127.0.0.1:5124/claude-bridge/mcp',
      token: 'secret-tok',
      sessionId: 'conv-mcp',
      workspaceRoot: 'C:\\repo',
      workspaceId: 'ws-1',
      applyMode: true,
      allowWebAccess: false,
    });
    expect(cfg.mcpServers['valkade']?.type).toBe('http');
    expect(cfg.mcpServers['valkade']?.headers['Authorization']).toBe('Bearer secret-tok');
    expect(cfg.mcpServers['valkade']?.headers['X-Valkade-Apply-Mode']).toBe('1');
    expect(cfg.mcpServers['valkade']?.headers['X-Valkade-Allow-Web']).toBe('0');

    expect(isReadOnlyValkadeBridgeTool('mcp__valkade__lsp_get_diagnostics')).toBe(true);
    expect(isReadOnlyValkadeBridgeTool('mcp__valkade__check_user_terminals')).toBe(true);
    expect(isReadOnlyValkadeBridgeTool('mcp__valkade__lsp_rename_symbol')).toBe(false);
    expect(isReadOnlyValkadeBridgeTool('mcp__valkade__propose_theme')).toBe(false);

    // Bridged tool names inherit native ValkAde pill verbs & categories.
    const diagPill = toolPillLabel({
      streamTag: 'tool-trail:1',
      label: 'mcp__valkade__lsp_get_diagnostics',
      text: '',
      toolTarget: 'src/app.ts',
    });
    expect(diagPill.verb).toBe('Diagnostics');
    expect(diagPill.category).toBe('lsp');

    // Ask mode disallows lsp_rename_symbol & screenshot_webpage; never passes --strict-mcp-config.
    const askArgs = buildClaudeCliArgs({
      modelId: 'claude-opus-5-5',
      effort: 'high',
      sessionId: null,
      applyMode: false,
      autoApplyMode: false,
      composerMode: 'ask',
      allowWebAccess: false,
      settings: { ...DEFAULT_CLAUDE_CLI_SETTINGS, bridgeWorkspaceTools: true },
      workspaceNotes: [],
      mcpConfigPath: '/tmp/valkade-mcp.json',
    });
    expect(askArgs).toContain('--mcp-config');
    expect(askArgs).not.toContain('--strict-mcp-config');
    expect(askArgs[askArgs.indexOf('--allowedTools') + 1]).toBe(CLAUDE_CLI_BRIDGE_READ_TOOLS.join(','));
    const askDisallowed = askArgs[askArgs.indexOf('--disallowedTools') + 1] ?? '';
    expect(askDisallowed).toContain('mcp__valkade__lsp_rename_symbol');
    expect(askDisallowed).toContain('mcp__valkade__screenshot_webpage');

    // End-to-end turn with mocked bridge: read-only auto-allowed, mutating prompted, theme drained.
    const fake = createFakeChildProcess();
    let capturedArgs: string[] = [];
    configureClaudeCliStatusForTests({ resolveExe: async () => '/usr/local/bin/claude' });
    setClaudeCliSpawnForTests(((_cmd: string, args: readonly string[]) => {
      capturedArgs = [...args];
      return fake.child;
    }) as unknown as typeof import('child_process').spawn);

    const mockTheme: ThemeProposalPayload = {
      version: 1,
      requestId: 'theme-abc',
      title: 'Theme proposal: Midnight Gold',
      summary: 'Dark theme with gold accent',
      theme: { version: 1, id: 'midnight-gold', name: 'Midnight Gold', mode: 'dark', tokens: {}, groups: {} },
      warnings: [],
    };
    let drainedOnce = false;
    setClaudeCliBridgeForTests({
      bridgeUrl: 'http://127.0.0.1:5124/claude-bridge/mcp',
      sidecarToken: 'tok-123',
      drainEvents: async () => {
        if (drainedOnce) {
          return [];
        }
        drainedOnce = true;
        return [{ type: 'theme_proposal', themeProposal: mockTheme }];
      },
    });

    const emitted: ParsedAgentStreamPayload[] = [];
    const provider = createPinnedClaudeCliProvider();
    provider.claudeCli = { ...DEFAULT_CLAUDE_CLI_SETTINGS, captureTurnDiffs: false, bridgeWorkspaceTools: true };

    const turnPromise = runClaudeCliChatTurn({
      conversationId: 'conv-mcp',
      userMessageId: 'msg-mcp',
      message: 'Check diagnostics and design a theme',
      provider,
      applyMode: true,
      autoApplyMode: false,
      composerMode: 'agent',
      allowWebAccess: false,
      workspaceId: 'ws-1',
      workspaceRoot: null,
      workspaceNotes: [],
      signal: new AbortController().signal,
      emit: (p) => {
        emitted.push(p);
        if (p.type === 'accept_command') {
          resolveClaudeCliApproval('conv-mcp', p.acceptCommand.requestId, 'confirm', '');
        }
      },
    });

    await new Promise((r) => setTimeout(r, 15));
    // Read-only bridge control_request should be auto-allowed WITHOUT emitting accept_command.
    fake.stdout.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'req-lsp-1',
        request: { subtype: 'can_use_tool', tool_name: 'mcp__valkade__lsp_get_diagnostics', input: { relative_path: 'src/a.ts' } },
      })}\n`,
    );
    // Mutating bridge control_request MUST emit accept_command.
    fake.stdout.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'req-theme-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'mcp__valkade__propose_theme',
          input: { theme: { name: 'Midnight Gold' } },
        },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-theme-1',
              name: 'mcp__valkade__propose_theme',
              input: { theme: { name: 'Midnight Gold' } },
            },
          ],
        },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-theme-1', content: 'Proposed theme "Midnight Gold"', is_error: false }],
        },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'sid-mcp',
      })}\n`,
    );
    await new Promise((r) => setTimeout(r, 30));
    fake.finish(0);

    const outcome = await turnPromise;
    expect(outcome).toBe('completed');
    expect(capturedArgs).toContain('--mcp-config');

    const approvalCards = emitted.filter((e) => e.type === 'accept_command');
    expect(approvalCards).toHaveLength(1);
    expect(approvalCards[0]?.type === 'accept_command' ? approvalCards[0].acceptCommand.requestId : '').toBe('req-theme-1');

    const parsedStdin = fake.stdinLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const lspResp = parsedStdin.find((m) => m['request_id'] === 'req-lsp-1');
    expect((lspResp?.['response'] as Record<string, unknown>)?.['behavior']).toBe('allow');

    const themeEvents = emitted.filter((e) => e.type === 'theme_proposal');
    expect(themeEvents).toHaveLength(1);
    expect(themeEvents[0]?.type === 'theme_proposal' ? themeEvents[0].themeProposal.theme.name : '').toBe('Midnight Gold');
  });

  it('embeds attached workspace images and inline image_url blocks while blocking path traversal', async () => {
    expect(claudeCliReasoningCaps().vision).toBe(true);

    const ws = await fs.mkdtemp(path.join(tmpdir(), 'valkade-claude-img-'));
    try {
      const assetsDir = path.join(ws, 'assets');
      await fs.mkdir(assetsDir, { recursive: true });
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await fs.writeFile(path.join(assetsDir, 'mockup.png'), pngBytes);

      const content = await buildClaudeUserMessageContent(
        'Describe these images',
        [
          { type: 'text', text: 'Describe these images' },
          {
            type: 'text',
            text: 'Attached image: assets/mockup.png (use read_workspace_image with relative_path="assets/mockup.png" for visual analysis)',
          },
          {
            type: 'text',
            text: 'Attached image: ../outside.png (use read_workspace_image with relative_path="../outside.png" for visual analysis)',
          },
          {
            type: 'image_url',
            image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' },
          },
        ],
        ws,
      );

      expect(Array.isArray(content)).toBe(true);
      const blocks = content as Array<Record<string, unknown>>;
      const images = blocks.filter((b) => b['type'] === 'image');
      expect(images).toHaveLength(2);
      expect(images[0]?.['source']).toEqual({
        type: 'base64',
        media_type: 'image/png',
        data: pngBytes.toString('base64'),
      });
      expect(images[1]?.['source']).toEqual({
        type: 'base64',
        media_type: 'image/jpeg',
        data: '/9j/4AAQ',
      });
      // Path traversal must not inline bytes.
      expect(blocks.some((b) => b['type'] === 'text' && b['text'] === 'Attached image: ../outside.png')).toBe(true);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it('generates conversation titles through Claude Code CLI with billing guard and --no-session-persistence', async () => {
    expect(sanitizeClaudeSuggestedTitle('"Fix Login Timeout Bug"\nExtra details')).toBe('Fix Login Timeout Bug');

    const fake = createFakeChildProcess();
    let capturedArgs: string[] = [];
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    configureClaudeCliStatusForTests({ resolveExe: async () => '/usr/local/bin/claude' });
    setClaudeCliSpawnForTests(((_cmd: string, args: readonly string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      capturedArgs = [...args];
      capturedEnv = opts?.env;
      return fake.child;
    }) as unknown as typeof import('child_process').spawn);

    const provider = createPinnedClaudeCliProvider();
    const titlePromise = suggestClaudeCliConversationTitle({
      messages: [
        { role: 'user', text: 'How do I fix the semantic search timeout in ValkAde?' },
        { role: 'assistant', text: 'Skip .venv and .git in walk.py so it only indexes source files.' },
      ],
      provider,
    });

    await new Promise((r) => setTimeout(r, 15));
    fake.stdout.write('"Fix Semantic Search Indexing Timeout"\n');
    fake.finish(0);

    const title = await titlePromise;
    expect(title).toBe('Fix Semantic Search Indexing Timeout');
    expect(capturedArgs).toContain('--no-session-persistence');
    expect(capturedArgs[capturedArgs.indexOf('--tools') + 1]).toBe('');
    expect(capturedArgs[capturedArgs.indexOf('--output-format') + 1]).toBe('text');
    expect(capturedEnv?.['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('aborts cleanly without deadlocking when a pending approval card is unanswered and removes temp MCP config', async () => {
    const fake = createFakeChildProcess();
    let mcpPath = '';
    configureClaudeCliStatusForTests({ resolveExe: async () => '/usr/local/bin/claude' });
    setClaudeCliSpawnForTests(((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('--mcp-config');
      if (idx >= 0) {
        mcpPath = args[idx + 1] ?? '';
      }
      return fake.child;
    }) as unknown as typeof import('child_process').spawn);
    setClaudeCliBridgeForTests({
      bridgeUrl: 'http://127.0.0.1:5124/claude-bridge/mcp',
      sidecarToken: 'tok-abort-test',
    });

    const controller = new AbortController();
    const provider = createPinnedClaudeCliProvider();
    provider.claudeCli = { ...DEFAULT_CLAUDE_CLI_SETTINGS, captureTurnDiffs: false, bridgeWorkspaceTools: true };

    let sawCard = false;
    const turnPromise = runClaudeCliChatTurn({
      conversationId: 'conv-abort-pending',
      userMessageId: 'msg-abort',
      message: 'Run something',
      provider,
      applyMode: true,
      autoApplyMode: false,
      composerMode: 'agent',
      allowWebAccess: false,
      workspaceRoot: null,
      workspaceNotes: [],
      signal: controller.signal,
      emit: (p) => {
        if (p.type === 'accept_command') {
          sawCard = true;
          // User clicks Stop while approval card is waiting; process exits shortly after.
          controller.abort();
          setTimeout(() => fake.finish(1), 5);
        }
      },
    });

    await new Promise((r) => setTimeout(r, 15));
    fake.stdout.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'req-stuck-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf tmp' } },
      })}\n`,
    );

    const outcome = await turnPromise;
    expect(sawCard).toBe(true);
    expect(outcome).toBe('aborted');
    expect(hasPendingClaudeCliApproval('conv-abort-pending', 'req-stuck-1')).toBe(false);
    expect(mcpPath).toBeTruthy();
    await expect(fs.stat(mcpPath)).rejects.toThrow();
  });
});
