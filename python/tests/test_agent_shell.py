"""Agent shell selection (PowerShell 7 → 5.1 → cmd on Windows) and PowerShell command handling."""

from __future__ import annotations

import asyncio
import os
import sys

import pytest

from valkade_backend.runtime import agent_shell as shell_mod
from valkade_backend.runtime.agent_shell import (
    AGENT_COMMAND_ENV,
    AGENT_SHELL_ENV,
    SHELL_CMD,
    SHELL_POWERSHELL,
    SHELL_PWSH,
    SHELL_SH,
    AgentShell,
    agent_shell,
    agent_shell_command_problem,
    agent_shell_error_hints,
    agent_shell_prompt_line,
    powershell_command_text,
    powershell_error_hints,
    spawn_agent_shell,
)

_ON_WINDOWS = sys.platform.startswith('win')


@pytest.fixture()
def fresh_shell(monkeypatch: pytest.MonkeyPatch):
    """Re-resolve the shell per test (it is cached for the process)."""
    monkeypatch.delenv(AGENT_SHELL_ENV, raising=False)
    agent_shell.cache_clear()
    yield monkeypatch
    agent_shell.cache_clear()


def _fake_windows(
    monkeypatch: pytest.MonkeyPatch,
    *,
    pwsh: str | None,
    powershell: str | None,
) -> None:
    monkeypatch.setattr(shell_mod.sys, 'platform', 'win32')
    monkeypatch.setattr(shell_mod, '_find_pwsh', lambda: pwsh)
    monkeypatch.setattr(shell_mod, '_find_windows_powershell', lambda: powershell)
    monkeypatch.setenv('ComSpec', r'C:\Windows\System32\cmd.exe')


def test_windows_prefers_powershell_7(fresh_shell) -> None:
    _fake_windows(fresh_shell, pwsh=r'C:\pwsh\pwsh.exe', powershell=r'C:\ps\powershell.exe')
    shell = agent_shell()
    assert (shell.kind, shell.executable) == (SHELL_PWSH, r'C:\pwsh\pwsh.exe')
    assert shell.is_powershell and shell.multiline


def test_windows_falls_back_to_powershell_5(fresh_shell) -> None:
    _fake_windows(fresh_shell, pwsh=None, powershell=r'C:\ps\powershell.exe')
    shell = agent_shell()
    assert (shell.kind, shell.executable) == (SHELL_POWERSHELL, r'C:\ps\powershell.exe')
    assert '5.1' in shell.label


def test_windows_falls_back_to_cmd_without_powershell(fresh_shell) -> None:
    _fake_windows(fresh_shell, pwsh=None, powershell=None)
    shell = agent_shell()
    assert (shell.kind, shell.executable) == (SHELL_CMD, r'C:\Windows\System32\cmd.exe')
    assert not shell.is_powershell and not shell.multiline


@pytest.mark.parametrize(
    ('preference', 'expected'),
    [('cmd', SHELL_CMD), ('powershell', SHELL_POWERSHELL), ('pwsh', SHELL_PWSH), ('auto', SHELL_PWSH), ('', SHELL_PWSH)],
)
def test_env_pins_the_windows_shell(fresh_shell, preference: str, expected: str) -> None:
    _fake_windows(fresh_shell, pwsh=r'C:\pwsh\pwsh.exe', powershell=r'C:\ps\powershell.exe')
    fresh_shell.setenv(AGENT_SHELL_ENV, preference)
    assert agent_shell().kind == expected


def test_pinned_powershell_5_missing_falls_back_to_auto(fresh_shell) -> None:
    _fake_windows(fresh_shell, pwsh=r'C:\pwsh\pwsh.exe', powershell=None)
    fresh_shell.setenv(AGENT_SHELL_ENV, 'powershell')
    assert agent_shell().kind == SHELL_PWSH


def test_posix_uses_bin_sh(fresh_shell) -> None:
    fresh_shell.setattr(shell_mod.sys, 'platform', 'linux')
    fresh_shell.setenv(AGENT_SHELL_ENV, 'pwsh')  # Windows-only setting: ignored elsewhere.
    shell = agent_shell()
    assert (shell.kind, shell.executable) == (SHELL_SH, '/bin/sh')


