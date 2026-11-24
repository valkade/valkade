import { promises as fs } from 'fs';
import path = require('path');
import {
  LEGACY_WORKSPACE_META_DIR,
  WORKSPACE_SYSTEM_PROMPT_FILE,
  WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
} from '../../shared';
import { getLegacyAppDataSystemPromptPath, getWorkspaceSystemPromptPath } from '../paths';
import { migrateLegacyWorkspaceMetaDir } from './meta-dir';

const LEGACY_WORKSPACE_SYSTEM_PROMPT_BODY = `You work iteratively: read the workspace, plan, make focused edits, run commands, and verify. Prefer small, reviewable changes. Explain trade-offs briefly, then act. Use the provided tools rather than asking the user to do things by hand.

Be direct and concise. When you are unsure about intent, ask a short clarifying question before making changes.
`;

/** Default system prompt written into every workspace so the prompt file always exists. */
export const DEFAULT_WORKSPACE_SYSTEM_PROMPT = `You are Valk, a software engineering agent in ValkAde.

Read relevant code before editing, make minimal changes that match the codebase, and verify with diagnostics or tests before finishing. Act directly on clear requests; ask a concise question only when ambiguity would materially change the result. Be direct and concise.
`;

/** Earlier defaults. A workspace prompt still identical to one of these was never edited, so it is upgraded. */
const LEGACY_DEFAULT_WORKSPACE_SYSTEM_PROMPTS = [
  `You are Valk, a senior software engineering agent operating inside the ValkAde IDE.

${LEGACY_WORKSPACE_SYSTEM_PROMPT_BODY}`,
  `You are ValkAde, a senior software engineering agent operating inside the ValkAde IDE.

${LEGACY_WORKSPACE_SYSTEM_PROMPT_BODY}`,
  `You are Clara, a senior software engineering agent operating inside the Clara Coder IDE.

${LEGACY_WORKSPACE_SYSTEM_PROMPT_BODY}`,
];

function isLegacyDefaultPrompt(text: string): boolean {
  const normalized = text.replace(/\r\n/g, '\n');
  return LEGACY_DEFAULT_WORKSPACE_SYSTEM_PROMPTS.includes(normalized);
}

/** The prompt to keep for `text`: the current default when `text` is an unedited earlier default. */
function upgradeLegacyDefaultPrompt(text: string): string {
  return isLegacyDefaultPrompt(text) ? DEFAULT_WORKSPACE_SYSTEM_PROMPT : text;
}

export interface EnsuredWorkspaceSystemPromptFile {
  absolutePath: string;
  relativePath: string;
  created: boolean;
}

export async function readWorkspaceSystemPromptText(workspaceRoot: string): Promise<string> {
  const root = (workspaceRoot || '').trim();
  if (!root) {
    return '';
  }
  const filePath = getWorkspaceSystemPromptPath(root);
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

/**
 * Ensure `{workspace}/.valkade/system-prompt.md` exists.
 * Seeds from leftover `.nemo/system-prompt.md`, then app-data, then the default.
 */
export async function ensureWorkspaceSystemPrompt(
  workspaceRoot: string,
  workspaceId?: string,
): Promise<EnsuredWorkspaceSystemPromptFile> {
  const root = (workspaceRoot || '').trim();
  if (!root) {
    throw new Error('Workspace path is required.');
  }
  await migrateLegacyWorkspaceMetaDir(root);
  const dest = getWorkspaceSystemPromptPath(root);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    const existing = await fs.readFile(dest, 'utf8');
    if (isLegacyDefaultPrompt(existing)) {
      await fs.writeFile(dest, DEFAULT_WORKSPACE_SYSTEM_PROMPT, 'utf8');
    }
    return {
      absolutePath: dest,
      relativePath: WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
      created: false,
    };
  } catch {
    /* missing — seed below */
  }

  const legacyDest = path.join(root, LEGACY_WORKSPACE_META_DIR, WORKSPACE_SYSTEM_PROMPT_FILE);
  try {
    const legacyText = await fs.readFile(legacyDest, 'utf8');
    await fs.writeFile(dest, upgradeLegacyDefaultPrompt(legacyText), 'utf8');
    return {
      absolutePath: dest,
      relativePath: WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
      created: true,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  const wid = (workspaceId || '').trim();
  if (wid) {
    try {
      const legacyText = await fs.readFile(getLegacyAppDataSystemPromptPath(wid), 'utf8');
      await fs.writeFile(dest, upgradeLegacyDefaultPrompt(legacyText), 'utf8');
      return {
        absolutePath: dest,
        relativePath: WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
        created: true,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        throw err;
      }
    }
  }

  await fs.writeFile(dest, DEFAULT_WORKSPACE_SYSTEM_PROMPT, 'utf8');
  return {
    absolutePath: dest,
    relativePath: WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
    created: true,
  };
}
