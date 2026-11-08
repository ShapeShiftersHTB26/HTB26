"""Prediction markets settled by data: turn a computed view into a YES/NO market on one of its numbers.

A market = a view + a row (equality selector on its key columns) + a numeric column + a comparator + a line
(threshold) + a settlement time. Creation checks that a calculation alone can decide it:
  - every step from the sources to the view is approved and is a fixed calculation (ops), with no LLM steps,
    so re-running it always gives the same answer (and `verify` can re-run it and match the fingerprint);
  - the selector picks at most one row, and the column is numeric: one number against one line is binary.
The calculation is pinned (the shape + transform of every view upstream, and its formula hash). Settlement runs
exactly that calculation on whatever data has been appended to the sources by then, even if the view is revised
later, verifies the hash tree, compares, and resolves the market on the prediction-market backend with the
evidence (value, row, instance fingerprint, source files). No row by then = void.

Markets live in the prediction-market backend (PM_API_URL); the rule is stored with the market (`resolution`).
settle_market is permissionless (the outcome doesn't depend on who calls it); `loop` settles due markets."""
import asyncio
import json
import logging
import math
import os
import re
import traceback
from datetime import datetime, timedelta, timezone

import httpx
from fastapi.concurrency import run_in_threadpool

from . import executor as X
from . import graph as g
from . import proposals as P
from . import store as ST
from .registry import operation

PM_API_URL = os.environ.get("PM_API_URL", "").rstrip("/")
PM_ADMIN_KEY = os.environ.get("PM_ADMIN_KEY", "")
logging.getLogger("httpx").setLevel(logging.WARNING)  # the settlement loop polls every 20 s
MIN_LEAD = timedelta(minutes=2)
MAX_ROWS = 5000
DATA_LAG = timedelta(days=30)  # periods are usually published about a month after they end
OPS = {">": "above", ">=": "at least", "<": "below", "<=": "at most"}
DETERMINISTIC = ("ops", "source")


# ---------------------------------------------------------------- prediction-market backend

def _pm(method: str, path: str, **kw) -> dict:
    if not PM_API_URL:
        raise ValueError("prediction markets are not configured (set PM_API_URL and PM_ADMIN_KEY for the api)")
    headers = {"x-admin-key": PM_ADMIN_KEY} if method != "GET" else {}
    try:
        r = httpx.request(method, f"{PM_API_URL}{path}", headers=headers, timeout=180, **kw)
    except httpx.HTTPError as e:
        raise ValueError(f"prediction-market backend unreachable at {PM_API_URL}: {e}") from e
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code >= 400:
        raise ValueError(f"prediction market: {body.get('error') or r.text[:200]}")
    return body


# ---------------------------------------------------------------- formatting

def _label(name: str) -> str:
    return name.replace("_", " ")


def _num(v: float) -> str:
    return f"{int(v):,}" if float(v).is_integer() else f"{v:,.2f}".rstrip("0").rstrip(".")


def _fmt(v, unit: str | None) -> str:
    if not isinstance(v, (int, float)):
        return str(v)
    u = (unit or "").lower()
    sym = {"gbp": "£", "usd": "$", "eur": "€"}.get(u)
    if sym:
        return f"{'-' if v < 0 else ''}{sym}{_num(round(abs(v)) if abs(v) >= 100 else abs(v))}"
    if u in ("%", "percent", "pct"):
        return f"{_num(v)}%"
    if u in ("", "count", "number", "rows"):
        return _num(v)
    return f"{_num(v)} {unit}"


def _nice(x: float) -> float:
    """Round to 3 significant figures: a line people can read (287,432 -> 287,000)."""
    if not x or not math.isfinite(x):
        return 0
    step = 10 ** (math.floor(math.log10(abs(x))) - 2)
    r = round(round(x / step) * step, 6)
    return int(r) if float(r).is_integer() else r


