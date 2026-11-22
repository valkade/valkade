"""Workspace-local ValkAde metadata directory (``.valkade``; ``.clara`` and ``.nemo`` before it)."""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any

WORKSPACE_META_DIR = '.valkade'
#: Older names of the meta dir, newest first; migration brings each into ``.valkade``.
LEGACY_WORKSPACE_META_DIRS = ('.clara', '.nemo')
SYSTEM_PROMPT_FILENAME = 'system-prompt.md'
BUILD_PLANS_DIR_NAME = 'build-plans'
BUILD_PLANS_REL_DIR = f'{WORKSPACE_META_DIR}/{BUILD_PLANS_DIR_NAME}'
LEGACY_BUILD_PLANS_REL_DIRS = tuple(f'{d}/{BUILD_PLANS_DIR_NAME}' for d in LEGACY_WORKSPACE_META_DIRS)
SYSTEM_PROMPT_RELATIVE_PATH = f'{WORKSPACE_META_DIR}/{SYSTEM_PROMPT_FILENAME}'
INDEX_FILENAME = 'index.json'
#: The user's project check commands for end-of-turn verification (see :mod:`valkade_backend.verify`).
CHECKS_FILENAME = 'checks.json'
CHECKS_RELATIVE_PATH = f'{WORKSPACE_META_DIR}/{CHECKS_FILENAME}'

_BUILD_PLANS_PREFIX = f'{BUILD_PLANS_REL_DIR}/'

logger = logging.getLogger('clara.workspace.meta')


#: Why a file tool refused (no ``Tool error:`` prefix and no final stop; each tool adds its own).
USER_OWNED_META_REASON = (
    f'`{CHECKS_RELATIVE_PATH}` holds commands that run without an approval card, so only the user changes it; '
    'tell the user what to change in it instead'
)


def _meta_path_key(relative_path: str) -> str:
    """The path as the file system resolves it, for comparing against the user-owned meta files.

    Case-folded, because Windows and macOS folders are case-insensitive. Each part also loses an
    NTFS stream suffix (``checks.json::$DATA``) and trailing dots and spaces, which Windows drops
    when it opens a file: ``.valkade./checks.json.`` writes ``.valkade/checks.json``.
    """
    parts = (relative_path or '').strip().replace('\\', '/').casefold().split('/')
    cleaned = (part.split(':', 1)[0].rstrip(' .') for part in parts)
    return '/'.join(part for part in cleaned if part)


def is_user_owned_meta_path(relative_path: str) -> bool:
    """True for the checks file (also under the legacy ``.clara`` and ``.nemo``, which migration copies into ``.valkade``).

    The agent's file tools refuse to write, copy onto or delete it: its commands run unasked in a
    trusted workspace.
    """
    return _meta_path_key(relative_path) in {
        f'{d}/{CHECKS_FILENAME}'.casefold() for d in (WORKSPACE_META_DIR, *LEGACY_WORKSPACE_META_DIRS)
    }


def holds_user_owned_meta_file(root: Path, relative_dir: str) -> bool:
    """True when ``relative_dir`` is a meta directory that contains the checks file (deleting it would too)."""
    n = _meta_path_key(relative_dir)
    if n not in {d.casefold() for d in (WORKSPACE_META_DIR, *LEGACY_WORKSPACE_META_DIRS)}:
        return False
    return (root / relative_dir / CHECKS_FILENAME).is_file()


def rewrite_legacy_build_plan_relative_path(relative_path: str) -> str:
    """Map ``.clara/build-plans/...`` and ``.nemo/build-plans/...`` to ``.valkade/build-plans/...``."""
    n = (relative_path or '').replace('\\', '/')
    for legacy_dir in LEGACY_BUILD_PLANS_REL_DIRS:
        if n.startswith(f'{legacy_dir}/'):
            return _BUILD_PLANS_PREFIX + n[len(legacy_dir) + 1 :]
        if n == legacy_dir:
            return BUILD_PLANS_REL_DIR
    return n


