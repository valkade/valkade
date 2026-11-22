"""Tests for the VALKADE_* -> legacy CLARA_* -> legacy NEMO_* env fallback."""

from __future__ import annotations

import os

import pytest

from valkade_backend.config import env_clara, env_valkade, set_env_valkade

_PREFIXES = ('VALKADE_', 'CLARA_', 'NEMO_')


@pytest.fixture
def clean(monkeypatch):
    def _clean(suffix: str) -> None:
        for prefix in _PREFIXES:
            monkeypatch.delenv(f'{prefix}{suffix}', raising=False)

    return _clean


def test_env_valkade_prefers_valkade_over_legacy(monkeypatch, clean):
    clean('LOG_DIR')
    monkeypatch.setenv('VALKADE_LOG_DIR', '/valkade/logs')
    monkeypatch.setenv('CLARA_LOG_DIR', '/clara/logs')
    monkeypatch.setenv('NEMO_LOG_DIR', '/nemo/logs')
    assert env_valkade('LOG_DIR') == '/valkade/logs'
    assert env_valkade('VALKADE_LOG_DIR') == '/valkade/logs'
    assert env_valkade('CLARA_LOG_DIR') == '/valkade/logs'


def test_env_valkade_falls_back_to_clara_then_nemo(monkeypatch, clean):
    clean('STAGING_DIR')
    monkeypatch.setenv('NEMO_STAGING_DIR', '/legacy/nemo')
    assert env_valkade('STAGING_DIR') == '/legacy/nemo'
    monkeypatch.setenv('CLARA_STAGING_DIR', '/legacy/clara')
    assert env_valkade('STAGING_DIR') == '/legacy/clara'
    # A blank value doesn't hide the next spelling.
    monkeypatch.setenv('VALKADE_STAGING_DIR', '  ')
    assert env_valkade('STAGING_DIR') == '/legacy/clara'


def test_env_valkade_default_when_unset(clean):
    clean('CHECKPOINT_DB')
    assert env_valkade('CHECKPOINT_DB', 'default.sqlite') == 'default.sqlite'
    assert env_valkade('CHECKPOINT_DB') == ''


def test_env_clara_is_an_alias(monkeypatch, clean):
    clean('LOG_DIR')
    monkeypatch.setenv('VALKADE_LOG_DIR', '/valkade/logs')
    assert env_clara is env_valkade
    assert env_clara('CLARA_LOG_DIR') == '/valkade/logs'


def test_set_env_valkade_drops_legacy_spellings(monkeypatch, clean):
    clean('CUSTOM_MODELS_DIR')
    monkeypatch.setenv('CLARA_CUSTOM_MODELS_DIR', '/stale/clara')
    monkeypatch.setenv('NEMO_CUSTOM_MODELS_DIR', '/stale/nemo')
    set_env_valkade('CUSTOM_MODELS_DIR', '/models')
    assert os.environ.get('VALKADE_CUSTOM_MODELS_DIR') == '/models'
    assert 'CLARA_CUSTOM_MODELS_DIR' not in os.environ
    assert 'NEMO_CUSTOM_MODELS_DIR' not in os.environ
    set_env_valkade('CLARA_CUSTOM_MODELS_DIR', '')
    assert env_valkade('CUSTOM_MODELS_DIR') == ''


def test_env_valkade_strip_false_keeps_value_as_set(monkeypatch, clean):
    clean('SCREENSHOT_URL')
    monkeypatch.setenv('CLARA_SCREENSHOT_URL', 'http://127.0.0.1:1/capture\n')
    assert env_valkade('SCREENSHOT_URL', strip=False) == 'http://127.0.0.1:1/capture\n'
