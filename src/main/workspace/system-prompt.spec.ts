import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH } from '../../shared';

const testRoot = { dir: '' };

vi.mock('../paths', () => ({
  getLegacyAppDataSystemPromptPath: (workspaceId: string) =>
    join(testRoot.dir, 'app-data', 'workspaces', workspaceId, 'system-prompt.md'),
  getWorkspaceSystemPromptPath: (workspaceRoot: string) =>
    join(workspaceRoot, '.valkade', 'system-prompt.md'),
}));

import {
  DEFAULT_WORKSPACE_SYSTEM_PROMPT,
  ensureWorkspaceSystemPrompt,
  readWorkspaceSystemPromptText,
} from './system-prompt';
import { migrateLegacyWorkspaceMetaDir } from './meta-dir';

function writeIndex(file: string, entries: unknown[]): void {
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

function readIndex(file: string): Array<{ id: string; relativePath: string; status: string }> {
  return JSON.parse(readFileSync(file, 'utf8')) as Array<{ id: string; relativePath: string; status: string }>;
}

describe('workspace system-prompt storage', () => {
  beforeEach(() => {
    testRoot.dir = mkdtempSync(join(tmpdir(), 'valkade-sys-prompt-'));
  });

  afterEach(() => {
    rmSync(testRoot.dir, { recursive: true, force: true });
  });

  it('seeds the default prompt under .valkade when missing', async () => {
    const ws = join(testRoot.dir, 'project');
    mkdirSync(ws, { recursive: true });
    const result = await ensureWorkspaceSystemPrompt(ws, 'ws-1');
    expect(result.created).toBe(true);
    expect(result.relativePath).toBe(WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH);
    expect(result.relativePath).toBe('.valkade/system-prompt.md');
    expect(existsSync(result.absolutePath)).toBe(true);
    expect(readFileSync(result.absolutePath, 'utf8')).toBe(DEFAULT_WORKSPACE_SYSTEM_PROMPT);
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe(DEFAULT_WORKSPACE_SYSTEM_PROMPT);
  });

  it('does not overwrite an existing workspace prompt file', async () => {
    const ws = join(testRoot.dir, 'project');
    const dest = join(ws, '.valkade', 'system-prompt.md');
    mkdirSync(join(ws, '.valkade'), { recursive: true });
    writeFileSync(dest, 'Keep me.', 'utf8');
    const result = await ensureWorkspaceSystemPrompt(ws, 'ws-1');
    expect(result.created).toBe(false);
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe('Keep me.');
  });

  it('names Valk in the default prompt', () => {
    expect(DEFAULT_WORKSPACE_SYSTEM_PROMPT).toMatch(/^You are Valk, /);
    expect(DEFAULT_WORKSPACE_SYSTEM_PROMPT).not.toContain('Clara');
  });

  it.each([
    ['Clara', 'Clara Coder'],
    ['ValkAde', 'ValkAde'],
    ['Valk', 'ValkAde'],
  ])('upgrades the unedited %s default prompt with CRLF line endings', async (name, ide) => {
    const ws = join(testRoot.dir, 'project');
    const dest = join(ws, '.valkade', 'system-prompt.md');
    mkdirSync(join(ws, '.valkade'), { recursive: true });
    const legacy = `You are ${name}, a senior software engineering agent operating inside the ${ide} IDE.

You work iteratively: read the workspace, plan, make focused edits, run commands, and verify. Prefer small, reviewable changes. Explain trade-offs briefly, then act. Use the provided tools rather than asking the user to do things by hand.

Be direct and concise. When you are unsure about intent, ask a short clarifying question before making changes.
`;
    writeFileSync(dest, legacy.replace(/\n/g, '\r\n'), 'utf8');
    const result = await ensureWorkspaceSystemPrompt(ws, 'ws-1');
    expect(result.created).toBe(false);
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe(DEFAULT_WORKSPACE_SYSTEM_PROMPT);
  });

  it('keeps an edited prompt that still mentions Clara', async () => {
    const ws = join(testRoot.dir, 'project');
    mkdirSync(join(ws, '.valkade'), { recursive: true });
    writeFileSync(join(ws, '.valkade', 'system-prompt.md'), 'You are Clara. Answer in French.', 'utf8');
    await ensureWorkspaceSystemPrompt(ws, 'ws-1');
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe('You are Clara. Answer in French.');
  });

  it('keeps a Clara Coder prompt by moving .clara to .valkade', async () => {
    const ws = join(testRoot.dir, 'project');
    mkdirSync(join(ws, '.clara'), { recursive: true });
    writeFileSync(join(ws, '.clara', 'system-prompt.md'), 'Clara prompt.', 'utf8');
    const result = await ensureWorkspaceSystemPrompt(ws, 'ws-1');
    expect(result.created).toBe(false);
    expect(existsSync(join(ws, '.clara'))).toBe(false);
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe('Clara prompt.');
  });

  it('migrates leftover app-data prompt into .valkade', async () => {
    const ws = join(testRoot.dir, 'project');
    mkdirSync(ws, { recursive: true });
    const legacy = join(testRoot.dir, 'app-data', 'workspaces', 'ws-legacy', 'system-prompt.md');
    mkdirSync(join(legacy, '..'), { recursive: true });
    writeFileSync(legacy, 'Migrated prompt.', 'utf8');

    const result = await ensureWorkspaceSystemPrompt(ws, 'ws-legacy');
    expect(result.created).toBe(true);
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe('Migrated prompt.');
  });

  it('returns empty text when no file exists', async () => {
    const ws = join(testRoot.dir, 'empty');
    mkdirSync(ws, { recursive: true });
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe('');
    await expect(readWorkspaceSystemPromptText('')).resolves.toBe('');
  });
});

describe('legacy .clara / .nemo metadata dir migration', () => {
  beforeEach(() => {
    testRoot.dir = mkdtempSync(join(tmpdir(), 'valkade-meta-dir-'));
  });

  afterEach(() => {
    rmSync(testRoot.dir, { recursive: true, force: true });
  });

  it('renames .clara to .valkade and rewrites build-plan index paths', async () => {
    const ws = testRoot.dir;
    const plans = join(ws, '.clara', 'build-plans');
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, 'plan-abc.md'), '# Plan\n', 'utf8');
    writeFileSync(join(ws, '.clara', 'checks.json'), '{"checks":[]}', 'utf8');
    writeIndex(join(plans, 'index.json'), [
      { id: 'plan-abc', relativePath: '.clara/build-plans/plan-abc.md', status: 'active' },
      { id: 'plan-win', relativePath: '.clara\\build-plans\\plan-win.md', status: 'active' },
    ]);

    await migrateLegacyWorkspaceMetaDir(ws);

    expect(existsSync(join(ws, '.clara'))).toBe(false);
    expect(existsSync(join(ws, '.valkade', 'build-plans', 'plan-abc.md'))).toBe(true);
    expect(readFileSync(join(ws, '.valkade', 'checks.json'), 'utf8')).toBe('{"checks":[]}');
    const index = readIndex(join(ws, '.valkade', 'build-plans', 'index.json'));
    expect(index.map((e) => e.relativePath)).toEqual([
      '.valkade/build-plans/plan-abc.md',
      '.valkade/build-plans/plan-win.md',
    ]);
  });

  it('renames .nemo to .valkade when it is the only legacy dir', async () => {
    const ws = testRoot.dir;
    const plans = join(ws, '.nemo', 'build-plans');
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, 'plan-abc.md'), '# Plan\n', 'utf8');
    writeIndex(join(plans, 'index.json'), [
      { id: 'plan-abc', relativePath: '.nemo/build-plans/plan-abc.md', status: 'active' },
    ]);

    await migrateLegacyWorkspaceMetaDir(ws);

    expect(existsSync(join(ws, '.nemo'))).toBe(false);
    expect(existsSync(join(ws, '.valkade', 'build-plans', 'plan-abc.md'))).toBe(true);
    const index = readIndex(join(ws, '.valkade', 'build-plans', 'index.json'));
    expect(index[0]?.relativePath).toBe('.valkade/build-plans/plan-abc.md');
  });

  it('merges .clara into an existing .valkade and leaves .clara in place', async () => {
    const ws = testRoot.dir;
    mkdirSync(join(ws, '.clara', 'build-plans'), { recursive: true });
    mkdirSync(join(ws, '.valkade', 'build-plans'), { recursive: true });
    writeFileSync(join(ws, '.clara', 'build-plans', 'old.md'), 'legacy', 'utf8');
    writeFileSync(join(ws, '.clara', 'build-plans', 'keep.md'), 'stale copy', 'utf8');
    writeFileSync(join(ws, '.valkade', 'build-plans', 'keep.md'), 'keep', 'utf8');
    writeIndex(join(ws, '.clara', 'build-plans', 'index.json'), [
      { id: 'plan-old', relativePath: '.clara/build-plans/old.md', status: 'active' },
      { id: 'shared', relativePath: '.clara/build-plans/old.md', status: 'legacy' },
    ]);
    writeIndex(join(ws, '.valkade', 'build-plans', 'index.json'), [
      { id: 'plan-new', relativePath: '.valkade/build-plans/keep.md', status: 'active' },
      { id: 'shared', relativePath: '.valkade/build-plans/keep.md', status: 'current' },
    ]);

    await migrateLegacyWorkspaceMetaDir(ws);

    expect(existsSync(join(ws, '.clara', 'build-plans', 'old.md'))).toBe(true);
    expect(existsSync(join(ws, '.valkade', 'build-plans', 'old.md'))).toBe(true);
    expect(readFileSync(join(ws, '.valkade', 'build-plans', 'keep.md'), 'utf8')).toBe('keep');
    const byId = Object.fromEntries(readIndex(join(ws, '.valkade', 'build-plans', 'index.json')).map((e) => [e.id, e]));
    expect(byId['plan-old']?.relativePath).toBe('.valkade/build-plans/old.md');
    expect(byId['plan-new']?.relativePath).toBe('.valkade/build-plans/keep.md');
    expect(byId['shared']?.status).toBe('current');
    expect(byId['shared']?.relativePath).toBe('.valkade/build-plans/keep.md');
  });

  it('renames .clara, then merges a leftover .nemo into it', async () => {
    const ws = testRoot.dir;
    mkdirSync(join(ws, '.clara', 'build-plans'), { recursive: true });
    mkdirSync(join(ws, '.nemo', 'build-plans'), { recursive: true });
    writeFileSync(join(ws, '.clara', 'build-plans', 'keep.md'), 'keep', 'utf8');
    writeFileSync(join(ws, '.nemo', 'build-plans', 'keep.md'), 'older', 'utf8');
    writeFileSync(join(ws, '.nemo', 'build-plans', 'ancient.md'), 'ancient', 'utf8');
    writeIndex(join(ws, '.clara', 'build-plans', 'index.json'), [
      { id: 'shared', relativePath: '.clara/build-plans/keep.md', status: 'clara' },
    ]);
    writeIndex(join(ws, '.nemo', 'build-plans', 'index.json'), [
      { id: 'shared', relativePath: '.nemo/build-plans/keep.md', status: 'nemo' },
      { id: 'plan-ancient', relativePath: '.nemo/build-plans/ancient.md', status: 'active' },
    ]);

    await migrateLegacyWorkspaceMetaDir(ws);

    expect(existsSync(join(ws, '.clara'))).toBe(false);
    expect(existsSync(join(ws, '.nemo'))).toBe(true);
    expect(readFileSync(join(ws, '.valkade', 'build-plans', 'keep.md'), 'utf8')).toBe('keep');
    expect(readFileSync(join(ws, '.valkade', 'build-plans', 'ancient.md'), 'utf8')).toBe('ancient');
    const byId = Object.fromEntries(readIndex(join(ws, '.valkade', 'build-plans', 'index.json')).map((e) => [e.id, e]));
    expect(byId['shared']).toMatchObject({ status: 'clara', relativePath: '.valkade/build-plans/keep.md' });
    expect(byId['plan-ancient']?.relativePath).toBe('.valkade/build-plans/ancient.md');
  });

  it('copies system-prompt.md from .clara when .valkade already exists without it', async () => {
    const ws = join(testRoot.dir, 'project');
    mkdirSync(join(ws, '.clara'), { recursive: true });
    mkdirSync(join(ws, '.valkade'), { recursive: true });
    writeFileSync(join(ws, '.clara', 'system-prompt.md'), 'Legacy workspace prompt.', 'utf8');

    const result = await ensureWorkspaceSystemPrompt(ws, 'ws-1');
    expect(readFileSync(result.absolutePath, 'utf8')).toBe('Legacy workspace prompt.');
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe('Legacy workspace prompt.');
  });

  it('copies system-prompt.md from .nemo when .valkade already exists without it', async () => {
    const ws = join(testRoot.dir, 'project');
    mkdirSync(join(ws, '.nemo'), { recursive: true });
    mkdirSync(join(ws, '.valkade'), { recursive: true });
    writeFileSync(join(ws, '.nemo', 'system-prompt.md'), 'Nemo workspace prompt.', 'utf8');

    const result = await ensureWorkspaceSystemPrompt(ws, 'ws-1');
    expect(readFileSync(result.absolutePath, 'utf8')).toBe('Nemo workspace prompt.');
  });
});