def _where_text(where: dict) -> str:
    return ", ".join(f"{_label(k)} {v}" for k, v in where.items())


# ---------------------------------------------------------------- rows, periods, comparisons

def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _eq(a, b) -> bool:
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return str(a) == str(b)


def _holds(v: float, op: str, line: float) -> bool:
    return {">": v > line, ">=": v >= line, "<": v < line, "<=": v <= line}[op]


def _columns(shape: dict) -> list[dict]:
    out = []
    for name, spec in (shape.get("schema", {}).get("properties") or {}).items():
        t = spec.get("type")
        types = t if isinstance(t, list) else [t]
        out.append({"name": name, "role": spec.get("x-role"), "unit": spec.get("x-unit"),
                    "description": spec.get("description"),
                    "numeric": any(x in ("number", "integer") for x in types)})
    return out


def _time_col(cols: list[dict]) -> str | None:
    c = next((c for c in cols if c["role"] == "time"), None) or next(
        (c for c in cols if c["name"].lower() in ("year", "period", "month")), None)
    return c["name"] if c else None


_MONTH = re.compile(r"^(\d{4})-(\d{2})(-01)?$")


def _next_period(values: list):
    """The period after the latest one: years (2025 -> 2026) and months ("2026-09" -> "2026-10")."""
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    if all(_is_num(v) and float(v).is_integer() and 1900 < v < 2200 for v in vals):
        return int(max(vals)) + 1
    ms = [_MONTH.match(str(v)) for v in vals]
    if all(ms):
        last = max(vals, key=str)
        y, m = int(str(last)[:4]), int(str(last)[5:7]) + 1
        y, m = (y + 1, 1) if m > 12 else (y, m)
        return f"{y:04d}-{m:02d}" + ("-01" if str(last).endswith("-01") and len(str(last)) == 10 else "")
    return None


def _period_end(v) -> datetime | None:
    if _is_num(v) and float(v).is_integer() and 1900 < v < 2200:
        return datetime(int(v) + 1, 1, 1, tzinfo=timezone.utc)
    m = _MONTH.match(str(v))
    if m:
        y, mo = int(m.group(1)), int(m.group(2)) + 1
        y, mo = (y + 1, 1) if mo > 12 else (y, mo)
        return datetime(y, mo, 1, tzinfo=timezone.utc)
    return None


def _parse_time(s: str) -> datetime:
    t = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- the pinned calculation

def _chain(view_id: str) -> dict[str, dict]:
    """Current shape + transform of the view and of every view upstream of it, down to the sources."""
    out, todo = {}, [view_id]
    while todo:
        vid = todo.pop()
        if vid in out:
            continue
        shape, transform = X._heads(vid)  # ValueError when something upstream isn't approved yet
        out[vid] = {"name": P.view_node(vid)["name"], "shape": shape, "transform": transform}
        todo += transform.get("reads") or []
    return out


def _pinned(vid: str, pins: dict) -> tuple[dict, dict]:
    sid, tid = pins[vid]
    s = g.run("MATCH (s:SchemaVersion {id:$s}) RETURN s", s=sid)
    t = g.run("MATCH (t:Transform {id:$t}) RETURN t", t=tid)
    if not s or not t:
        raise ValueError(f"the pinned calculation of view {vid} no longer exists")
    return P.decode(s[0]["s"]), P.decode(t[0]["t"])


