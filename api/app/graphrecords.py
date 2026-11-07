"""Optional copy of rows into Memgraph, as in the first version: (Record {rid, ...fields})-[:IN]->(Instance|Batch)
and (Record)-[:DERIVED_FROM]->(Record). Postgres stays the source of truth for reads and hashes; this copy is for
exploring in Memgraph Lab / Cypher. Switch: BACKTRACE_GRAPH_RECORDS=true|false (default true)."""
import os

from . import graph as g

ENABLED = os.environ.get("BACKTRACE_GRAPH_RECORDS", "true").lower() in ("1", "true", "yes")
BATCH = 1000


def mirror(prefix: str, view_id: str, rows: list[dict], srcs: list[list[str]] | None = None,
           label: str = "Instance") -> None:
    """Write rows (in storage order; rid = <prefix>:<n>) under the Instance or Batch node with id = prefix."""
    if not ENABLED:
        return
    for start in range(0, len(rows), BATCH):
        batch = [{**{k: v for k, v in r.items() if not k.startswith("_") and not isinstance(v, (dict, list))},
                  "rid": f"{prefix}:{start + n}", "_n": start + n, "_view_id": view_id}
                 for n, r in enumerate(rows[start:start + BATCH])]
        g.run(f"MATCH (x:{'Batch' if label == 'Batch' else 'Instance'} {{id:$p}}) "
              "UNWIND $rows AS row CREATE (r:Record)-[:IN]->(x) SET r = row", p=prefix, rows=batch)
    if srcs:
        pairs = [[f"{prefix}:{n}", s] for n, ss in enumerate(srcs) for s in (ss or [])]
        for start in range(0, len(pairs), BATCH):
            g.run("UNWIND $pairs AS p MATCH (a:Record {rid:p[0]}), (b:Record {rid:p[1]}) "
                  "CREATE (a)-[:DERIVED_FROM]->(b)", pairs=pairs[start:start + BATCH])
