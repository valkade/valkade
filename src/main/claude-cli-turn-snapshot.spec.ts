import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureWorkspacePreTurnSnapshot,
  recordClaudeCliTurnDiffsToJournal,
} from './claude-cli-turn-snapshot';
import { closeConversationsDbForTests, openConversationsDbForTests } from './conversations-db';
import { finalizeTurnEdits, getTurnFileDiff } from './turn-edits';

describe('claude-cli-turn-snapshot', () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(tmpdir(), 'valkade-cc-snap-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    openConversationsDbForTests(path.join(tmpDir, 'conversations.sqlite'));
  });

  afterEach(async () => {
    closeConversationsDbForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('records created, edited, and deleted files into conversation_file_journal for Turn Review', async () => {
    const editPath = path.join(workspaceDir, 'app.ts');
    const delPath = path.join(workspaceDir, 'old.ts');
    await fs.writeFile(editPath, 'const a = 1;\n', 'utf-8');
    await fs.writeFile(delPath, 'export const gone = true;\n', 'utf-8');

    const snapshot = await captureWorkspacePreTurnSnapshot(workspaceDir);

    // Simulate Claude Code editing, creating, and deleting files on disk.
    await snapshot.captureBeforeToolEdit('Edit', { file_path: editPath });
    await fs.writeFile(editPath, 'const a = 1;\nconst b = 2;\n', 'utf-8');
    await fs.writeFile(path.join(workspaceDir, 'new.ts'), 'export const fresh = 1;\n', 'utf-8');
    await snapshot.captureBeforeToolEdit('Edit', { file_path: delPath });
    await fs.rm(delPath);

    const written = await recordClaudeCliTurnDiffsToJournal(snapshot, 'conv-snap', 'turn-1');
    expect(written).toBe(3);

    const summary = await finalizeTurnEdits('conv-snap', 'turn-1', workspaceDir);
    const byPath = new Map(summary.map((s) => [s.relativePath, s]));
    expect(byPath.get('app.ts')?.op).toBe('modify');
    expect(byPath.get('app.ts')?.additions).toBe(1);
    expect(byPath.get('new.ts')?.op).toBe('create');
    expect(byPath.get('old.ts')?.op).toBe('delete');

    const diff = getTurnFileDiff('conv-snap', 'turn-1', 'app.ts');
    expect(diff.ok).toBe(true);
    if (diff.ok) {
      expect(diff.before).toBe('const a = 1;\n');
      expect(diff.after).toBe('const a = 1;\nconst b = 2;\n');
    }
  });
});
