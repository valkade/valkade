"""Shared prompt fragments injected into ValkAde's system prompt and tool guidance."""

from __future__ import annotations

from textwrap import dedent
from typing import Any

from valkade_backend.lsp.file_policy import PRETTIER_MANAGED_SUFFIXES
from valkade_backend.session.state import agent_formatters_enabled, runtime_config


def source_code_formatting_guidance() -> str:
    """Compact I/O defaults and auto-formatter coverage."""
    enc = (runtime_config.tools.default_workspace_encoding or 'utf-8').strip() or 'utf-8'
    nl = (runtime_config.tools.default_workspace_newline or 'lf').strip() or 'lf'
    prettier_exts = ', '.join(sorted(PRETTIER_MANAGED_SUFFIXES))
    if agent_formatters_enabled():
        fmt = (
            f'Black auto-formats `.py` and Prettier auto-formats {prettier_exts} on write; '
            'for other file types, match surrounding indentation, quotes, and style.'
        )
    else:
        fmt = 'Auto-formatters are off—match surrounding indentation, quotes, and style.'
    return (
        f'**Formatting & I/O:** Omitted `encoding`/`newline` default to `{enc}` / `{nl}`; '
        f"preserve an existing file's actual encoding and line endings unless asked to change them. {fmt}"
    )


def edit_semantics_block() -> str:
    """Canonical workspace edit semantics (write-through edits, per-turn review/reset, Java build rule).

    Injected once via ``messages._outer_agent_operational_block``. Do not re-embed this
    block in model suffixes or tool descriptions—extend this function instead.
    """
    return (
        '**Edit semantics:** `write_workspace_file`, `replace_workspace_lines`, and `replace_workspace_snippet` '
        'write immediately (no staging or diff card). After your reply, the user may reset any file touched this turn; '
        'a reset notice means it reverted to pre-turn content—re-read before editing again. '
        'Prefer `replace_workspace_lines` with numbered reads or `replace_workspace_snippet` for unique context; '
        'use `write_workspace_file` for new files (parent directories are created automatically) or full rewrites '
        'after reading the whole file. Re-read before editing the same file again in a later step '
        '(parallel non-overlapping line edits from one read are shifted automatically). '
        'Use `lsp_rename_symbol` to rename code symbols across references. '
        '**Java:** call `java_bootstrap_project` before creating `.java` files when no parent up to the workspace '
        'root has `pom.xml`, `build.gradle(.kts)`, or `settings.gradle(.kts)`. '
        'Never hard-code jar paths—declare dependencies as `group:artifact:version`.'
    )


def subagent_role_block(name: str, role: Any = None) -> str:
    """Role of a sub-agent session (one-shot clone the main agent started with ``spawn_subagent``).

    ``role`` (a :class:`~valkade_backend.domain.RuntimeSubagentRole`) adds what Settings say about
    this kind of sub-agent: what it is for, that it is read-only, and the user's extra instructions.
    """
    label = ' '.join((name or '').split()) or 'sub-agent'
    base = dedent(
        f"""
        **You are a sub-agent** named `{label}`, working for the main Valk agent, not directly for the user.
        - The task in the first message comes from the main agent. Do that task with your tools; do not
          widen it, and stay within the files it names when it says so.
        - You cannot ask the user (or the main agent) anything: when something is unclear, make a sensible
          choice and say so. You get no follow-ups: this turn is your whole job.
        - Your final message is your report back to the main agent: concise, with what you found or
          changed (paths, key facts, anything left undone). It is not shown to the user as a reply.
        """
    ).strip()
    if role is None:
        return base
    lines = [base]
    purpose = ' '.join((role.description or '').split())
    role_line = f'- Your role is `{role.name.strip()}`'
    lines.append(f'{role_line}: {purpose}' if purpose else f'{role_line}.')
    if role.read_only:
        lines.append('- This role is read-only: you inspect and report, and change nothing.')
    extra = (role.instructions or '').strip()
    if extra:
        lines.append(f'\n**Instructions for this role:**\n{extra}')
    return '\n'.join(lines)


def speech_tts_mood_block() -> str:
    """When speech/TTS is on: model must emit a strip-able mood tag for the voice pipeline."""
    return dedent(
        """
        **Spoken reply (TTS is on):** The user's client will read your reply aloud.
        - Start the user-facing reply with exactly one mood line the UI strips before speech:
          `[[tts_mood: short natural-language mood and tone]]`
          Example: `[[tts_mood: calm, helpful, slightly upbeat]]`
        - Keep the mood phrase short (a few adjectives or a brief speaking style). Do not put the mood only inside the spoken prose.
        - After the tag, write normally. Prefer concise spoken-friendly sentences; avoid dumping large code blocks when a short summary suffices.
        """
    ).strip()
