"""Postgres data plane: all rows (raw + derived) and record-level lineage live here.
Layout:
  raw.src_<view>      append-only landing table per source view (trigger blocks UPDATE/DELETE)
  derived.inst_<id>   one table per derived instance: _rid, _n, _src text[] + shape columns
  meta.tables         rid prefix (instance/batch id) -> table, so any rid can be resolved
Every row has _rid = '<prefix>:<n>' and _n (order within its prefix)."""
import datetime as dt
import json
import os
import re

import psycopg
import psycopg.rows
from psycopg import sql

DSN = os.environ.get("PG_DSN", "")
_conn: psycopg.Connection | None = None
INTERNAL = ("_rid", "_n", "_src", "_batch_id", "_loaded_at")


def conn() -> psycopg.Connection:
    global _conn
    if not DSN:
        raise RuntimeError("PG_DSN is not set (add the Postgres connection string to .env)")
    if _conn is None or _conn.closed:
        _conn = psycopg.connect(DSN, autocommit=True)
    return _conn


def run(query, params=None, _retry: bool = True) -> list[dict]:
    global _conn
    try:
        with conn().cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute(query, params)
            return cur.fetchall() if cur.description else []
    except psycopg.OperationalError:
        if not _retry:
            raise
        _conn = None  # remote connection dropped: reconnect once
        return run(query, params, _retry=False)


def ensure_schema() -> None:
    run("CREATE SCHEMA IF NOT EXISTS raw")
    run("CREATE SCHEMA IF NOT EXISTS derived")
    run("CREATE SCHEMA IF NOT EXISTS meta")
    run("""CREATE TABLE IF NOT EXISTS meta.tables (
             prefix text PRIMARY KEY, schema_name text NOT NULL, table_name text NOT NULL,
             view_id text, kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())""")
    run("ALTER TABLE meta.tables ADD COLUMN IF NOT EXISTS batches text[]")
    run("""CREATE OR REPLACE FUNCTION meta.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'raw tables are append-only (% on %)', TG_OP, TG_TABLE_NAME; END $$""")


def ping() -> bool:
    run("SELECT 1")
    return True


# ---------------------------------------------------------------- types

def _ident(name: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError(f"bad column name {name!r} (use letters, digits, underscore)")
    return name


def sql_type(prop: dict) -> str:
    t = prop.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), "string")
    if t == "integer":
        return "bigint"
    if t == "number":
        return "double precision"
    if t == "boolean":
        return "boolean"
    if t in ("array", "object"):
        return "jsonb"
    if prop.get("format") == "date":
        return "date"
    return "text"


def _value(v, typ: str):
    if v is None:
        return None
    if typ == "jsonb":
        return json.dumps(v)
    return v


# ---------------------------------------------------------------- writing

def _register(prefix: str, schema: str, table: str, view_id: str, kind: str) -> None:
    run("INSERT INTO meta.tables (prefix, schema_name, table_name, view_id, kind) VALUES (%s,%s,%s,%s,%s) "
        "ON CONFLICT (prefix) DO NOTHING", (prefix, schema, table, view_id, kind))


def _copy(schema: str, table: str, cols: list[str], rows):
    q = sql.SQL("COPY {}.{} ({}) FROM STDIN").format(
        sql.Identifier(schema), sql.Identifier(table), sql.SQL(", ").join(map(sql.Identifier, cols)))
    with conn().cursor() as cur, cur.copy(q) as cp:
        for r in rows:
            cp.write_row(r)


def write_derived(instance_id: str, view_id: str, props: dict, rows: list[dict],
                  srcs: list[list[str]] | None) -> str:
    """Create derived.inst_<id> and COPY rows (+ lineage) into it. Returns the table name."""
    table = f"inst_{instance_id}"
    cols = [_ident(c) for c in props]
    types = {c: sql_type(props[c]) for c in cols}
    ddl = sql.SQL("CREATE TABLE {}.{} (_rid text PRIMARY KEY, _n bigint NOT NULL, _src text[], {})").format(
        sql.Identifier("derived"), sql.Identifier(table),
        sql.SQL(", ").join(sql.SQL("{} {}").format(sql.Identifier(c), sql.SQL(types[c])) for c in cols))
    run(ddl)
    _copy("derived", table, ["_rid", "_n", "_src", *cols],
          ((f"{instance_id}:{n}", n, (srcs[n] if srcs else None),
            *[_value(r.get(c), types[c]) for c in cols]) for n, r in enumerate(rows)))
    _register(instance_id, "derived", table, view_id, "derived")
    return table


def write_raw(batch_id: str, view_id: str, props: dict, rows: list[dict]) -> str:
    """Append a batch to raw.src_<view> (created on first use, append-only). Returns the table name."""
    table = f"src_{view_id}"
    cols = [_ident(c) for c in props]
    types = {c: sql_type(props[c]) for c in cols}
    exists = run("SELECT 1 FROM information_schema.tables WHERE table_schema='raw' AND table_name=%s", (table,))
    if not exists:
        run(sql.SQL("CREATE TABLE {}.{} (_rid text PRIMARY KEY, _batch_id text NOT NULL, _n bigint NOT NULL, "
                    "_loaded_at timestamptz NOT NULL DEFAULT now(), {})").format(
            sql.Identifier("raw"), sql.Identifier(table),
            sql.SQL(", ").join(sql.SQL("{} {}").format(sql.Identifier(c), sql.SQL(types[c])) for c in cols)))
        run(sql.SQL("CREATE INDEX ON {}.{} (_batch_id, _n)").format(sql.Identifier("raw"), sql.Identifier(table)))
        run(sql.SQL("CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON {}.{} "
                    "FOR EACH ROW EXECUTE FUNCTION meta.append_only()").format(
            sql.Identifier("raw"), sql.Identifier(table)))
    _copy("raw", table, ["_rid", "_batch_id", "_n", *cols],
          ((f"{batch_id}:{n}", batch_id, n, *[_value(r.get(c), types[c]) for c in cols]) for n, r in enumerate(rows)))
    _register(batch_id, "raw", table, view_id, "raw")
    return table


