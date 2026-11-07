"""All Backtrace operations. Each function is exposed as an MCP tool (docstring = description)
and as POST /api/op/<name> (JSON body = kwargs)."""
import jsonschema

from . import graph as g
from . import proposals as P
from .registry import operation


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
    out = []
    for v in views:
        props = v.pop("_proposals")
        out.append({**v,
                    "head": {k: (h["id"] if (h := P.head(ps)) else None) for k, ps in props.items()},
                    "pending": {k: sum(p["status"] == "pending" for p in ps) for k, ps in props.items()}})
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
    return {
        "view": view,
        "proposals": props,
        "head": {k: (h["id"] if (h := P.head(ps)) else None) for k, ps in props.items()},
        "comments": comments,
        "upstream": [e["from"] for e in edges if e["to"] == view_id and not e["pending"]],
        "downstream": [e["to"] for e in edges if e["from"] == view_id and not e["pending"]],
    }
