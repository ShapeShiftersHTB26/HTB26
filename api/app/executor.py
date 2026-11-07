"""Instances and records: writing evaluated rows (+ lineage) to the graph and reading them back."""
import json

import pandas as pd

from . import graph as g

BATCH = 1000


def to_rows(df: pd.DataFrame) -> list[dict]:
    """DataFrame -> JSON-safe dicts (dates as ISO, NaN dropped, internal columns removed)."""
    df = df.drop(columns=[c for c in ("_rid", "_src") if c in df.columns]).copy()
    for c in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            df[c] = df[c].dt.strftime("%Y-%m-%d")
    data = json.loads(df.to_json(orient="records"))
    return [{k: v for k, v in row.items() if v is not None} for row in data]


def write_instance(view_id: str, df: pd.DataFrame, schema_id: str, transform_id: str,
                   input_instances: list[str], invalid_count: int = 0, model: str | None = None) -> dict:
    iid = g.new_id("i")
    rows = to_rows(df)
    g.run("MATCH (v:View {id:$v}), (s:SchemaVersion {id:$s}), (t:Transform {id:$t}) "
          "CREATE (i:Instance)-[:OF]->(v) SET i = $props "
          "CREATE (i)-[:USED_SCHEMA]->(s) CREATE (i)-[:USED_TRANSFORM]->(t)",
          v=view_id, s=schema_id, t=transform_id,
          props={k: val for k, val in {"id": iid, "view_id": view_id, "created_at": g.now(),
                                       "row_count": len(rows), "invalid_count": invalid_count,
                                       "model": model}.items() if val is not None})
    for src in input_instances:
        g.run("MATCH (i:Instance {id:$i}), (j:Instance {id:$j}) CREATE (i)-[:FROM]->(j)", i=iid, j=src)
    for start in range(0, len(rows), BATCH):
        batch = [{**r, "rid": f"{iid}:{start + n}", "_n": start + n} for n, r in enumerate(rows[start:start + BATCH])]
        g.run("MATCH (i:Instance {id:$i}) UNWIND $rows AS row CREATE (r:Record)-[:IN]->(i) SET r = row",
              i=iid, rows=batch)
    if "_src" in df.columns:
        pairs = [[f"{iid}:{n}", s] for n, srcs in enumerate(df["_src"]) for s in (srcs or [])]
        for start in range(0, len(pairs), BATCH):
            g.run("UNWIND $pairs AS p MATCH (a:Record {rid:p[0]}), (b:Record {rid:p[1]}) "
                  "CREATE (a)-[:DERIVED_FROM]->(b)", pairs=pairs[start:start + BATCH])
    return {"instance_id": iid, "row_count": len(rows), "invalid_count": invalid_count}


def instances(view_id: str) -> list[dict]:
    return [r["i"] for r in g.run("MATCH (i:Instance {view_id:$v}) RETURN i ORDER BY i.created_at DESC", v=view_id)]


def latest_instance(view_id: str) -> dict | None:
    xs = instances(view_id)
    return xs[0] if xs else None


def record_out(r: dict) -> dict:
    return {"_rid": r["rid"], **{k: v for k, v in r.items() if k not in ("rid", "_n")}}
