"""The system prompt says which ValkAde build runs the agent when the workspace is ValkAde's own source."""

from __future__ import annotations

from pathlib import Path

import pytest

from valkade_backend.llm import messages
from valkade_backend.llm.messages import build_system_prompt
from valkade_backend.session.state import get_session


@pytest.fixture()
def session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    for name in ('APP_VERSION', 'BUNDLED_PYTHON'):
        for prefix in ('VALKADE_', 'CLARA_', 'NEMO_'):
            monkeypatch.delenv(f'{prefix}{name}', raising=False)
    sess = get_session('running-build-prompt')
    sess.workspace_path = str(tmp_path)
    return sess


def _valkade_checkout(root: Path) -> Path:
    package = root / 'python' / 'valkade_backend'
    package.mkdir(parents=True)
    (package / '__init__.py').write_text('', encoding='utf-8')
    return root


def test_other_projects_get_no_build_line(session) -> None:
    assert messages._running_build_line(session) == ''
    assert 'Running build:' not in build_system_prompt(session, True)


def test_installed_build_says_workspace_edits_do_not_change_its_tools(session, monkeypatch) -> None:
    _valkade_checkout(Path(session.workspace_path))
    monkeypatch.setenv('VALKADE_APP_VERSION', '0.6.2')
    monkeypatch.setenv('VALKADE_BUNDLED_PYTHON', r'C:\Program Files\ValkAde\resources\runtime-python\python.exe')

    line = messages._running_build_line(session)

    assert line.startswith('Running build: installed ValkAde 0.6.2')
    assert 'not this workspace' in line
    assert 'even after a restart' in line
    assert line in build_system_prompt(session, True)


def test_development_build_from_another_checkout(session) -> None:
    _valkade_checkout(Path(session.workspace_path))
    line = messages._running_build_line(session)
    assert line.startswith('Running build: ValkAde development build from another checkout')


def test_development_build_on_this_workspace(session, monkeypatch, tmp_path: Path) -> None:
    checkout = _valkade_checkout(tmp_path / 'valkade')
    monkeypatch.setattr(messages, '_RUNNING_BACKEND_ROOT', checkout / 'python')
    monkeypatch.setenv('VALKADE_APP_VERSION', '0.7.0')
    session.workspace_path = str(checkout)

    line = messages._running_build_line(session)

    assert line.startswith("Running build: ValkAde 0.7.0 development build on this workspace's backend")
    assert 'restarts' in line


def test_running_backend_root_is_the_python_folder() -> None:
    assert (messages._RUNNING_BACKEND_ROOT / 'valkade_backend' / '__init__.py').is_file()
