"""All Backtrace operations. Each function is exposed as an MCP tool (docstring = description)
and as POST /api/op/<name> (JSON body = kwargs)."""
import json

import jsonschema

from . import executor as X
from . import graph as g
from . import pg as PG
from . import store as ST
from . import proposals as P
from .registry import operation
from .transforms import ops as OPS
from .transforms import source as SRC


# ---------------------------------------------------------------- S0

@operation
def ping() -> dict:
    """Health check. Returns ok and whether the graph database is reachable."""
    out = {"ok": True}
    for name, check in (("memgraph", lambda: g.run("RETURN 1 AS one")), ("postgres", PG.ping)):
        try:
            check()
            out[name] = True
        except Exception as e:  # noqa: BLE001
            out[name], out[f"{name}_error"] = False, str(e)[:200]
    return out


def _all_views() -> list[dict]:
    rows = g.run(
        f"MATCH (v:View) OPTIONAL MATCH (p)-[:{P.VIEW_EDGES}]->(v) "
        "RETURN v, collect(CASE WHEN p IS NULL THEN NULL ELSE "
        "{label: labels(p)[0], id: p.id, status: p.status, counter: p.counter, reads: p.reads, kind: p.kind, "
        "parent_id: p.parent_id, uses: p.uses, intent_id: p.intent_id, created_at: p.created_at} END) AS ps "
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
                    edges.append({"from": src, "to": v["id"], "pending": pending, "kind": t.get("kind")})
    return edges


@operation
def get_graph() -> dict:
    """Overview of everything: all views with the ids of their current (head) shape, transform and
    visual, counts of pending proposals, their latest data instance, their visuals (current + pending, with
    the views each visual `uses`), and the edges between views (input -> output, with transform kind).
    Call this first to see what exists before acting."""
    import re
    views = _all_views()
    latest, counts = {}, {}
    for r in g.run("MATCH (i:Instance) RETURN i ORDER BY i.created_at"):
        i = r["i"]
        latest[i["view_id"]] = {"id": i["id"], "row_count": i["row_count"], "created_at": i["created_at"],
                                "model": i.get("model"), "hash": i.get("hash")}
        counts[i["view_id"]] = counts.get(i["view_id"], 0) + 1
    titles = {}
    for r in g.run("MATCH (p:Visual) RETURN p.id AS id, p.html AS html"):
        m = re.search(r"<title>(.*?)</title>", r["html"] or "", re.I | re.S)
        html = (r["html"] or "").lower()
        titles[r["id"]] = (m.group(1).strip()[:60] if m else
                           "map" if "leaflet" in html else "chart" if "<svg" in html or "vega" in html else "visual")
    out = []
    for v in views:
        props = v.pop("_proposals")
        current = P.heads_by_tree(props["visual"])
        visuals = [{"id": x["id"], "status": x["status"], "uses": x.get("uses") or [], "title": titles.get(x["id"]),
                    "intent_id": x.get("intent_id")}
                   for x in current + [x for x in props["visual"] if x["status"] == "pending"]]
        out.append({**v,
                    "head": {k: (h["id"] if (h := P.head(ps)) else None) for k, ps in props.items()},
                    "pending": {k: sum(p["status"] == "pending" for p in ps) for k, ps in props.items()},
                    "latest_instance": latest.get(v["id"]), "instance_count": counts.get(v["id"], 0),
                    "visuals": visuals})
        v["_proposals"] = props
    return {"views": out, "edges": _edges(views), "intents": _intent_summaries(views)}


# ---------------------------------------------------------------- Intents

def _check_intent(intent_id: str | None) -> None:
    if intent_id and not g.run("MATCH (q:Intent {id:$id}) RETURN q.id AS id", id=intent_id):
        raise ValueError(f"no intent with id '{intent_id}' (call start_intent first)")


def _intent_summaries(views: list[dict]) -> list[dict]:
    """Per intent: member views/visuals (created while serving it), external inputs, result, step count."""
    out = []
    for r in g.run("MATCH (q:Intent) RETURN q ORDER BY q.created_at"):
        q = dict(r["q"])
        q["anchors"] = json.loads(q.get("anchors") or "[]")
        qid = q["id"]
        members = [v["id"] for v in views if v.get("intent_id") == qid]
        steps, visuals, reads = 0, [], set()
        for v in views:
            for kind, ps in v["_proposals"].items():
                for p in ps:
                    if p.get("intent_id") != qid:
                        continue
                    steps += 1
                    if kind == "visual" and p["status"] != "discarded":
                        visuals.append(p["id"])
                    if kind == "transform" and p["status"] != "discarded":
                        reads |= set(p.get("reads") or [])
        inputs = sorted((reads | set(q["anchors"])) - set(members))
        current = q.get("result_id")
        if q.get("result_kind") == "visual":  # follow the result visual's revision tree to its current version
            for v in views:
                vis = v["_proposals"]["visual"]
                if any(x["id"] == current for x in vis):
                    by_id = {x["id"]: x for x in vis}

                    def root(x):
                        while x.get("parent_id") in by_id:
                            x = by_id[x["parent_id"]]
                        return x["id"]
                    r0 = root(by_id[current])
                    tree = [x for x in vis if root(x) == r0]
                    h = P.head(tree)
                    current = h["id"] if h else current
                    q["result_view_id"] = v["id"]
        elif current:
            q["result_view_id"] = current
        out.append({**q, "members": members, "visuals": visuals, "inputs": inputs, "steps": steps,
                    "result_current": current})
    return out


@operation
def start_intent(text: str, anchors: list[str] | None = None, mode: str | None = None,
                 parent_id: str | None = None, author: str = "user") -> dict:
    """Record a natural-language request as an Intent. Call this FIRST for every new user request, then pass
    the returned intent_id to every propose_* call made while serving it.
    - text: the user's request verbatim
    - anchors: view ids the request starts from (e.g. the dataset the user is looking at); empty for a fresh question
    - mode: "auto" (approve your own steps; the user sees the outcome and can inspect the path) or "guided"
      (stop for the user's approval at each step). Default: auto when anchored (exploration), guided otherwise.
    - parent_id: the previous intent when this is a follow-up or refinement ("now only flats")."""
    anchors = anchors or []
    for a in anchors:
        P.view_node(a)
    _check_intent(parent_id)
    if not mode and parent_id:  # a follow-up question keeps its workspace's mode (auto-accept on or off)
        mode = (g.run("MATCH (p:Intent {id:$p}) RETURN p.mode AS m", p=parent_id) or [{}])[0].get("m")
    mode = mode or ("auto" if anchors else "guided")
    if mode not in ("auto", "guided"):
        raise ValueError("mode must be auto | guided")
    qid = g.new_id("q")
    g.run("CREATE (q:Intent) SET q = $props", props={k: v for k, v in {
        "id": qid, "text": text, "anchors": json.dumps(anchors), "mode": mode, "status": "open",
        "parent_id": parent_id, "author": author, "created_at": g.now()}.items() if v is not None})
    for a in anchors:
        g.run("MATCH (q:Intent {id:$q}), (v:View {id:$v}) CREATE (q)-[:ANCHORED_ON]->(v)", q=qid, v=a)
    if parent_id:
        g.run("MATCH (q:Intent {id:$q}), (p:Intent {id:$p}) CREATE (q)-[:FOLLOWS]->(p)", q=qid, p=parent_id)
    return {"id": qid, "mode": mode, "status": "open"}


@operation
def resolve_intent(intent_id: str, result_id: str, summary: str) -> dict:
    """Mark an Intent answered once its result exists: result_id = the visual (preferred) or view that answers
    it; summary = one or two sentences answering the request in plain language (shown on the canvas)."""
    _check_intent(intent_id)
    if result_id.startswith("v_"):
        P.view_node(result_id)
        label = "View"
    else:
        label, _ = P.find(result_id)
    if label not in ("View", "Visual"):
        raise ValueError("result_id must be a view or a visual")
    g.run("MATCH (q:Intent {id:$q}) SET q.status = 'answered', q.result_id = $r, q.result_kind = $k, "
          "q.summary = $s, q.answered_at = $t", q=intent_id, r=result_id, k=label.lower(), s=summary, t=g.now())
    return {"id": intent_id, "status": "answered", "result_id": result_id}


@operation
def restate_intent(intent_id: str, text: str) -> dict:
    """Replace an intent's question text when the user changes what they're asking, e.g. they started with
    Edinburgh, found no data and switched to Coventry: the thread title and the canvas question should say
    Coventry. The first wording is kept as original_text. Rename the affected tables with rename_view too."""
    _check_intent(intent_id)
    text = (text or "").strip()
    if not text:
        raise ValueError("empty text")
    g.run("MATCH (q:Intent {id:$q}) SET q.original_text = coalesce(q.original_text, q.text), q.text = $t, "
          "q.restated_at = $now", q=intent_id, t=text, now=g.now())
    return {"id": intent_id, "text": text}


@operation
def rename_view(view_id: str, name: str, question: str | None = None) -> dict:
    """Rename a view (a table on the canvas) when its name no longer fits, e.g. edinburgh_flat_prices ->
    coventry_flat_prices after the user switched place. Names are labels only: versions, hashes and lineage are
    unchanged, and visuals that look the view up by its old name keep working (old names are kept as aliases).
    name: snake_case, not used by another view. question: optionally replace the question the view answers."""
    import re
    if not re.fullmatch(r"[a-z][a-z0-9_]*", name or ""):
        raise ValueError("name must be snake_case, e.g. coventry_flat_prices_by_year")
    v = P.view_node(view_id)
    if g.run("MATCH (x:View {name:$n}) WHERE x.id <> $v RETURN x.id AS id", n=name, v=view_id):
        raise ValueError(f"another view is already called '{name}'")
    aliases = list(v.get("aliases") or [])
    if v["name"] != name and v["name"] not in aliases:
        aliases.append(v["name"])
    g.run("MATCH (v:View {id:$v}) SET v.name = $n, v.aliases = $a" + (", v.question = $qn" if question else ""),
          v=view_id, n=name, a=aliases, qn=question)
    return {"view_id": view_id, "name": name, "aliases": aliases}


@operation
def get_intent(intent_id: str) -> dict:
    """An Intent with its path under the hood: every step taken to serve it, in order (kind, view, status,
    who decided, rationale), its member views, inputs, result and follow-up intents."""
    views = _all_views()
    q = next((x for x in _intent_summaries(views) if x["id"] == intent_id), None)
    if q is None:
        raise ValueError(f"no intent with id '{intent_id}'")
    names = {v["id"]: v["name"] for v in views}
    rows = g.run("MATCH (p) WHERE (p:SchemaVersion OR p:Transform OR p:Visual) AND p.intent_id = $q "
                 "RETURN labels(p)[0] AS label, p ORDER BY p.created_at", q=intent_id)
    steps = []
    for r in rows:
        p = P.decode(r["p"])
        steps.append({"id": p["id"], "kind": P.LABEL_TO_KIND[r["label"]], "view_id": p["view_id"],
                      "view_name": names.get(p["view_id"]), "status": p["status"],
                      "decided_by": p.get("decided_by"), "rationale": p.get("rationale"),
                      "created_at": p["created_at"], "transform_kind": p.get("kind"),
                      "reads": [names.get(x, x) for x in p.get("reads") or []]})
    children = [r["c"] for r in g.run("MATCH (c:Intent {parent_id:$q}) RETURN c", q=intent_id)]
    ri = X.latest_instance(q["result_view_id"]) if q.get("result_view_id") else None
    return {"intent": q, "steps": steps, "children": children, "names": names,
            "result_instance": {"id": ri["id"], "hash": ri.get("hash")} if ri else None}


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
                   parent_id: str | None = None, author: str = "agent", intent_id: str | None = None) -> dict:
    """Propose the shape of a view. Omit view_id to create a NEW view (then `name` is required and
    `question` should hold the user's question verbatim). To revise an existing shape, pass view_id and
    parent_id = the version being revised (proposals are immutable; revisions are siblings).
    - schema: JSON Schema for ONE row: {"type":"object","properties":{col:{"type", "x-role"
      (id|dimension|time|measure|geo_lat|geo_lon|text), "x-unit"?, "description"}}, "required":[...]}
    - grain: what one row is, e.g. "one row per postcode district per year"
    - scope: constraints/interpretations, e.g. ["Reading district", "flats only"]
    - preview: 3-6 plausible example rows (rendered in the UI before any data exists)
    - rationale: 1-2 sentences on why this shape answers the question
    Returns the new proposal id, its view_id and any warnings (fix warnings with a sibling).
    intent_id: the Intent this step serves (from start_intent) - always pass it."""
    _check_intent(intent_id)
    if view_id is None:
        if not name:
            raise ValueError("name is required when creating a new view")
        view_id = g.new_id("v")
        g.run("CREATE (v:View) SET v = $props",
              props={k: v for k, v in {"id": view_id, "name": name, "kind": "derived", "question": question or "",
                     "auto_accept": False, "created_at": g.now(), "intent_id": intent_id}.items() if v is not None})
    p = P.create("schema", view_id, {"schema": schema, "grain": grain, "scope": scope, "preview": preview,
                                     "rationale": rationale, "intent_id": intent_id}, parent_id, author)
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
        "visual_heads": [h["id"] for h in P.heads_by_tree(props["visual"])],
        "comments": comments,
        "upstream": [e["from"] for e in edges if e["to"] == view_id and not e["pending"]],
        "downstream": [e["to"] for e in edges if e["from"] == view_id and not e["pending"]],
        "instances": insts,
        "latest_instance": insts[0] if insts else None,
    }


