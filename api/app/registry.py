"""Single registry of operations. Every op is exposed as POST /api/op/<name>; ops marked mcp=False (UI/runner
plumbing) are hidden from the agent's MCP tool list."""
from typing import Callable

REGISTRY: dict[str, Callable] = {}
REST_ONLY: set[str] = set()


def operation(fn: Callable | None = None, *, mcp: bool = True):
    def register(f: Callable) -> Callable:
        REGISTRY[f.__name__] = f
        if not mcp:
            REST_ONLY.add(f.__name__)
        return f
    return register(fn) if fn is not None else register