def _run(vid: str, pins: dict, memo: dict) -> dict:
    """Evaluate the pinned chain on the latest source snapshots; returns the view's instance node. An instance
    computed by the same shape + transform from exactly the same inputs is reused (the steps are deterministic)."""
    if vid in memo:
        return memo[vid]
    shape, transform = _pinned(vid, pins)
    if transform["kind"] == "source":
        rows = g.run("MATCH (i:Instance {view_id:$v})-[:USED_TRANSFORM]->(:Transform {id:$t}) "
                     "RETURN i ORDER BY i.created_at DESC LIMIT 1", v=vid, t=transform["id"])
        if not rows:
            raise ValueError(f"source {P.view_node(vid)['name']} has no data for its pinned recipe")
        inst = rows[0]["i"]
    else:
        reads = transform.get("reads") or []
        ins = [_run(r, pins, memo) for r in reads]
        want = sorted(x["id"] for x in ins)
        inst = None
        for r in g.run("MATCH (i:Instance {view_id:$v})-[:USED_TRANSFORM]->(:Transform {id:$t}), "
                       "(i)-[:USED_SCHEMA]->(:SchemaVersion {id:$s}) OPTIONAL MATCH (i)-[:FROM]->(j:Instance) "
                       "WITH i, collect(j.id) AS ins RETURN i, ins ORDER BY i.created_at DESC",
                       v=vid, t=transform["id"], s=shape["id"]):
            if sorted(r["ins"]) == want and r["i"].get("hash"):
                inst = r["i"]
                break
        if inst is None:
            frames = {P.view_node(r)["name"]: X.load_frame(x["id"]) for r, x in zip(reads, ins)}
            formula = X._formula(transform, shape, [x["formula_hash"] for x in ins])
            rows, srcs, invalid, model = X._compute(transform, shape, frames)
            res = X.write_instance(vid, rows, srcs, shape["id"], transform["id"], [x["id"] for x in ins],
                                   invalid_count=invalid, model=model, formula=formula)
            inst = X.instance_node(res["instance_id"])
    memo[vid] = inst
    return inst


def _sources(pins: dict, memo: dict) -> list[dict]:
    """The source data a pinned evaluation used: per source view, its snapshot's files and fingerprint."""
    out = []
    for vid in pins:
        inst = memo.get(vid)
        if not inst or not inst.get("batches"):
            continue
        ids = json.loads(inst["batches"])
        files = [os.path.basename(r["p"]) for r in g.run(
            "MATCH (b:Batch) WHERE b.id IN $ids RETURN b.path AS p ORDER BY b.created_at", ids=ids)]
        out.append({"view_id": vid, "name": P.view_node(vid)["name"], "files": files,
                    "rows": inst.get("row_count"), "hash": inst.get("hash")})
    return out


def _rows(instance_id: str) -> tuple[int, list[dict]]:
    return ST.read(instance_id, limit=MAX_ROWS)


# ---------------------------------------------------------------- draft = defaults + validation