# ---------------------------------------------------------------- S2

@operation
def propose_visual(view_id: str, html: str, rationale: str, uses: list[str] | None = None,
                   parent_id: str | None = None, author: str = "agent", intent_id: str | None = None) -> dict:
    """Propose a visual for a view: a complete self-contained HTML document. At runtime the page gets
    window.BACKTRACE = {schema, rows, mode: "preview"|"instance", view: {id, name},
                        views: {<view name>: {view_id, schema, rows, mode}}}
    and window.backtraceSelect(rid) to call on click (real rows carry `_rid`; preview rows don't).
    A view can have several visuals: omit parent_id to ADD a new visual (existing ones stay); pass parent_id
    to revise that visual. `uses` = ids of OTHER views the visual also needs (e.g. a reference view of district locations or
    boundaries); their rows appear under window.BACKTRACE.views keyed by view name, and the HTML joins them
    (e.g. on postcode_district). Read data ONLY from window.BACKTRACE (never hardcode values).
    Revise with parent_id.
    intent_id: the Intent this step serves (from start_intent) - always pass it."""
    _check_intent(intent_id)
    if "<" not in html:
        raise ValueError("html must be an HTML document")
    uses = [u for u in (uses or []) if u != view_id]
    for u in uses:
        P.view_node(u)
    p = P.create("visual", view_id, {"html": html, "rationale": rationale, "uses": uses, "intent_id": intent_id},
                 parent_id, author)
    return {"id": p["id"], "view_id": view_id, "uses": uses, "status": "pending"}


