/** Workspace-local ValkAde metadata directory (hidden from the file tree). */
export const WORKSPACE_META_DIR = '.valkade';

/**
 * Pre-rename metadata directories, newest first. Each is merged into {@link WORKSPACE_META_DIR}
 * when safe (`.clara` from Clara Coder, `.nemo` from before that).
 */
export const LEGACY_WORKSPACE_META_DIRS = ['.clara', '.nemo'] as const;

/** Most recent pre-rename metadata directory (`.clara`). */
export const LEGACY_WORKSPACE_META_DIR = LEGACY_WORKSPACE_META_DIRS[0];

export const WORKSPACE_SYSTEM_PROMPT_FILE = 'system-prompt.md';

export const WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH = `${WORKSPACE_META_DIR}/${WORKSPACE_SYSTEM_PROMPT_FILE}`;

/** The user's project check commands, run when an editing turn ends (trusted workspaces only). */
export const WORKSPACE_CHECKS_FILE = 'checks.json';

export const WORKSPACE_CHECKS_RELATIVE_PATH = `${WORKSPACE_META_DIR}/${WORKSPACE_CHECKS_FILE}`;

export const WORKSPACE_BUILD_PLANS_DIR = 'build-plans';

export const WORKSPACE_BUILD_PLANS_REL_DIR = `${WORKSPACE_META_DIR}/${WORKSPACE_BUILD_PLANS_DIR}`;

export function isWorkspaceSystemPromptRelativePath(relativePath: string): boolean {
  let n = (relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  while (n.startsWith('./')) {
    n = n.slice(2);
  }
  return n === WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH;
}
