"""The shell that agent commands run in (``run_command``, workspace checks, the elevated broker).

Windows: PowerShell 7 (``pwsh``) when installed, else Windows PowerShell 5.1, else ``cmd.exe``.
POSIX: ``/bin/sh`` (``asyncio.create_subprocess_shell``).

``VALKADE_AGENT_SHELL`` (``auto`` | ``pwsh`` | ``powershell`` | ``cmd``) pins a Windows shell; a pinned
shell that is not installed falls back to the automatic choice.

PowerShell gets the command through an environment variable instead of its command line, so quoting,
newlines and Unicode survive untouched; :data:`_POWERSHELL_BOOTSTRAP` removes that variable before the
command runs (child processes never see it), switches output to UTF-8 without progress bars, and exits
with the code of the last statement (the native exit code when that was a program).
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

SHELL_PWSH = 'pwsh'
SHELL_POWERSHELL = 'powershell'
SHELL_CMD = 'cmd'
SHELL_SH = 'sh'

AGENT_SHELL_ENV = 'VALKADE_AGENT_SHELL'
#: Carries the command text into PowerShell; removed by the bootstrap before the command runs.
AGENT_COMMAND_ENV = 'VALKADE_AGENT_COMMAND'

_POWERSHELL_BOOTSTRAP = '\n'.join(
    (
        "$ProgressPreference = 'SilentlyContinue'",
        'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
        '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        "if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }",
        f'$__valkadeCommand = $env:{AGENT_COMMAND_ENV}',
        f'Remove-Item Env:{AGENT_COMMAND_ENV} -ErrorAction SilentlyContinue',
        '$__valkadeOk = $false',
        '$global:LASTEXITCODE = 0',
        # The blank line ends a trailing backtick continuation before the status capture.
        'try { $__valkadeBlock = [scriptblock]::Create($__valkadeCommand + "`n`n`$__valkadeOk = `$?") }',
        # A syntax error: print only the parser's message (it quotes the command's own line), not this wrapper.
        'catch { $__valkadeError = $_.Exception; if ($__valkadeError.InnerException) '
        '{ $__valkadeError = $__valkadeError.InnerException }; [Console]::Error.WriteLine($__valkadeError.Message); exit 1 }',
        '. $__valkadeBlock',
        'if ($__valkadeOk) { exit 0 }',
        'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
        'exit 1',
    )
)

#: A command that opens with a quoted program path (``"C:\\x\\python.exe" -m pytest``, the cmd/sh habit).
_QUOTED_PROGRAM = re.compile(r'''^(\s*)(["'])([^"'\r\n]+)\2(?=\s|$)''')
_PROGRAM_SUFFIXES = ('.exe', '.cmd', '.bat', '.com', '.ps1')
#: PowerShell binary operators (``-eq``, ``-replace`` …; ``c``/``i`` prefixed forms too) that make the
#: quoted string an expression rather than a program to call.
_POWERSHELL_OPERATORS = frozenset(
    {
        'eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'notlike', 'match', 'notmatch', 'replace', 'contains',
        'notcontains', 'in', 'notin', 'is', 'isnot', 'as', 'split', 'join', 'and', 'or', 'xor', 'band', 'bor',
        'bxor', 'shl', 'shr',
    }
)
_LEADING_OPTION = re.compile(r'-([a-z]+)\b', re.IGNORECASE)

#: Bash/coreutils words PowerShell does not know, and what to write instead.
_BASH_COMMAND_FIXES: dict[str, str] = {
    'export': 'set variables with `$env:NAME = "value"` (not `export NAME=value`)',
    'unset': 'remove a variable with `Remove-Item Env:NAME`',
    'which': 'find a program with `Get-Command name` (or `where.exe name`)',
    'grep': 'search with `Select-String -Pattern "text" -Path file` or `cmd | Select-String "text"`',
    'head': 'take the first lines with `Get-Content file -TotalCount 20` or `cmd | Select-Object -First 20`',
    'tail': 'take the last lines with `Get-Content file -Tail 20` or `cmd | Select-Object -Last 20`',
    'touch': 'create a file with `New-Item -ItemType File -Force path`',
    'source': 'activate a venv with `.\\.venv\\Scripts\\Activate.ps1`; run a script in scope with `. .\\script.ps1`',
    'sed': "replace text with `(Get-Content f) -replace 'old', 'new' | Set-Content f`",
    'awk': "split fields with `cmd | ForEach-Object { ($_ -split '\\s+')[0] }`",
    'wc': 'count lines with `(Get-Content file).Count` or `cmd | Measure-Object -Line`',
}
#: ``(pattern, hint)`` pairs matched against PowerShell output; the first hint per pattern is reported.
_POWERSHELL_ERROR_HINTS: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), hint)
    for pattern, hint in (
        (
            r"The token '(?:&&|\|\|)' is not a valid statement separator",
            'Windows PowerShell 5.1 has no `&&` / `||`: chain with `;` and guard the next step with '
            '`step1; if ($?) { step2 }` (or `step1; if (-not $?) { step2 }` for `||`).',
        ),
        (
            # 5.1 writes ``Remove-Item : …``; PowerShell 7's concise view ``Remove-Item: …``.
            r"Remove-Item ?: (?:A parameter cannot be found that matches parameter name|"
            r"Parameter cannot be processed because the parameter name) '[a-z]+'",
            '`rm -rf` / `rm -f` are bash flags: use `Remove-Item -Recurse -Force path` '
            '(add `-ErrorAction SilentlyContinue` if it may not exist).',
        ),
        (
            r"Get-ChildItem ?: A parameter cannot be found that matches parameter name '[a-z]+'",
            '`ls` flags like `-la` are bash: use `Get-ChildItem -Force` (hidden files) or `Get-ChildItem -Recurse`.',
        ),
        (
            r"Invoke-WebRequest ?: (?:A parameter cannot be found that matches parameter name|"
            r"Parameter cannot be processed because the parameter name) '[a-z]+'",
            'In Windows PowerShell 5.1 `curl` / `wget` are aliases of `Invoke-WebRequest`: call `curl.exe` for real '
            'curl, or use `Invoke-WebRequest -Uri URL -OutFile file`.',
        ),
        (
            r"Could not find a part of the path '[a-z]:\\dev\\null'",
            '`/dev/null` does not exist on Windows: discard output with `2>$null`, `>$null` or `| Out-Null`.',
        ),
        (
            r"Unexpected token '[^'\r\n]*' in expression or statement",
            'If a step starts with a quoted program path, PowerShell reads it as a string: call it with `&` '
            '(`& "C:\\path\\tool.exe" --flag`).',
        ),
    )
)
_UNKNOWN_COMMAND = re.compile(r"The term '([^'\r\n]+)' is not recognized as (?:the |a )?name of a cmdlet", re.IGNORECASE)
_MAX_ERROR_HINTS = 3

__all__ = [
    'AGENT_COMMAND_ENV',
    'AGENT_SHELL_ENV',
    'AgentShell',
    'SHELL_CMD',
    'SHELL_POWERSHELL',
    'SHELL_PWSH',
    'SHELL_SH',
    'agent_shell',
    'agent_shell_command_problem',
    'agent_shell_error_hints',
    'agent_shell_prompt_line',
    'powershell_argv',
    'powershell_command_text',
    'powershell_error_hints',
    'spawn_agent_shell',
]


@dataclass(frozen=True)
class AgentShell:
    """Resolved agent shell: ``kind`` is one of the ``SHELL_*`` names."""

    kind: str
    executable: str
    label: str

    @property
    def is_powershell(self) -> bool:
        return self.kind in (SHELL_PWSH, SHELL_POWERSHELL)

    @property
    def multiline(self) -> bool:
        """``cmd /c`` stops at the first line break; the other shells run every line."""
        return self.kind != SHELL_CMD


def _system_root() -> Path:
    return Path((os.environ.get('SystemRoot') or os.environ.get('windir') or r'C:\Windows').strip())


def _existing(path: Path) -> str | None:
    try:
        return str(path) if path.is_file() else None
    except OSError:
        return None


def _find_pwsh() -> str | None:
    found = shutil.which('pwsh')
    if found:
        return found
    for env_name in ('ProgramFiles', 'ProgramW6432'):
        base = (os.environ.get(env_name) or '').strip()
        if not base:
            continue
        root = Path(base) / 'PowerShell'
        stable = _existing(root / '7' / 'pwsh.exe')
        if stable:
            return stable
        try:
            versions = sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name, reverse=True)
        except OSError:
            continue
        for version_dir in versions:
            hit = _existing(version_dir / 'pwsh.exe')
            if hit:
                return hit
    # winget / Microsoft Store installs (MSIX) expose ``pwsh`` as a per-user app alias; it is normally on
    # PATH, but a launcher with a trimmed PATH would otherwise fall back to 5.1.
    local_app_data = (os.environ.get('LOCALAPPDATA') or '').strip()
    if local_app_data:
        alias = Path(local_app_data) / 'Microsoft' / 'WindowsApps' / 'pwsh.exe'
        if os.path.lexists(alias):  # An app alias is a reparse point that ``is_file`` may not follow.
            return str(alias)
    return None


def _find_windows_powershell() -> str | None:
    return _existing(_system_root() / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe') or shutil.which(
        'powershell'
    )


def _cmd_shell() -> AgentShell:
    comspec = (os.environ.get('ComSpec') or '').strip() or str(_system_root() / 'System32' / 'cmd.exe')
    return AgentShell(SHELL_CMD, comspec, 'cmd.exe')


def _windows_shell(preference: str) -> AgentShell:
    if preference == SHELL_CMD:
        return _cmd_shell()
    if preference != SHELL_POWERSHELL:
        pwsh = _find_pwsh()
        if pwsh:
            return AgentShell(SHELL_PWSH, pwsh, 'PowerShell 7 (pwsh)')
    powershell = _find_windows_powershell()
    if powershell:
        return AgentShell(SHELL_POWERSHELL, powershell, 'Windows PowerShell 5.1 (powershell.exe)')
    if preference == SHELL_POWERSHELL:
        return _windows_shell('auto')
    return _cmd_shell()


@lru_cache(maxsize=1)
def agent_shell() -> AgentShell:
    """The shell for agent commands on this host (cached; ``agent_shell.cache_clear()`` re-resolves)."""
    if not sys.platform.startswith('win'):
        return AgentShell(SHELL_SH, '/bin/sh', '/bin/sh')
    preference = (os.environ.get(AGENT_SHELL_ENV) or '').strip().lower()
    return _windows_shell(preference)


def powershell_argv(shell: AgentShell) -> list[str]:
    """Argv that runs the bootstrap; the command itself travels in :data:`AGENT_COMMAND_ENV`."""
    return [
        shell.executable,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-OutputFormat',
        'Text',
        '-Command',
        _POWERSHELL_BOOTSTRAP,
    ]


def powershell_command_text(command: str) -> str:
    """``command`` with ``& `` before a leading quoted program path, which PowerShell would print, not run.

    ``"C:\\tools\\app.exe" --flag`` runs the program in cmd and sh; in PowerShell a statement that starts
    with a string is an expression, so the approved command gets the call operator it means.
    """
    match = _QUOTED_PROGRAM.match(command or '')
    if match is None:
        return command
    program = match.group(3)
    if not ('/' in program or '\\' in program or program.lower().endswith(_PROGRAM_SUFFIXES)):
        return command
    rest = command[match.end():].lstrip(' \t')
    if rest[:1] in ('+', ','):
        return command
    option = _LEADING_OPTION.match(rest)
    if option is not None:
        word = option.group(1).lower()
        if word in _POWERSHELL_OPERATORS or (word[:1] in ('c', 'i') and word[1:] in _POWERSHELL_OPERATORS):
            return command
    return f'{match.group(1)}& {command[match.start(2):]}'


def agent_shell_command_problem(command: str) -> str | None:
    """Why the agent shell cannot run ``command`` as written, or None."""
    shell = agent_shell()
    if '\n' in (command or '') and not shell.multiline:
        return (
            f'Tool error: the agent shell is {shell.label}, which runs only the first line of a command. '
            'Put the steps on one line joined with `&&`.'
        )
    return None


def powershell_error_hints(output: str) -> list[str]:
    """One-line fixes for bash habits that PowerShell rejected in ``output`` (deduplicated, at most a few)."""
    text = output or ''
    if not text:
        return []
    hints: list[str] = []
    for pattern, hint in _POWERSHELL_ERROR_HINTS:
        if pattern.search(text):
            hints.append(hint)
    for match in _UNKNOWN_COMMAND.finditer(text):
        word = match.group(1).strip().lower()
        fix = _BASH_COMMAND_FIXES.get(word)
        if fix:
            hints.append(f'`{word}` is not a PowerShell command: {fix}.')
    return list(dict.fromkeys(hints))[:_MAX_ERROR_HINTS]


def agent_shell_error_hints(output: str) -> list[str]:
    """:func:`powershell_error_hints` when the agent shell is PowerShell; nothing for the other shells."""
    return powershell_error_hints(output) if agent_shell().is_powershell else []


async def spawn_agent_shell(
    command: str,
    *,
    cwd: str | None,
    env: Mapping[str, str] | None,
    **kwargs: Any,
) -> asyncio.subprocess.Process:
    """Start ``command`` in the agent shell; ``kwargs`` go to ``asyncio.create_subprocess_*``."""
    shell = agent_shell()
    if not shell.is_powershell:
        return await asyncio.create_subprocess_shell(command, cwd=cwd, env=env, **kwargs)
    child_env = dict(os.environ if env is None else env)
    child_env[AGENT_COMMAND_ENV] = powershell_command_text(command)
    return await asyncio.create_subprocess_exec(*powershell_argv(shell), cwd=cwd, env=child_env, **kwargs)


def agent_shell_prompt_line() -> str:
    """System-prompt bullet naming the shell ``run_command`` uses and how to chain steps in it."""
    shell = agent_shell()
    if shell.kind == SHELL_PWSH:
        syntax = (
            'chain steps with `;`, new lines, or `&&` / `||`; call a quoted program path with `&` '
            '(`& "C:\\tools\\app.exe" --flag`); set variables with `$env:NAME = "value"`'
        )
    elif shell.kind == SHELL_POWERSHELL:
        syntax = (
            'chain steps with `;` or new lines—`&&` / `||` do not exist in 5.1, use `step1; if ($?) { step2 }`; '
            'call a quoted program path with `&` (`& "C:\\tools\\app.exe" --flag`); set variables with '
            '`$env:NAME = "value"`'
        )
    elif shell.kind == SHELL_CMD:
        syntax = 'one line only; chain steps with `&&`; set variables with `set NAME=value`'
    else:
        syntax = 'chain steps with `&&`, `;`, or new lines'
    return f'- `run_command` runs in {shell.label}: {syntax}. Do not assume Bash on Windows.'
