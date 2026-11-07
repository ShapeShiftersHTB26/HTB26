"""Source transform: read a CSV (in chunks), filter, and infer a row schema."""
import pandas as pd

from .expr import ev


def run(spec: dict) -> pd.DataFrame:
    cols = spec.get("columns")
    kwargs = {"chunksize": 200_000, "low_memory": False}
    if cols:
        kwargs.update(names=cols, header=None)
    chunks, kept = [], 0
    for chunk in pd.read_csv(spec["path"], **kwargs):
        for c in spec.get("parse_dates") or []:
            chunk[c] = pd.to_datetime(chunk[c], errors="coerce")
        if spec.get("filter"):
            chunk = chunk[ev(spec["filter"], chunk)]
        chunks.append(chunk)
        kept += len(chunk)
        if spec.get("limit") and kept >= spec["limit"]:
            break
    df = pd.concat(chunks, ignore_index=True) if chunks else pd.DataFrame(columns=cols or [])
    if spec.get("limit"):
        df = df.head(spec["limit"])
    return df


def infer_schema(df: pd.DataFrame) -> dict:
    props, required = {}, []
    for c in df.columns:
        s = df[c]
        if pd.api.types.is_bool_dtype(s):
            p = {"type": "boolean", "x-role": "dimension"}
        elif pd.api.types.is_integer_dtype(s):
            p = {"type": "integer", "x-role": "measure"}
        elif pd.api.types.is_float_dtype(s):
            p = {"type": "number", "x-role": "measure"}
        elif pd.api.types.is_datetime64_any_dtype(s):
            p = {"type": "string", "format": "date", "x-role": "time"}
        else:
            p = {"type": "string", "x-role": "dimension"}
        props[c] = p
        if not s.isna().any():
            required.append(c)
    return {"type": "object", "properties": props, "required": required}
