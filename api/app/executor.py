"""Instances and records: evaluating views, writing rows (+ lineage) to the graph, reading them back."""
import json

import jsonschema
import pandas as pd

from . import graph as g
from . import proposals as P

BATCH = 1000


def to_rows(df: pd.DataFrame) -> list[dict]:
    """DataFrame -> JSON-safe dicts (dates as ISO, NaN dropped, internal columns removed)."""
    df = df.drop(columns=[c for c in ("_rid", "_src") if c in df.columns]).copy()
    for c in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            df[c] = df[c].dt.strftime("%Y-%m-%d")
    data = json.loads(df.to_json(orient="records"))
    return [{k: v for k, v in row.items() if v is not None} for row in data]


def write_instance(view_id: str, rows: list[dict], srcs: list[list[str]] | None, schema_id: str,
                   transform_id: str, input_instances: list[str], invalid_count: int = 0,
                   model: str | None = None) -> dict:
    iid = g.new_id("i")
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
    if srcs:
        pairs = [[f"{iid}:{n}", s] for n, ss in enumerate(srcs) for s in (ss or [])]
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


def load_frame(instance_id: str) -> pd.DataFrame:
    rows = g.run("MATCH (r:Record)-[:IN]->(:Instance {id:$i}) RETURN r ORDER BY r.`_n`", i=instance_id)
    recs = [record_out(r["r"]) for r in rows]
    return pd.DataFrame(recs) if recs else pd.DataFrame(columns=["_rid"])


def _heads(view_id: str) -> tuple[dict, dict]:
    rows = g.run(f"MATCH (p)-[:{P.VIEW_EDGES}]->(:View {{id:$id}}) RETURN labels(p)[0] AS label, p", id=view_id)
    by: dict[str, list] = {k: [] for k in P.KINDS}
    for r in rows:
        by[P.LABEL_TO_KIND[r["label"]]].append(P.decode(r["p"]))
    shape, transform = P.head(by["schema"]), P.head(by["transform"])
    name = P.view_node(view_id)["name"]
    if shape is None:
        raise ValueError(f"view '{name}' has no approved shape")
    if transform is None:
        raise ValueError(f"view '{name}' has no approved transform (see get_frontier)")
    return shape, transform


def evaluate(view_id: str, inputs: dict | None = None, _stack: tuple = ()) -> dict:
    """Evaluate the head shape+transform of a view; inputs default to the latest instance of each upstream
    view (evaluated recursively if missing). Returns instance summary plus upstream evaluations."""
    from .transforms import ops as OPS

    if view_id in _stack:
        raise ValueError("cycle in view graph")
    inputs = inputs or {}
    shape, transform = _heads(view_id)
    if transform["kind"] == "source":
        inst = latest_instance(view_id)
        if inst is None:
            raise ValueError("source view has no data; re-run ingest")
        return {"instance_id": inst["id"], "row_count": inst["row_count"], "invalid_count": 0, "reused": True}

    upstream, frames, used = [], {}, []
    for src in transform.get("reads") or []:
        iid = inputs.get(src)
        if iid is None:
            inst = latest_instance(src)
            if inst is None:
                sub = evaluate(src, inputs, _stack + (view_id,))
                upstream.append({"view_id": src, **sub})
                iid = sub["instance_id"]
            else:
                iid = inst["id"]
        frames[P.view_node(src)["name"]] = load_frame(iid)
        used.append(iid)

    if transform["kind"] == "ops":
        out = OPS.run(frames, transform["spec"])
    else:
        raise ValueError(f"transform kind '{transform['kind']}' is not implemented yet (stage 4)")

    props = shape["schema"].get("properties", {})
    missing = [c for c in props if c not in out.columns]
    if missing:
        raise ValueError(f"transform output lacks shape column(s) {missing}; has {[c for c in out.columns if c != '_src']}")
    srcs = out["_src"].tolist() if "_src" in out.columns else None
    rows = to_rows(out[list(props)])
    validator = jsonschema.Draft202012Validator(shape["schema"])
    keep = [i for i, r in enumerate(rows) if validator.is_valid(r)]
    invalid = len(rows) - len(keep)
    rows = [rows[i] for i in keep]
    srcs = [srcs[i] for i in keep] if srcs else None
    res = write_instance(view_id, rows, srcs, shape["id"], transform["id"], used, invalid_count=invalid)
    return {**res, "upstream": upstream}


def trace(rid: str, sample: int = 20) -> dict:
    """Walk DERIVED_FROM breadth-first; one level per hop, grouped by instance."""
    def meta(iid: str) -> dict:
        r = g.run("MATCH (i:Instance {id:$i})-[:OF]->(v:View) OPTIONAL MATCH (i)-[:USED_TRANSFORM]->(t) "
                  "RETURN i, v, t", i=iid)
        if not r:
            raise ValueError(f"no instance '{iid}'")
        t = P.decode(r[0]["t"]) if r[0]["t"] else {}
        return {"instance_id": iid, "view_id": r[0]["v"]["id"], "view_name": r[0]["v"]["name"],
                "view_kind": r[0]["v"]["kind"],
                "transform": {k: t.get(k) for k in ("id", "kind", "spec", "reads", "rationale")}}

    def records(rids: list[str]) -> list[dict]:
        return [record_out(r["r"]) for r in g.run("MATCH (r:Record) WHERE r.rid IN $ids RETURN r", ids=rids)]

    root = records([rid])
    if not root:
        raise ValueError(f"no record '{rid}'")
    levels = [{**meta(rid.split(":")[0]), "count": 1, "sample": root}]
    frontier = [rid]
    while frontier:
        nxt = [r["rid"] for r in g.run(
            "MATCH (a:Record)-[:DERIVED_FROM]->(b:Record) WHERE a.rid IN $ids RETURN DISTINCT b.rid AS rid",
            ids=frontier)]
        if not nxt:
            break
        by_inst: dict[str, list] = {}
        for x in nxt:
            by_inst.setdefault(x.split(":")[0], []).append(x)
        for iid, xs in by_inst.items():
            xs.sort(key=lambda s: int(s.split(":")[1]))
            levels.append({**meta(iid), "count": len(xs), "sample": records(xs[:sample])})
        frontier = nxt
    return {"rid": rid, "levels": levels}
