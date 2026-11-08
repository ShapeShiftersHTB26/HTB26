"""TEMP one-off loader for CSVs too big for `ingest`: streams the file into Postgres as a new SOURCE view.

Run from the repo root, in a one-off container from the api image (same code, env and network; it doesn't block
the api server):
    docker compose run --rm --no-deps -v ./scripts:/srv/scripts api \
        python /srv/scripts/load_big_csv.py epc_jan_may_25.csv epc_domestic_2025 [--limit N]

1. Scan the whole file and infer column types: a column is integer / number / date only if EVERY value parses
   as one (codes with leading zeros stay text), so nothing is coerced or lost.
2. Stream 50k-row chunks into raw.src_<view> with COPY (memory stays at one chunk).
3. Hash the stored rows exactly as `verify` does, then create the usual manifests: View, shape, recipe, Batch,
   snapshot Instance. Trace and verify then work as for any source.
Graph nodes are created only after the rows are in; on failure the half-written table is dropped."""
import argparse
import os
import re
import sys
import time

sys.path.insert(0, "/srv")

import pandas as pd  # noqa: E402

from app import executor as X  # noqa: E402
from app import graph as g  # noqa: E402
from app import hashing as H  # noqa: E402
from app import pg  # noqa: E402
from app import proposals as P  # noqa: E402

CHUNK = 50_000
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LEADING_ZERO = re.compile(r"^-?0\d")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def read(path: str, limit: int | None):
    return pd.read_csv(path, dtype=str, chunksize=CHUNK, nrows=limit)


def infer(path: str, limit: int | None) -> tuple[dict, dict, int]:
    st: dict[str, dict] = {}
    n = 0
    for chunk in read(path, limit):
        for c in chunk.columns:
            s = chunk[c].dropna()
            x = st.setdefault(c, {"int": True, "num": True, "date": True, "nulls": False, "seen": False})
            x["nulls"] |= len(s) < len(chunk)
            if s.empty:
                continue
            x["seen"] = True
            if x["num"]:
                num = pd.to_numeric(s, errors="coerce")
                if num.isna().any() or s.str.match(LEADING_ZERO).any():  # not numeric, or codes like "0123"
                    x["num"] = x["int"] = False
                elif x["int"] and (s.str.contains(r"[.eE]").any() or num.abs().max() >= 2**62):
                    x["int"] = False
            if x["date"] and not s.str.match(ISO_DATE).all():
                x["date"] = False
        n += len(chunk)
        log(f"scanned {n:,} rows")
    props, types = {}, {}
    for c, x in st.items():
        if not x["seen"]:
            t, p = "string", {"type": "string", "x-role": "dimension"}
        elif x["date"] and not x["num"]:
            t, p = "date", {"type": "string", "format": "date", "x-role": "time"}
        elif x["int"]:
            t, p = "integer", {"type": "integer", "x-role": "measure"}
        elif x["num"]:
            t, p = "number", {"type": "number", "x-role": "measure"}
        else:
            t, p = "string", {"type": "string", "x-role": "dimension"}
        props[c], types[c] = p, t
    schema = {"type": "object", "properties": props, "required": [c for c, x in st.items() if not x["nulls"]]}
    return schema, types, n


