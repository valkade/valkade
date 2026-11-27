"""Tests for the Phase 2 Claude Code local Streamable HTTP MCP bridge."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from valkade_backend.main import app
from valkade_backend.routes import claude_bridge
from valkade_backend.session import state
from valkade_backend.tools.user_terminals import (
    append_user_pty_output,
    clear_all_user_pty_terminals,
    register_user_pty_terminal,
)


def _rpc(method: str, params: dict[str, Any] | None = None, req_id: int | None = 1) -> dict[str, Any]:
    body: dict[str, Any] = {'jsonrpc': '2.0', 'method': method}
    if req_id is not None:
        body['id'] = req_id
    if params is not None:
        body['params'] = params
    return body


def test_mcp_initialize_ping_and_notification(monkeypatch) -> None:
    monkeypatch.setenv('VALKADE_SIDECAR_AUTH_OPTIONAL', '1')
    monkeypatch.delenv('VALKADE_SIDECAR_TOKEN', raising=False)
    monkeypatch.delenv('CLARA_SIDECAR_TOKEN', raising=False)

    with TestClient(app) as client:
        r_init = client.post('/claude-bridge/mcp', json=_rpc('initialize', {'protocolVersion': '2025-03-26'}))
        assert r_init.status_code == 200
        data = r_init.json()
        assert data['id'] == 1
        assert data['result']['protocolVersion'] == '2025-03-26'
        assert data['result']['serverInfo']['name'] == 'valkade'

        r_notif = client.post('/claude-bridge/mcp', json=_rpc('notifications/initialized', {}, req_id=None))
        assert r_notif.status_code == 202

        r_ping = client.post('/claude-bridge/mcp', json=_rpc('ping', {}, req_id=2))
        assert r_ping.status_code == 200
        assert r_ping.json()['result'] == {}

        r_get = client.get('/claude-bridge/mcp')
        assert r_get.status_code == 405


def test_mcp_tools_list_respects_apply_mode_and_web_access(monkeypatch) -> None:
    monkeypatch.setenv('VALKADE_SIDECAR_AUTH_OPTIONAL', '1')
    monkeypatch.delenv('VALKADE_SIDECAR_TOKEN', raising=False)
    monkeypatch.delenv('CLARA_SIDECAR_TOKEN', raising=False)
    prev_web = state.runtime_config.tools.allow_web_access

    try:
        with TestClient(app) as client:
            # Ask / read-only + web off
            state.runtime_config.tools.allow_web_access = False
            r1 = client.post(
                '/claude-bridge/mcp',
                headers={'X-Valkade-Apply-Mode': '0', 'X-Valkade-Allow-Web': '0'},
                json=_rpc('tools/list'),
            )
            names1 = {t['name'] for t in r1.json()['result']['tools']}
            assert 'lsp_get_diagnostics' in names1
            assert 'check_user_terminals' in names1
            assert 'retrieve_workspace_semantic' in names1
            assert 'propose_theme' in names1
            assert 'lsp_rename_symbol' not in names1
            assert 'screenshot_webpage' not in names1
            # Structured zoom tools were excluded by design
            assert 'structured_overview' not in names1

            # Editor mode + web enabled
            state.runtime_config.tools.allow_web_access = True
            r2 = client.post(
                '/claude-bridge/mcp',
                headers={'X-Valkade-Apply-Mode': '1', 'X-Valkade-Allow-Web': '1'},
                json=_rpc('tools/list'),
            )
            names2 = {t['name'] for t in r2.json()['result']['tools']}
            assert 'lsp_rename_symbol' in names2
            assert 'screenshot_webpage' in names2

            # Calling lsp_rename_symbol when apply_mode=0 must be refused
            r_denied = client.post(
                '/claude-bridge/mcp',
                headers={'X-Valkade-Apply-Mode': '0'},
                json=_rpc('tools/call', {'name': 'lsp_rename_symbol', 'arguments': {}}),
            )
            assert r_denied.json()['result']['isError'] is True
            assert 'not enabled' in r_denied.json()['result']['content'][0]['text']
    finally:
        state.runtime_config.tools.allow_web_access = prev_web


def test_mcp_check_user_terminals_and_propose_theme_drain(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv('VALKADE_SIDECAR_AUTH_OPTIONAL', '1')
    monkeypatch.delenv('VALKADE_SIDECAR_TOKEN', raising=False)
    monkeypatch.delenv('CLARA_SIDECAR_TOKEN', raising=False)
    clear_all_user_pty_terminals()
    sid = 'claude-bridge-test-sess'
    claude_bridge.drain_bridge_events(sid)

    try:
        register_user_pty_terminal(
            session_id='pty-1',
            workspace_root=str(tmp_path),
            cwd=str(tmp_path),
            shell='powershell',
        )
        append_user_pty_output('pty-1', 'pytest passed 12 tests\n')

        with TestClient(app) as client:
            r_term = client.post(
                '/claude-bridge/mcp',
                headers={
                    'X-Valkade-Session-Id': sid,
                    'X-Valkade-Workspace-Root': str(tmp_path),
                    'X-Valkade-Apply-Mode': '0',
                },
                json=_rpc('tools/call', {'name': 'check_user_terminals', 'arguments': {}}),
            )
            assert r_term.status_code == 200
            res_term = r_term.json()['result']
            assert res_term['isError'] is False
            assert 'pytest passed 12 tests' in res_term['content'][0]['text']

            # Propose theme validates and queues a theme_proposal UI event for Electron to drain
            r_theme = client.post(
                '/claude-bridge/mcp',
                headers={'X-Valkade-Session-Id': sid, 'X-Valkade-Apply-Mode': '1'},
                json=_rpc(
                    'tools/call',
                    {
                        'name': 'propose_theme',
                        'arguments': {
                            'theme': {
                                'name': 'Solarized Dusk',
                                'mode': 'dark',
                                'tokens': {'--t-primary': '#d4af37', '--t-bg-deep': '#10141c'},
                            },
                            'summary': 'Warm dusk theme with gold accent.',
                        },
                    },
                ),
            )
            res_theme = r_theme.json()['result']
            assert res_theme['isError'] is False
            assert 'Solarized Dusk' in res_theme['content'][0]['text']

            r_drain = client.post('/claude-bridge/events/drain', json={'session_id': sid})
            events = r_drain.json()['events']
            assert len(events) == 1
            assert events[0]['type'] == 'theme_proposal'
            assert events[0]['themeProposal']['theme']['name'] == 'Solarized Dusk'

            # Second drain is empty
            r_drain2 = client.post('/claude-bridge/events/drain', json={'session_id': sid})
            assert r_drain2.json()['events'] == []
    finally:
        clear_all_user_pty_terminals()
        state.sessions.pop(sid, None)
        claude_bridge.drain_bridge_events(sid)


def test_mcp_semantic_returns_promptly_while_index_lock_is_held(monkeypatch, tmp_path: Path) -> None:
    import threading
    from unittest.mock import MagicMock
    from valkade_backend.workspace_index import embeddings_factory as ef
    from valkade_backend.workspace_index.index_build import workspace_index_lock

    monkeypatch.setenv('VALKADE_SIDECAR_AUTH_OPTIONAL', '1')
    monkeypatch.delenv('VALKADE_SIDECAR_TOKEN', raising=False)
    monkeypatch.delenv('CLARA_SIDECAR_TOKEN', raising=False)
    monkeypatch.setattr(claude_bridge, '_SEMANTIC_BRIDGE_WAIT_SEC', 0.15)
    monkeypatch.setattr(ef, 'build_embedding_model', lambda _conn: (MagicMock(), ''))

    sid = 'claude-bridge-sem-lock'
    wid = 'ws-sem-lock'
    lock = workspace_index_lock(wid, tmp_path)
    hold_ready = threading.Event()
    release_hold = threading.Event()

    def _holder() -> None:
        with lock:
            hold_ready.set()
            release_hold.wait(timeout=5.0)

    t = threading.Thread(target=_holder, daemon=True)
    t.start()
    assert hold_ready.wait(timeout=2.0)

    try:
        with TestClient(app) as client:
            resp = client.post(
                '/claude-bridge/mcp',
                headers={
                    'X-Valkade-Session-Id': sid,
                    'X-Valkade-Workspace-Root': str(tmp_path),
                    'X-Valkade-Workspace-Id': wid,
                    'X-Valkade-Apply-Mode': '0',
                },
                json=_rpc(
                    'tools/call',
                    {'name': 'retrieve_workspace_semantic', 'arguments': {'query': 'where is auth?'}},
                ),
            )
            assert resp.status_code == 200
            result = resp.json()['result']
            assert result['isError'] is False
            text = result['content'][0]['text']
            assert 'building in the background' in text
    finally:
        release_hold.set()
        t.join(timeout=2.0)
        state.sessions.pop(sid, None)


def test_semantic_walk_skips_venv_git_and_node_modules_even_when_expose_all_enabled(tmp_path: Path) -> None:
    from valkade_backend.workspace_index.walk import is_indexable_workspace_relative_path, iter_index_workspace_files

    (tmp_path / 'src').mkdir()
    (tmp_path / 'src' / 'app.ts').write_text('export const x = 1;\n', encoding='utf-8')
    (tmp_path / '.venv' / 'Lib').mkdir(parents=True)
    (tmp_path / '.venv' / 'Lib' / 'pkg.py').write_text('x = 1\n', encoding='utf-8')
    (tmp_path / '.git' / 'objects').mkdir(parents=True)
    (tmp_path / '.git' / 'objects' / 'pack.txt').write_text('pack\n', encoding='utf-8')
    (tmp_path / 'node_modules' / 'foo').mkdir(parents=True)
    (tmp_path / 'node_modules' / 'foo' / 'index.js').write_text('module.exports = 1;\n', encoding='utf-8')

    prev = state.runtime_config.tools.expose_all_workspace_files
    try:
        state.runtime_config.tools.expose_all_workspace_files = True
        found = [p.relative_to(tmp_path).as_posix() for p in iter_index_workspace_files(tmp_path, max_files=100)]
        assert found == ['src/app.ts']
        assert is_indexable_workspace_relative_path(tmp_path, 'src/app.ts') is True
        assert is_indexable_workspace_relative_path(tmp_path, '.venv/Lib/pkg.py') is False
        assert is_indexable_workspace_relative_path(tmp_path, '.git/objects/pack.txt') is False
    finally:
        state.runtime_config.tools.expose_all_workspace_files = prev


def test_mcp_semantic_reports_background_build_error_immediately(monkeypatch, tmp_path: Path) -> None:
    from unittest.mock import MagicMock
    from valkade_backend.workspace_index import embeddings_factory as ef
    from valkade_backend.workspace_index import index_build

    monkeypatch.setenv('VALKADE_SIDECAR_AUTH_OPTIONAL', '1')
    monkeypatch.delenv('VALKADE_SIDECAR_TOKEN', raising=False)
    monkeypatch.delenv('CLARA_SIDECAR_TOKEN', raising=False)
    monkeypatch.setattr(ef, 'build_embedding_model', lambda _conn: (MagicMock(), ''))

    def _boom(*_args, **_kwargs):
        raise RuntimeError('disk full')

    monkeypatch.setattr(index_build, 'load_or_rebuild_workspace_index', _boom)

    sid = 'claude-bridge-sem-err'
    try:
        with TestClient(app) as client:
            resp = client.post(
                '/claude-bridge/mcp',
                headers={
                    'X-Valkade-Session-Id': sid,
                    'X-Valkade-Workspace-Root': str(tmp_path),
                    'X-Valkade-Workspace-Id': 'ws-sem-err',
                    'X-Valkade-Apply-Mode': '0',
                },
                json=_rpc(
                    'tools/call',
                    {'name': 'retrieve_workspace_semantic', 'arguments': {'query': 'auth'}},
                ),
            )
            assert resp.status_code == 200
            result = resp.json()['result']
            assert result['isError'] is True
            assert 'disk full' in result['content'][0]['text']
    finally:
        state.sessions.pop(sid, None)


