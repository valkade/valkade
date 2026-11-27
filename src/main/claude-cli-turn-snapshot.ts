/**
 * Workspace pre/post-turn snapshotter for Claude Code CLI turns.
 *
 * Claude Code writes directly to disk instead of calling ValkAde's Python edit tools.
 * This module captures pre-turn file state and writes standard `conversation_file_journal`
 * rows when a turn completes, so ValkAde's existing `finalizeTurnEdits()`, Turn Review diff
 * viewer, and one-click Reset Turn Files work natively with Claude Code turns.
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path = require('path');
import { appendConversationFileJournal } from './conversations-db';
import { decodeWorkspaceFileContent } from './utils/workspace-file-encoding';
import { resolveSafeWorkspacePath } from './utils/workspace-safe-path';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'release',
  'target',
  '.angular',
  '.next',
  '.cache',
  'out',
  '.pytest_cache',
  '.valkade',
  '.clara',
  '.nemo',
]);

const MAX_WALK_FILES = 15_000;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;

interface StatEntry {
  mtimeMs: number;
  size: number;
}

interface CapturedBefore {
  existed: boolean;
  content: string | null;
  newline: 'lf' | 'crlf';
}

export interface ClaudeCliTurnSnapshot {
  workspaceRoot: string;
  isGitRepo: boolean;
  preStats: Map<string, StatEntry>;
  /** Exact pre-turn contents for files that were dirty before the turn or captured pre-tool. */
  beforeContentByPath: Map<string, CapturedBefore>;
  /** Capture a file's pre-edit content right before a Claude Code tool mutates it. */
  captureBeforeToolEdit(toolName: string, input: unknown): Promise<void>;
}

function toPosixRel(workspaceRoot: string, rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(workspaceRoot, trimmed);
  const rel = path.relative(workspaceRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return rel.replace(/\\/g, '/');
}

async function readTextIfSafe(absPath: string): Promise<CapturedBefore> {
  try {
    const st = await fs.stat(absPath);
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) {
      return { existed: true, content: null, newline: 'lf' };
    }
    const buf = await fs.readFile(absPath);
    if (buf.includes(0)) {
      return { existed: true, content: null, newline: 'lf' };
    }
    const rawUtf8 = buf.toString('utf8');
    const newline: 'lf' | 'crlf' = rawUtf8.includes('\r\n') ? 'crlf' : 'lf';
    return { existed: true, content: decodeWorkspaceFileContent(buf, 'utf-8'), newline };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { existed: false, content: null, newline: 'lf' };
    }
    return { existed: true, content: null, newline: 'lf' };
  }
}

async function walkStats(root: string): Promise<Map<string, StatEntry>> {
  const out = new Map<string, StatEntry>();
  const queue: string[] = [root];

  while (queue.length > 0 && out.size < MAX_WALK_FILES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.size >= MAX_WALK_FILES) {
        break;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          queue.push(abs);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const st = await fs.stat(abs);
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        out.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // File vanished during walk.
      }
    }
  }
  return out;
}

function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_SNAPSHOT_BYTES + 65536 },
      (err, stdout) => {
        resolve({ ok: !err, stdout: String(stdout ?? '') });
      },
    );
  });
}

function extractTargetPathsFromToolInput(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [];
  }
  const rec = input as Record<string, unknown>;
  const name = toolName.toLowerCase();
  const paths: string[] = [];
  if (name === 'edit' || name === 'write' || name === 'multiedit') {
    if (typeof rec['file_path'] === 'string') {
      paths.push(rec['file_path']);
    }
    if (typeof rec['path'] === 'string') {
      paths.push(rec['path']);
    }
  } else if (name === 'notebookedit') {
    if (typeof rec['notebook_path'] === 'string') {
      paths.push(rec['notebook_path']);
    }
  }
  return paths;
}

/**
 * Snapshot workspace stat metadata (and already-dirty git files) before a Claude Code turn starts.
 */