def _resolve_path(path: str) -> str:
    import os
    full = path if path.startswith("/data/") else os.path.join("/data/raw", path)
    if not os.path.isfile(full):
        raise ValueError(f"file not found: {full} (put datasets in data/raw/)")
    return full


@operation
def ingest(path: str, name: str, columns: list[str] | None = None, filter: str | None = None,
           parse_dates: list[str] | None = None, limit: int | None = None, storage: str | None = None) -> dict:
    """Load a CSV from data/raw/ as a new SOURCE view (with records). `path` is relative to data/raw/.
    - columns: column names, required when the CSV has no header row
    - filter: optional pandas expression over column names to keep a slice, e.g. "district == 'READING'"
    - parse_dates: columns to parse as dates; limit: max rows
    - storage: where this source's rows live: "postgres" or "graph" (Record nodes); default from BACKTRACE_STORE
    The shape is inferred (crude roles) and auto-approved; refine it afterwards with propose_schema
    (parent_id = the returned schema_id). The parsing rules become the view's RECIPE; this first run appends
    batch 1 and publishes the first snapshot (with hashes). Add later files with append_batch.
    Returns view_id, snapshot instance, hashes, schema and sample rows."""
    spec = {"type": "file", "path": _resolve_path(path), "columns": columns, "filter": filter,
            "parse_dates": parse_dates, "limit": limit}
    spec = {k: v for k, v in spec.items() if v is not None}
    store_name = ST.get(storage) and (storage or ST.DEFAULT)
    df = SRC.run(spec)
    schema = SRC.infer_schema(df)
    view_id = g.new_id("v")
    g.run("CREATE (v:View) SET v = $props", props={"id": view_id, "name": name, "kind": "source",
          "question": "", "auto_accept": False, "created_at": g.now(), "store": store_name})
    preview = X.to_rows(df.head(5))
    s = P.create("schema", view_id, {"schema": schema, "grain": "one row per source record",
                                     "scope": [f"filter: {filter}"] if filter else ["all rows"],
                                     "preview": preview, "rationale": f"Inferred from {path}."}, None, "agent")
    t = P.create("transform", view_id, {"kind": "source", "spec": spec, "reads": [],
                                        "rationale": f"Recipe: read {path}"
                                                     + (f", keep rows where {filter}" if filter else "") + "."},
                 None, "agent")
    P.decide(s["id"], "approve", "auto")
    P.decide(t["id"], "approve", "auto")
    inst = X.append_batch(view_id, df=df)
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
                      author: str = "agent", intent_id: str | None = None) -> dict:
    """Propose how a view is computed (one step upstream). The transform reads existing views (`reads`,
    view ids) and/or NEW intermediate views defined in `new_inputs` [{name, schema, grain, scope, preview}]
    — those are created now and approved together with this transform.
    - kind "ops": spec {"ops": [...]} over exactly ONE input. Ops:
        {"op":"filter","where":"<pandas expr>"}, {"op":"derive","column":c,"expr":"<pandas expr>"},
        {"op":"aggregate","by":[cols],"metrics":{out:[col, mean|median|sum|count|min|max]}},
        {"op":"sort","by":[cols],"desc":bool}, {"op":"limit","n":int}
      Expressions are Python with columns as pandas Series plus pd/np, e.g. "pd.to_datetime(date).dt.year",
      "(property_type == 'F') & (district == 'READING')". Ops run in order on the current table, so after an
      aggregate + sort a derive can compare rows, e.g. year-on-year change:
      {"op":"derive","column":"change_pct","expr":"(median_price.pct_change() * 100).round(1)"} (or .shift(), .cumsum()).
    - kind "agent_map": spec {prompt, batch_size} — LLM adds fields per row
    - kind "agent_reduce": spec {prompt, max_rows} — LLM judges the whole table, cites source rows
    - kind "python": spec {"code": "..."} — the notebook escape hatch: pandas over the inputs (variables named
      after the input views, with _rid; with one input also as `df`), assigning the output to `df`. Row lineage
      only if the output keeps _rid or a _src list; prefer ops when they can express the step.
    To revise, pass parent_id = the transform being revised. Returns id, new input view ids and
    warnings from a static column check (fix warnings with a sibling before asking the user).
    intent_id: the Intent this step serves (from start_intent) - always pass it."""
    _check_intent(intent_id)
    if kind not in ("ops", "agent_map", "agent_reduce", "python"):
        raise ValueError("kind must be ops | agent_map | agent_reduce | python")
    if kind == "python" and not isinstance((spec or {}).get("code"), str):
        raise ValueError('python transforms need spec {"code": "..."}')
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
        g.run("CREATE (v:View) SET v = $props", props={k: v for k, v in {"id": vid, "name": ni["name"],
              "kind": "derived", "question": "", "auto_accept": False, "created_at": g.now(),
              "intent_id": intent_id}.items() if v is not None})
        P.create("schema", vid, {"schema": ni["schema"], "grain": ni.get("grain", ""),
                                 "scope": ni.get("scope", []), "preview": ni.get("preview", []),
                                 "rationale": ni.get("rationale", f"Input for {view_id}"),
                                 "proposed_with": tid, "intent_id": intent_id}, None, author)
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
                                        "warnings": warnings, "intent_id": intent_id}, parent_id, author, pid=tid)
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
    if instance_id is None:
        if view_id is None:
            raise ValueError("pass view_id or instance_id")
        inst = X.latest_instance(view_id)
        if inst is None:
            return {"instance": None, "total": 0, "rows": [], "note": "view has no data yet (not evaluated)"}
        instance_id = inst["id"]
    else:
        inst = g.run("MATCH (i:Instance {id:$i}) RETURN i", i=instance_id)[0]["i"]
    total, rows = ST.read(instance_id, where=where, limit=min(int(limit), 2000), offset=int(offset))
    return {"instance": inst, "total": total, "rows": rows}


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


# ---------------------------------------------------------------- data plane: batches + hashes

@operation
def append_batch(view_id: str, path: str) -> dict:
    """Append new data to a SOURCE view: runs the view's recipe (its parsing rules and filter) on another file
    in data/raw/ (e.g. "pp-2026.csv"), stores the rows as a new append-only batch, and publishes a new snapshot
    containing all earlier batches plus this one. Downstream views then re-evaluate on the new snapshot."""
    return X.append_batch(view_id, path)


@operation
def verify(instance_id: str, recompute: bool = True) -> dict:
    """Check an instance's hash tree end to end: recompute every data root from the stored rows, every formula
    hash from the definitions, every batch from its source file (when present), and — with recompute — re-run
    deterministic (ops) steps from their stored inputs. Returns the tree with ok/failed checks per node.
    The instance hash of a final view commits to all operations and rows below it."""
    return X.verify(instance_id, recompute)
