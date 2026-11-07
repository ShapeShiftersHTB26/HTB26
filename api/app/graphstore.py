"""Graph (Memgraph) implementation of the row store, as in the first version: rows are Record nodes,
lineage is _src on the record plus (Record)-[:DERIVED_FROM]->(Record) edges, and records hang off their
Instance/Batch via [:IN]. Same interface as pg.py (see store.py)."""
import re

from . import graph as g

BATCH = 1000
INTERNAL = ("rid", "_n", "_prefix", "_view_id", "_src")


def _ident(name: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError(f"bad column name {name!r}")
    return name


def ping() -> bool:
    g.run("RETURN 1")
    return True


def _write(prefix: str, view_id: str, rows: list[dict], srcs: list[list[str]] | None) -> None:
    for start in range(0, len(rows), BATCH):
        batch = []
        for n, r in enumerate(rows[start:start + BATCH], start):
            rec = {k: v for k, v in r.items() if v is not None and not k.startswith("_")}
            rec.update({"rid": f"{prefix}:{n}", "_n": n, "_prefix": prefix, "_view_id": view_id})
            if srcs:
                rec["_src"] = list(srcs[n] or [])
            batch.append(rec)
        g.run("UNWIND $rows AS row CREATE (r:Record) SET r = row", rows=batch)
    if srcs:
        pairs = [[f"{prefix}:{n}", s] for n, ss in enumerate(srcs) for s in (ss or [])]
        for start in range(0, len(pairs), BATCH):
            g.run("UNWIND $pairs AS p MATCH (a:Record {rid:p[0]}), (b:Record {rid:p[1]}) "
                  "CREATE (a)-[:DERIVED_FROM]->(b)", pairs=pairs[start:start + BATCH])


def write_raw(batch_id: str, view_id: str, props: dict, rows: list[dict]) -> str:
    for c in props:
        _ident(c)
    _write(batch_id, view_id, rows, None)
    return f"Record[_view_id={view_id}]"


def write_derived(instance_id: str, view_id: str, props: dict, rows: list[dict], srcs) -> str:
    for c in props:
        _ident(c)
    _write(instance_id, view_id, rows, srcs)
    return f"Record[_prefix={instance_id}]"


def register_snapshot(instance_id: str, view_id: str, table: str, batches: list[str]) -> None:
    pass  # the snapshot manifest (Instance.batches) is the registration


def attach(prefix: str, label: str) -> None:
    """Link records to their Instance/Batch node once it exists (for exploring in Lab)."""
    g.run(f"MATCH (x:{label} {{id:$p}}) MATCH (r:Record {{_prefix:$p}}) CREATE (r)-[:IN]->(x)", p=prefix)


def clean(r: dict) -> dict:
    out = {"_rid": r["rid"], **{k: v for k, v in r.items() if k not in INTERNAL and v is not None}}
    if r.get("_src") is not None:
        out["_src"] = list(r["_src"])
    return out


def _parts(prefix: str) -> list[str]:
    """A snapshot instance reads its batches in order; anything else is a single prefix."""
    r = g.run("MATCH (i:Instance {id:$p}) RETURN i.batches AS b", p=prefix)
    if r and r[0]["b"]:
        import json
        return json.loads(r[0]["b"])
    return [prefix]


def _where(where: dict | None) -> tuple[str, dict]:
    conds, params = [], {}
    for n, (k, v) in enumerate((where or {}).items()):
        conds.append(f"toString(r.`{_ident(k)}`) = $w{n}")
        params[f"w{n}"] = str(v)
    return (" AND " + " AND ".join(conds)) if conds else "", params


def read(prefix: str, where: dict | None = None, limit: int | None = None, offset: int = 0,
         keep_src: bool = False) -> tuple[int, list[dict]]:
    w, params = _where(where)
    total, rows = 0, []
    for part in _parts(prefix):
        total += g.run(f"MATCH (r:Record {{_prefix:$p}}) WHERE TRUE{w} RETURN count(r) AS n", p=part, **params)[0]["n"]
        rows += [clean(x["r"]) for x in g.run(
            f"MATCH (r:Record {{_prefix:$p}}) WHERE TRUE{w} RETURN r ORDER BY r._n", p=part, **params)]
    rows = rows[offset:] if limit is None else rows[offset:offset + int(limit)]
    if not keep_src:
        rows = [{k: v for k, v in x.items() if k != "_src"} for x in rows]
    return total, rows


def by_rids(rids: list[str]) -> list[dict]:
    rows = [clean(x["r"]) for x in g.run("MATCH (r:Record) WHERE r.rid IN $ids RETURN r", ids=rids)]
    return sorted(rows, key=lambda x: (x["_rid"].split(":")[0], int(x["_rid"].split(":")[1])))


def stream(prefix: str, page: int = 10_000):
    for part in _parts(prefix):
        offset = 0
        while True:
            rows = g.run("MATCH (r:Record {_prefix:$p}) RETURN r ORDER BY r._n SKIP $o LIMIT $l",
                         p=part, o=offset, l=page)
            for x in rows:
                yield clean(x["r"])
            if len(rows) < page:
                break
            offset += page


def drop_prefixes(prefixes: list[str]) -> int:
    g.run("MATCH (r:Record) WHERE r._prefix IN $p DETACH DELETE r", p=prefixes)
    return len(prefixes)


def drop_raw_for_views(view_ids: list[str]) -> None:
    g.run("MATCH (r:Record) WHERE r._view_id IN $v DETACH DELETE r", v=view_ids)
