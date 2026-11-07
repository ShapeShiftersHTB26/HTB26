"""Hierarchical hashes.
  row      = canonical JSON of a stored row (incl. _rid and _src lineage; None dropped; numbers normalised)
  data root= Merkle root over chunks of CHUNK row hashes, rows in storage order
  formula  = H(engine, transform kind+spec (recipe: minus run params), shape schema, sorted input formula hashes)
  batch    = H(recipe formula, file sha256, batch data root)
  instance = H(formula, data root, input hashes)   input hashes: batch hashes (snapshots) / input instance hashes
The instance hash of a final view therefore commits to every operation and every row down to the source files."""
import hashlib
import json
import math
from typing import Iterable

ENGINE = "backtrace-exec/1"   # bump when evaluation semantics change
CHUNK = 10_000
SEP = "\x1f"
RUN_PARAMS = ("path",)        # recipe fields that vary per run (recorded on the batch, not in the formula)


def h(*parts: str) -> str:
    return hashlib.sha256(SEP.join(parts).encode()).hexdigest()


def _canon(v):
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return str(v)
        if v.is_integer() and abs(v) < 2**53:
            return int(v)
        return float(format(v, ".12g"))
    if isinstance(v, dict):
        return {k: _canon(x) for k, x in v.items() if x is not None}
    if isinstance(v, (list, tuple)):
        return [_canon(x) for x in v]
    return str(v)


def row_hash(row: dict) -> str:
    clean = {k: _canon(v) for k, v in row.items() if v is not None}
    return hashlib.sha256(json.dumps(clean, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                          .encode()).hexdigest()


def merkle(leaves: list[str]) -> str:
    if not leaves:
        return hashlib.sha256(b"").hexdigest()
    level = leaves
    while len(level) > 1:
        level = [h(level[i], level[i + 1] if i + 1 < len(level) else level[i]) for i in range(0, len(level), 2)]
    return level[0]


def data_root(rows: Iterable[dict]) -> tuple[str, int]:
    """Merkle root over chunk hashes; returns (root, row_count)."""
    chunks, cur, n = [], [], 0
    for r in rows:
        cur.append(row_hash(r))
        n += 1
        if len(cur) == CHUNK:
            chunks.append(h(*cur))
            cur = []
    if cur:
        chunks.append(h(*cur))
    return merkle(chunks), n


def _canon_json(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def formula_hash(kind: str, spec: dict, schema: dict, input_formulas: list[str]) -> str:
    spec = {k: v for k, v in (spec or {}).items() if not (kind == "source" and k in RUN_PARAMS)}
    return h("formula", ENGINE, _canon_json({"kind": kind, "spec": spec, "schema": schema}),
             *sorted(input_formulas))


def batch_hash(formula: str, file_sha256: str, root: str) -> str:
    return h("batch", formula, file_sha256 or "", root)


def instance_hash(formula: str, root: str, input_hashes: list[str], ordered: bool = False) -> str:
    return h("instance", formula, root, *(input_hashes if ordered else sorted(input_hashes)))


def file_sha256(path: str) -> str:
    d = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            d.update(block)
    return d.hexdigest()
