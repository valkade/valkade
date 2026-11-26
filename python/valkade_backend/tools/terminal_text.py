"""Terminal output as plain text for the model.

Agent commands run with colors forced on (``FORCE_COLOR`` and friends, see
:func:`valkade_backend.runtime.python_env.with_subprocess_color_env`) so the in-app terminal tab renders
them. The model only needs the text: escape sequences cost tokens on every line, and carriage-return
redraws (progress bars, spinners) repeat a line many times over.
"""

from __future__ import annotations

import re

__all__ = ['plain_terminal_lines', 'plain_terminal_text']

#: OSC strings (titles, OSC 7 working-directory reports), CSI sequences (colors, cursor moves) and
#: two-character escapes.
_ANSI_ESCAPE_RE = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]')


def plain_terminal_lines(raw: str) -> list[str]:
    """``raw`` without escape sequences, one entry per line, each line as a terminal last drew it.

    A carriage return without a newline overwrites its line, so only the last non-empty segment stays;
    other control characters except tab are dropped and trailing whitespace is trimmed.
    """
    if not raw:
        return []
    text = _ANSI_ESCAPE_RE.sub('', raw).replace('\r\n', '\n')
    lines: list[str] = []
    for line in text.split('\n'):
        if '\r' in line:
            line = next((segment for segment in reversed(line.split('\r')) if segment), '')
        lines.append(''.join(ch for ch in line if ch == '\t' or ord(ch) >= 32).rstrip())
    return lines


def plain_terminal_text(raw: str) -> str:
    """:func:`plain_terminal_lines` joined with ``\\n``."""
    return '\n'.join(plain_terminal_lines(raw))
