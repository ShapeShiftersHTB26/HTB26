"""All Backtrace operations. Each function is exposed as an MCP tool (docstring = description)
and as POST /api/op/<name> (JSON body = kwargs)."""
import jsonschema

from . import executor as X
from . import graph as g
from . import proposals as P
from .registry import operation
from .transforms import ops as OPS
from .transforms import source as SRC


# ---------------------------------------------------------------- S0

@operation
def ping() -> dict:
    """Health check. Returns ok and whether the graph database is reachable."""
    try:
        g.run("RETURN 1 AS one")
        return {"ok": True, "memgraph": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": True, "memgraph": False, "error": str(e)}


def _all_views() -> list[dict]:
    rows = g.run(
        f"MATCH (v:View) OPTIONAL MATCH (p)-[:{P.VIEW_EDGES}]->(v) "
        "RETURN v, collect(CASE WHEN p IS NULL THEN NULL ELSE "
        "{label: labels(p)[0], id: p.id, status: p.status, counter: p.counter, reads: p.reads} END) AS ps "
        "ORDER BY v.created_at")
    out = []
    for r in rows:
        by_kind: dict[str, list] = {k: [] for k in P.KINDS}
        for p in r["ps"]:
            by_kind[P.LABEL_TO_KIND[p["label"]]].append(P.decode(p))
        out.append({**r["v"], "_proposals": by_kind})
    return out


def _edges(views: list[dict]) -> list[dict]:
    """Edges input -> output: solid for the head transform, dashed for pending transforms."""
    edges, seen = [], set()
    for v in views:
        ts = v["_proposals"]["transform"]
        h = P.head(ts)
        for t, pending in [(h, False)] + [(t, True) for t in ts if t["status"] == "pending"]:
            for src in (t or {}).get("reads") or []:
                if (src, v["id"]) not in seen:
                    seen.add((src, v["id"]))
                    edges.append({"from": src, "to": v["id"], "pending": pending})
    return edges


@operation
def get_graph() -> dict:
    """Overview of everything: all views with the ids of their current (head) shape, transform and
    visual, counts of pending proposals, and the edges between views (input -> output).
    Call this first to see what exists before acting."""
    views = _all_views()
    latest = {}
    for r in g.run("MATCH (i:Instance) RETURN i ORDER BY i.created_at"):
        latest[r["i"]["view_id"]] = {"id": r["i"]["id"], "row_count": r["i"]["row_count"]}
    out = []
    for v in views:
        props = v.pop("_proposals")
        out.append({**v,
                    "head": {k: (h["id"] if (h := P.head(ps)) else None) for k, ps in props.items()},
                    "pending": {k: sum(p["status"] == "pending" for p in ps) for k, ps in props.items()},
                    "latest_instance": latest.get(v["id"])})
        v["_proposals"] = props
    return {"views": out, "edges": _edges(views)}


# ---------------------------------------------------------------- S1

def _schema_warnings(schema: dict, preview: list[dict]) -> list[str]:
    warnings = []
    if schema.get("type") != "object" or not isinstance(schema.get("properties"), dict):
        return ["schema must be a JSON Schema object with 'properties' (one row)"]
    for col, spec in schema["properties"].items():
        if "x-role" not in spec:
            warnings.append(f"column '{col}' has no x-role")
    try:
        jsonschema.Draft202012Validator.check_schema(schema)
        v = jsonschema.Draft202012Validator(schema)
        for i, row in enumerate(preview or []):
            for err in v.iter_errors(row):
                warnings.append(f"preview row {i}: {err.message}")
    except jsonschema.SchemaError as e:
        warnings.append(f"invalid JSON Schema: {e.message}")
    return warnings


@operation
def propose_schema(schema: dict, grain: str, scope: list[str], preview: list[dict], rationale: str,
                   view_id: str | None = None, name: str | None = None, question: str | None = None,
                   parent_id: str | None = None, author: str = "agent") -> dict:
    """Propose the shape of a view. Omit view_id to create a NEW view (then `name` is required and
    `question` should hold the user's question verbatim). To revise an existing shape, pass view_id and
    parent_id = the version being revised (proposals are immutable; revisions are siblings).
    - schema: JSON Schema for ONE row: {"type":"object","properties":{col:{"type", "x-role"
      (id|dimension|time|measure|geo_lat|geo_lon|text), "x-unit"?, "description"}}, "required":[...]}
    - grain: what one row is, e.g. "one row per postcode district per year"
    - scope: constraints/interpretations, e.g. ["Reading district", "flats only"]
    - preview: 3-6 plausible example rows (rendered in the UI before any data exists)
    - rationale: 1-2 sentences on why this shape answers the question
    Returns the new proposal id, its view_id and any warnings (fix warnings with a sibling)."""
    if view_id is None:
        if not name:
            raise ValueError("name is required when creating a new view")
        view_id = g.new_id("v")
        g.run("CREATE (v:View) SET v = $props",
              props={"id": view_id, "name": name, "kind": "derived", "question": question or "",
                     "auto_accept": False, "created_at": g.now()})
    p = P.create("schema", view_id, {"schema": schema, "grain": grain, "scope": scope, "preview": preview,
                                     "rationale": rationale}, parent_id, author)
    return {"id": p["id"], "view_id": view_id, "status": "pending", "warnings": _schema_warnings(schema, preview)}


@operation
def comment(target_id: str, text: str, author: str = "user") -> dict:
    """Attach a comment to a proposal (shape, transform or visual). Comments are feedback: the agent
    answers them by proposing a sibling revision with parent_id = target_id."""
    P.find(target_id)
    cid = g.new_id("c")
    g.run("MATCH (p {id:$target}) CREATE (c:Comment)-[:ON]->(p) SET c = $props", target=target_id,
          props={"id": cid, "target_id": target_id, "text": text, "author": author, "created_at": g.now()})
    return {"id": cid, "target_id": target_id}


@operation
def decide(target_id: str, decision: str, by: str = "user") -> dict:
    """Approve or discard a pending proposal. decision: 'approve' | 'discard'. by: 'user' (also when the
    user approves via chat) or 'auto' (auto-accept). Decisions are final; to change course, propose a
    sibling or approve another sibling (the most recently approved becomes current)."""
    return P.decide(target_id, decision, by)


@operation
def get_view(view_id: str) -> dict:
    """Everything about one view: the view itself, all proposals per kind (schema/transform/visual)
    including pending and discarded ones (each has parent_id -> tree of revisions), the current head of
    each kind, comments per proposal, and upstream/downstream view ids. Re-read this before acting on a
    view: the user may have approved, discarded or commented in the UI."""
    views = _all_views()
    v = next((x for x in views if x["id"] == view_id), None)
    if v is None:
        raise ValueError(f"no view with id '{view_id}'")
    rows = g.run(f"MATCH (p)-[:{P.VIEW_EDGES}]->(:View {{id:$id}}) RETURN labels(p)[0] AS label, p "
                 "ORDER BY p.created_at", id=view_id)
    props: dict[str, list] = {k: [] for k in P.KINDS}
    for r in rows:
        props[P.LABEL_TO_KIND[r["label"]]].append(P.decode(r["p"]))
    ids = [p["id"] for ps in props.values() for p in ps]
    comments: dict[str, list] = {}
    for r in g.run("MATCH (c:Comment) WHERE c.target_id IN $ids RETURN c ORDER BY c.created_at", ids=ids):
        comments.setdefault(r["c"]["target_id"], []).append(r["c"])
    edges = _edges(views)
    view = {k: val for k, val in v.items() if k != "_proposals"}
    insts = X.instances(view_id)
    return {
        "view": view,
        "proposals": props,
        "head": {k: (h["id"] if (h := P.head(ps)) else None) for k, ps in props.items()},
        "comments": comments,
        "upstream": [e["from"] for e in edges if e["to"] == view_id and not e["pending"]],
        "downstream": [e["to"] for e in edges if e["from"] == view_id and not e["pending"]],
        "instances": insts,
        "latest_instance": insts[0] if insts else None,
    }


# ---------------------------------------------------------------- S2

@operation
def propose_visual(view_id: str, html: str, rationale: str, parent_id: str | None = None,
                   author: str = "agent") -> dict:
    """Propose a visual for a view: a complete self-contained HTML document. At runtime the page gets
    window.BACKTRACE = {schema, rows, mode: "preview"|"instance", view: {id, name}} and a function
    window.backtraceSelect(rid) to call on click (rows from real data carry `_rid`; preview rows don't).
    Read data ONLY from window.BACKTRACE.rows (never hardcode values). Revise with parent_id."""
    if "<" not in html:
        raise ValueError("html must be an HTML document")
    p = P.create("visual", view_id, {"html": html, "rationale": rationale}, parent_id, author)
    return {"id": p["id"], "view_id": view_id, "status": "pending"}


def _resolve_path(path: str) -> str:
    import os
    full = path if path.startswith("/data/") else os.path.join("/data/raw", path)
    if not os.path.isfile(full):
        raise ValueError(f"file not found: {full} (put datasets in data/raw/)")
    return full


@operation
def ingest(path: str, name: str, columns: list[str] | None = None, filter: str | None = None,
           parse_dates: list[str] | None = None, limit: int | None = None) -> dict:
    """Load a CSV from data/raw/ as a new SOURCE view (with records). `path` is relative to data/raw/.
    - columns: column names, required when the CSV has no header row
    - filter: optional pandas expression over column names to keep a slice, e.g. "district == 'READING'"
    - parse_dates: columns to parse as dates; limit: max rows
    The shape is inferred (crude roles) and auto-approved; refine it afterwards with propose_schema
    (parent_id = the returned schema_id). Returns view_id, row_count, schema and sample rows."""
    spec = {"path": _resolve_path(path), "columns": columns, "filter": filter,
            "parse_dates": parse_dates, "limit": limit}
    spec = {k: v for k, v in spec.items() if v is not None}
    df = SRC.run(spec)
    schema = SRC.infer_schema(df)
    view_id = g.new_id("v")
    g.run("CREATE (v:View) SET v = $props", props={"id": view_id, "name": name, "kind": "source",
          "question": "", "auto_accept": False, "created_at": g.now()})
    preview = X.to_rows(df.head(5))
    s = P.create("schema", view_id, {"schema": schema, "grain": "one row per source record",
                                     "scope": [f"filter: {filter}"] if filter else ["all rows"],
                                     "preview": preview, "rationale": f"Inferred from {path}."}, None, "agent")
    t = P.create("transform", view_id, {"kind": "source", "spec": spec, "reads": [],
                                        "rationale": f"Ingest {path}."}, None, "agent")
    P.decide(s["id"], "approve", "auto")
    P.decide(t["id"], "approve", "auto")
    inst = X.write_instance(view_id, X.to_rows(df), None, s["id"], t["id"], [])
    return {"view_id": view_id, "schema_id": s["id"], "transform_id": t["id"], **inst,
            "schema": schema, "sample": preview}


def _head_schema(view_id: str, allow_pending: bool = False) -> dict | None:
    rows = g.run("MATCH (s:SchemaVersion {view_id:$v}) RETURN s", v=view_id)
    ps = [P.decode(r["s"]) for r in rows]
    h = P.head(ps)
    if h is None and allow_pending:
        pend = sorted([p for p in ps if p["status"] == "pending"], key=lambda p: p["created_at"])
        h = pend[-1] if pend else None
    return h


@operation
def propose_transform(view_id: str, kind: str, spec: dict, rationale: str, reads: list[str] | None = None,
                      new_inputs: list[dict] | None = None, parent_id: str | None = None,
                      author: str = "agent") -> dict:
    """Propose how a view is computed (one step upstream). The transform reads existing views (`reads`,
    view ids) and/or NEW intermediate views defined in `new_inputs` [{name, schema, grain, scope, preview}]
    — those are created now and approved together with this transform.
    - kind "ops": spec {"ops": [...]} over exactly ONE input. Ops:
        {"op":"filter","where":"<pandas expr>"}, {"op":"derive","column":c,"expr":"<pandas expr>"},
        {"op":"aggregate","by":[cols],"metrics":{out:[col, mean|median|sum|count|min|max]}},
        {"op":"sort","by":[cols],"desc":bool}, {"op":"limit","n":int}
      Expressions are Python with columns as pandas Series plus pd/np, e.g. "pd.to_datetime(date).dt.year",
      "(property_type == 'F') & (district == 'READING')".
    - kind "agent_map": spec {prompt, batch_size} — LLM adds fields per row
    - kind "agent_reduce": spec {prompt, max_rows} — LLM judges the whole table, cites source rows
    To revise, pass parent_id = the transform being revised. Returns id, new input view ids and
    warnings from a static column check (fix warnings with a sibling before asking the user)."""
    if kind not in ("ops", "agent_map", "agent_reduce"):
        raise ValueError("kind must be ops | agent_map | agent_reduce")
    target = _head_schema(view_id, allow_pending=True)
    if target is None:
        raise ValueError(f"view '{view_id}' has no shape yet; propose_schema first")
    tid = g.new_id("t")
    reads = list(reads or [])
    for r in reads:
        P.view_node(r)
    created = []
    for ni in new_inputs or []:
        vid = g.new_id("v")
        g.run("CREATE (v:View) SET v = $props", props={"id": vid, "name": ni["name"], "kind": "derived",
              "question": "", "auto_accept": False, "created_at": g.now()})
        P.create("schema", vid, {"schema": ni["schema"], "grain": ni.get("grain", ""),
                                 "scope": ni.get("scope", []), "preview": ni.get("preview", []),
                                 "rationale": ni.get("rationale", f"Input for {view_id}"),
                                 "proposed_with": tid}, None, author)
        created.append({"view_id": vid, "name": ni["name"]})
        reads.append(vid)
    warnings = []
    if kind == "ops":
        if len(reads) != 1:
            warnings.append(f"ops transforms read exactly one view (got {len(reads)})")
        else:
            src = _head_schema(reads[0], allow_pending=True)
            in_cols = list((src or {}).get("schema", {}).get("properties", {}))
            warnings += OPS.check(spec, in_cols, list(target["schema"].get("properties", {})))
    p = P.create("transform", view_id, {"kind": kind, "spec": spec, "reads": reads, "rationale": rationale,
                                        "warnings": warnings}, parent_id, author, pid=tid)
    return {"id": p["id"], "view_id": view_id, "reads": reads, "new_inputs": created,
            "status": "pending", "warnings": warnings}


@operation
def get_frontier(view_id: str) -> dict:
    """Views still unresolved upstream of (and including) this view: derived views with no approved
    transform. Empty frontier = the whole chain reaches existing data and can be evaluated."""
    views = {v["id"]: v for v in _all_views()}
    frontier, seen, todo = [], set(), [view_id]
    while todo:
        vid = todo.pop()
        if vid in seen or vid not in views:
            continue
        seen.add(vid)
        v = views[vid]
        h = P.head(v["_proposals"]["transform"])
        if h is None:
            if v["kind"] != "source":
                pending = [t["id"] for t in v["_proposals"]["transform"] if t["status"] == "pending"]
                frontier.append({"view_id": vid, "name": v["name"], "has_shape": bool(P.head(v["_proposals"]["schema"])),
                                 "pending_transforms": pending})
            continue
        todo.extend(h.get("reads") or [])
    return {"view_id": view_id, "frontier": frontier}


@operation
def get_records(view_id: str | None = None, instance_id: str | None = None, where: dict | None = None,
                limit: int = 50, offset: int = 0) -> dict:
    """Read data rows of a view (its latest instance by default, or a given instance_id).
    `where` is an equality filter, e.g. {"district": "READING"}. Each row has `_rid` (use it for trace)."""
    import re
    if instance_id is None:
        if view_id is None:
            raise ValueError("pass view_id or instance_id")
        inst = X.latest_instance(view_id)
        if inst is None:
            return {"instance": None, "total": 0, "rows": [], "note": "view has no data yet (not evaluated)"}
        instance_id = inst["id"]
    else:
        inst = g.run("MATCH (i:Instance {id:$i}) RETURN i", i=instance_id)[0]["i"]
    conds, params = [], {"iid": instance_id, "limit": min(int(limit), 2000), "offset": int(offset)}
    for n, (k, v) in enumerate((where or {}).items()):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
            raise ValueError(f"bad column name in where: {k!r}")
        conds.append(f"r.`{k}` = $w{n}")
        params[f"w{n}"] = v
    wh = ("WHERE " + " AND ".join(conds)) if conds else ""
    base = f"MATCH (r:Record)-[:IN]->(:Instance {{id:$iid}}) {wh}"
    total = g.run(base + " RETURN count(r) AS n", **params)[0]["n"]
    rows = g.run(base + " RETURN r ORDER BY r.`_n` SKIP $offset LIMIT $limit", **params)
    return {"instance": inst, "total": total, "rows": [X.record_out(r["r"]) for r in rows]}


# ---------------------------------------------------------------- S3

@operation
def evaluate(view_id: str, inputs: dict | None = None) -> dict:
    """Run a view's current (head) transform over its inputs and store the result as a new instance
    (an observation) with record-level lineage. Each input defaults to the LATEST instance of that upstream
    view; upstream views with no data are evaluated first. Pass inputs={view_id: instance_id} to pin a
    specific earlier observation. Fails with a readable error if the chain is unresolved or a transform
    breaks — fix by proposing a sibling transform."""
    return X.evaluate(view_id, inputs)


@operation
def trace(rid: str) -> dict:
    """Explain where a record came from: walks lineage from the record (`_rid` from get_records) back to the
    source rows. Returns levels from the record itself down to the raw data; each level has the view, the
    transform that produced it, how many records contributed, and a sample of them."""
    return X.trace(rid)
