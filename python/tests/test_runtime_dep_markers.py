"""Runtime dependency markers: ``.valkade-*`` names, with the pre-rename ``.clara-*`` ones read as fallback."""

from __future__ import annotations

from pathlib import Path

import pytest

from valkade_backend.runtime.deps import download
from valkade_backend.runtime.deps.providers import kokoro, llama_server as ls, whisper


def test_ready_marker_names() -> None:
    assert download.READY_MARKER == '.valkade-ready'
    assert download.LEGACY_READY_MARKER == '.clara-ready'
    assert kokoro.MARKER_NAME == '.valkade-kokoro-ready'
    assert kokoro.LEGACY_MARKER_NAME == '.clara-kokoro-ready'
    assert whisper.MARKER_NAME == '.valkade-whisper-ready'
    assert whisper.LEGACY_MARKER_NAME == '.clara-whisper-ready'
    assert ls.VARIANT_MARKER == '.valkade-llama-variant'
    assert ls.LEGACY_VARIANT_MARKER == '.clara-llama-variant'


def test_write_ready_marker_uses_the_new_name(tmp_path: Path) -> None:
    download.write_ready_marker(tmp_path, 'v1')
    assert (tmp_path / '.valkade-ready').read_text(encoding='utf-8') == 'v1\n'
    assert not (tmp_path / '.clara-ready').exists()
    assert download.read_ready_marker(tmp_path) == 'v1'


def test_read_ready_marker_falls_back_to_the_legacy_name(tmp_path: Path) -> None:
    (tmp_path / '.clara-ready').write_text('v0\n', encoding='utf-8')
    assert download.read_ready_marker(tmp_path) == 'v0'


def test_read_ready_marker_prefers_the_new_name(tmp_path: Path) -> None:
    (tmp_path / '.clara-ready').write_text('v0\n', encoding='utf-8')
    (tmp_path / '.valkade-ready').write_text('v1\n', encoding='utf-8')
    assert download.read_ready_marker(tmp_path) == 'v1'


def test_read_ready_marker_missing(tmp_path: Path) -> None:
    assert download.read_ready_marker(tmp_path) is None


def test_clear_ready_marker_removes_both_names(tmp_path: Path) -> None:
    (tmp_path / '.clara-ready').write_text('v0\n', encoding='utf-8')
    (tmp_path / '.valkade-ready').write_text('v1\n', encoding='utf-8')
    download.clear_ready_marker(tmp_path)
    assert download.read_ready_marker(tmp_path) is None
    assert not (tmp_path / '.clara-ready').exists()


def test_llama_variant_falls_back_to_the_legacy_marker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ls, 'get_runtime_bin_dir', lambda: tmp_path)
    (tmp_path / '.clara-llama-variant').write_text('vulkan\n', encoding='utf-8')
    assert ls._read_variant() == 'vulkan'

    ls._write_variant('cuda')
    assert (tmp_path / '.valkade-llama-variant').read_text(encoding='utf-8') == 'cuda\n'
    assert ls._read_variant() == 'cuda'


def test_llama_clear_markers_removes_legacy_markers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ls, 'get_runtime_bin_dir', lambda: tmp_path)
    for name in ('.clara-ready', '.clara-llama-variant', '.valkade-ready', '.valkade-llama-variant'):
        (tmp_path / name).write_text('x\n', encoding='utf-8')
    ls._clear_markers(tmp_path)
    assert sorted(p.name for p in tmp_path.iterdir()) == []
    assert ls._read_variant() is None
    assert download.read_ready_marker(tmp_path) is None


@pytest.mark.parametrize('provider', [kokoro, whisper], ids=['kokoro', 'whisper'])
def test_optional_dep_marker_falls_back_to_the_legacy_name(
    provider, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(provider, 'get_runtime_python_dir', lambda: tmp_path)
    assert provider._marker_path() == tmp_path / provider.MARKER_NAME

    legacy = tmp_path / provider.LEGACY_MARKER_NAME
    legacy.write_text('installed\n', encoding='utf-8')
    assert provider._marker_path() == legacy

    current = tmp_path / provider.MARKER_NAME
    current.write_text('installed\n', encoding='utf-8')
    assert provider._marker_path() == current


@pytest.mark.parametrize('provider', [kokoro, whisper], ids=['kokoro', 'whisper'])
def test_optional_dep_delete_removes_both_markers(provider, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(provider, 'get_runtime_python_dir', lambda: tmp_path)
    monkeypatch.setattr(provider, 'venv_python', lambda: None)
    monkeypatch.setattr(provider.PROGRESS, 'emit', lambda *_a, **_k: None)
    if provider is whisper:
        monkeypatch.setattr(whisper, 'whisper_models_dir', lambda *_a, **_k: tmp_path / 'no-models')
        monkeypatch.setattr(whisper, 'list_downloaded_models', lambda root=None: [])
    (tmp_path / provider.LEGACY_MARKER_NAME).write_text('installed\n', encoding='utf-8')
    (tmp_path / provider.MARKER_NAME).write_text('installed\n', encoding='utf-8')

    provider.delete()

    assert not (tmp_path / provider.LEGACY_MARKER_NAME).exists()
    assert not (tmp_path / provider.MARKER_NAME).exists()
