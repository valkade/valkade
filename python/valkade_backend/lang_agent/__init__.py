"""LangChain / LangGraph agent core for the ValkAde sidecar.

Composer dispatch (agent vs plan mode) lives in :mod:`valkade_backend.composer`.

Modules
-------
``graph`` — ``create_agent`` outer graph builder and stream runner
``loop`` — turn outcomes and history-commit policy
``context_compaction`` — the pure part of context compaction (budgets, cut, view, digest, tool caps)
``streaming`` — shared SSE JSON helpers (status, chunks, read-tool mirroring)
``pause`` — compatibility re-export of :mod:`valkade_backend.session.pause`
``question`` — plan-mode question HITL staging and resolution
``langgraph_sse`` — LangGraph event → SSE line mapping
"""
