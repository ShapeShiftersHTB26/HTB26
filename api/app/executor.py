"""Instances and records: evaluating views; rows + record lineage live in Postgres (pg.py), instance manifests
and instance-level lineage in Memgraph."""
import json

import jsonschema
import pandas as pd

from . import graph as g
from . import hashing as H
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
                   model: str | None = None, props: dict | None = None, raw: bool = False,
                   formula: str | None = None) -> dict:
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
    hashes = {}
    if formula:
        hashes = seal(iid, formula, [instance_node(x)["hash"] for x in input_instances])
    return {"instance_id": iid, **hashes, "row_count": len(rows), "invalid_count": invalid_count}


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


def instance_node(iid: str) -> dict:
    r = g.run("MATCH (i:Instance {id:$i}) RETURN i", i=iid)
    if not r:
        raise ValueError(f"no instance '{iid}'")
    return r[0]["i"]


def seal(iid: str, formula: str, input_hashes: list[str], ordered: bool = False) -> dict:
    """Hash the stored rows (read back from Postgres) and record formula/data/instance hashes on the manifest."""
    root, n = H.data_root(pg.stream(iid))
    ih = H.instance_hash(formula, root, input_hashes, ordered=ordered)
    g.run("MATCH (i:Instance {id:$i}) SET i.formula_hash = $f, i.data_root = $r, i.hash = $h, i.engine = $e",
          i=iid, f=formula, r=root, h=ih, e=H.ENGINE)
    return {"formula_hash": formula, "data_root": root, "hash": ih, "hashed_rows": n}


def _formula(transform: dict, shape: dict, input_formulas: list[str]) -> str:
    return H.formula_hash(transform["kind"], transform.get("spec") or {}, shape["schema"], input_formulas)


def _compute(transform: dict, shape: dict, frames: dict) -> tuple[list[dict], list | None, int, str | None]:
    """Run a transform over input frames; validate against the shape. Returns (rows, srcs, invalid, model)."""
    from .transforms import ops as OPS

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
    return [rows[i] for i in keep], ([list(srcs[i]) for i in keep] if srcs else None), len(rows) - len(keep), model


def evaluate(view_id: str, inputs: dict | None = None, _stack: tuple = ()) -> dict:
    """Evaluate the head shape+transform of a view; inputs default to the latest instance of each upstream
    view (evaluated recursively if missing). Returns instance summary (with hashes) plus upstream evaluations."""
    if view_id in _stack:
        raise ValueError("cycle in view graph")
    inputs = inputs or {}
    shape, transform = _heads(view_id)
    if transform["kind"] == "source":
        inst = latest_instance(view_id)
        if inst is None:
            raise ValueError("source view has no data; run ingest or append_batch")
        return {"instance_id": inst["id"], "row_count": inst["row_count"], "invalid_count": 0, "reused": True,
                "hash": inst.get("hash")}

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
    in_nodes = [instance_node(x) for x in used]
    if any(not n.get("hash") for n in in_nodes):
        raise ValueError("an input instance has no hash yet; run python -m app.backfill_hashes")
    formula = _formula(transform, shape, [n["formula_hash"] for n in in_nodes])
    rows, srcs, invalid, model = _compute(transform, shape, frames)
    res = write_instance(view_id, rows, srcs, shape["id"], transform["id"], used, invalid_count=invalid,
                         model=model, formula=formula)
    return {**res, "upstream": upstream}


# ---------------------------------------------------------------- sources: recipe runs -> batches -> snapshots

def source_formula(shape: dict, recipe: dict) -> str:
    return _formula(recipe, shape, [])


