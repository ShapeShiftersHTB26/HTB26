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


def run(inputs: dict, spec: dict):
    """Interpret ops over the single input frame (has `_rid`). Output carries `_src` (list of input rids)."""
    import pandas as pd

    from .expr import ev

    if len(inputs) != 1:
        raise ValueError(f"ops transforms read exactly one view (got {len(inputs)})")
    df = next(iter(inputs.values())).copy()
    df["_src"] = df["_rid"].map(lambda r: [r])
    for i, o in enumerate(spec.get("ops", [])):
        kind = o.get("op")
        try:
            if kind == "filter":
                mask = ev(o["where"], df)
                df = df[mask.fillna(False).astype(bool)] if hasattr(mask, "fillna") else df[mask]
            elif kind == "derive":
                df[o["column"]] = ev(o["expr"], df)
            elif kind == "aggregate":
                by, metrics = o.get("by", []), o.get("metrics", {})
                agg = {out: pd.NamedAgg(column=col, aggfunc=fn) for out, (col, fn) in metrics.items()}
                agg["_src"] = pd.NamedAgg(column="_src", aggfunc=lambda s: [r for lst in s for r in lst])
                df = df.groupby(by, dropna=False).agg(**agg).reset_index() if by else \
                    pd.DataFrame([{out: getattr(df[c], f)() for out, (c, f) in metrics.items()}
                                  | {"_src": [r for lst in df["_src"] for r in lst]}])
            elif kind == "sort":
                df = df.sort_values(o.get("by", []), ascending=not o.get("desc", False))
            elif kind == "limit":
                df = df.head(int(o["n"]))
            else:
                raise ValueError(f"unknown op '{kind}'")
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"op {i} ({kind}) failed: {type(e).__name__}: {e}") from e
    return df.reset_index(drop=True)
