"""Instances and records: evaluating views; rows + record lineage live in Postgres (pg.py), instance manifests
and instance-level lineage in Memgraph."""
import json

import jsonschema
import pandas as pd

from . import graph as g
from . import pg
from . import proposals as P


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
                   model: str | None = None, props: dict | None = None, raw: bool = False) -> dict:
    """Store rows in Postgres (raw.src_<view> batch for sources, derived.inst_<id> otherwise), then the manifest."""
    iid = g.new_id("i")
    if props is None:
        props = P.decode(g.run("MATCH (s:SchemaVersion {id:$s}) RETURN s", s=schema_id)[0]["s"])["schema"]["properties"]
    table = pg.write_raw(iid, view_id, props, rows) if raw else pg.write_derived(iid, view_id, props, rows, srcs)
    storage = f"{'raw' if raw else 'derived'}.{table}"
    g.run("MATCH (v:View {id:$v}), (s:SchemaVersion {id:$s}), (t:Transform {id:$t}) "
          "CREATE (i:Instance)-[:OF]->(v) SET i = $props "
          "CREATE (i)-[:USED_SCHEMA]->(s) CREATE (i)-[:USED_TRANSFORM]->(t)",
          v=view_id, s=schema_id, t=transform_id,
          props={k: val for k, val in {"id": iid, "view_id": view_id, "created_at": g.now(),
                                       "row_count": len(rows), "invalid_count": invalid_count,
                                       "model": model, "storage": storage}.items() if val is not None})
    for src in input_instances:
        g.run("MATCH (i:Instance {id:$i}), (j:Instance {id:$j}) CREATE (i)-[:FROM]->(j)", i=iid, j=src)
    return {"instance_id": iid, "row_count": len(rows), "invalid_count": invalid_count}


def instances(view_id: str) -> list[dict]:
    return [r["i"] for r in g.run("MATCH (i:Instance {view_id:$v}) RETURN i ORDER BY i.created_at DESC", v=view_id)]


def latest_instance(view_id: str) -> dict | None:
    xs = instances(view_id)
    return xs[0] if xs else None


def load_frame(instance_id: str) -> pd.DataFrame:
    _, recs = pg.read(instance_id)
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

    model = None
    if transform["kind"] == "ops":
        out = OPS.run(frames, transform["spec"])
    elif transform["kind"] in ("agent_map", "agent_reduce"):
        from .transforms import agentic as AG
        fn = AG.run_map if transform["kind"] == "agent_map" else AG.run_reduce
        out, model = fn(frames, transform["spec"], shape["schema"]), AG.MODEL
    else:
        raise ValueError(f"unknown transform kind '{transform['kind']}'")

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
    res = write_instance(view_id, rows, srcs, shape["id"], transform["id"], used, invalid_count=invalid,
                         model=model)
    return {**res, "upstream": upstream}


def trace(rid: str, sample: int = 20) -> dict:
    """Walk record lineage (_src in Postgres) breadth-first; one level per hop, grouped by instance."""
    def meta(iid: str) -> dict:
        r = g.run("MATCH (i:Instance {id:$i})-[:OF]->(v:View) OPTIONAL MATCH (i)-[:USED_TRANSFORM]->(t) "
                  "RETURN i, v, t", i=iid)
        if not r:
            raise ValueError(f"no instance '{iid}'")
        t = P.decode(r[0]["t"]) if r[0]["t"] else {}
        return {"instance_id": iid, "view_id": r[0]["v"]["id"], "view_name": r[0]["v"]["name"],
                "view_kind": r[0]["v"]["kind"],
                "transform": {k: t.get(k) for k in ("id", "kind", "spec", "reads", "rationale")}}

    def strip(rows):
        return [{k: v for k, v in x.items() if k != "_src"} for x in rows]

    root = pg.by_rids([rid])
    if not root:
        raise ValueError(f"no record '{rid}'")
    levels = [{**meta(rid.split(":")[0]), "count": 1, "sample": strip(root)}]
    frontier = root
    while frontier:
        nxt = sorted({s for row in frontier for s in (row.get("_src") or [])},
                     key=lambda s: (s.split(":")[0], int(s.split(":")[1])))
        if not nxt:
            break
        by_inst: dict[str, list] = {}
        for x in nxt:
            by_inst.setdefault(x.split(":")[0], []).append(x)
        frontier = []
        for iid, xs in by_inst.items():
            rows = pg.by_rids(xs)
            levels.append({**meta(iid), "count": len(xs), "sample": strip(rows[:sample])})
            frontier += rows
    return {"rid": rid, "levels": levels}
