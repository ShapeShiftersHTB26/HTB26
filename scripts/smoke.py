"""Smoke test the demo path over REST (+ MCP listing). Stdlib only.
Usage: python scripts/smoke.py [--stage N]   (runs checks for stages 0..N; default = all implemented)"""
import json
import sys
import urllib.error
import urllib.request

API = "http://localhost:8000"
results: list[tuple[str, bool, str]] = []


def op(name: str, **kwargs):
    req = urllib.request.Request(f"{API}/api/op/{name}", data=json.dumps(kwargs).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{name}: {e.code} {e.read().decode()[:300]}") from e


def mcp(method: str, params: dict | None = None):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    req = urllib.request.Request(f"{API}/mcp/", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json",
                                          "accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=30) as r:
        text = r.read().decode()
    for line in text.splitlines():  # SSE framing: "data: {...}"
        if line.startswith("data:"):
            return json.loads(line[5:])
    return json.loads(text)


def check(label: str, fn):
    try:
        detail = fn()
        results.append((label, True, str(detail or "")))
    except Exception as e:  # noqa: BLE001
        results.append((label, False, str(e)))


def stage0():
    def ping():
        r = op("ping")
        assert r["memgraph"], r
    check("S0 ping + memgraph", ping)
    check("S0 get_graph", lambda: f"{len(op('get_graph')['views'])} views")

    def tools():
        mcp("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                           "clientInfo": {"name": "smoke", "version": "0"}})
        names = [t["name"] for t in mcp("tools/list")["result"]["tools"]]
        assert "get_graph" in names, names
        return f"{len(names)} tools"
    check("S0 MCP tools/list", tools)


STAGES = [stage0]

if __name__ == "__main__":
    upto = int(sys.argv[sys.argv.index("--stage") + 1]) if "--stage" in sys.argv else len(STAGES) - 1
    for s in STAGES[: upto + 1]:
        s()
    for label, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {label}  {detail}")
    sys.exit(0 if all(ok for _, ok, _ in results) else 1)