def append_batch(view_id: str, path: str | None = None, df=None) -> dict:
    """Run the source view's head recipe (optionally on another file), append the rows as a new raw batch and
    publish a new snapshot = previous snapshot's batches + this one."""
    import os

    from .transforms import source as SRC

    shape, recipe = _heads(view_id)
    if recipe["kind"] != "source":
        raise ValueError("append_batch works on source views only")
    spec = dict(recipe["spec"])
    if path:
        spec["path"] = path if path.startswith("/data/") else os.path.join("/data/raw", path)
    if not os.path.isfile(spec["path"]):
        raise ValueError(f"file not found: {spec['path']}")
    if df is None:
        df = SRC.run(spec)
    rows = to_rows(df)
    props = shape["schema"]["properties"]
    unknown = [c for c in (rows[0] if rows else {}) if c not in props]
    if unknown:
        raise ValueError(f"file has columns not in the source shape: {unknown}")
    formula = source_formula(shape, recipe)
    batch_id = g.new_id("b")
    table = pg.write_raw(batch_id, view_id, props, rows)
    b_root, n = H.data_root(pg.stream(batch_id))
    sha = H.file_sha256(spec["path"])
    bh = H.batch_hash(formula, sha, b_root)
    g.run("MATCH (v:View {id:$v}), (t:Transform {id:$t}) CREATE (b:Batch)-[:OF]->(v) SET b = $props "
          "CREATE (b)-[:RAN]->(t)", v=view_id, t=recipe["id"],
          props={"id": batch_id, "view_id": view_id, "transform_id": recipe["id"], "path": spec["path"],
                 "file_sha256": sha, "row_count": n, "data_root": b_root, "hash": bh, "created_at": g.now()})
    prev = latest_instance(view_id)
    batches = (json.loads(prev["batches"]) if prev and prev.get("batches") else []) + [batch_id]
    return publish_snapshot(view_id, shape, recipe, batches, table)


def publish_snapshot(view_id: str, shape: dict, recipe: dict, batches: list[str], table: str) -> dict:
    iid = g.new_id("i")
    pg.register_snapshot(iid, view_id, table, batches)
    bnodes = {r["b"]["id"]: r["b"] for r in g.run("MATCH (b:Batch) WHERE b.id IN $ids RETURN b", ids=batches)}
    rows = sum(bnodes[b]["row_count"] for b in batches)
    g.run("MATCH (v:View {id:$v}), (s:SchemaVersion {id:$s}), (t:Transform {id:$t}) "
          "CREATE (i:Instance)-[:OF]->(v) SET i = $props "
          "CREATE (i)-[:USED_SCHEMA]->(s) CREATE (i)-[:USED_TRANSFORM]->(t) "
          "WITH i MATCH (b:Batch) WHERE b.id IN $batches CREATE (i)-[:INCLUDES]->(b)",
          v=view_id, s=shape["id"], t=recipe["id"], batches=batches,
          props={"id": iid, "view_id": view_id, "created_at": g.now(), "row_count": rows, "invalid_count": 0,
                 "storage": f"raw.{table}", "batches": json.dumps(batches)})
    hashes = seal(iid, source_formula(shape, recipe), [bnodes[b]["hash"] for b in batches], ordered=True)
    return {"instance_id": iid, "row_count": rows, "batches": batches, **hashes}


# ---------------------------------------------------------------- verify

