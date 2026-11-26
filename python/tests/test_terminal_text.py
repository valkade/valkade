"""Command output as plain text for the model: no escape sequences, carriage-return redraws replayed."""

from __future__ import annotations

import pytest

from valkade_backend.tools.terminal_text import plain_terminal_lines, plain_terminal_text


@pytest.mark.parametrize(
    ('raw', 'expected'),
    [
        ('', ''),
        ('plain text', 'plain text'),
        # pytest's colored progress dots and summary.
        ('\x1b[32m.\x1b[0m\x1b[32m.\x1b[0m\x1b[31mF\x1b[0m', '..F'),
        ('\x1b[1m\x1b[32m3 passed\x1b[0m in 0.1s', '3 passed in 0.1s'),
        # 256-color / truecolor SGR, cursor moves, erase-line.
        ('\x1b[38;5;208mwarn\x1b[0m', 'warn'),
        ('\x1b[38;2;255;0;0mred\x1b[0m\x1b[2K', 'red'),
        # OSC window title and OSC 7 working directory, BEL- and ST-terminated.
        ('\x1b]0;title\x07after', 'after'),
        ('\x1b]7;file:///c:/work\x1b\\after', 'after'),
        # Windows line endings, and a tab kept.
        ('a\r\nb\r\n', 'a\nb\n'),
        ('col1\tcol2', 'col1\tcol2'),
        # A progress bar redrawn with carriage returns keeps only what the terminal shows last.
        ('Downloading  10%\rDownloading  55%\rDownloading 100%\ndone', 'Downloading 100%\ndone'),
        # Other control characters go; trailing spaces are trimmed.
        ('bell\x07 here   ', 'bell here'),
    ],
)
def test_plain_terminal_text(raw: str, expected: str) -> None:
    assert plain_terminal_text(raw) == expected


def test_plain_terminal_lines_keeps_blank_lines_between_text() -> None:
    assert plain_terminal_lines('a\n\n\x1b[31mb\x1b[0m') == ['a', '', 'b']


def test_user_terminal_cleaning_still_clips_long_lines() -> None:
    from valkade_backend.tools.tool_conventions import TOOL_LINE_MAX_CHARS
    from valkade_backend.tools.user_terminals import clean_terminal_output

    lines = clean_terminal_output('\x1b[32m' + 'x' * (TOOL_LINE_MAX_CHARS + 10) + '\x1b[0m\n\n')
    assert len(lines) == 1
    assert lines[0].startswith('x' * TOOL_LINE_MAX_CHARS)
    assert lines[0].endswith('[+10 chars]')
