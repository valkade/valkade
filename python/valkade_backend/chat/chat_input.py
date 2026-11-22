"""Compatibility re-export of :mod:`valkade_backend.session.chat_input`."""

from valkade_backend.session.chat_input import (
    effective_user_message_content,
    validate_user_turn_not_empty,
)

__all__ = ['effective_user_message_content', 'validate_user_turn_not_empty']
