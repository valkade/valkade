import {
  classifyShellCommand,
  isReadToolPreviewStreamTag,
  isRunCommandStreamTag,
  isShellStyleToolStreamTag,
  isWorkspaceReadToolLabel,
  readToolStatusHeadline,
  toolTargetFromRunningDetail,
  type ShellCommandIntent,
  type StreamPart,
} from '@shared/index';

/**
 * Which tool spinner a running tool shows: `read` (scanner), `run` (arc round a play mark),
 * `web` (hub and nodes) or `write` (lines being written — every other tool).
 */
export type ToolSpinnerKind = 'read' | 'write' | 'run' | 'web';

/** Spinner a live pill can host: a tool kind, or `think` for the compact thinking pill. */
export type PillSpinnerKind = ToolSpinnerKind | 'think';

/**
 * Prompt-prefill spinners: `prefill` (a drop absorbed into a pool) plus the alternates a turn can
 * pick while it reads the prompt — a sheet unfolding, a cipher dial, two waves falling into phase.
 */
export type PrefillSpinnerKind = 'prefill' | 'prefill-unfold' | 'prefill-decipher' | 'prefill-attune';

/** Every spinner {@link ToolSpinnerComponent} draws: pill kinds plus the prefill set. */
export type SpinnerKind = PillSpinnerKind | PrefillSpinnerKind;

/** Shell command execution tools whose command text can be inspected for read/edit intent. */
const SHELL_COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'run_command',
  'Bash',
  'bash',
  'PowerShell',
  'powershell',
  'pwsh',
  'shell',
]);

/** Shell / background-command tools (terminal spinner). */
const RUN_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'run_command',
  'wait_for_command',
  'list_background_commands',
  'kill_background_command',
  'Bash',
  'PowerShell',
  'TaskOutput',
  'TaskStop',
]);

/** Read-only built-in tools outside `WORKSPACE_READ_TOOL_NAMES` (e.g. Claude Code CLI). */
const EXTRA_READ_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'Read',
  'Glob',
  'Grep',
  'ToolSearch',
  'LSP',
  'read_structured_section',
  'structured_overview',
  'search_structured',
]);

/** Network tools (globe spinner). */
const WEB_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'web_search',
  'fetch_url',
  'screenshot_webpage',
  'WebSearch',
  'WebFetch',
]);

/**
 * One glyph per agent tool: drawn still it is the tool's icon, animated it is that tool's spinner.
 * Names never collide with {@link SpinnerKind}, so {@link ToolSpinnerComponent} takes either.
 */
export const TOOL_GLYPH_IDS = [
  'read-file',
  'image',
  'list',
  'search',
  'semantic',
  'outline',
  'tree-search',
  'section',
  'xml',
  'json',
  'wsdl',
  'context',
  'diagnostics',
  'hover',
  'definition',
  'references',
  'symbols',
  'write-file',
  'edit-lines',
  'edit-snippet',
  'format',
  'copy',
  'delete',
  'java',
  'web-search',
  'fetch',
  'screenshot',
  'command',
  'wait',
  'stop-command',
  'commands',
  'terminals',
  'plan',
  'plan-check',
  'spawn',
  'agents',
  'stop-agent',
  'theme',
  'plug',
] as const;

export type ToolGlyph = (typeof TOOL_GLYPH_IDS)[number];

/** Spinner a live pill can host: a tool's glyph, or `think` for the compact thinking pill. */
export type PillGlyph = ToolGlyph | 'think';

