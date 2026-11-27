"""Local Streamable HTTP MCP bridge exposing ValkAde workspace tools to Claude Code CLI.

Mounted on the authenticated Python sidecar at ``POST /claude-bridge/mcp``. Electron passes
a per-turn ``--mcp-config`` file with ``Authorization: Bearer <sidecar-token>`` plus
``X-Valkade-Session-Id``, ``X-Valkade-Workspace-Root``, ``X-Valkade-Workspace-Id``,
``X-Valkade-Apply-Mode``, and ``X-Valkade-Allow-Web`` headers.

Exposes only the curated ValkAde-only tool groups that Claude Code lacks natively:
- LSP intelligence (all ``LSP_READ_TOOLS``, plus ``lsp_rename_symbol`` when Editor mode is on)
- Integrated user terminal inspection (``check_user_terminals``)
- Semantic workspace retrieval (``retrieve_workspace_semantic``)
- Public webpage screenshots (``screenshot_webpage``, only when web access is enabled)
- App theme proposals (``propose_theme``), queuing UI ``theme_proposal`` cards for Electron to drain
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import threading
import uuid
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from valkade_backend.session import state
from valkade_backend.theme.propose_theme import (
    PROPOSE_THEME_NAME,
    build_theme_proposal_payload,
    propose_theme_tool,
    validate_theme_proposal,
)
from valkade_backend.tools.lsp_rename import LSP_RENAME_SYMBOL_NAME, lsp_rename_symbol
from valkade_backend.tools.lsp_tools import LSP_READ_TOOLS
from valkade_backend.tools.screenshot_webpage import SCREENSHOT_WEBPAGE_NAME, screenshot_webpage_tool
from valkade_backend.tools.semantic import RETRIEVE_WORKSPACE_SEMANTIC_NAME, retrieve_workspace_semantic
from valkade_backend.tools.user_terminals import CHECK_USER_TERMINALS_NAME, check_user_terminals_tool

logger = logging.getLogger('valkade.claude_bridge')

router = APIRouter(prefix='/claude-bridge', tags=['claude-bridge'])

_DEFAULT_MCP_PROTOCOL_VERSION = '2025-03-26'
_SERVER_INFO = {'name': 'valkade', 'version': '0.6.2'}

# Keep MCP `tools/call` responses well under Claude Code's ~60s HTTP MCP timeout so a first-time
# CPU index build on a large workspace never causes a silent timeout.
_SEMANTIC_BRIDGE_WAIT_SEC = 15.0
_SEMANTIC_BRIDGE_BUILD_WAIT_SEC = 20.0
_SEMANTIC_BRIDGE_QUERY_TIMEOUT_SEC = 25.0

_MAX_PENDING_EVENTS_PER_SESSION = 32
_MAX_PENDING_EVENT_SESSIONS = 64
_PENDING_BRIDGE_EVENTS: dict[str, deque[dict[str, Any]]] = {}

_PROPOSE_THEME_MCP_DESCRIPTION = (
    'Propose a complete ValkAde UI theme the user can preview live and save from a card in chat. '
    'Pass `theme` = {name, mode: "dark"|"light", description?, tokens: {"--t-bg-deep", "--t-bg-surface", '
    '"--t-fg", "--t-primary", "--t-border", ...}, groups?: {"<category>.<name>": {tokens?, css?, '
    'background?: {opacity, fit}}}, monaco?: {base, colors, rules}} and a short `summary` (1-2 sentences). '
    'Unknown token names are dropped and reported in the tool response.'
)


def _enqueue_bridge_event(session_id: str, event: dict[str, Any]) -> None:
    q = _PENDING_BRIDGE_EVENTS.get(session_id)
    if q is None:
        while len(_PENDING_BRIDGE_EVENTS) >= _MAX_PENDING_EVENT_SESSIONS:
            oldest = next(iter(_PENDING_BRIDGE_EVENTS))
            _PENDING_BRIDGE_EVENTS.pop(oldest, None)
        q = deque(maxlen=_MAX_PENDING_EVENTS_PER_SESSION)
        _PENDING_BRIDGE_EVENTS[session_id] = q
    q.append(event)


def drain_bridge_events(session_id: str) -> list[dict[str, Any]]:
    """Pop all queued side-channel UI events (such as ``theme_proposal``) for *session_id*."""
    sid = (session_id or '').strip()
    if not sid:
        return []
    q = _PENDING_BRIDGE_EVENTS.pop(sid, None)
    return list(q) if q else []


def _parse_bool_header(request: Request, name: str) -> bool:
    raw = (request.headers.get(name) or '').strip().lower()
    return raw in ('1', 'true', 'yes', 'on')


def _ensure_bridge_session_workspace(
    session_id: str,
    workspace_root: str,
    workspace_id: str,
) -> None:
    """Ensure the Python session knows the active workspace even before any LangGraph turn."""
    sess = state.get_session(session_id)
    root = (workspace_root or '').strip()
    wid = (workspace_id or '').strip()
    if root:
        try:
            resolved = str(Path(root).expanduser().resolve())
        except OSError:
            resolved = root
        if resolved != (sess.workspace_path or '').strip():
            sess.workspace_path = resolved
    if wid and wid != (sess.workspace_id or '').strip():
        sess.workspace_id = wid


def _bridge_tools_for_request(*, apply_mode: bool, allow_web: bool) -> list[Any]:
    """Curated ValkAde-only tool list available for this Claude Code turn."""
    tools: list[Any] = [
        *LSP_READ_TOOLS,
        check_user_terminals_tool,
        retrieve_workspace_semantic,
        propose_theme_tool,
    ]
    if apply_mode:
        tools.append(lsp_rename_symbol)
    if allow_web and bool(getattr(state.runtime_config.tools, 'allow_web_access', False)):
        tools.append(screenshot_webpage_tool)
    return tools


def _tool_input_schema(tool_obj: Any) -> dict[str, Any]:
    """Extract a clean JSON Schema ``object`` descriptor from a LangChain tool."""
    schema_model = getattr(tool_obj, 'args_schema', None)
    if schema_model is not None and hasattr(schema_model, 'model_json_schema'):
        try:
            raw = schema_model.model_json_schema()
            if isinstance(raw, dict):
                out: dict[str, Any] = {
                    'type': 'object',
                    'properties': raw.get('properties', {}),
                }
                if isinstance(raw.get('required'), list) and raw['required']:
                    out['required'] = raw['required']
                if isinstance(raw.get('$defs'), dict) and raw['$defs']:
                    out['$defs'] = raw['$defs']
                return out
        except Exception:
            logger.debug('Failed to derive JSON schema for tool %s', getattr(tool_obj, 'name', '?'), exc_info=True)
    return {'type': 'object', 'properties': {}}


def _mcp_tool_descriptor(tool_obj: Any) -> dict[str, Any]:
    name = str(getattr(tool_obj, 'name', '') or '')
    desc = _PROPOSE_THEME_MCP_DESCRIPTION if name == PROPOSE_THEME_NAME else str(getattr(tool_obj, 'description', '') or '')
    return {
        'name': name,
        'description': desc,
        'inputSchema': _tool_input_schema(tool_obj),
    }


def _jsonrpc_result(req_id: Any, result: dict[str, Any]) -> JSONResponse:
    return JSONResponse({'jsonrpc': '2.0', 'id': req_id, 'result': result})


def _jsonrpc_error(req_id: Any, code: int, message: str, *, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        {'jsonrpc': '2.0', 'id': req_id, 'error': {'code': code, 'message': message}},
        status_code=status_code,
    )


def _run_propose_theme_bridge(session_id: str, arguments: dict[str, Any]) -> tuple[str, bool]:
    """Validate a theme proposal and queue a ``theme_proposal`` UI card for Electron to drain."""
    theme = arguments.get('theme')
    summary = str(arguments.get('summary') or '')
    doc, notes = validate_theme_proposal(theme)
    if doc is None:
        return 'Tool error: ' + '; '.join(notes), True

    payload = build_theme_proposal_payload(doc, summary, notes)
    _enqueue_bridge_event(session_id, {'type': 'theme_proposal', 'themeProposal': payload})

    token_count = len(doc['tokens'])
    group_count = len(doc['groups'])
    summary_line = (
        f"Proposed theme \"{doc['name']}\" ({doc['mode']}, {token_count} tokens, {group_count} group override"
        f"{'' if group_count == 1 else 's'}"
        f"{', custom Monaco palette' if doc.get('monaco') else ''}). "
        'The user can preview, save, or dismiss it from the card in chat.'
    )
    if notes:
        ordered = sorted(notes, key=lambda n: '.css' not in n.split(':', 1)[0])
        shown = ordered[:8]
        more = f' (+{len(notes) - 8} more)' if len(notes) > 8 else ''
        summary_line += ' Dropped/adjusted: ' + '; '.join(shown) + more + '.'
    return summary_line, False


def _maybe_warmup_semantic_index(session_id: str) -> None:
    """Kick off background semantic indexing early if this workspace has no compatible index yet."""
    try:
        from valkade_backend.workspace_index.embeddings_factory import (
            embeddings_available,
            resolve_embedding_model_id,
        )
        from valkade_backend.workspace_index.incremental import schedule_semantic_index_background
        from valkade_backend.workspace_index.index_build import (
            _manifest_compatible,
            manifest_embedding_model_id,
            read_manifest,
        )
        from valkade_backend.workspace_index.paths import workspace_index_persist_dir

        sess = state.get_session(session_id)
        root_s = (sess.workspace_path or '').strip()
        if not root_s:
            return
        conn = state.get_main_connection()
        ok, _ = embeddings_available(conn)
        if not ok:
            return
        root = Path(root_s).resolve()
        wid = (sess.workspace_id or '').strip()
        pdir = workspace_index_persist_dir(wid, root)
        model = manifest_embedding_model_id(resolve_embedding_model_id(conn))
        if not _manifest_compatible(read_manifest(pdir), root=root, model=model, pdir=pdir):
            schedule_semantic_index_background(session_id, ensure_corpus=True)
    except Exception:
        logger.debug('Claude bridge semantic warmup skipped session=%s', session_id, exc_info=True)


async def _run_semantic_bridge(session_id: str, arguments: dict[str, Any]) -> tuple[str, bool]:
    """Run ``retrieve_workspace_semantic`` with bounded wait so MCP HTTP never times out on full builds."""
    from valkade_backend.workspace_index.embeddings_factory import (
        build_embedding_model,
        resolve_embedding_model_id,
    )
    from valkade_backend.workspace_index.index_build import (
        _manifest_compatible,
        load_or_rebuild_workspace_index,
        manifest_embedding_model_id,
        read_manifest,
        workspace_index_lock,
    )
    from valkade_backend.workspace_index.paths import workspace_index_persist_dir

    query = str(arguments.get('query') or '').strip()
    if not query:
        return 'Semantic index: empty query.', False
    try:
        top_k = max(1, min(int(arguments.get('top_k', 8)), 25))
    except (TypeError, ValueError):
        top_k = 8

    sess = state.get_session(session_id)
    root_s = (sess.workspace_path or '').strip()
    if not root_s:
        return 'Semantic index: no workspace is attached to this conversation.', False

    conn = state.get_main_connection()
    mid = resolve_embedding_model_id(conn)
    embed_model, err = build_embedding_model(conn)
    if embed_model is None:
        return err or 'Semantic index unavailable.', False

    root = Path(root_s).resolve()
    wid = (sess.workspace_id or '').strip()
    pdir = workspace_index_persist_dir(wid, root)
    model_id = manifest_embedding_model_id(mid)
    lock = workspace_index_lock(wid, root)

    def _probe_or_wait_for_lock(wait_sec: float) -> tuple[bool, bool]:
        """Return ``(acquired, has_compatible_manifest)`` without holding the lock on return."""
        acquired = lock.acquire(timeout=max(0.01, wait_sec))
        if not acquired:
            return False, False
        try:
            compatible = _manifest_compatible(read_manifest(pdir), root=root, model=model_id, pdir=pdir)
            return True, compatible
        finally:
            lock.release()

    acquired, compatible = await asyncio.to_thread(_probe_or_wait_for_lock, 0.05)
    if not acquired:
        # Another thread is currently building or reconciling this workspace's index.
        # Wait briefly in case it is almost done, then return promptly before MCP times out.
        acquired, compatible = await asyncio.to_thread(_probe_or_wait_for_lock, _SEMANTIC_BRIDGE_WAIT_SEC)
        if not acquired:
            return (
                'Semantic index is currently building in the background for this workspace '
                '(first-time indexing on large repos can take 1–3 minutes on CPU). '
                'Use Grep/Glob/Read for now and retry `retrieve_workspace_semantic` once indexing completes.'
            ), False

    if not compatible:
        # First-ever build: run it on a daemon background thread and wait briefly so small
        # workspaces still answer on the first call, while large ones never time out MCP.
        done_evt = threading.Event()
        build_error: list[str] = []

        def _build_in_bg() -> None:
            try:
                load_or_rebuild_workspace_index(
                    root,
                    wid,
                    embed_model,
                    fingerprint_override=None,
                    embedding_model_id=mid,
                )
            except Exception as exc:
                logger.warning('Background semantic build failed for %s', root, exc_info=True)
                build_error.append(f'{type(exc).__name__}: {exc}')
            finally:
                done_evt.set()

        threading.Thread(target=_build_in_bg, name='claude-bridge-semantic-build', daemon=True).start()
        finished = await asyncio.to_thread(done_evt.wait, _SEMANTIC_BRIDGE_BUILD_WAIT_SEC)
        if not finished:
            return (
                'Semantic index build started in the background for this workspace and is still indexing. '
                'Use Grep/Glob/Read for now and retry `retrieve_workspace_semantic` in a moment.'
            ), False
        if build_error:
            return f'Tool error: Semantic index build failed: {build_error[0]}', True

    # Index exists on disk (or just finished building): run the actual semantic query with a bounded wait.
    tok_sid = state.current_session_id.set(session_id)
    tok_apply = state.current_stream_apply_mode.set(False)
    tok_call = state.current_tool_call_id.set(f'claude-mcp-{uuid.uuid4().hex[:12]}')
    try:
        ctx = contextvars.copy_context()
        raw = await asyncio.wait_for(
            asyncio.to_thread(ctx.run, retrieve_workspace_semantic.invoke, {'query': query, 'top_k': top_k}),
            timeout=_SEMANTIC_BRIDGE_QUERY_TIMEOUT_SEC,
        )
        text = raw if isinstance(raw, str) else str(raw)
        return text, text.startswith('Tool error:')
    except asyncio.TimeoutError:
        return (
            'Semantic index is still updating in the background for this workspace. '
            'Use Grep/Glob/Read for now and retry `retrieve_workspace_semantic` shortly.'
        ), False
    except Exception as exc:
        logger.warning('Claude MCP bridge semantic retrieval failed: %s', exc, exc_info=True)
        return f'Tool error: {type(exc).__name__}: {exc}', True
    finally:
        state.current_tool_call_id.reset(tok_call)
        state.current_stream_apply_mode.reset(tok_apply)
        state.current_session_id.reset(tok_sid)


async def _invoke_bridge_tool(
    tool_obj: Any,
    tool_name: str,
    arguments: dict[str, Any],
    *,
    session_id: str,
    apply_mode: bool,
) -> tuple[str, bool]:
    """Invoke one ValkAde tool with session/apply-mode ContextVars bound."""
    if tool_name == PROPOSE_THEME_NAME:
        return _run_propose_theme_bridge(session_id, arguments)
    if tool_name == RETRIEVE_WORKSPACE_SEMANTIC_NAME:
        return await _run_semantic_bridge(session_id, arguments)

    tok_sid = state.current_session_id.set(session_id)
    tok_apply = state.current_stream_apply_mode.set(apply_mode)
    tok_call = state.current_tool_call_id.set(f'claude-mcp-{uuid.uuid4().hex[:12]}')
    try:
        if getattr(tool_obj, 'coroutine', None) is not None:
            raw = await tool_obj.ainvoke(arguments)
        else:
            ctx = contextvars.copy_context()
            raw = await asyncio.to_thread(ctx.run, tool_obj.invoke, arguments)
        text = raw if isinstance(raw, str) else str(raw)
        is_err = text.startswith('Tool error:')
        return text, is_err
    except Exception as exc:
        logger.warning('Claude MCP bridge tool %s failed: %s', tool_name, exc, exc_info=True)
        return f'Tool error: {type(exc).__name__}: {exc}', True
    finally:
        state.current_tool_call_id.reset(tok_call)
        state.current_stream_apply_mode.reset(tok_apply)
        state.current_session_id.reset(tok_sid)


@router.get('/mcp')
async def claude_bridge_mcp_get() -> Response:
    """Stateless Streamable HTTP server: no server-initiated GET SSE stream."""
    return Response(status_code=405, headers={'Allow': 'POST, DELETE'})


@router.delete('/mcp')
async def claude_bridge_mcp_delete() -> JSONResponse:
    return JSONResponse({'ok': True})


@router.post('/mcp')
async def claude_bridge_mcp_post(request: Request) -> Response:
    """Handle one JSON-RPC 2.0 MCP message from Claude Code CLI."""
    try:
        body = await request.json()
    except Exception:
        return _jsonrpc_error(None, -32700, 'Parse error', status_code=400)

    if not isinstance(body, dict) or body.get('jsonrpc') != '2.0':
        return _jsonrpc_error(None, -32600, 'Invalid JSON-RPC 2.0 request', status_code=400)

    method = body.get('method')
    req_id = body.get('id')
    params = body.get('params') if isinstance(body.get('params'), dict) else {}

    # JSON-RPC notifications (no `id`) receive 202 Accepted with an empty body.
    if 'id' not in body or req_id is None:
        return Response(status_code=202)

    if not isinstance(method, str) or not method:
        return _jsonrpc_error(req_id, -32600, 'Missing method')

    if method == 'initialize':
        client_ver = params.get('protocolVersion')
        protocol_version = (
            client_ver.strip()
            if isinstance(client_ver, str) and client_ver.strip()
            else _DEFAULT_MCP_PROTOCOL_VERSION
        )
        return _jsonrpc_result(
            req_id,
            {
                'protocolVersion': protocol_version,
                'capabilities': {'tools': {}},
                'serverInfo': _SERVER_INFO,
            },
        )

    if method == 'ping':
        return _jsonrpc_result(req_id, {})

    session_id = (request.headers.get('x-valkade-session-id') or '').strip() or 'claude-bridge-default'
    workspace_root = (request.headers.get('x-valkade-workspace-root') or '').strip()
    workspace_id = (request.headers.get('x-valkade-workspace-id') or '').strip()
    apply_mode = _parse_bool_header(request, 'x-valkade-apply-mode')
    allow_web = _parse_bool_header(request, 'x-valkade-allow-web')

    tools = _bridge_tools_for_request(apply_mode=apply_mode, allow_web=allow_web)

    if method == 'tools/list':
        if workspace_root:
            _ensure_bridge_session_workspace(session_id, workspace_root, workspace_id)
            _maybe_warmup_semantic_index(session_id)
        return _jsonrpc_result(req_id, {'tools': [_mcp_tool_descriptor(t) for t in tools]})

    if method == 'tools/call':
        tool_name = str(params.get('name') or '').strip()
        raw_args = params.get('arguments')
        arguments = raw_args if isinstance(raw_args, dict) else {}
        tool_map = {str(getattr(t, 'name', '')): t for t in tools}
        tool_obj = tool_map.get(tool_name)
        if tool_obj is None:
            return _jsonrpc_result(
                req_id,
                {
                    'content': [{'type': 'text', 'text': f'Tool error: `{tool_name}` is not enabled for this turn.'}],
                    'isError': True,
                },
            )
        _ensure_bridge_session_workspace(session_id, workspace_root, workspace_id)
        text, is_err = await _invoke_bridge_tool(
            tool_obj,
            tool_name,
            arguments,
            session_id=session_id,
            apply_mode=apply_mode,
        )
        return _jsonrpc_result(
            req_id,
            {
                'content': [{'type': 'text', 'text': text}],
                'isError': is_err,
            },
        )

    return _jsonrpc_error(req_id, -32601, f'Method not found: {method}')


@router.post('/events/drain')
async def claude_bridge_drain_events(request: Request) -> JSONResponse:
    """Drain side-channel UI events (such as ``theme_proposal`` cards) for one conversation."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    raw_sid = ''
    if isinstance(body, dict):
        raw_sid = str(body.get('session_id') or body.get('sessionId') or '').strip()
    return JSONResponse({'events': drain_bridge_events(raw_sid)})


__all__ = [
    'CHECK_USER_TERMINALS_NAME',
    'LSP_RENAME_SYMBOL_NAME',
    'PROPOSE_THEME_NAME',
    'RETRIEVE_WORKSPACE_SEMANTIC_NAME',
    'SCREENSHOT_WEBPAGE_NAME',
    'drain_bridge_events',
    'router',
]
