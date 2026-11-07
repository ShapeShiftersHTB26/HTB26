"""One-off: copy existing rows from Postgres into Memgraph Record nodes (sources first, so lineage edges resolve).
Run: python -m app.mirror_records"""
from . import graph as g
from . import graphrecords as GR
from . import pg


def main() -> None:
    if not GR.ENABLED:
        raise SystemExit("BACKTRACE_GRAPH_RECORDS is off")
    g.run("MATCH (r:Record) DETACH DELETE r")
    batches = g.run("MATCH (b:Batch) RETURN b.id AS id, b.view_id AS v ORDER BY b.created_at")
    insts = g.run("MATCH (i:Instance)-[:USED_TRANSFORM]->(t:Transform) WHERE t.kind <> 'source' "
                  "RETURN i.id AS id, i.view_id AS v ORDER BY i.created_at")
    for b in batches:
        rows = list(pg.stream(b["id"]))
        GR.mirror(b["id"], b["v"], rows, label="Batch")
        print(f"batch {b['id']}: {len(rows)} records")
    for i in insts:
        rows = list(pg.stream(i["id"]))
        GR.mirror(i["id"], i["v"], rows, [r.get("_src") or [] for r in rows])
        print(f"instance {i['id']}: {len(rows)} records")
    n = g.run("MATCH (r:Record) RETURN count(r) AS n")[0]["n"]
    e = g.run("MATCH (:Record)-[d:DERIVED_FROM]->(:Record) RETURN count(d) AS n")[0]["n"]
    print(f"{n} Record nodes, {e} DERIVED_FROM edges in Memgraph")


if __name__ == "__main__":
    main()