const TOOL_GLYPHS: Readonly<Record<string, ToolGlyph>> = {
  read_workspace_file: 'read-file',
  read_staged_edit: 'read-file',
  read_workspace_image: 'image',
  list_workspace_directory: 'list',
  search_workspace: 'search',
  retrieve_workspace_semantic: 'semantic',
  structured_overview: 'outline',
  search_structured: 'tree-search',
  read_structured_section: 'section',
  activate_context: 'context',
  compact_context: 'context',
  verify_turn: 'diagnostics',
  lsp_get_diagnostics: 'diagnostics',
  lsp_hover: 'hover',
  lsp_find_definition: 'definition',
  lsp_find_references: 'references',
  lsp_get_document_symbols: 'symbols',
  lsp_find_implementations: 'definition',
  lsp_call_hierarchy: 'references',
  lsp_type_hierarchy: 'references',
  lsp_workspace_symbols: 'symbols',
  write_workspace_file: 'write-file',
  apply_workspace_full_file: 'write-file',
  stage_create_file: 'write-file',
  stage_workspace_file_overwrite: 'write-file',
  transfer_staged_file_to_workspace: 'write-file',
  replace_workspace_lines: 'edit-lines',
  replace_workspace_line_range: 'edit-lines',
  stage_line_range_edit: 'edit-lines',
  replace_workspace_snippet: 'edit-snippet',
  stage_snippet_edit: 'edit-snippet',
  format_workspace_file: 'format',
  lsp_rename_symbol: 'edit-snippet',
  copy_workspace_files: 'copy',
  delete_workspace_entry: 'delete',
  delete_workspace_entries: 'delete',
  batch_delete_workspace_entries: 'delete',
  discard_staged_edits: 'delete',
  java_bootstrap_project: 'java',
  web_search: 'web-search',
  fetch_url: 'fetch',
  screenshot_webpage: 'screenshot',
  run_command: 'command',
  wait_for_command: 'wait',
  kill_background_command: 'stop-command',
  list_background_commands: 'commands',
  check_user_terminals: 'terminals',
  read_build_plan: 'plan',
  mark_build_plan_steps_complete: 'plan-check',
  spawn_subagent: 'spawn',
  wait_for_subagents: 'agents',
  stop_subagent: 'stop-agent',
  propose_theme: 'theme',
  // Claude Code CLI built-in tools
  Read: 'read-file',
  Glob: 'list',
  Grep: 'search',
  ToolSearch: 'search',
  Write: 'write-file',
  Edit: 'edit-snippet',
  MultiEdit: 'edit-snippet',
  NotebookEdit: 'edit-snippet',
  Bash: 'command',
  PowerShell: 'command',
  TaskOutput: 'wait',
  TaskStop: 'stop-command',
  WebSearch: 'web-search',
  WebFetch: 'fetch',
  LSP: 'symbols',
  Agent: 'spawn',
  TodoWrite: 'plan',
  TaskCreate: 'plan',
  TaskUpdate: 'plan-check',
  TaskList: 'plan',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan-check',
};

/** Tool families matched by name prefix (`xml_overview`, `json_get_path`, …). */
const TOOL_GLYPH_PREFIXES: readonly (readonly [string, ToolGlyph])[] = [
  ['xml_', 'xml'],
  ['json_', 'json'],
  ['wsdl_', 'wsdl'],
];

/** `lsp_update_typescript_file` / `lsp_create_java_file`: language-routed full-file writes. */
const LSP_WRITE_TOOL = /^lsp_(?:update|create)_[a-z]+_file$/;

const SHELL_INTENT_GLYPH: Readonly<Record<ShellCommandIntent, ToolGlyph>> = {
  edit: 'edit-snippet',
  write: 'write-file',
  copy: 'copy',
  delete: 'delete',
  read: 'read-file',
  search: 'search',
  list: 'list',
  run: 'command',
};

const SHELL_INTENT_SPINNER_KIND: Readonly<Record<ShellCommandIntent, ToolSpinnerKind>> = {
  edit: 'write',
  write: 'write',
  copy: 'write',
  delete: 'write',
  read: 'read',
  search: 'read',
  list: 'read',
  run: 'run',
};

/** `mcp__valkade__run_command` → `run_command`; other MCP tools keep their prefix. */
function canonicalToolName(label: string): string {
  const n = label.trim();
  return n.startsWith('mcp__valkade__') ? n.slice('mcp__valkade__'.length) : n;
}

/** True when a tool call or output lane executes a shell/PowerShell command. */
function isShellCommandInvocation(name: string, streamTag: string): boolean {
  return SHELL_COMMAND_TOOL_NAMES.has(name) || isRunCommandStreamTag(streamTag);
}