export async function captureWorkspacePreTurnSnapshot(workspaceRoot: string): Promise<ClaudeCliTurnSnapshot> {
  const root = path.resolve(workspaceRoot);
  const [preStats, gitCheck] = await Promise.all([
    walkStats(root),
    runGit(root, ['rev-parse', '--is-inside-work-tree']),
  ]);
  const isGitRepo = gitCheck.ok && gitCheck.stdout.trim() === 'true';
  const beforeContentByPath = new Map<string, CapturedBefore>();

  if (isGitRepo) {
    // Pre-read already-dirty files so git HEAD isn't mistakenly used as the pre-turn baseline.
    const [prefixRes, status] = await Promise.all([
      runGit(root, ['rev-parse', '--show-prefix']),
      runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '--', '.']),
    ]);
    const repoPrefix = prefixRes.ok ? prefixRes.stdout.trim().replace(/\\/g, '/') : '';
    if (status.ok && status.stdout) {
      const lines = status.stdout.split(/\r?\n/).filter((l) => l.length >= 4);
      for (const line of lines.slice(0, 200)) {
        const rawPath = line.slice(3).trim();
        const rel = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop()!.trim() : rawPath;
        let clean = rel.replace(/^"|"$/g, '').replace(/\\/g, '/');
        if (repoPrefix && clean.startsWith(repoPrefix)) {
          clean = clean.slice(repoPrefix.length);
        }
        if (!clean || beforeContentByPath.has(clean)) {
          continue;
        }
        try {
          const abs = resolveSafeWorkspacePath(root, clean);
          beforeContentByPath.set(clean, await readTextIfSafe(abs));
        } catch {
          // Skip paths outside root.
        }
      }
    }
  }

  return {
    workspaceRoot: root,
    isGitRepo,
    preStats,
    beforeContentByPath,
    async captureBeforeToolEdit(toolName: string, input: unknown): Promise<void> {
      const targets = extractTargetPathsFromToolInput(toolName, input);
      for (const raw of targets) {
        const rel = toPosixRel(root, raw);
        if (!rel || beforeContentByPath.has(rel)) {
          continue;
        }
        try {
          const abs = resolveSafeWorkspacePath(root, rel);
          beforeContentByPath.set(rel, await readTextIfSafe(abs));
        } catch {
          // Ignore unsafe paths.
        }
      }
    },
  };
}

async function resolveBeforeContent(snapshot: ClaudeCliTurnSnapshot, relPath: string): Promise<CapturedBefore> {
  const cached = snapshot.beforeContentByPath.get(relPath);
  if (cached) {
    return cached;
  }
  if (!snapshot.preStats.has(relPath)) {
    return { existed: false, content: null, newline: 'lf' };
  }
  if (snapshot.isGitRepo) {
    const head = await runGit(snapshot.workspaceRoot, ['show', `HEAD:./${relPath}`]);
    if (head.ok && !head.stdout.includes('\0')) {
      const newline: 'lf' | 'crlf' = head.stdout.includes('\r\n') ? 'crlf' : 'lf';
      return { existed: true, content: head.stdout.replace(/\r\n/g, '\n'), newline };
    }
  }
  return { existed: true, content: null, newline: 'lf' };
}

/**
 * Diff post-turn disk state against `snapshot` and append `conversation_file_journal` entries
 * so `finalizeTurnEdits` builds accurate Turn Review diffs & reset actions.
 */
export async function recordClaudeCliTurnDiffsToJournal(
  snapshot: ClaudeCliTurnSnapshot,
  conversationId: string,
  userMessageId: string,
): Promise<number> {
  if (!conversationId.trim() || !userMessageId.trim()) {
    return 0;
  }
  const postStats = await walkStats(snapshot.workspaceRoot);
  const changedPaths: { rel: string; op: 'create' | 'modify' | 'delete' }[] = [];

  for (const [rel, post] of postStats.entries()) {
    const pre = snapshot.preStats.get(rel);
    if (!pre) {
      changedPaths.push({ rel, op: 'create' });
    } else if (pre.size !== post.size || Math.abs(pre.mtimeMs - post.mtimeMs) > 0.5) {
      changedPaths.push({ rel, op: 'modify' });
    }
  }

  for (const rel of snapshot.preStats.keys()) {
    if (!postStats.has(rel)) {
      changedPaths.push({ rel, op: 'delete' });
    }
  }

  let written = 0;
  for (const { rel, op } of changedPaths) {
    const before = await resolveBeforeContent(snapshot, rel);
    try {
      appendConversationFileJournal({
        conversationId,
        userMessageId,
        relativePath: rel,
        op,
        beforeContent: op === 'create' ? null : before.content,
        beforeEncoding: 'utf-8',
        beforeNewline: before.newline,
      });
      written += 1;
    } catch (err) {
      console.warn('[claude-cli] Failed to append file journal row for', rel, err);
    }
  }
  return written;
}
