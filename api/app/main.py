"""FastAPI app: exposes the ops registry as REST (/api/op/<name>) and MCP (/mcp/)."""
import contextlib
import traceback

from fastapi import Body, FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from mcp.server.fastmcp import FastMCP

from . import graph, ops, pg, thread  # noqa: F401  (imports register operations)
from .registry import REGISTRY, REST_ONLY

mcp = FastMCP("backtrace", stateless_http=True, streamable_http_path="/")
for name, fn in REGISTRY.items():
    if name in REST_ONLY:
        continue
    mcp.add_tool(fn, name=name, description=(fn.__doc__ or "").strip())


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    await run_in_threadpool(graph.wait_until_ready)
    await run_in_threadpool(graph.ensure_indexes)
    try:
        await run_in_threadpool(pg.ensure_schema)
    except Exception as e:  # noqa: BLE001  (api still starts; ping reports postgres down)
        print(f"postgres not ready: {e}")
    async with mcp.session_manager.run():
        yield


app = FastAPI(title="backtrace", lifespan=lifespan)
app.mount("/mcp", mcp.streamable_http_app())


@app.get("/api/ops")
def list_ops() -> dict:
    return {"ops": sorted(REGISTRY)}


@app.post("/api/op/{name}")
async def run_op(name: str, body: dict = Body(default_factory=dict)):
    fn = REGISTRY.get(name)
    if fn is None:
        raise HTTPException(404, f"unknown op '{name}'")
    try:
        return await run_in_threadpool(fn, **body)
    except TypeError as e:
        raise HTTPException(400, f"bad arguments for '{name}': {e}") from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        raise HTTPException(500, f"{type(e).__name__}: {e}") from e
