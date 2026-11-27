"""Walk workspace files for semantic indexing (ignores align with workspace tools; PDFs included)."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

from valkade_backend.workspace.workspace_ignore import (
    SEARCH_SKIP_SUFFIXES,
    get_workspace_ignore_rules_cached,
    should_ignore_workspace_entry,
)

# Same as grep search skips except PDFs are indexed semantically, plus compiled/binary artifacts.
_INDEX_SKIP_SUFFIXES: frozenset[str] = frozenset(
    {x for x in SEARCH_SKIP_SUFFIXES if x != '.pdf'}
    | {'.pyc', '.pyo', '.pyd', '.dll', '.exe', '.so', '.dylib', '.whl', '.o', '.obj', '.a', '.lib', '.class', '.jar'}
)

# Virtualenvs, VCS internals, package caches, and tool bundles are never useful in semantic search,
# even when Settings → Tools → "Expose all workspace files" disables `.gitignore` filters.
_SEMANTIC_ALWAYS_IGNORED_DIRS: frozenset[str] = frozenset(
    {
        '.git',
        '.svn',
        '.hg',
        '.venv',
        'venv',
        'node_modules',
        '__pycache__',
        '.pytest_cache',
        '.mypy_cache',
        '.ruff_cache',
        '.angular',
        '.cache',
        '.next',
        '.nuxt',
        '.clara',
        '.nemo',
        '.valkade',
        'runtime-bundle',
        'vtsls-bundle',
    }
)


def _is_always_ignored_semantic_segment(segment: str) -> bool:
    return segment in _SEMANTIC_ALWAYS_IGNORED_DIRS


def iter_index_workspace_files(root: Path, *, max_files: int) -> Iterator[Path]:
    """Yield files under *root* respecting ignore rules, capped at *max_files*."""
    root = root.resolve()
    ignore_rules = get_workspace_ignore_rules_cached(root)
    count = 0
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        rdir = Path(dirpath)
        rel_dir_raw = rdir.relative_to(root).as_posix()
        rel_dir = '' if rel_dir_raw == '.' else rel_dir_raw

        kept: list[str] = []
        for d in dirnames:
            if _is_always_ignored_semantic_segment(d):
                continue
            rel_path = f'{rel_dir}/{d}' if rel_dir else d
            if should_ignore_workspace_entry(d, rel_path, ignore_rules):
                continue
            kept.append(d)
        dirnames[:] = kept

        for fn in filenames:
            if count >= max_files:
                return
            rel_path = f'{rel_dir}/{fn}' if rel_dir else fn
            if should_ignore_workspace_entry(fn, rel_path, ignore_rules):
                continue
            sfx = Path(fn).suffix.lower()
            if sfx in _INDEX_SKIP_SUFFIXES:
                continue
            count += 1
            yield rdir / fn


def is_indexable_workspace_relative_path(root: Path, rel_posix: str) -> bool:
    """True if *rel_posix* under *root* would be yielded by :func:`iter_index_workspace_files` (single-path check)."""
    root = root.resolve()
    rel = rel_posix.strip().replace('\\', '/').lstrip('/')
    if not rel or rel.startswith('../'):
        return False
    parts = [p for p in rel.split('/') if p]
    if any(_is_always_ignored_semantic_segment(part) for part in parts[:-1]):
        return False
    ignore_rules = get_workspace_ignore_rules_cached(root)
    fn = Path(rel).name
    if should_ignore_workspace_entry(fn, rel, ignore_rules):
        return False
    sfx = Path(fn).suffix.lower()
    if sfx in _INDEX_SKIP_SUFFIXES:
        return False
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return candidate.is_file()
