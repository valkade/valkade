"""Deprecated alias for :mod:`valkade_backend` (the package was renamed in v0.6; remove in v0.7).

LangGraph's ``JsonPlusSerializer`` stores the module path of every pydantic model or dataclass it
checkpoints, so conversations saved before the rename still name ``clara_coder_backend.*`` types.
Importing this package replaces itself with :mod:`valkade_backend` in ``sys.modules`` and installs a
``sys.meta_path`` finder that maps every ``clara_coder_backend.x.y`` to the ``valkade_backend.x.y``
module object itself, never a second copy, so classes stay identical (``is``) under both names.
"""

from __future__ import annotations

import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import sys
from types import CodeType, ModuleType

_LEGACY = __name__
_TARGET = 'valkade_backend'


class _AliasLoader(importlib.abc.Loader):
    """Hands back the already-imported target module instead of executing anything."""

    def __init__(self, target: str) -> None:
        self._target = target
        self._target_spec: importlib.machinery.ModuleSpec | None = None

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> ModuleType:
        module = importlib.import_module(self._target)
        self._target_spec = module.__spec__
        return module

    def exec_module(self, module: ModuleType) -> None:
        # module_from_spec always overwrites __spec__ with the alias spec; give the module its own back.
        if self._target_spec is not None:
            module.__spec__ = self._target_spec

    def get_code(self, fullname: str) -> CodeType | None:
        """For ``python -m clara_coder_backend.x``: runpy runs the target's code without importing it."""
        del fullname
        spec = importlib.util.find_spec(self._target)
        loader = spec.loader if spec is not None else None
        get_code = getattr(loader, 'get_code', None)
        return get_code(self._target) if get_code is not None else None


class _AliasFinder(importlib.abc.MetaPathFinder):
    """Resolves ``clara_coder_backend.<sub>`` to ``valkade_backend.<sub>``."""

    prefix = _LEGACY + '.'

    def find_spec(
        self,
        fullname: str,
        path: object = None,
        target: ModuleType | None = None,
    ) -> importlib.machinery.ModuleSpec | None:
        del path, target
        if not fullname.startswith(self.prefix):
            return None
        target_name = _TARGET + fullname[len(_LEGACY) :]
        target_spec = importlib.util.find_spec(target_name)
        if target_spec is None:
            return None
        return importlib.machinery.ModuleSpec(
            fullname,
            _AliasLoader(target_name),
            is_package=target_spec.submodule_search_locations is not None,
        )


def _install_finder() -> None:
    # It must come before PathFinder: this package's __path__ is valkade_backend's, so PathFinder would
    # otherwise load a second copy of each submodule under the legacy name.
    if not any(getattr(f, 'prefix', None) == _AliasFinder.prefix for f in sys.meta_path):
        sys.meta_path.insert(0, _AliasFinder())


_install_finder()
sys.modules[_LEGACY] = importlib.import_module(_TARGET)
