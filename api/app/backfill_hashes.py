"""One-off: give pre-hash instances their hashes (and migrated source instances a Batch), oldest first.
Run: python -m app.backfill_hashes"""
import json
import os

from . import executor as X
from . import graph as g
from . import hashing as H
from . import pg
from . import proposals as P


def main() -> None:
    pg.ensure_schema()
    rows = g.run("MATCH (i:Instance)-[:USED_SCHEMA]->(s), (i)-[:USED_TRANSFORM]->(t) "
                 "RETURN i, s, t ORDER BY i.created_at")
    for r in rows:
        i, shape, t = r["i"], P.decode(r["s"]), P.decode(r["t"])
        if i.get("hash"):
            continue
        if t["kind"] == "source":
            # migrated single-batch source: its rows are batch <instance id> in raw.src_<view>
            formula = X.source_formula(shape, t)
            b_root, n = H.data_root(pg.stream(i["id"]))
            path = t["spec"].get("path", "")
            sha = H.file_sha256(path) if os.path.isfile(path) else ""
            bh = H.batch_hash(formula, sha, b_root)
            if not g.run("MATCH (b:Batch {id:$i}) RETURN b.id", i=i["id"]):
                g.run("MATCH (v:View {id:$v}), (t:Transform {id:$t}) CREATE (b:Batch)-[:OF]->(v) SET b = $p "
                      "CREATE (b)-[:RAN]->(t)", v=i["view_id"], t=t["id"],
                      p={"id": i["id"], "view_id": i["view_id"], "transform_id": t["id"], "path": path,
                         "file_sha256": sha, "row_count": n, "data_root": b_root, "hash": bh,
                         "created_at": i["created_at"]})
            g.run("MATCH (i:Instance {id:$i}), (b:Batch {id:$i}) MERGE (i)-[:INCLUDES]->(b) SET i.batches = $bs",
                  i=i["id"], bs=json.dumps([i["id"]]))
            res = X.seal(i["id"], formula, [bh], ordered=True)
        else:
            ins = [x["j"] for x in g.run("MATCH (:Instance {id:$i})-[:FROM]->(j:Instance) RETURN j", i=i["id"])]
            ins = [X.instance_node(x["id"]) for x in ins]
            formula = X._formula(t, shape, [x["formula_hash"] for x in ins])
            res = X.seal(i["id"], formula, [x["hash"] for x in ins])
        print(f"{i['id']} {t['kind']:12s} hash={res['hash'][:16]}… rows={res['hashed_rows']}")


if __name__ == "__main__":
    main()
