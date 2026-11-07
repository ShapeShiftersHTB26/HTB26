"""One-off recovery: rebuild the row store (Postgres) from the graph's manifests after the row tables were lost.

Every Batch is re-read from its source file with its recipe, and every derived Instance is recomputed from its
inputs with its pinned transform + shape, under the SAME ids. Each result is checked against the data root
stored in the graph, so a match proves the rebuilt rows are exactly the ones that were hashed.
Usage (inside the api container):  python -m app.rebuild_rows"""
import json

from . import executor as X
from . import graph as g
from . import hashing as H
from . import pg
from . import proposals as P
from . import store as ST
from .transforms import source as SRC


def _shape_for_view(view_id: str) -> dict:
    ss = [P.decode(r["s"]) for r in g.run("MATCH (s:SchemaVersion)-[:VERSION_OF]->(:View {id:$v}) RETURN s", v=view_id)]
    return P.head(ss) or ss[-1]


def main() -> None:
    pg.ensure_schema()
    report = {"ok": [], "mismatch": [], "failed": []}
    tables: dict[str, str] = {}

    batches = [r["b"] for r in g.run("MATCH (b:Batch) RETURN b ORDER BY b.created_at")]
    for b in batches:
        if (b.get("store") or "postgres") != "postgres":
            continue
        try:
            recipe = P.decode(g.run("MATCH (t:Transform {id:$t}) RETURN t", t=b["transform_id"])[0]["t"])
            spec = {**recipe["spec"], "path": b["path"]}
            rows = X.to_rows(SRC.run(spec))
            props = _shape_for_view(b["view_id"])["schema"]["properties"]
            pg.drop_prefixes([b["id"]])
            tables[b["view_id"]] = pg.write_raw(b["id"], b["view_id"], props, rows)
            root, n = H.data_root(pg.stream(b["id"]))
            (report["ok"] if root == b["data_root"] else report["mismatch"]).append(f"batch {b['id']} ({n} rows)")
        except Exception as e:  # noqa: BLE001
            report["failed"].append(f"batch {b['id']}: {type(e).__name__}: {e}")
        print(f"batch {b['id']} done", flush=True)

    insts = [r["i"] for r in g.run("MATCH (i:Instance) RETURN i ORDER BY i.created_at")]
    for i in insts:
        if (i.get("store") or "postgres") != "postgres":
            continue
        iid = i["id"]
        try:
            if i.get("batches"):  # source snapshot: just register its batches again
                table = (i.get("storage") or "").split(":")[-1].split(".")[-1] or tables.get(i["view_id"])
                pg.register_snapshot(iid, i["view_id"], table, json.loads(i["batches"]))
                root, n = H.data_root(pg.stream(iid))
            else:
                r = g.run("MATCH (i:Instance {id:$i})-[:USED_SCHEMA]->(s), (i)-[:USED_TRANSFORM]->(t) RETURN s, t",
                          i=iid)[0]
                shape, transform = P.decode(r["s"]), P.decode(r["t"])
                frames = {x["v"]["name"]: X.load_frame(x["j"]["id"]) for x in g.run(
                    "MATCH (:Instance {id:$i})-[:FROM]->(j:Instance)-[:OF]->(v:View) RETURN j, v", i=iid)}
                rows, srcs, _, _ = X._compute(transform, shape, frames)
                pg.drop_prefixes([iid])
                pg.write_derived(iid, i["view_id"], shape["schema"]["properties"], rows, srcs)
                root, n = H.data_root(pg.stream(iid))
            (report["ok"] if root == i.get("data_root") else report["mismatch"]).append(f"instance {iid} ({n} rows)")
        except Exception as e:  # noqa: BLE001
            report["failed"].append(f"instance {iid}: {type(e).__name__}: {e}")
        print(f"instance {iid} done", flush=True)

    print(json.dumps({k: (len(v) if k == "ok" else v) for k, v in report.items()}, indent=1))


if __name__ == "__main__":
    main()