def verify(instance_id: str, recompute: bool = True, _seen: dict | None = None) -> dict:
    """Recompute an instance's hash tree from Postgres + definitions. With recompute, deterministic (ops)
    instances are re-executed from their stored inputs and must reproduce the same data root."""
    seen = _seen if _seen is not None else {}
    if instance_id in seen:
        return seen[instance_id]
    i = instance_node(instance_id)
    r = g.run("MATCH (i:Instance {id:$i})-[:USED_SCHEMA]->(s), (i)-[:USED_TRANSFORM]->(t), (i)-[:OF]->(v) "
              "RETURN s, t, v", i=instance_id)[0]
    shape, transform, view = P.decode(r["s"]), P.decode(r["t"]), r["v"]
    root, n = H.data_root(pg.stream(instance_id))
    node = {"instance_id": instance_id, "view_id": view["id"], "view_name": view["name"],
            "kind": transform["kind"], "rows": n, "stored_hash": i.get("hash"), "checks": {}, "inputs": []}
    checks = node["checks"]
    checks["data_root"] = root == i.get("data_root")

    if transform["kind"] == "source":
        batches = json.loads(i.get("batches") or "[]")
        formula = source_formula(shape, transform)
        bnodes = {x["b"]["id"]: x["b"] for x in g.run("MATCH (b:Batch) WHERE b.id IN $ids RETURN b", ids=batches)}
        bhashes = []
        for b in batches:
            bn = bnodes[b]
            b_root, _ = H.data_root(pg.stream(b))
            import os
            file_ok = (H.file_sha256(bn["path"]) == bn["file_sha256"]) if os.path.isfile(bn["path"]) else None
            bh = H.batch_hash(formula, bn["file_sha256"], b_root)
            node["inputs"].append({"batch_id": b, "path": bn["path"], "rows": bn["row_count"],
                                   "checks": {"data_root": b_root == bn["data_root"], "hash": bh == bn["hash"],
                                              "file": file_ok}, "stored_hash": bn["hash"]})
            bhashes.append(bh)
        recomputed = H.instance_hash(formula, root, bhashes, ordered=True)
    else:
        ins = [x["j"]["id"] for x in g.run("MATCH (:Instance {id:$i})-[:FROM]->(j:Instance) RETURN j", i=instance_id)]
        children = [verify(x, recompute, seen) for x in ins]
        node["inputs"] = children
        in_nodes = [instance_node(x) for x in ins]
        formula = _formula(transform, shape, [x["formula_hash"] for x in in_nodes])
        recomputed = H.instance_hash(formula, root, [x["hash"] for x in in_nodes])
        if recompute and transform["kind"] == "ops":
            names = {x["v"]["id"]: x["v"]["name"] for x in g.run(
                "MATCH (:Instance {id:$i})-[:FROM]->(j:Instance)-[:OF]->(v:View) RETURN v", i=instance_id)}
            frames = {names[x["view_id"]]: load_frame(x["id"]) for x in in_nodes}
            rows, srcs, _, _ = _compute(transform, shape, frames)
            mem = ({"_rid": f"{instance_id}:{k}", **row, **({"_src": srcs[k]} if srcs else {})}
                   for k, row in enumerate(rows))
            checks["recomputed"] = H.data_root(mem)[0] == root
        elif transform["kind"] != "ops":
            checks["recomputed"] = None  # agentic: stored model output, replayable but not recomputable
            node["note"] = "agentic step: verified against its stored output (not re-run)"
    checks["formula"] = formula == i.get("formula_hash")
    checks["hash"] = recomputed == i.get("hash")
    node["recomputed_hash"] = recomputed
    node["ok"] = all(v is not False for v in checks.values()) and all(
        c.get("ok", all(v is not False for v in c.get("checks", {}).values())) for c in node["inputs"])
    seen[instance_id] = node
    return node


def trace(rid: str, sample: int = 20) -> dict:
    """Walk record lineage (_src in Postgres) breadth-first; one level per hop, grouped by instance."""
    def meta(iid: str) -> dict:
        r = g.run("MATCH (i:Instance {id:$i})-[:OF]->(v:View) OPTIONAL MATCH (i)-[:USED_TRANSFORM]->(t) "
                  "RETURN i, v, t", i=iid)
        if not r:  # source rows: the prefix is a raw batch
            r = g.run("MATCH (i:Batch {id:$i})-[:OF]->(v:View) OPTIONAL MATCH (i)-[:RAN]->(t) RETURN i, v, t", i=iid)
        if not r:
            raise ValueError(f"no instance or batch '{iid}'")
        t = P.decode(r[0]["t"]) if r[0]["t"] else {}
        return {"instance_id": iid, "hash": r[0]["i"].get("hash"), "view_id": r[0]["v"]["id"],
                "view_name": r[0]["v"]["name"],
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
