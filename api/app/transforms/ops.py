"""Declarative ops transforms: static column check (S2) and interpreter (S3)."""
from .expr import names

KNOWN = {"filter", "derive", "aggregate", "sort", "limit"}
AGG_FNS = {"mean", "median", "sum", "count", "min", "max"}


def check(spec: dict, input_cols: list[str], output_cols: list[str]) -> list[str]:
    """Walk the ops tracking which columns exist; return human-readable warnings."""
    ops = spec.get("ops")
    if not isinstance(ops, list) or not ops:
        return ["spec must be {\"ops\": [ ... ]} with at least one op"]
    cols, warnings = set(input_cols), []

    def need(i: int, needed, what: str):
        missing = sorted(set(needed) - cols)
        if missing:
            warnings.append(f"op {i} ({what}): column(s) {missing} not available; have {sorted(cols)}")

    for i, o in enumerate(ops):
        kind = o.get("op")
        try:
            if kind not in KNOWN:
                warnings.append(f"op {i}: unknown op '{kind}' (known: {sorted(KNOWN)})")
            elif kind == "filter":
                need(i, names(o["where"]), "filter")
            elif kind == "derive":
                need(i, names(o["expr"]), f"derive {o['column']}")
                cols.add(o["column"])
            elif kind == "aggregate":
                by, metrics = o.get("by", []), o.get("metrics", {})
                need(i, by, "aggregate by")
                for out, (col, fn) in metrics.items():
                    need(i, [col], f"metric {out}")
                    if fn not in AGG_FNS:
                        warnings.append(f"op {i}: unknown aggregate fn '{fn}' (known: {sorted(AGG_FNS)})")
                cols = set(by) | set(metrics)
            elif kind == "sort":
                need(i, o.get("by", []), "sort")
        except (KeyError, TypeError, ValueError) as e:
            warnings.append(f"op {i} ({kind}): malformed — {e}")
    missing = sorted(set(output_cols) - cols)
    if missing:
        warnings.append(f"output column(s) {missing} are not produced by the ops")
    return warnings
