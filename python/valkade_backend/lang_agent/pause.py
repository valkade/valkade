"""Compatibility re-export — pause helpers live in :mod:`valkade_backend.session.pause`."""

from valkade_backend.session.pause import await_diff_review_note, await_question_answers

__all__ = ['await_diff_review_note', 'await_question_answers']
