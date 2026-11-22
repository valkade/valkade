"""``clara_coder_backend`` stays importable as an alias of ``valkade_backend`` (old checkpoints name it)."""

from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path

import pytest

import valkade_backend
import valkade_backend.domain

PYTHON_ROOT = Path(__file__).resolve().parents[1]


def test_top_level_import_is_the_new_package() -> None:
    import clara_coder_backend

    assert clara_coder_backend is valkade_backend
    assert sys.modules['clara_coder_backend'] is valkade_backend


def test_nested_submodule_import_is_the_same_module_object() -> None:
    import clara_coder_backend.runtime.deps.registry as legacy
    import valkade_backend.runtime.deps.registry as current

    assert legacy is current
    assert sys.modules['clara_coder_backend.runtime.deps.registry'] is current
    assert sys.modules['clara_coder_backend.runtime.deps'] is sys.modules['valkade_backend.runtime.deps']


def test_from_import_gives_identical_classes() -> None:
    from clara_coder_backend.domain import SessionState, SessionWorkspaceState
    from clara_coder_backend.session.schemas import ChatRequest

    from valkade_backend.session import schemas

    assert SessionState is valkade_backend.domain.SessionState
    assert SessionWorkspaceState is valkade_backend.domain.SessionWorkspaceState
    assert ChatRequest is schemas.ChatRequest


def test_checkpoint_style_lookup_resolves_to_the_new_class() -> None:
    """JsonPlusSerializer rebuilds objects with ``import_module(module)`` + ``getattr(name)``."""
    cls = getattr(importlib.import_module('clara_coder_backend.domain'), 'SessionWorkspaceState')

    assert cls is valkade_backend.domain.SessionWorkspaceState
    assert isinstance(cls(), valkade_backend.domain.SessionWorkspaceState)


def test_alias_keeps_the_real_module_spec() -> None:
    importlib.import_module('clara_coder_backend.domain')

    assert valkade_backend.domain.__spec__ is not None
    assert valkade_backend.domain.__spec__.name == 'valkade_backend.domain'
    assert valkade_backend.domain.__name__ == 'valkade_backend.domain'


def test_missing_submodule_still_raises() -> None:
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module('clara_coder_backend.no_such_module')


def test_legacy_name_imported_first_loads_no_second_copy() -> None:
    script = (
        'import sys\n'
        'from clara_coder_backend.session.schemas import ChatRequest\n'
        'import valkade_backend.session.schemas as current\n'
        'assert ChatRequest is current.ChatRequest\n'
        "legacy = {k: m for k, m in sys.modules.items() if k.startswith('clara_coder_backend.')}\n"
        'assert legacy\n'
        "assert all(m is sys.modules['valkade_backend' + k[len('clara_coder_backend'):]] for k, m in legacy.items())\n"
    )
    proc = subprocess.run(
        [sys.executable, '-c', script], cwd=PYTHON_ROOT, capture_output=True, text=True, timeout=120, check=False
    )

    assert proc.returncode == 0, proc.stderr


def test_run_module_under_the_legacy_name() -> None:
    proc = subprocess.run(
        [sys.executable, '-m', 'clara_coder_backend.runtime.deps', '--help'],
        cwd=PYTHON_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    assert proc.returncode == 0, proc.stderr
    assert 'usage' in proc.stdout.lower()
