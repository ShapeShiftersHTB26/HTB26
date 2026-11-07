"""Single registry of operations. Every op is exposed as an MCP tool and as POST /api/op/<name>."""
from typing import Callable

REGISTRY: dict[str, Callable] = {}


def operation(fn: Callable) -> Callable:
    REGISTRY[fn.__name__] = fn
    return fn