def typed(chunk: pd.DataFrame, types: dict) -> pd.DataFrame:
    for c, t in types.items():
        if t == "integer":
            chunk[c] = pd.to_numeric(chunk[c]).astype("Int64")
        elif t == "number":
            chunk[c] = pd.to_numeric(chunk[c])
    return chunk


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("file", help="CSV in data/raw/ (with a header row)")
    ap.add_argument("name", help="source view name, snake_case")
    ap.add_argument("--limit", type=int, help="only the first N rows (for a trial run)")
    a = ap.parse_args()
    path = a.file if a.file.startswith("/data/") else os.path.join("/data/raw", a.file)
    if not re.fullmatch(r"[a-z][a-z0-9_]*", a.name):
        sys.exit("name must be snake_case")
    if g.run("MATCH (v:View {name:$n}) RETURN v.id", n=a.name):
        sys.exit(f"a view called {a.name} already exists")

    log(f"pass 1: inferring column types over {path}")
    schema, types, total = infer(path, a.limit)
    counts = {t: sum(1 for x in types.values() if x == t) for t in set(types.values())}
    log(f"{len(types)} columns {counts}, {total:,} rows")

    pg.ensure_schema()
    view_id, batch_id = g.new_id("v"), g.new_id("b")
    props = schema["properties"]
    cols = list(props)
    table = pg.write_raw(batch_id, view_id, props, [])  # creates raw.src_<view> + registers the batch
    try:
        log(f"pass 2: streaming into raw.{table}")
        n, preview = 0, []
        sqlt = {c: pg.sql_type(props[c]) for c in cols}
        for chunk in read(path, a.limit):
            rows = X.to_rows(typed(chunk, types))
            if not preview:
                preview = rows[:5]
            pg._copy("raw", table, ["_rid", "_batch_id", "_n", *cols],
                     ((f"{batch_id}:{n + k}", batch_id, n + k, *[pg._value(r.get(c), sqlt[c]) for c in cols])
                      for k, r in enumerate(rows)))
            n += len(rows)
            log(f"loaded {n:,} / {total:,} rows")

        log("hashing the stored rows (as verify does)")
        root, hashed = H.data_root(pg.stream(batch_id))
        if hashed != n:
            raise RuntimeError(f"stored {hashed} rows, expected {n}")
    except BaseException:
        log("failed: dropping the half-written table")
        pg.run(f'DROP TABLE IF EXISTS raw."{table}"')
        pg.run("DELETE FROM meta.tables WHERE prefix = %s", (batch_id,))
        raise

    log("creating the graph manifests")
    spec = {"type": "file", "path": path, "loader": "scripts/load_big_csv.py", "dtypes": types}
    if a.limit:
        spec["limit"] = a.limit
    g.run("CREATE (v:View) SET v = $props", props={"id": view_id, "name": a.name, "kind": "source", "question": "",
                                                   "auto_accept": False, "created_at": g.now(), "store": "postgres"})
    fname = os.path.basename(path)
    s = P.create("schema", view_id, {
        "schema": schema, "grain": "one row per source record", "scope": [f"first {a.limit} rows"] if a.limit else ["all rows"],
        "preview": preview, "rationale": f"Inferred from {fname}: types checked over every row ({n:,})."}, None, "agent")
    t = P.create("transform", view_id, {"kind": "source", "spec": spec, "reads": [],
                                        "rationale": f"Recipe: stream {fname} with the inferred column types."},
                 None, "agent")
    P.decide(s["id"], "approve", "auto")
    P.decide(t["id"], "approve", "auto")
    shape = {"id": s["id"], "schema": schema}
    recipe = {"id": t["id"], "kind": "source", "spec": spec}
    formula = X.source_formula(shape, recipe)
    sha = H.file_sha256(path)
    bh = H.batch_hash(formula, sha, root)
    g.run("MATCH (v:View {id:$v}), (t:Transform {id:$t}) CREATE (b:Batch)-[:OF]->(v) SET b = $props "
          "CREATE (b)-[:RAN]->(t)", v=view_id, t=t["id"],
          props={"id": batch_id, "view_id": view_id, "transform_id": t["id"], "path": path, "file_sha256": sha,
                 "row_count": n, "data_root": root, "hash": bh, "created_at": g.now(), "store": "postgres"})
    # snapshot = this one batch: same rows in the same order, so the same data root
    iid = g.new_id("i")
    pg.register_snapshot(iid, view_id, table, [batch_id])
    ih = H.instance_hash(formula, root, [bh], ordered=True)
    g.run("MATCH (v:View {id:$v}), (s:SchemaVersion {id:$s}), (t:Transform {id:$t}) "
          "CREATE (i:Instance)-[:OF]->(v) SET i = $props "
          "CREATE (i)-[:USED_SCHEMA]->(s) CREATE (i)-[:USED_TRANSFORM]->(t) "
          "WITH i MATCH (b:Batch {id:$b}) CREATE (i)-[:INCLUDES]->(b)",
          v=view_id, s=s["id"], t=t["id"], b=batch_id,
          props={"id": iid, "view_id": view_id, "created_at": g.now(), "row_count": n, "invalid_count": 0,
                 "storage": f"postgres:{table}", "store": "postgres", "batches": f'["{batch_id}"]',
                 "formula_hash": formula, "data_root": root, "hash": ih, "engine": H.ENGINE})
    log(f"done: view {a.name} ({view_id}), {n:,} rows, snapshot {iid}, hash {ih[:16]}…")


if __name__ == "__main__":
    main()