/** Minimal `StreamPart` fields needed to resolve a tool's glyph or spinner kind. */
export type ToolSpinnerPart = Pick<StreamPart, 'label' | 'streamTag'> &
  Partial<Pick<StreamPart, 'toolTarget' | 'text' | 'toolChainState'>>;

/**
 * Extract the command string carried by a shell tool row (`run_command`, `Bash`, or a
 * `run-command:*` output lane), or `''` for non-shell rows.
 */
export function streamPartCommandText(part: ToolSpinnerPart): string {
  const name = canonicalToolName(part.label);
  if (isRunCommandStreamTag(part.streamTag)) {
    return (part.toolTarget ?? '').trim() || part.label.trim();
  }
  if (!SHELL_COMMAND_TOOL_NAMES.has(name)) {
    return '';
  }
  const target = (part.toolTarget ?? '').trim();
  if (target) {
    return target;
  }
  const text = (part.text ?? '').trim();
  if (!text) {
    return '';
  }
  if (part.toolChainState === 'running') {
    return toolTargetFromRunningDetail(readToolStatusHeadline(text));
  }
  const reported = /Command: `([^`]+?)(?:`|…?$)/.exec(text);
  if (reported) {
    return reported[1]!.trim();
  }
  // Claude CLI `Bash` / `PowerShell` rows put the command summary directly as `detail` on completion.
  if (
    (name === 'Bash' || name === 'PowerShell') &&
    !/^Tool error:/i.test(text) &&
    !/^User (?:cancelled|declined|dismissed)\b/i.test(text)
  ) {
    return readToolStatusHeadline(text);
  }
  return '';
}

/** The glyph for one tool row; unknown and MCP tools get the plug. */
export function toolGlyph(label: string, streamTag: string, command?: string): ToolGlyph {
  const name = canonicalToolName(label);
  if (isShellCommandInvocation(name, streamTag)) {
    const cmd = (command ?? (isRunCommandStreamTag(streamTag) ? label : '')).trim();
    return cmd ? SHELL_INTENT_GLYPH[classifyShellCommand(cmd)] : 'command';
  }
  const named = TOOL_GLYPHS[name];
  if (named) {
    return named;
  }
  if (LSP_WRITE_TOOL.test(name)) {
    return 'write-file';
  }
  for (const [prefix, glyph] of TOOL_GLYPH_PREFIXES) {
    if (name.startsWith(prefix)) {
      return glyph;
    }
  }
  if (isReadToolPreviewStreamTag(streamTag)) {
    return 'read-file';
  }
  if (isShellStyleToolStreamTag(streamTag)) {
    return 'command';
  }
  return 'plug';
}

export function toolSpinnerKind(label: string, streamTag: string, command?: string): ToolSpinnerKind {
  const name = canonicalToolName(label);
  if (isShellCommandInvocation(name, streamTag)) {
    const cmd = (command ?? (isRunCommandStreamTag(streamTag) ? label : '')).trim();
    return cmd ? SHELL_INTENT_SPINNER_KIND[classifyShellCommand(cmd)] : 'run';
  }
  if (isWorkspaceReadToolLabel(name) || EXTRA_READ_TOOL_NAMES.has(name) || isReadToolPreviewStreamTag(streamTag)) {
    return 'read';
  }
  if (WEB_TOOL_NAMES.has(name)) {
    return 'web';
  }
  if (RUN_TOOL_NAMES.has(name) || isShellStyleToolStreamTag(streamTag)) {
    return 'run';
  }
  return 'write';
}

/** Resolve the glyph for a `StreamPart`, inspecting command text for shell reads and edits. */
export function streamPartToolGlyph(part: ToolSpinnerPart): ToolGlyph {
  return toolGlyph(part.label, part.streamTag, streamPartCommandText(part));
}

/** Resolve the spinner kind for a `StreamPart`, inspecting command text for shell reads and edits. */
export function streamPartToolSpinnerKind(part: ToolSpinnerPart): ToolSpinnerKind {
  return toolSpinnerKind(part.label, part.streamTag, streamPartCommandText(part));
}
