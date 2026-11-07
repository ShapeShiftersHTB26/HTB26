"""All Backtrace operations. Each function is exposed as an MCP tool (docstring = description)
and as POST /api/op/<name> (JSON body = kwargs)."""
from . import graph as g
from .registry import operation


@operation
def ping() -> dict:
    """Health check. Returns ok and whether the graph database is reachable."""
    try:
        g.run("RETURN 1 AS one")
        return {"ok": True, "memgraph": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": True, "memgraph": False, "error": str(e)}


@operation
def get_graph() -> dict:
    """Overview of everything: all views with their current (head) and pending proposals,
    and the edges between views. Call this first to see what exists before acting."""
    views = g.run("MATCH (v:View) RETURN v ORDER BY v.created_at")
    return {"views": [r["v"] for r in views], "edges": []}