def _draft(view_id: str, where: dict | None, column: str | None, op: str | None, threshold,
           resolution_time: str | None, initial_price_cents, question: str | None, verify: bool) -> dict:
    checks: list[dict] = []

    def add(level: str, text: str):
        checks.append({"level": level, "text": text})

    view = P.view_node(view_id)
    out: dict = {"view": {"id": view_id, "name": view["name"], "question": view.get("question") or "",
                          "intent_id": view.get("intent_id")}, "checks": checks}

    def done():
        out["ok"] = not any(c["level"] == "error" for c in checks)
        return out

    if view.get("kind") == "source":
        add("error", "This is raw source data, one row per record. Build a summary table on it in Research "
                     "(e.g. a monthly median), then make the market on that.")
        return done()
    try:
        chain = _chain(view_id)
    except ValueError as e:
        add("error", f"Not fully computed yet: {e}. Finish the calculation in Research first.")
        return done()
    pins = {vid: [c["shape"]["id"], c["transform"]["id"]] for vid, c in chain.items()}
    llm = [c for c in chain.values() if c["transform"]["kind"] not in DETERMINISTIC]
    srcs = sorted(c["name"] for c in chain.values() if c["transform"]["kind"] == "source")
    if llm:
        for c in llm:
            add("error", f"{c['name']} is computed by an AI step ({c['transform']['kind']}): re-running it can give a "
                         "different answer, so it can't settle a market. Rebuild it with fixed calculations.")
    else:
        add("ok", f"Deterministic: every step from {', '.join(srcs) or 'the source'} is a fixed calculation, so "
                  "re-running it always gives the same answer.")

    memo: dict = {}
    if llm:
        inst = X.latest_instance(view_id)  # display only: never re-run AI steps here
    else:
        try:
            inst = _run(view_id, pins, memo)
        except Exception as e:  # noqa: BLE001  (a broken step: report, don't crash the form)
            add("error", f"The calculation fails on the latest data: {e}")
            inst = None
    if inst is None:
        if not any(c["level"] == "error" for c in checks):
            add("error", "The table hasn't been computed yet.")
        return done()
    total, rows = _rows(inst["id"])
    out["instance"] = {k: inst.get(k) for k in ("id", "hash", "formula_hash", "row_count", "created_at")}
    if total > MAX_ROWS:
        add("error", f"The table has {total:,} rows: a market needs a summary table. Aggregate it first.")
        return done()

    shape = chain[view_id]["shape"]
    cols = _columns(shape)
    by = {c["name"]: c for c in cols}
    measures = [c["name"] for c in cols if c["numeric"] and c["role"] == "measure"] or \
               [c["name"] for c in cols if c["numeric"] and c["role"] not in ("time", "id")]
    keys = [c["name"] for c in cols if c["name"] not in measures and c["role"] not in ("geo_lat", "geo_lon")]
    tc = _time_col(cols)
    tc = tc if tc in keys else None
    options = {}
    for k in keys:
        vals = sorted({r.get(k) for r in rows if r.get(k) is not None}, key=lambda v: (not _is_num(v), v if _is_num(v) else str(v)))
        options[k] = vals[:80]
    nxt = _next_period(options.get(tc, [])) if tc else None
    if tc and nxt is not None and nxt not in options[tc]:
        options[tc] = options[tc] + [nxt]
    out.update(columns=cols, measures=measures, keys=keys, options=options, time_column=tc, next_period=nxt)
    if not measures:
        add("error", "The table has no numeric column to set a line on.")
        return done()

    # --- the number: column + row
    if column is None:
        column = next((m for m in measures if (by[m]["unit"] or "").lower() != "count"), measures[0])
    if column not in by or not by[column]["numeric"]:
        add("error", f"'{column}' isn't a numeric column of {view['name']}.")
        return done()
    unit = by[column]["unit"]
    if where is None:
        if len(rows) <= 1:
            where = {}
        else:
            base = max(rows, key=lambda r: str(r.get(tc))) if tc else rows[0]
            where = {k: base.get(k) for k in keys if base.get(k) is not None}
            if tc and nxt is not None:
                where[tc] = nxt
    where = {k: v for k, v in (where or {}).items() if v is not None and v != ""}
    bad = [k for k in where if k not in by]
    if bad:
        add("error", f"Unknown column(s) in the row choice: {bad}.")
        return done()
    matched = [r for r in rows if all(_eq(r.get(k), v) for k, v in where.items())]
    current = None
    if len(matched) > 1:
        more = [k for k in keys if k not in where]
        add("error", f"{len(matched)} rows match {_where_text(where) or 'the whole table'}: pick "
                     f"{' and '.join(more) if more else 'more columns'} so exactly one row decides it.")
    elif len(matched) == 1:
        current = matched[0].get(column)
        if not _is_num(current):
            current = None
    else:
        add("warn", f"No row for {_where_text(where)} in the data yet. It settles on the data published by the end "
                    "date; if the row still isn't there, the market is void (each share pays back 50¢).")
    hist = []
    if tc:
        others = {k: v for k, v in where.items() if k != tc}
        hist = sorted(([r[tc], r[column]] for r in rows
                       if r.get(tc) is not None and _is_num(r.get(column))
                       and all(_eq(r.get(k), v) for k, v in others.items())), key=lambda x: str(x[0]) if not _is_num(x[0]) else f"{x[0]:012.2f}")

    # --- the line
    values = [r[column] for r in rows if _is_num(r.get(column))]
    suggested_line = _nice(current if current is not None else hist[-1][1] if hist else
                           sorted(values)[len(values) // 2] if values else 0)
    if threshold is None or threshold == "":
        threshold = suggested_line
    try:
        threshold = float(threshold)
        assert math.isfinite(threshold)
        threshold = int(threshold) if threshold.is_integer() else threshold
    except (TypeError, ValueError, AssertionError):
        add("error", "The line must be a number.")
        return done()
    op = op or ">"
    if op not in OPS:
        add("error", f"The comparison must be one of {list(OPS)}.")
        return done()
    if len(matched) <= 1:
        add("ok", f"Binary: one number ({_label(column)}{' for ' + _where_text(where) if where else ''}) against "
                  f"one line, so it's YES or NO.")
    if current is not None:
        add("warn", f"On today's data this would settle {'YES' if _holds(current, op, threshold) else 'NO'} "
                    f"({_fmt(current, unit)} vs a line of {_fmt(threshold, unit)}). Only data added before the end "
                    "date can change it.")
    ref = [v for _, v in hist] or values
    if ref:
        lo, hi = min(ref), max(ref)
        span = (hi - lo) or abs(hi) or 1
        if threshold > hi + 2 * span or threshold < lo - 2 * span:
            add("warn", f"The line is far outside anything in the data ({_fmt(lo, unit)} to {_fmt(hi, unit)}), so the "
                        "answer is close to certain.")

    # --- when it settles
    now = datetime.now(timezone.utc)
    target_end = _period_end(where[tc]) if tc and tc in where else None
    if not resolution_time:
        if target_end and current is None and target_end + DATA_LAG > now + MIN_LEAD:
            t = target_end + DATA_LAG
        else:
            t = (now + timedelta(days=7)).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        resolution_time = _iso(t)
    try:
        rt = _parse_time(resolution_time)
    except ValueError:
        add("error", "The end date isn't a valid date.")
        return done()
    if rt < now + MIN_LEAD:
        add("error", f"The end date must be at least {int(MIN_LEAD.total_seconds() // 60)} minutes from now.")
    elif target_end and rt < target_end:
        add("warn", f"{where[tc]} isn't over by the end date: it settles on the part of {where[tc]} published by then.")

    # --- a starting chance from how the number moved before (future periods only)
    suggested_chance, why = None, None
    hv = [v for _, v in hist]
    if current is None and len(hv) >= 3 and all(v > 0 for v in hv):
        ratios = [b / a for a, b in zip(hv, hv[1:])]
        hits = sum(_holds(hv[-1] * r, op, threshold) for r in ratios)
        suggested_chance = max(5, min(95, round(100 * (hits + 1) / (len(ratios) + 2))))
        why = (f"If {where.get(tc)} moves like each of the last {len(ratios)} periods did, {hits} of {len(ratios)} "
               f"would settle YES.")
    elif current is not None:
        yes_now = _holds(current, op, threshold)
        suggested_chance = 85 if yes_now else 15
        why = f"Today's data already says {'YES' if yes_now else 'NO'}; only newer data can change it."
    price = initial_price_cents if initial_price_cents not in (None, "") else (suggested_chance or 50)
    try:
        price = int(price)
        assert 2 <= price <= 98
    except (TypeError, ValueError, AssertionError):
        add("error", "The starting chance must be between 2% and 98%.")
        price = 50

    # --- wording
    title = _label(view["name"])
    title = title[:1].upper() + title[1:]
    generated = (f"{title}: will {_label(column)}{' for ' + _where_text(where) if where else ''} be {OPS[op]} "
                 f"{_fmt(threshold, unit)}?")
    q = (question or "").strip() or generated
    if not 10 <= len(q) <= 300:
        add("error", "The question must be 10-300 characters.")
    files = sorted({f for s in _sources(pins, memo) for f in s["files"]})
    formula = inst.get("formula_hash") or ""
    rules = (
        f"Settles automatically from data at {rt.strftime('%d %b %Y %H:%M')} UTC.\n"
        f"YES if {_label(column)}{f' ({unit})' if unit else ''}"
        f"{' for ' + _where_text(where) if where else ''} in the Backtrace table \"{view['name']}\" is "
        f"{OPS[op]} {_fmt(threshold, unit)}, computed at settlement by the calculation pinned when this market opened "
        f"(formula {formula[:12]}) on all data published by then{' (now: ' + ', '.join(files) + ')' if files else ''}. "
        f"NO otherwise.\n"
        "If that row doesn't exist by then, the market is void: each share pays back 50¢.\n"
        "Every step is a fixed calculation, so anyone can re-run it and check the fingerprint.")

    if verify and not any(c["level"] == "error" for c in checks):
        rep = X.verify(inst["id"], recompute=True)
        if rep.get("ok"):
            add("ok", f"Re-ran every step and matched the fingerprint {str(inst.get('hash'))[:12]}.")
        else:
            add("error", "The fingerprint check failed: the stored data doesn't match its calculation.")

    out.update(
        spec={"view_id": view_id, "where": where, "column": column, "unit": unit, "op": op, "threshold": threshold,
              "resolution_time": _iso(rt), "initial_price_cents": price},
        current=current, matched=len(matched) == 1, history=hist, range=[min(ref), max(ref)] if ref else None,
        suggested={"threshold": suggested_line, "chance": suggested_chance, "why": why},
        question=q, generated_question=generated, rules=rules, pins=pins, sources=files)
    return done()


@operation(mcp=True)
def market_draft(view_id: str, where: dict | None = None, column: str | None = None, op: str | None = None,
                 threshold: float | None = None, resolution_time: str | None = None,
                 initial_price_cents: int | None = None, question: str | None = None) -> dict:
    """Check whether a view can settle a YES/NO prediction market, and fill in sensible defaults.
    The market: "will <column> for the row <where> be <op> <threshold> at <resolution_time>?", settled by
    re-running the view's exact calculation on the data published by then.
    - where: equality filter picking ONE row by its key columns, e.g. {"year": 2026}; a future period is allowed
    - op: > | >= | < | <= ; threshold: the line; resolution_time: ISO date-time
    Omitted fields get defaults (next period, current value as the line, ...). Returns checks [{level: ok|warn|error,
    text}], ok (no errors), the filled spec, current value, history, generated question and rules.
    Markets need every step to be a fixed calculation (ops): AI steps (agent_map/agent_reduce) can't settle one.
    Creating the market is the user's call: they press "Create market" on the table in Research."""
    return _draft(view_id, where, column, op, threshold, resolution_time, initial_price_cents, question, verify=False)


@operation(mcp=False)
def create_market(view_id: str, where: dict | None = None, column: str | None = None, op: str | None = None,
                  threshold: float | None = None, resolution_time: str | None = None,
                  initial_price_cents: int | None = None, question: str | None = None,
                  intent_id: str | None = None) -> dict:
    """UI: validate (with a full fingerprint check) and open a data-settled market on the prediction-market backend."""
    d = _draft(view_id, where, column, op, threshold, resolution_time, initial_price_cents, question, verify=True)
    if not d["ok"]:
        raise ValueError(" ".join(c["text"] for c in d["checks"] if c["level"] == "error"))
    s, inst = d["spec"], d["instance"]
    intent_id = intent_id or d["view"].get("intent_id")
    # the backend de-duplicates by normalized question: point at the existing market instead of creating one
    norm = lambda q: " ".join((q or "").split()).lower()  # noqa: E731
    same = [x for x in _pm("GET", "/markets") if x["status"] != "failed" and norm(x["question"]) == norm(d["question"])]
    if same:
        return {"market_id": same[0]["id"], "created": False, "question": same[0]["question"],
                "status": same[0]["status"], "href": f"#/predictions/market/{same[0]['id']}"}
    rule = {"source": "backtrace", "view_id": view_id, "view_name": d["view"]["name"], "where": s["where"],
            "column": s["column"], "unit": s["unit"], "op": s["op"], "threshold": s["threshold"], "if_missing": "void",
            "formula_hash": inst["formula_hash"], "pins": d["pins"], "intent_id": intent_id,
            "created_from": {"instance_id": inst["id"], "hash": inst["hash"], "value": d["current"],
                             "files": d["sources"]}}
    m = _pm("POST", "/markets", json={"question": d["question"], "description": d["rules"],
                                      "resolution_time": s["resolution_time"],
                                      "initial_price_cents": s["initial_price_cents"],
                                      "resolution": rule})  # liquidity: the backend's default ladder
    if intent_id:
        try:
            from . import thread as T
            T._post(T._root_of(intent_id), "agent",
                    f"Market #{m['id']} is open: \"{d['question']}\" It settles by itself on "
                    f"{_parse_time(s['resolution_time']).strftime('%d %b %Y %H:%M')} UTC from this calculation.",
                    "market", market_id=m["id"], view_id=view_id)
        except Exception:  # noqa: BLE001  (the market exists; the chat note is a nicety)
            traceback.print_exc()
    return {"market_id": m["id"], "created": True, "question": m.get("question"), "status": m.get("status"),
            "href": f"#/predictions/market/{m['id']}"}


def _decide(rule: dict) -> tuple[str, dict]:
    """Outcome + evidence for a data-settled market, from the pinned calculation on the latest data."""
    memo: dict = {}
    inst = _run(rule["view_id"], rule["pins"], memo)
    if inst.get("formula_hash") != rule["formula_hash"]:
        raise ValueError("the pinned calculation no longer reproduces its formula hash")
    rep = X.verify(inst["id"], recompute=True)
    if not rep.get("ok"):
        raise ValueError(f"fingerprint check failed for instance {inst['id']}; not settling")
    _, rows = _rows(inst["id"])
    matched = [r for r in rows if all(_eq(r.get(k), v) for k, v in (rule.get("where") or {}).items())]
    value = matched[0].get(rule["column"]) if len(matched) == 1 else None
    if len(matched) > 1:
        outcome, reason = "void", f"{len(matched)} rows matched; the rule needs exactly one"
    elif not _is_num(value):
        outcome, reason = "void", "no such row in the data at settlement"
    else:
        yes = _holds(value, rule["op"], rule["threshold"])
        outcome = "yes" if yes else "no"
        reason = (f"{_label(rule['column'])} = {_fmt(value, rule.get('unit'))}, "
                  f"{'' if yes else 'not '}{OPS[rule['op']]} {_fmt(rule['threshold'], rule.get('unit'))}")
    row = {k: v for k, v in matched[0].items() if k != "_src"} if len(matched) == 1 else None
    return outcome, {"value": value if _is_num(value) else None, "row": row, "reason": reason,
                     "instance_id": inst["id"], "hash": inst.get("hash"), "formula_hash": inst.get("formula_hash"),
                     "verified": True, "data": _sources(rule["pins"], memo), "settled_at": _iso(datetime.now(timezone.utc))}


def _rule(market: dict) -> dict:
    rule = market.get("resolution") or {}
    if rule.get("source") != "backtrace":
        raise ValueError(f"market #{market.get('id')} isn't settled by data")
    return rule


@operation(mcp=False)
def market_status(market_id: int) -> dict:
    """UI: a data-settled market's number on today's data, what it would settle as now, and its history."""
    m = _pm("GET", f"/markets/{int(market_id)}")
    rule = _rule(m)
    out = {"market_id": m["id"], "status": m["status"], "rule": {k: v for k, v in rule.items() if k != "pins"}}
    if m["status"] != "active":
        return out
    try:
        memo: dict = {}
        inst = _run(rule["view_id"], rule["pins"], memo)
        _, rows = _rows(inst["id"])
        where = rule.get("where") or {}
        matched = [r for r in rows if all(_eq(r.get(k), v) for k, v in where.items())]
        value = matched[0].get(rule["column"]) if len(matched) == 1 else None
        shape, _ = _pinned(rule["view_id"], rule["pins"])
        tc = _time_col(_columns(shape))
        hist = []
        if tc:
            others = {k: v for k, v in where.items() if k != tc}
            hist = sorted(([r[tc], r[rule["column"]]] for r in rows if r.get(tc) is not None
                           and _is_num(r.get(rule["column"])) and all(_eq(r.get(k), v) for k, v in others.items())),
                          key=lambda x: str(x[0]) if not _is_num(x[0]) else f"{x[0]:012.2f}")
        out.update(value=value if _is_num(value) else None,
                   would_settle=("void" if not _is_num(value) else
                                 "yes" if _holds(value, rule["op"], rule["threshold"]) else "no"),
                   history=hist, time_column=tc if tc in where else None,
                   instance={"id": inst["id"], "hash": inst.get("hash"), "created_at": inst.get("created_at")},
                   data=_sources(rule["pins"], memo))
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)
    return out


@operation(mcp=False)
def settle_market(market_id: int) -> dict:
    """Settle a data-settled market whose end date has passed: re-run its pinned calculation on the latest data,
    verify the fingerprint, compare, and resolve it on-chain with the evidence. Anyone may call it: the outcome
    doesn't depend on who does."""
    m = _pm("GET", f"/markets/{int(market_id)}")
    rule = _rule(m)
    if m["status"] != "active":
        return {"market_id": m["id"], "status": m["status"], "outcome": m.get("outcome"), "already": True}
    if datetime.now(timezone.utc) < _parse_time(m["resolution_time"]):
        raise ValueError(f"market #{m['id']} settles at {m['resolution_time']}")
    outcome, evidence = _decide(rule)
    try:
        r = _pm("POST", f"/markets/{m['id']}/resolve", json={"outcome": outcome, "evidence": evidence})
    except ValueError as e:
        if "TooEarly" in str(e):
            raise ValueError("the chain's clock hasn't reached the end date yet (a local validator can lag behind); "
                             "it settles automatically once it does") from e
        raise
    return {"market_id": m["id"], "outcome": outcome, "evidence": evidence, "tx": r.get("tx")}


# ---------------------------------------------------------------- background settlement

SETTLE_EVERY_S = 20
ENABLED = bool(PM_API_URL)


def settle_due() -> list[tuple[int, str]]:
    """Settle every data-settled market past its end date; one failure doesn't hold up the others."""
    now = datetime.now(timezone.utc)
    out = []
    for m in _pm("GET", "/markets", params={"status": "active"}):
        if (m.get("resolution") or {}).get("source") == "backtrace" and _parse_time(m["resolution_time"]) <= now:
            try:
                out.append((m["id"], f"settled {settle_market(m['id']).get('outcome')}"))
            except Exception as e:  # noqa: BLE001
                out.append((m["id"], f"can't settle yet: {e}"))
    return out


async def loop() -> None:
    said: dict = {}
    while True:
        await asyncio.sleep(SETTLE_EVERY_S)
        try:
            for mid, msg in await run_in_threadpool(settle_due):
                if said.get(mid) != msg:  # log each market's state once, not every tick
                    said[mid] = msg
                    print(f"market #{mid}: {msg}")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001  (backend down: retry later)
            if said.get("_") != str(e):
                said["_"] = str(e)
                print(f"market settlement: {e}")