@pytest.mark.parametrize(
    ('command', 'expected'),
    [
        ('"C:/py/python.exe" -m pytest', '& "C:/py/python.exe" -m pytest'),
        ("'C:\\tools\\app.exe'", "& 'C:\\tools\\app.exe'"),
        ('  "./node_modules/.bin/tsc.cmd" --noEmit', '  & "./node_modules/.bin/tsc.cmd" --noEmit'),
        ('"build.bat" /release', '& "build.bat" /release'),
        ('"C:/py/python.exe" -f config.toml', '& "C:/py/python.exe" -f config.toml'),
        # Already called, not path-like, or an expression: unchanged.
        ('& "C:/py/python.exe" -m pytest', '& "C:/py/python.exe" -m pytest'),
        ('"hello world"', '"hello world"'),
        ('"{0}" -f $name', '"{0}" -f $name'),
        ('"C:\\a\\b" -replace "\\\\", "/"', '"C:\\a\\b" -replace "\\\\", "/"'),
        ('"C:\\a" -ieq $path', '"C:\\a" -ieq $path'),
        ('"C:/a/" + "b"', '"C:/a/" + "b"'),
        ('npm test', 'npm test'),
    ],
)
def test_powershell_command_text_adds_call_operator(command: str, expected: str) -> None:
    assert powershell_command_text(command) == expected


def test_cmd_rejects_multiline_commands(fresh_shell) -> None:
    fresh_shell.setattr(shell_mod, 'agent_shell', lambda: AgentShell(SHELL_CMD, 'cmd.exe', 'cmd.exe'))
    problem = agent_shell_command_problem('npm ci\nnpm test')
    assert problem is not None and 'cmd.exe' in problem
    assert agent_shell_command_problem('npm ci && npm test') is None


@pytest.mark.parametrize(
    ('shell', 'needle'),
    [
        (AgentShell(SHELL_PWSH, 'pwsh.exe', 'PowerShell 7 (pwsh)'), '`&&` / `||`'),
        (AgentShell(SHELL_POWERSHELL, 'powershell.exe', 'Windows PowerShell 5.1 (powershell.exe)'), 'do not exist in 5.1'),
        (AgentShell(SHELL_CMD, 'cmd.exe', 'cmd.exe'), 'one line only'),
        (AgentShell(SHELL_SH, '/bin/sh', '/bin/sh'), 'new lines'),
    ],
)
def test_prompt_line_names_the_shell_and_its_chaining(fresh_shell, shell: AgentShell, needle: str) -> None:
    fresh_shell.setattr(shell_mod, 'agent_shell', lambda: shell)
    line = agent_shell_prompt_line()
    assert line.startswith(f'- `run_command` runs in {shell.label}:')
    assert needle in line


#: Error text as Windows PowerShell 5.1 prints it (``Name : message``) and PowerShell 7 (``Name: message``).
_REJECTED_BASH = [
    ("The token '&&' is not a valid statement separator in this version.", '`step1; if ($?) { step2 }`'),
    ("The token '||' is not a valid statement separator in this version.", 'if (-not $?)'),
    ("Remove-Item : A parameter cannot be found that matches parameter name 'rf'.", 'Remove-Item -Recurse -Force'),
    ("Remove-Item: A parameter cannot be found that matches parameter name 'rf'.", 'Remove-Item -Recurse -Force'),
    (
        "Remove-Item : Parameter cannot be processed because the parameter name 'f' is ambiguous. "
        'Possible matches include: -Filter -Force.',
        'Remove-Item -Recurse -Force',
    ),
    ("Get-ChildItem : A parameter cannot be found that matches parameter name 'la'.", 'Get-ChildItem -Force'),
    ("Invoke-WebRequest : A parameter cannot be found that matches parameter name 'sL'.", 'curl.exe'),
    ("out-file : Could not find a part of the path 'C:\\dev\\null'.", '2>$null'),
    ("Unexpected token 'version' in expression or statement.", '& "C:\\path\\tool.exe"'),
    (
        "export : The term 'export' is not recognized as the name of a cmdlet, function, script file, or operable "
        'program.',
        '$env:NAME = "value"',
    ),
    (
        "grep: The term 'grep' is not recognized as a name of a cmdlet, function, script file, or executable program.",
        'Select-String',
    ),
    ("which : The term 'which' is not recognized as the name of a cmdlet", 'Get-Command'),
]


@pytest.mark.parametrize(('output', 'fix'), _REJECTED_BASH)
def test_powershell_error_hints_name_the_fix(output: str, fix: str) -> None:
    hints = powershell_error_hints(f'some output\n{output}\nAt line:1 char:1')
    assert len(hints) == 1
    assert fix in hints[0]


