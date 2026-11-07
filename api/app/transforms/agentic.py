"""Agentic transforms: the api calls Claude with the output shape as a structured-output JSON schema.
- agent_map: per row, adds the fields the output shape has but the input lacks; lineage 1:1 via _rid
- agent_reduce: whole table in, a few rows out; each row cites `_src` (input rids), unknown rids dropped
Responses are cached on disk by sha256(model + prompt + payload)."""
import hashlib
import json
import os

import anthropic
import pandas as pd

MODEL = os.environ.get("BACKTRACE_MODEL") or "claude-haiku-5-5"
CACHE_DIR = "/data/cache"
_client = None

SYSTEM = ("You are one transformation step in a data pipeline where every output must be traceable to its "
          "input rows. Follow the task exactly, return only the requested JSON, and never invent input rows. "
          "When a value must be inferred rather than read from the data, give your best estimate.")


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def _field_schema(spec: dict) -> dict:
    """Strip annotations (x-*) and unsupported constraints; keep type/format/enum/description."""
    keep = {k: v for k, v in spec.items() if k in ("type", "format", "enum", "description")}
    return keep or {"type": "string"}


def _rows_schema(fields: dict, extra: dict) -> dict:
    props = {**extra, **{k: _field_schema(v) for k, v in fields.items()}}
    return {"type": "object", "additionalProperties": False, "required": ["rows"],
            "properties": {"rows": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": list(props), "properties": props}}}}


def _describe(fields: dict) -> str:
    return "\n".join(f"- {k} ({v.get('type')}{', ' + v['x-unit'] if v.get('x-unit') else ''}): "
                     f"{v.get('description', '')}" for k, v in fields.items())


def _call(prompt: str, payload: list[dict], schema: dict) -> list[dict]:
    body = json.dumps(payload, sort_keys=True, default=str)
    key = hashlib.sha256((MODEL + "\n" + prompt + "\n" + json.dumps(schema, sort_keys=True) + "\n" + body)
                         .encode()).hexdigest()
    path = os.path.join(CACHE_DIR, f"{key}.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    # server-side fallback on refusal where the model has one (Haiku 5.5 doesn't)
    fallback = {} if "haiku" in MODEL else {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    resp = client().beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        **fallback,
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
        system=SYSTEM,
        messages=[{"role": "user", "content": f"{prompt}\n\nINPUT ROWS (JSON):\n{body}"}],
    )
    if resp.stop_reason == "refusal":
        raise ValueError("the model declined this transform (refusal)")
    if resp.stop_reason == "max_tokens":
        raise ValueError("model output hit max_tokens; reduce batch_size / max_rows")
    text = next(b.text for b in resp.content if b.type == "text")
    rows = json.loads(text)["rows"]
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f)
    return rows


def _records(df: pd.DataFrame, cols: list[str]) -> list[dict]:
    from ..executor import to_rows
    rows = to_rows(df[cols])
    return [{"_rid": rid, **r} for rid, r in zip(df["_rid"], rows)]


def run_map(inputs: dict, spec: dict, shape: dict) -> pd.DataFrame:
    if len(inputs) != 1:
        raise ValueError("agent_map reads exactly one view")
    df = next(iter(inputs.values()))
    props = shape.get("properties", {})
    in_cols = [c for c in df.columns if c != "_rid"]
    new = {k: v for k, v in props.items() if k not in df.columns}
    if not new:
        raise ValueError("agent_map: output shape has no new fields beyond the input columns")
    schema = _rows_schema(new, {"_rid": {"type": "string"}})
    prompt = (f"TASK (apply to each input row): {spec['prompt']}\n\nFor EVERY input row return one object with its "
              f"`_rid` and these fields:\n{_describe(new)}")
    out = []
    size = int(spec.get("batch_size", 50))
    for start in range(0, len(df), size):
        chunk = df.iloc[start:start + size]
        out += _call(prompt, _records(chunk, in_cols), schema)
    got = pd.DataFrame(out).drop_duplicates("_rid") if out else pd.DataFrame(columns=["_rid", *new])
    merged = df.merge(got, on="_rid", how="inner")
    merged["_src"] = merged["_rid"].map(lambda r: [r])
    return merged


def run_reduce(inputs: dict, spec: dict, shape: dict) -> pd.DataFrame:
    if len(inputs) != 1:
        raise ValueError("agent_reduce reads exactly one view")
    df = next(iter(inputs.values()))
    max_rows = int(spec.get("max_rows", 200))
    if len(df) > max_rows:
        raise ValueError(f"agent_reduce input has {len(df)} rows (max_rows={max_rows}); aggregate first")
    props = shape.get("properties", {})
    schema = _rows_schema(props, {"_src": {"type": "array", "items": {"type": "string"},
                                           "description": "_rid values of the input rows this output is based on"}})
    prompt = (f"TASK (over the whole table): {spec['prompt']}\n\nReturn output rows with these fields:\n"
              f"{_describe(props)}\n- _src: the `_rid`s of the input rows that justify each output row (cite them).")
    out = _call(prompt, _records(df, [c for c in df.columns if c != "_rid"]), schema)
    valid = set(df["_rid"])
    for r in out:
        r["_src"] = [s for s in r.get("_src", []) if s in valid]
    return pd.DataFrame(out) if out else pd.DataFrame(columns=[*props, "_src"])
