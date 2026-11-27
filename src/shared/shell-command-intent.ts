/**
 * High-level file-operation intent inferred from a shell command string (PowerShell, Bash, CMD,
 * or inline Python/Node one-liners). Used to pick read/search/list/edit/write/delete/copy process
 * spinners when an LLM uses a shell command instead of dedicated file tools.
 */
export type ShellCommandIntent =
  | 'edit'
  | 'write'
  | 'copy'
  | 'delete'
  | 'read'
  | 'search'
  | 'list'
  | 'run';

/** Priority for combining mutation intents when a command performs multiple file writes. */
const MUTATION_RANK: Readonly<Record<'edit' | 'write' | 'delete' | 'copy', number>> = {
  edit: 4,
  write: 3,
  delete: 2,
  copy: 1,
};

/** Wrapper shells whose quoted payload holds the actual command (`pwsh -Command "..."`, `bash -lc "..."`). */
const SHELL_WRAPPER_RE =
  /^(?:&\s*)?(?:(?:[\w.:\\/-]+[\\/])?(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?)\s+(?:(?:-\w+(?:\s+(?!-)(?!\/)[\w.-]+)?|\/\w)\s+)*(?:-(?:[a-z]*c|command)|\/c)\s+([\s\S]+)$/i;

/** Leading call operator or privilege wrapper (`& `, `sudo `, `command `). */
const LEADING_PREFIX_RE = /^(?:(?:&\s*)|(?:(?:sudo|command|env(?:\s+[A-Za-z_]\w*=[^\s]+)*)\s+))+/i;

/** Pure directory/environment setup statements that should not mask a read/edit statement. */
const SETUP_CMD_RE =
  /^(?:cd|chdir|set-location|sl|push-location|pushd|pop-location|popd|export|set|chcp|cls|clear|clear-host)(?:\s|$)/i;

/** Variable assignment without file I/O (`$path = 'src/a.ts'`, `$c[2] = 'x'`, `$c += 'line'`). */
const PS_SIMPLE_ASSIGN_RE = /^\$[A-Za-z_][\w:]*(?:\[[^\]]*\]|\.[A-Za-z_]\w*)*\s*[+\-*/]?=/;