def _rewrite_build_plan_index_file(index_path: Path) -> None:
    if not index_path.is_file():
        return
    try:
        data = json.loads(index_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(data, list):
        return
    changed = False
    rewritten: list[Any] = []
    for entry in data:
        if not isinstance(entry, dict):
            rewritten.append(entry)
            continue
        rel = str(entry.get('relativePath') or '')
        next_rel = rewrite_legacy_build_plan_relative_path(rel)
        if next_rel != rel:
            entry = {**entry, 'relativePath': next_rel}
            changed = True
        rewritten.append(entry)
    if changed:
        index_path.write_text(json.dumps(rewritten, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def _read_index_entries(index_path: Path) -> list[dict[str, Any]]:
    if not index_path.is_file():
        return []
    try:
        data = json.loads(index_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    return [entry for entry in data if isinstance(entry, dict)]


def _with_rewritten_relative_path(entry: dict[str, Any]) -> dict[str, Any]:
    rel = str(entry.get('relativePath') or '')
    next_rel = rewrite_legacy_build_plan_relative_path(rel)
    if next_rel == rel:
        return entry
    return {**entry, 'relativePath': next_rel}


def _merge_build_plan_index_entries(
    current_entries: list[dict[str, Any]],
    legacy_entries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Union by ``id``, preferring the current dir's entries when ids collide."""
    seen_ids: set[str] = set()
    merged: list[dict[str, Any]] = []
    for entry in current_entries:
        rewritten = _with_rewritten_relative_path(entry)
        eid = str(rewritten.get('id') or '')
        if eid:
            seen_ids.add(eid)
        merged.append(rewritten)
    for entry in legacy_entries:
        rewritten = _with_rewritten_relative_path(entry)
        eid = str(rewritten.get('id') or '')
        if eid and eid in seen_ids:
            continue
        if eid:
            seen_ids.add(eid)
        merged.append(rewritten)
    return merged


def _copy_missing_files(src_root: Path, dest_root: Path) -> None:
    """Recursively copy files from ``src_root`` that are absent under ``dest_root``."""
    try:
        for src in src_root.rglob('*'):
            try:
                if not src.is_file():
                    continue
                dest = dest_root / src.relative_to(src_root)
                if dest.exists():
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
            except OSError as exc:
                logger.warning('[workspace-meta] Failed to copy legacy metadata file: %s', exc)
    except OSError as exc:
        logger.warning('[workspace-meta] Failed to copy legacy metadata dir: %s', exc)


def _write_merged_index(index_path: Path, entries: list[dict[str, Any]]) -> None:
    try:
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(
            json.dumps(entries, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
    except OSError as exc:
        logger.warning('[workspace-meta] Failed to write merged build-plan index: %s', exc)


def _migrate_one_legacy_meta_dir(legacy: Path, current: Path) -> None:
    try:
        if legacy.is_dir() and not current.exists():
            legacy.rename(current)
        elif legacy.is_dir() and current.exists():
            _copy_missing_files(legacy, current)
            merged = _merge_build_plan_index_entries(
                _read_index_entries(current / BUILD_PLANS_DIR_NAME / INDEX_FILENAME),
                _read_index_entries(legacy / BUILD_PLANS_DIR_NAME / INDEX_FILENAME),
            )
            _write_merged_index(current / BUILD_PLANS_DIR_NAME / INDEX_FILENAME, merged)
    except OSError as exc:
        logger.warning('[workspace-meta] Failed to migrate legacy metadata dir %s: %s', legacy, exc)


def migrate_legacy_workspace_meta_dir(workspace_root: str | Path) -> None:
    """Bring each legacy dir (``.clara``, then ``.nemo``) into ``{root}/.valkade``.

    A legacy dir is renamed when ``.valkade`` does not exist yet. Otherwise its missing files are
    copied in (no overwrite), ``build-plans/index.json`` is merged (the current entry wins on an id
    collision), and the legacy dir is left in place. Afterwards, rewrite ``build-plans/index.json``
    relativePath values.
    """
    if not (str(workspace_root) or '').strip():
        return
    root = Path(workspace_root).resolve()
    current = root / WORKSPACE_META_DIR
    for legacy_name in LEGACY_WORKSPACE_META_DIRS:
        _migrate_one_legacy_meta_dir(root / legacy_name, current)
    index_path = current / BUILD_PLANS_DIR_NAME / INDEX_FILENAME
    try:
        _rewrite_build_plan_index_file(index_path)
    except OSError as exc:
        logger.warning('[workspace-meta] Failed to rewrite build-plan index paths: %s', exc)
