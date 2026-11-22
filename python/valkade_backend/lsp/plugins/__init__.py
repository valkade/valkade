"""Built-in LSP server plugin implementations."""

from __future__ import annotations

from valkade_backend.lsp.plugins.gdscript_plugin import GdscriptLspPlugin
from valkade_backend.lsp.plugins.java_plugin import JavaLspPlugin
from valkade_backend.lsp.plugins.python_plugin import PythonLspPlugin
from valkade_backend.lsp.plugins.rust_plugin import RustLspPlugin
from valkade_backend.lsp.plugins.typescript_plugin import TypescriptLspPlugin
from valkade_backend.lsp.server_plugin import LspServerPlugin

__all__ = [
    'BUILTIN_LSP_PLUGINS',
    'GdscriptLspPlugin',
    'JavaLspPlugin',
    'PythonLspPlugin',
    'RustLspPlugin',
    'TypescriptLspPlugin',
]

BUILTIN_LSP_PLUGINS: tuple[type[LspServerPlugin], ...] = (
    PythonLspPlugin,
    TypescriptLspPlugin,
    GdscriptLspPlugin,
    JavaLspPlugin,
    RustLspPlugin,
)