/** PowerShell here-string start (`@'` or `@"`), optionally assigned to a variable. */
const PS_HERE_STRING_START_RE = /^(?:\$[A-Za-z_][\w:]*\s*=\s*)?@['"]/;

/** PowerShell / POSIX text replacement operators indicating in-place edit intent. */
const REPLACE_OP_RE = /(?:^|\s)-[ci]?replace\b|\.replace\s*\(|\[(?:system\.text\.regularexpressions\.)?regex\]::replace\s*\(|\bre\.sub\s*\(/i;

/** .NET file mutation APIs commonly invoked from PowerShell. */
const DOTNET_WRITE_RE =
  /\[(?:system\.)?io\.file\]::(?:writealltext|writealllines|writeallbytes|appendalltext|appendalllines|create|createtext|openwrite)\s*\(|(?:new-object|\[(?:system\.)?io\.(?:streamwriter|fileinfo)\]|::new)\b[\s\S]*streamwriter/i;

const DOTNET_READ_RE =
  /\[(?:system\.)?io\.file\]::(?:readalltext|readalllines|readallbytes|readlines|opentext|openread)\s*\(|streamreader/i;

const DOTNET_DELETE_RE = /\[(?:system\.)?io\.(?:file|directory)\]::delete\s*\(/i;
const DOTNET_COPY_RE = /\[(?:system\.)?io\.file\]::copy\s*\(/i;
const DOTNET_MOVE_RE = /\[(?:system\.)?io\.(?:file|directory)\]::move\s*\(/i;

/** Python inline command (`python -c "..."` / `py -3 -c '...'`). */
const PYTHON_INLINE_RE = /^(?:(?:[\w.:\\/-]+[\\/])?(?:python3?|py)(?:\.exe)?)\s+(?:(?:-[\w.]+)\s+)*-c\s+([\s\S]+)$/i;
/** Node inline command (`node -e "..."` / `node --eval '...'`). */
const NODE_INLINE_RE = /^(?:(?:[\w.:\\/-]+[\\/])?node(?:\.exe)?)\s+(?:(?:--?[\w=-]+)\s+)*(?:-e|--eval)\s+([\s\S]+)$/i;

/**
 * Strip balanced outer single/double quotes when the whole string is wrapped in them
 * (e.g. the command payload passed to `pwsh -Command "..."`).
 */
function stripOuterQuotes(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    const q = s[0]!;
    // Ensure the opening quote is not closed earlier (except escaped quotes).
    let escaped = false;
    for (let i = 1; i < s.length - 1; i++) {
      const ch = s[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (q === '"' && (ch === '\\' || ch === '`')) {
        escaped = true;
        continue;
      }
      if (ch === q) {
        return s;
      }
    }
    return s.slice(1, -1).trim();
  }
  return s;
}

/** Unwrap up to two nested shell invocations (`pwsh -NoProfile -Command "..."`). */
function unwrapShellCommand(command: string): string {
  let cur = command.trim();
  for (let depth = 0; depth < 2; depth++) {
    const match = SHELL_WRAPPER_RE.exec(cur);
    if (!match) {
      break;
    }
    const inner = stripOuterQuotes(match[1]!);
    if (!inner || inner === cur) {
      break;
    }
    cur = inner;
  }
  return cur;
}

/**
 * Replace single/double quoted string contents with spaces while preserving quote boundaries,
 * so operator / separator scanning (`;`, `|`, `>`) never triggers inside string literals.
 */
function maskQuotedStrings(text: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (escaped) {
        escaped = false;
        out += ' ';
        continue;
      }
      if (quote === '"' && (ch === '\\' || ch === '`')) {
        escaped = true;
        out += ' ';
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += ch;
        continue;
      }
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Split a command on top-level statement separators (`;`, `&&`, `||`, `\n`) outside quotes. */
function splitStatements(command: string): string[] {
  const masked = maskQuotedStrings(command);
  const out: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === '(') {
      parenDepth += 1;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (parenDepth > 0 || braceDepth > 0) {
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '\r') {
      const part = command.slice(start, i).trim();
      if (part) {
        out.push(part);
      }
      start = i + 1;
      continue;
    }
    if ((ch === '&' && masked[i + 1] === '&') || (ch === '|' && masked[i + 1] === '|')) {
      const part = command.slice(start, i).trim();
      if (part) {
        out.push(part);
      }
      i += 1;
      start = i + 1;
    }
  }
  const tail = command.slice(start).trim();
  if (tail) {
    out.push(tail);
  }
  return out;
}

/** Split one statement into pipeline stages on top-level `|` (not `||`) outside quotes. */
function splitPipeline(statement: string): string[] {
  const masked = maskQuotedStrings(statement);
  const out: string[] = [];
  let start = 0;
  let braceDepth = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === '{') {
      braceDepth += 1;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth > 0) {
      continue;
    }
    if (ch === '|' && masked[i - 1] !== '|' && masked[i + 1] !== '|') {
      const part = statement.slice(start, i).trim();
      if (part) {
        out.push(part);
      }
      start = i + 1;
    }
  }
  const tail = statement.slice(start).trim();
  if (tail) {
    out.push(tail);
  }
  return out;
}

/**
 * True when a statement redirects stdout to an actual file (`> file`, `>> file`, `1> file`),
 * ignoring stream merges (`2>&1`), null sinks (`>$null`, `>/dev/null`, `>NUL`), and arrows/comparisons
 * (`=>`, `->`, `>=`, `<=`, `<>`).
 */
function hasFileRedirection(statement: string): boolean {
  const masked = maskQuotedStrings(statement);
  const re = /(?:^|[\s\w)'"`])([1*]?)>>?(?![=>&])(\s*)("[^"]*"|'[^']*'|[^\s;|&)]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const startIdx = match.index + match[0].indexOf('>');
    const prev = startIdx > 0 ? masked[startIdx - 1] : '';
    if (prev === '=' || prev === '-' || prev === '<' || prev === '2' || prev === '3') {
      continue;
    }
    const targetStart = match.index + match[0].length - match[3]!.length;
    const rawTarget = statement
      .slice(targetStart, targetStart + match[3]!.length)
      .replace(/^['"]|['"]$/g, '')
      .trim()
      .toLowerCase();
    if (!rawTarget || rawTarget === '$null' || rawTarget === '/dev/null' || rawTarget === 'nul' || rawTarget === 'null') {
      continue;
    }
    return true;
  }
  return false;
}

/** Classify an inline `python -c ...` snippet by its file I/O calls. */
function classifyPythonInline(code: string): ShellCommandIntent {
  const hasDelete = /\b(?:os\.(?:remove|unlink|rmdir)|shutil\.rmtree)\s*\(|\.\s*unlink\s*\(/i.test(code);
  const hasCopy = /\bshutil\.copy(?:2|file|tree)?\s*\(/i.test(code);
  const hasMove = /\b(?:os\.(?:rename|replace)|shutil\.move)\s*\(|\.\s*rename\s*\(/i.test(code);
  const hasWrite =
    /\.(?:write_text|write_bytes|writelines|write)\s*\(|\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][wax+][^'"]*['"]|\bopen\s*\([^)]*,\s*['"][^'"]*[wax+][^'"]*['"]/i.test(
      code,
    );
  const hasRead =
    /\.(?:read_text|read_bytes|readlines|readline|read)\s*\(|\bopen\s*\(/i.test(code);
  const hasReplace = /\.\s*replace\s*\(|\bre\.sub\s*\(/i.test(code);
  const hasList = /\b(?:os\.listdir|os\.walk|glob\.glob)\s*\(|\.\s*(?:glob|rglob|iterdir)\s*\(/i.test(code);

  if (hasWrite) {
    return hasRead || hasReplace ? 'edit' : 'write';
  }
  if (hasMove) {
    return 'edit';
  }
  if (hasDelete) {
    return 'delete';
  }
  if (hasCopy) {
    return 'copy';
  }
  if (hasRead) {
    return 'read';
  }
  if (hasList) {
    return 'list';
  }
  return 'run';
}

/** Classify an inline `node -e ...` snippet by its `fs` calls. */
function classifyNodeInline(code: string): ShellCommandIntent {
  const hasWrite = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|truncateSync)\s*\(/i.test(code);
  const hasRead = /\b(?:readFileSync|readFile|createReadStream)\s*\(/i.test(code);
  const hasReplace = /\.\s*replace(?:All)?\s*\(/i.test(code);
  const hasDelete = /\b(?:unlinkSync|unlink|rmSync|rmdirSync)\s*\(/i.test(code);
  const hasCopy = /\b(?:copyFileSync|copyFile|cpSync)\s*\(/i.test(code);
  const hasMove = /\b(?:renameSync|rename)\s*\(/i.test(code);
  const hasList = /\b(?:readdirSync|readdir)\s*\(/i.test(code);

  if (hasWrite) {
    return hasRead || hasReplace ? 'edit' : 'write';
  }
  if (hasMove) {
    return 'edit';
  }
  if (hasDelete) {
    return 'delete';
  }
  if (hasCopy) {
    return 'copy';
  }
  if (hasRead) {
    return 'read';
  }
  if (hasList) {
    return 'list';
  }
  return 'run';
}

/** First command word of a pipeline stage (stripping leading `(`, `$var = `, `&`, `sudo`, path prefix). */
function extractStageCommand(stage: string): { cmd: string; rest: string; assigned: boolean } {
  let s = stage.trim();
  let assigned = false;
  // Strip outer grouping parens such as `(Get-Content a.ts -Raw) -replace ...`
  while (s.startsWith('(')) {
    s = s.slice(1).trim();
  }
  const assignMatch = /^\$[A-Za-z_][\w:]*\s*=\s*([\s\S]+)$/.exec(s);
  if (assignMatch) {
    assigned = true;
    s = assignMatch[1]!.trim();
    while (s.startsWith('(')) {
      s = s.slice(1).trim();
    }
  }
  s = s.replace(LEADING_PREFIX_RE, '').trim();
  const tokenMatch = /^([^\s|;&()]+)([\s\S]*)$/.exec(s);
  if (!tokenMatch) {
    return { cmd: '', rest: '', assigned };
  }
  const rawToken = tokenMatch[1]!.replace(/^['"]|['"]$/g, '');
  const base = rawToken.split(/[\\/]/).pop() ?? rawToken;
  return { cmd: base.toLowerCase(), rest: tokenMatch[2]!.trim(), assigned };
}

/** True for PowerShell `sc` used as Windows `sc.exe` Service Control rather than `Set-Content`. */
function isWindowsServiceControl(cmd: string, rest: string): boolean {
  if (cmd === 'sc.exe') {
    return true;
  }
  if (cmd !== 'sc') {
    return false;
  }
  return /^(?:query|queryex|start|stop|pause|continue|config|qc|qdescription|description|delete|create|sdshow|sdset|failure)\b/i.test(
    rest,
  );
}

type StageKind = ShellCommandIntent | 'setup' | 'filter';

function classifyStage(stage: string): StageKind {
  const trimmed = stage.trim();
  if (!trimmed) {
    return 'setup';
  }

  // .NET File / Directory APIs anywhere in the stage
  if (DOTNET_WRITE_RE.test(trimmed)) {
    return DOTNET_READ_RE.test(trimmed) || REPLACE_OP_RE.test(trimmed) ? 'edit' : 'write';
  }
  if (DOTNET_MOVE_RE.test(trimmed)) {
    return 'edit';
  }
  if (DOTNET_DELETE_RE.test(trimmed)) {
    return 'delete';
  }
  if (DOTNET_COPY_RE.test(trimmed)) {
    return 'copy';
  }
  if (DOTNET_READ_RE.test(trimmed)) {
    return 'read';
  }

  // Inline Python / Node scripts
  const pyMatch = PYTHON_INLINE_RE.exec(trimmed.replace(LEADING_PREFIX_RE, '').trim());
  if (pyMatch) {
    return classifyPythonInline(stripOuterQuotes(pyMatch[1]!));
  }
  const nodeMatch = NODE_INLINE_RE.exec(trimmed.replace(LEADING_PREFIX_RE, '').trim());
  if (nodeMatch) {
    return classifyNodeInline(stripOuterQuotes(nodeMatch[1]!));
  }

  // Pure setup statements (cd, Set-Location, Push-Location, export)
  if (SETUP_CMD_RE.test(trimmed)) {
    return 'setup';
  }

  const { cmd, rest, assigned } = extractStageCommand(trimmed);
  if (!cmd) {
    return 'setup';
  }
  const cmdNoExe = cmd.endsWith('.exe') ? cmd.slice(0, -4) : cmd;

  // PowerShell / POSIX write cmdlets
  if (
    cmdNoExe === 'set-content' ||
    cmdNoExe === 'add-content' ||
    cmdNoExe === 'ac' ||
    cmdNoExe === 'out-file' ||
    cmdNoExe === 'new-item' ||
    cmdNoExe === 'ni' ||
    cmdNoExe === 'clear-content' ||
    cmdNoExe === 'clc' ||
    cmdNoExe === 'tee-object' ||
    cmdNoExe === 'tee' ||
    cmdNoExe === 'touch' ||
    cmdNoExe === 'mkdir' ||
    cmdNoExe === 'md' ||
    (cmd === 'sc' && !isWindowsServiceControl(cmd, rest))
  ) {
    return 'write';
  }

  // In-place edit / patch / move / rename
  if (
    cmdNoExe === 'rename-item' ||
    cmdNoExe === 'rni' ||
    cmdNoExe === 'ren' ||
    cmdNoExe === 'move-item' ||
    cmdNoExe === 'mi' ||
    cmdNoExe === 'move' ||
    cmdNoExe === 'mv' ||
    cmdNoExe === 'patch' ||
    cmdNoExe === 'apply_patch'
  ) {
    return 'edit';
  }
  if (cmdNoExe === 'sed') {
    if (/(?:^|\s)(?:-[a-z]*i\b|--in-place\b)/i.test(rest)) {
      return 'edit';
    }
    return 'read';
  }
  if (cmdNoExe === 'perl' && /(?:^|\s)-[a-z]*i/i.test(rest)) {
    return 'edit';
  }
  if (cmdNoExe === 'git') {
    const sub = rest.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (sub === 'apply') {
      return 'edit';
    }
    if (sub === 'grep') {
      return 'search';
    }
    if (sub === 'ls-files' || sub === 'ls-tree') {
      return 'list';
    }
    return 'run';
  }

  // Copy
  if (
    cmdNoExe === 'copy-item' ||
    cmdNoExe === 'cpi' ||
    cmdNoExe === 'cp' ||
    cmdNoExe === 'copy' ||
    cmdNoExe === 'robocopy' ||
    cmdNoExe === 'xcopy'
  ) {
    return 'copy';
  }

  // Delete
  if (
    cmdNoExe === 'remove-item' ||
    cmdNoExe === 'ri' ||
    cmdNoExe === 'rm' ||
    cmdNoExe === 'del' ||
    cmdNoExe === 'erase' ||
    cmdNoExe === 'rd' ||
    cmdNoExe === 'rmdir'
  ) {
    return 'delete';
  }

  // Search
  if (
    cmdNoExe === 'select-string' ||
    cmdNoExe === 'sls' ||
    cmdNoExe === 'rg' ||
    cmdNoExe === 'ripgrep' ||
    cmdNoExe === 'grep' ||
    cmdNoExe === 'egrep' ||
    cmdNoExe === 'fgrep' ||
    cmdNoExe === 'findstr' ||
    cmdNoExe === 'ag' ||
    cmdNoExe === 'ack'
  ) {
    if ((cmdNoExe === 'rg' || cmdNoExe === 'ripgrep') && /(?:^|\s)--files\b/.test(rest)) {
      return 'list';
    }
    return 'search';
  }

  // Directory listing / file finding
  if (
    cmdNoExe === 'get-childitem' ||
    cmdNoExe === 'gci' ||
    cmdNoExe === 'dir' ||
    cmdNoExe === 'ls' ||
    cmdNoExe === 'tree' ||
    cmdNoExe === 'fd' ||
    cmdNoExe === 'find'
  ) {
    return 'list';
  }

  // File reading (`cat << EOF` is a heredoc write, not a file read).
  if (cmdNoExe === 'cat' && /<</.test(rest)) {
    return 'write';
  }
  if (
    cmdNoExe === 'get-content' ||
    cmdNoExe === 'gc' ||
    cmdNoExe === 'cat' ||
    cmdNoExe === 'type' ||
    cmdNoExe === 'head' ||
    cmdNoExe === 'tail' ||
    cmdNoExe === 'more' ||
    cmdNoExe === 'less' ||
    cmdNoExe === 'nl' ||
    cmdNoExe === 'wc' ||
    cmdNoExe === 'bat' ||
    cmdNoExe === 'import-csv' ||
    cmdNoExe === 'import-clixml' ||
    cmdNoExe === 'get-filehash' ||
    cmdNoExe === 'get-item' ||
    cmdNoExe === 'gi' ||
    cmdNoExe === 'test-path' ||
    cmdNoExe === 'stat' ||
    cmdNoExe === 'file'
  ) {
    return 'read';
  }

  // Pipeline-only filters (`Select-Object`, `Where-Object`, `Measure-Object`, `Sort-Object`, `Format-*`)
  if (
    cmdNoExe === 'select-object' ||
    cmdNoExe === 'select' ||
    cmdNoExe === 'where-object' ||
    cmdNoExe === 'where' ||
    cmdNoExe === 'measure-object' ||
    cmdNoExe === 'measure' ||
    cmdNoExe === 'sort-object' ||
    cmdNoExe === 'sort' ||
    cmdNoExe === 'foreach-object' ||
    cmdNoExe === 'out-string' ||
    cmdNoExe === 'convertfrom-json' ||
    cmdNoExe === 'convertto-json' ||
    cmdNoExe.startsWith('format-')
  ) {
    return 'filter';
  }

  // Variable assignment to a literal / path / string transformation (e.g. `$p = 'a.ts'`, `$c = $c.Replace(...)`)
  if (assigned || PS_SIMPLE_ASSIGN_RE.test(trimmed)) {
    return 'setup';
  }

  return 'run';
}

function isMutation(intent: StageKind): intent is 'edit' | 'write' | 'delete' | 'copy' {
  return intent === 'edit' || intent === 'write' || intent === 'delete' || intent === 'copy';
}

function isLookup(intent: StageKind): intent is 'read' | 'search' | 'list' {
  return intent === 'read' || intent === 'search' || intent === 'list';
}

/**
 * Infer whether a shell/PowerShell command is reading, searching, listing, editing, writing,
 * copying, deleting, or running a general command.
 *
 * Mutations take priority over lookups so read-modify-write pipelines
 * (`(Get-Content a.ts) -replace 'x','y' | Set-Content a.ts`) classify as `'edit'`, while
 * test/build pipelines (`npm test | Select-String FAIL`) stay `'run'`.
 */
export function classifyShellCommand(command: string): ShellCommandIntent {
  const unwrapped = unwrapShellCommand(command);
  if (!unwrapped) {
    return 'run';
  }

  const statements = splitStatements(unwrapped);
  let mutation: 'edit' | 'write' | 'delete' | 'copy' | null = null;
  let sawRead = false;
  let sawSearch = false;
  let sawList = false;
  let sawRun = false;
  let sawReplace = REPLACE_OP_RE.test(maskQuotedStrings(unwrapped));

  const recordMutation = (next: 'edit' | 'write' | 'delete' | 'copy'): void => {
    if (!mutation || MUTATION_RANK[next] > MUTATION_RANK[mutation]) {
      mutation = next;
    }
  };

  for (const statement of statements) {
    const stages = splitPipeline(statement);
    const stageKinds = stages.map(classifyStage);

    // Check file redirection on this statement (`echo hi > a.txt`, `cat <<'EOF' > a.ts`).
    if (hasFileRedirection(statement)) {
      recordMutation(sawReplace ? 'edit' : 'write');
    }

    // Any mutating stage anywhere in the pipeline promotes the whole command.
    for (const kind of stageKinds) {
      if (isMutation(kind)) {
        recordMutation(kind);
      }
    }

    // Determine the primary non-setup stage of this pipeline.
    const lead = stageKinds.find((k) => k !== 'setup' && k !== 'filter');
    if (!lead) {
      continue;
    }
    if (lead === 'run') {
      // Piping a test/build runner into `head`/`tail`/`Select-String` stays `run`.
      sawRun = true;
      continue;
    }
    if (isLookup(lead)) {
      // A read/list pipeline filtered by `Select-String`/`grep` is a search (`gci | sls foo`).
      const pipedSearch = stageKinds.includes('search');
      if (pipedSearch || lead === 'search') {
        sawSearch = true;
      } else if (lead === 'read') {
        sawRead = true;
      } else {
        sawList = true;
      }
    }
  }

  // A read-modify-write command (read + replace + write, or read + write with replace) is an edit.
  if (mutation === 'write' && (sawRead || sawReplace)) {
    return 'edit';
  }
  if (mutation) {
    return mutation;
  }

  // Truncated PowerShell here-strings (`@'` / `$content = @'` cut off by status-line ellipsis)
  // almost always build file content for `Set-Content` / `Out-File` at the end of the script.
  if (
    !sawRun &&
    !sawRead &&
    !sawSearch &&
    !sawList &&
    unwrapped.endsWith('…') &&
    PS_HERE_STRING_START_RE.test(unwrapped)
  ) {
    return 'write';
  }

  // A truncated PowerShell read-modify-write (`$c = Get-Content a.ts -Raw; $c = $c -replace ...…`)
  // where `Set-Content` fell past the 140/200-char preview cap.
  if (sawRead && sawReplace && !sawRun) {
    return 'edit';
  }

  if (sawRun) {
    return 'run';
  }
  if (sawSearch) {
    return 'search';
  }
  if (sawRead) {
    return 'read';
  }
  if (sawList) {
    return 'list';
  }
  return 'run';
}
