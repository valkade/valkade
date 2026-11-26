"""Universal (preset-agnostic) write-through edit guidance in ``edit_semantics_block``."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from valkade_backend.llm.messages import build_system_prompt
from valkade_backend.llm.prompt_blocks import chat_rendering_block, edit_semantics_block
from valkade_backend.domain import RuntimeConnection, SessionState


def _conn() -> RuntimeConnection:
    return RuntimeConnection(
        id='c',
        name='test',
        provider='openai',
        base_url='http://127.0.0.1:1234/v1',
        model='test-model',
        api_key='',
        reasoning_effort='',
        temperature=1.0,
        parallel_tool_calls=False,
        optimization_preset='generic',
        max_output_tokens=0,
    )


def test_edit_semantics_describe_write_through_and_reset() -> None:
    block = edit_semantics_block()
    assert 'immediately' in block
    assert 'reset' in block
    assert 'include_line_numbers' not in block or 'replace_workspace_lines' in block
    for removed in ('land_in_workspace', 'transfer_staged_file_to_workspace', 'stage_', 'read_staged_edit'):
        assert removed not in block


def test_edit_semantics_prefers_targeted_edits() -> None:
    block = edit_semantics_block()
    assert 'Prefer `replace_workspace_lines`' in block
    assert '`write_workspace_file`' in block


@patch('valkade_backend.llm.messages.get_active_connection')
@patch('valkade_backend.llm.model_tuning.get_active_connection', create=True)
def test_build_system_prompt_injects_edit_semantics_once(_mt: MagicMock, mock_conn: MagicMock) -> None:
    mock_conn.return_value = _conn()
    for auto_run in (False, True):
        session = SessionState(workspace_path='/tmp/ws', workspace_context='.', auto_apply_mode=auto_run)
        prompt = build_system_prompt(session, apply_mode=True)
        assert prompt.count('**Edit semantics:**') == 1
        assert prompt.count('Never put tool arguments') == 1
        assert 'staged draft' not in prompt
        assert 'transfer_staged_file_to_workspace' not in prompt


def test_chat_rendering_block_names_diagram_and_chart_fences() -> None:
    block = chat_rendering_block()
    assert '```mermaid' in block
    assert '```chart' in block
    assert 'JSON' in block and 'no functions' in block


@patch('valkade_backend.llm.messages.get_active_connection')
@patch('valkade_backend.llm.model_tuning.get_active_connection', create=True)
def test_chat_rendering_block_is_for_the_main_agent_only(_mt: MagicMock, mock_conn: MagicMock) -> None:
    mock_conn.return_value = _conn()
    main = SessionState(workspace_path='/tmp/ws', workspace_context='.')
    assert build_system_prompt(main, apply_mode=True).count('**Rich replies:**') == 1
    # A sub-agent's final message is a report to the main agent, never rendered in chat.
    sub = SessionState(
        workspace_path='/tmp/ws',
        workspace_context='.',
        subagent_parent_session_id='parent',
        subagent_name='scout',
    )
    assert '**Rich replies:**' not in build_system_prompt(sub, apply_mode=True)
