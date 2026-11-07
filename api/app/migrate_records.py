"""One-off: move Record nodes (and DERIVED_FROM lineage) from Memgraph into the Postgres data plane, keeping every
rid, then delete the Record nodes. Idempotent per instance. Run: python -m app.migrate_records"""
from . import graph as g
from . import pg
from . import proposals as P


def main() -> None:
    pg.ensure_schema()
    insts = g.run("MATCH (i:Instance)-[:USED_TRANSFORM]->(t:Transform), (i)-[:USED_SCHEMA]->(s:SchemaVersion) "
                  "RETURN i, t.kind AS kind, s.schema AS schema ORDER BY i.created_at")
    moved = 0
    for r in insts:
        i = r["i"]
        if i.get("storage"):
            continue
        recs = g.run("MATCH (x:Record)-[:IN]->(:Instance {id:$i}) RETURN x ORDER BY x.`_n`", i=i["id"])
        rows = [{k: v for k, v in x["x"].items() if k not in ("rid", "_n")} for x in recs]
        props = P.json.loads(r["schema"])["properties"]
        if r["kind"] == "source":
            table = pg.write_raw(i["id"], i["view_id"], props, rows)
            storage = f"raw.{table}"
        else:
            edges = g.run("MATCH (a:Record)-[:IN]->(:Instance {id:$i}) MATCH (a)-[:DERIVED_FROM]->(b:Record) "
                          "RETURN a.`_n` AS n, b.rid AS src", i=i["id"])
            srcs: list[list[str]] = [[] for _ in rows]
            for e in edges:
                srcs[e["n"]].append(e["src"])
            table = pg.write_derived(i["id"], i["view_id"], props, rows, srcs)
            storage = f"derived.{table}"
        g.run("MATCH (i:Instance {id:$i}) SET i.storage = $s", i=i["id"], s=storage)
        moved += 1
        print(f"{i['id']} ({i['view_id']}): {len(rows)} rows -> {storage}")
    left = g.run("MATCH (x:Record) RETURN count(x) AS n")[0]["n"]
    if left:
        g.run("MATCH (x:Record) DETACH DELETE x")
    print(f"moved {moved} instances; deleted {left} Record nodes from Memgraph")


if __name__ == "__main__":
    main()
