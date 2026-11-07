"""Pluggable row stores. A store is a module implementing:
  write_raw(batch_id, view_id, props, rows) -> location     append a source batch
  write_derived(instance_id, view_id, props, rows, srcs)    write a derived instance (+ lineage _src)
  register_snapshot(instance_id, view_id, location, batches)
  attach(prefix, label)                                     optional hook once the manifest node exists
  read(prefix, where, limit, offset, keep_src) -> (total, rows)
  by_rids(rids) -> rows (with _src)      stream(prefix) -> rows in storage order (with _src)
  drop_prefixes(prefixes)                drop_raw_for_views(view_ids)                ping()
Every row is returned as {_rid, <fields>, _src?} so hashes are identical whichever store holds the data.
Which store holds a batch/instance is recorded on its manifest node (`store`); legacy manifests = postgres."""
import os

from . import graph as g
from . import graphstore, pg

STORES = {"postgres": pg, "graph": graphstore}
DEFAULT = os.environ.get("BACKTRACE_STORE", "postgres")


def get(name: str | None):
    name = name or DEFAULT
    if name not in STORES:
        raise ValueError(f"unknown store '{name}' (available: {sorted(STORES)})")
    return STORES[name]


def name_for_view(view_id: str) -> str:
    r = g.run("MATCH (v:View {id:$v}) RETURN v.store AS s", v=view_id)
    return (r[0]["s"] if r and r[0]["s"] else None) or DEFAULT


def of_prefix(prefix: str):
    r = g.run("MATCH (x) WHERE (x:Instance OR x:Batch) AND x.id = $p RETURN x.store AS s LIMIT 1", p=prefix)
    return get(r[0]["s"] if r and r[0]["s"] else "postgres")


def read(prefix: str, **kw):
    return of_prefix(prefix).read(prefix, **kw)


def stream(prefix: str):
    return of_prefix(prefix).stream(prefix)


def by_rids(rids: list[str]) -> list[dict]:
    groups: dict[str, list[str]] = {}
    for r in rids:
        groups.setdefault(r.split(":")[0], []).append(r)
    out = []
    for prefix, ids in groups.items():
        out += of_prefix(prefix).by_rids(ids)
    return out


def drop_views(view_ids: list[str], prefixes: list[str]) -> None:
    for st in STORES.values():
        try:
            st.drop_prefixes(prefixes)
            st.drop_raw_for_views(view_ids)
        except RuntimeError:
            pass  # store not configured