@pytest.mark.parametrize(
    'output',
    [
        '',
        'All 12 tests passed.',
        'curl : Unable to connect to the remote server',
        # Unknown words that are not bash habits (a missing tool) get no guess.
        "npm : The term 'npm' is not recognized as the name of a cmdlet, function, script file, or operable program.",
    ],
)
def test_powershell_error_hints_stay_quiet_without_a_known_mistake(output: str) -> None:
    assert powershell_error_hints(output) == []


def test_powershell_error_hints_are_deduplicated_and_capped() -> None:
    output = '\n'.join(
        [
            "The token '&&' is not a valid statement separator in this version.",
            "The token '&&' is not a valid statement separator in this version.",
            "Remove-Item : A parameter cannot be found that matches parameter name 'rf'.",
            "head : The term 'head' is not recognized as the name of a cmdlet",
            "tail : The term 'tail' is not recognized as the name of a cmdlet",
        ]
    )
    hints = powershell_error_hints(output)
    assert len(hints) == 3
    assert len(set(hints)) == 3
    assert '&&' in hints[0]


def test_error_hints_only_for_a_powershell_agent_shell(fresh_shell) -> None:
    output = "The token '&&' is not a valid statement separator in this version."
    fresh_shell.setattr(shell_mod, 'agent_shell', lambda: AgentShell(SHELL_SH, '/bin/sh', '/bin/sh'))
    assert agent_shell_error_hints(output) == []
    fresh_shell.setattr(shell_mod, 'agent_shell', lambda: AgentShell(SHELL_POWERSHELL, 'powershell.exe', '5.1'))
    assert agent_shell_error_hints(output)


async def _run(command: str) -> tuple[int, str]:
    proc = await spawn_agent_shell(
        command,
        cwd=os.getcwd(),
        env=dict(os.environ),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
    return int(proc.returncode if proc.returncode is not None else -1), out.decode('utf-8', 'replace')


_needs_powershell = pytest.mark.skipif(
    not (_ON_WINDOWS and agent_shell().is_powershell), reason='PowerShell agent shell (Windows) only'
)


@_needs_powershell
@pytest.mark.asyncio(loop_scope='function')
async def test_powershell_reports_real_exit_codes() -> None:
    py = sys.executable.replace('\\', '/')
    assert (await _run('exit 3'))[0] == 3
    # A failing program as the last step keeps its own exit code.
    assert (await _run(f'"{py}" -c "import sys; sys.exit(5)"'))[0] == 5
    # A failing cmdlet as the last step is a failure.
    assert (await _run('Get-Item does-not-exist-valkade'))[0] == 1
    # Like sh: the last step decides.
    assert (await _run(f'"{py}" -c "import sys; sys.exit(5)"; Write-Output after'))[0] == 0


@_needs_powershell
@pytest.mark.asyncio(loop_scope='function')
async def test_powershell_runs_bundled_multiline_unicode_commands() -> None:
    code, out = await _run('$env:VALKADE_T = "bundled"\nWrite-Output "a: $env:VALKADE_T"; Write-Output "b: café ✓"')
    assert code == 0
    assert 'a: bundled' in out
    assert 'b: café ✓' in out


@_needs_powershell
@pytest.mark.asyncio(loop_scope='function')
async def test_powershell_command_variable_is_not_inherited() -> None:
    py = sys.executable.replace('\\', '/')
    code, out = await _run(f'"{py}" -c "import os; print(\'seen=\' + str(os.environ.get(\'{AGENT_COMMAND_ENV}\')))"')
    assert code == 0
    assert 'seen=None' in out


@_needs_powershell
@pytest.mark.asyncio(loop_scope='function')
async def test_powershell_syntax_errors_show_only_the_commands_own_line() -> None:
    code, out = await _run('Write-Output a\nWrite-Output "unterminated')
    assert code == 1
    assert 'Write-Output "unterminated' in out
    assert 'missing the terminator' in out
    # Nothing of the bootstrap that wraps the command leaks into the output.
    assert 'scriptblock' not in out.lower()
    assert '__valkade' not in out
    assert 'Exception calling' not in out


@_needs_powershell
@pytest.mark.asyncio(loop_scope='function')
async def test_live_powershell_errors_produce_hints() -> None:
    for command, fix in (
        ('rm -rf does-not-exist-valkade', 'Remove-Item -Recurse -Force'),
        ('export VALKADE_X=1', '$env:NAME'),
        ('ls -la', 'Get-ChildItem -Force'),
    ):
        code, out = await _run(command)
        assert code == 1, out
        hints = powershell_error_hints(out)
        assert hints and fix in hints[0], (command, out)
