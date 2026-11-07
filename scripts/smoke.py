"""Smoke test the demo path over REST (+ MCP listing). Stdlib only.
Usage: python scripts/smoke.py [--stage N]   (runs checks for stages 0..N; default = all implemented)"""
import json
import sys
import urllib.error
import urllib.request

API = "http://localhost:8000"
results: list[tuple[str, bool, str]] = []


def op(op_name: str, **kwargs):
    req = urllib.request.Request(f"{API}/api/op/{op_name}", data=json.dumps(kwargs).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{op_name}: {e.code} {e.read().decode()[:300]}") from e


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


SHAPE = {"type": "object", "required": ["k", "x"], "properties": {
    "k": {"type": "string", "x-role": "dimension"}, "x": {"type": "number", "x-role": "measure", "x-unit": "GBP"}}}


CTX: dict = {}


def stage1():
    ctx = CTX

    def propose():
        r = op("propose_schema", name="smoke_view", question="smoke?", schema=SHAPE, grain="one row per k",
               scope=["smoke"], preview=[{"k": "a", "x": 1}], rationale="smoke test")
        assert not r["warnings"], r["warnings"]
        ctx.update(view=r["view_id"], first=r["id"])
    check("S1 propose_schema (new view)", propose)

    def revise():
        op("comment", target_id=ctx["first"], text="add y")
        r = op("propose_schema", view_id=ctx["view"], parent_id=ctx["first"], schema=SHAPE, grain="g",
               scope=[], preview=[], rationale="revision")
        ctx["second"] = r["id"]
        d = op("decide", target_id=r["id"], decision="approve")
        assert d["status"] == "approved", d
    check("S1 comment + sibling + approve", revise)

    def head():
        v = op("get_view", view_id=ctx["view"])
        assert v["head"]["schema"] == ctx["second"], v["head"]
        assert v["comments"].get(ctx["first"]), "comment missing"
    check("S1 get_view head + comments", head)


PPD_COLUMNS = ["transaction_id", "price", "date", "postcode", "property_type", "new_build", "tenure", "paon",
               "saon", "street", "locality", "town", "district", "county", "ppd_category", "record_status"]


def stage2():
    ctx = CTX

    def visual():
        r = op("propose_visual", view_id=ctx["view"], html="<html><head></head><body>smoke</body></html>",
               rationale="smoke")
        assert op("decide", target_id=r["id"], decision="approve")["status"] == "approved"
    check("S2 propose_visual + approve", visual)

    def ingest():
        r = op("ingest", path="pp-2025.csv", name="smoke_source", columns=PPD_COLUMNS, parse_dates=["date"], limit=50)
        assert r["row_count"] == 50, r["row_count"]
        ctx["src"] = r["view_id"]
        rows = op("get_records", view_id=r["view_id"], limit=3)["rows"]
        assert rows and "_rid" in rows[0], rows
        return "50 records"
    check("S2 ingest + get_records", ingest)

    def multi_visual():
        r = op("propose_visual", view_id=ctx["view"], html="<html><head></head><body>2</body></html>",
               rationale="second visual using another view", uses=[ctx["src"]])
        op("decide", target_id=r["id"], decision="approve")
        heads = op("get_view", view_id=ctx["view"])["visual_heads"]
        assert len(heads) == 2, heads
    check("S2 second visual with uses (both current)", multi_visual)

    def transform():
        spec = {"ops": [{"op": "derive", "column": "k", "expr": "postcode.str.split(' ').str[0]"},
                        {"op": "aggregate", "by": ["k"], "metrics": {"x": ["price", "mean"]}}]}
        r = op("propose_transform", view_id=ctx["view"], kind="ops", spec=spec, reads=[ctx["src"]], rationale="smoke")
        assert not r["warnings"], r["warnings"]
        assert op("get_frontier", view_id=ctx["view"])["frontier"], "should be unresolved before approval"
        op("decide", target_id=r["id"], decision="approve")
        f = op("get_frontier", view_id=ctx["view"])["frontier"]
        assert not f, f
        g = op("get_graph")
        assert any(e["from"] == ctx["src"] and e["to"] == ctx["view"] and not e["pending"] for e in g["edges"])
    check("S2 propose_transform + frontier + edge", transform)

    def new_inputs():
        r = op("propose_schema", name="smoke_down", schema=SHAPE, grain="one", scope=[], preview=[], rationale="d")
        op("decide", target_id=r["id"], decision="approve")
        t = op("propose_transform", view_id=r["view_id"], kind="ops", reads=[], rationale="via new input",
               spec={"ops": [{"op": "limit", "n": 1}]},
               new_inputs=[{"name": "smoke_mid", "schema": SHAPE, "grain": "g", "scope": [], "preview": []}])
        mid = t["new_inputs"][0]["view_id"]
        op("decide", target_id=t["id"], decision="approve")
        assert op("get_view", view_id=mid)["head"]["schema"], "bundled input shape not approved"
        assert [x["view_id"] for x in op("get_frontier", view_id=r["view_id"])["frontier"]] == [mid]
    check("S2 new_inputs bundle approval + frontier", new_inputs)


def stage3():
    ctx = CTX

    def evaluate():
        r = op("evaluate", view_id=ctx["view"])
        assert r["row_count"] > 0, r
        ctx["row"] = op("get_records", view_id=ctx["view"], limit=1)["rows"][0]
        return f"{r['row_count']} rows"
    check("S3 evaluate", evaluate)

    def trace():
        t = op("trace", rid=ctx["row"]["_rid"])
        last = t["levels"][-1]
        assert last["view_kind"] == "source" and last["count"] > 0, last
        return " <- ".join(f"{L['view_name']}({L['count']})" for L in t["levels"])
    check("S3 trace to source", trace)


def stage4():
    ctx = CTX

    def reduce_():
        shape = {"type": "object", "required": ["finding"], "properties": {
            "finding": {"type": "string", "x-role": "text", "description": "one notable observation"}}}
        r = op("propose_schema", name="smoke_reduce", schema=shape, grain="one row per finding", scope=[],
               preview=[], rationale="smoke")
        op("decide", target_id=r["id"], decision="approve")
        t = op("propose_transform", view_id=r["view_id"], kind="agent_reduce", reads=[ctx["view"]],
               spec={"prompt": "Give exactly one short observation about the highest x.", "max_rows": 200},
               rationale="smoke")
        op("decide", target_id=t["id"], decision="approve")
        e = op("evaluate", view_id=r["view_id"])
        assert e["row_count"] >= 1, e
        row = op("get_records", view_id=r["view_id"], limit=1)["rows"][0]
        levels = op("trace", rid=row["_rid"])["levels"]
        assert levels[-1]["view_kind"] == "source", levels[-1]
        return f"{e['row_count']} finding(s); cited {levels[1]['count']} row(s)"
    check("S4 agent_reduce evaluate + cited trace", reduce_)


def stage_dp():
    import subprocess
    ctx = CTX

    def append():
        r = op("append_batch", view_id=ctx["src"], path="pp-2025.csv")
        assert len(r["batches"]) == 2 and r["row_count"] == 100, r
        v = op("verify", instance_id=r["instance_id"])
        assert v["ok"], v
        return f"2 batches, {r['row_count']} rows, hash {r['hash'][:12]}"
    check("DP append_batch -> 2-batch snapshot verifies", append)

    def reevaluate():
        e = op("evaluate", view_id=ctx["view"])
        v = op("verify", instance_id=e["instance_id"])
        assert v["ok"] and v["checks"]["recomputed"], v
        ctx["inst"] = e["instance_id"]
        return f"re-evaluated on new snapshot, verified (recomputed)"
    check("DP re-evaluate + verify with recompute", reevaluate)

    def tamper():
        subprocess.run(["docker", "compose", "exec", "-T", "api", "python", "-c",
                        f"from app import pg; pg.run('UPDATE derived.inst_{ctx['inst']} SET x = x + 1 WHERE _n = 0')"],
                       check=True, stdout=subprocess.DEVNULL)
        v = op("verify", instance_id=ctx["inst"])
        assert not v["ok"] and v["checks"]["data_root"] is False, v["checks"]
        return "tampered row detected"
    check("DP verify detects a tampered row", tamper)


STAGES = [stage0, stage1, stage2, stage3, stage4, stage_dp]

if __name__ == "__main__":
    import subprocess
    upto = int(sys.argv[sys.argv.index("--stage") + 1]) if "--stage" in sys.argv else len(STAGES) - 1
    for s in STAGES[: upto + 1]:
        s()
    subprocess.call(["docker", "compose", "exec", "-T", "api", "python", "-m", "app.reset", "smoke_"],
                    stdout=subprocess.DEVNULL)
    for label, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {label}  {detail}")
    sys.exit(0 if all(ok for _, ok, _ in results) else 1)