# ---------------------------------------------------------------- reading

def _location(prefix: str) -> dict:
    r = run("SELECT * FROM meta.tables WHERE prefix = %s", (prefix,))
    if not r:
        raise ValueError(f"no data stored for '{prefix}'")
    return r[0]


def _jsonable(v):
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    return v


def clean(row: dict) -> dict:
    out = {"_rid": row["_rid"]}
    for k, v in row.items():
        if k not in INTERNAL and v is not None:
            out[k] = _jsonable(v)
    if row.get("_src") is not None:
        out["_src"] = row["_src"]
    return out


def register_snapshot(instance_id: str, view_id: str, table: str, batches: list[str]) -> None:
    """A source snapshot is a manifest over raw batches (rows are not copied: raw is append-only)."""
    run("INSERT INTO meta.tables (prefix, schema_name, table_name, view_id, kind, batches) "
        "VALUES (%s,'raw',%s,%s,'snapshot',%s) ON CONFLICT (prefix) DO NOTHING",
        (instance_id, table, view_id, batches))


def _source_of(prefix: str) -> tuple[sql.Composable, sql.Composable, list, sql.Composable]:
    """(table, where, params, order) selecting the rows of an instance, batch or snapshot in storage order."""
    loc = _location(prefix)
    t = sql.SQL("{}.{}").format(sql.Identifier(loc["schema_name"]), sql.Identifier(loc["table_name"]))
    if loc["kind"] == "raw":
        return t, sql.SQL("_batch_id = %s"), [prefix], sql.SQL("_n")
    if loc["kind"] == "snapshot":
        return (t, sql.SQL("_batch_id = ANY(%s)"), [loc["batches"]],
                sql.SQL("array_position({}::text[], _batch_id), _n").format(sql.Literal(loc["batches"])))
    return t, sql.SQL("TRUE"), [], sql.SQL("_n")


def read(prefix: str, where: dict | None = None, limit: int | None = None, offset: int = 0,
         keep_src: bool = False) -> tuple[int, list[dict]]:
    """Rows of one instance/batch in order, with an optional equality filter. Returns (total, rows)."""
    t, base, params, order = _source_of(prefix)
    conds, p = [base], list(params)
    for k, v in (where or {}).items():
        conds.append(sql.SQL("{}::text = %s").format(sql.Identifier(_ident(k))))
        p.append(str(v))
    w = sql.SQL(" AND ").join(conds)
    total = run(sql.SQL("SELECT count(*) AS n FROM {} WHERE {}").format(t, w), p)[0]["n"]
    q = sql.SQL("SELECT * FROM {} WHERE {} ORDER BY {}").format(t, w, order)
    if limit is not None:
        q = sql.SQL("SELECT * FROM {} WHERE {} ORDER BY {} LIMIT %s OFFSET %s").format(t, w, order)
        p += [int(limit), int(offset)]
    rows = run(q, p)
    return total, [clean(r) if keep_src else {k: v for k, v in clean(r).items() if k != "_src"} for r in rows]


def by_rids(rids: list[str]) -> list[dict]:
    """Fetch rows by rid across tables (grouped by prefix); keeps _src for lineage walking."""
    out = []
    groups: dict[str, list[str]] = {}
    for r in rids:
        groups.setdefault(r.split(":")[0], []).append(r)
    for prefix, ids in groups.items():
        t, _, _, _ = _source_of(prefix)
        out += [clean(r) for r in run(sql.SQL("SELECT * FROM {} WHERE _rid = ANY(%s) ORDER BY _n").format(t), (ids,))]
    return out


def stream(prefix: str, page: int = 10_000):
    """All rows of an instance/batch/snapshot in storage order (with _src), paged; used for hashing."""
    t, base, params, order = _source_of(prefix)
    offset = 0
    while True:
        rows = run(sql.SQL("SELECT * FROM {} WHERE {} ORDER BY {} LIMIT %s OFFSET %s").format(t, base, order),
                   [*params, page, offset])
        for r in rows:
            yield clean(r)
        if len(rows) < page:
            return
        offset += page


def drop_prefixes(prefixes: list[str]) -> int:
    """Remove stored data for instances/batches (drops derived tables; raw tables are dropped per view)."""
    n = 0
    for p in prefixes:
        r = run("SELECT * FROM meta.tables WHERE prefix = %s", (p,))
        if not r:
            continue
        loc = r[0]
        if loc["kind"] == "derived":
            run(sql.SQL("DROP TABLE IF EXISTS {}.{}").format(sql.Identifier("derived"), sql.Identifier(loc["table_name"])))
        run("DELETE FROM meta.tables WHERE prefix = %s", (p,))
        n += 1
    return n


def drop_raw_for_views(view_ids: list[str]) -> None:
    for v in view_ids:
        run(sql.SQL("DROP TABLE IF EXISTS {}.{}").format(sql.Identifier("raw"), sql.Identifier(f"src_{v}")))
        run("DELETE FROM meta.tables WHERE kind = 'raw' AND view_id = %s", (v,))


def wipe() -> None:
    run("DROP SCHEMA IF EXISTS raw CASCADE")
    run("DROP SCHEMA IF EXISTS derived CASCADE")
    run("DROP SCHEMA IF EXISTS meta CASCADE")
    ensure_schema()


def attach(prefix: str, label: str) -> None:
    pass  # rows are located through meta.tables; nothing to link
