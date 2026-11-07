"""Shared proposal mechanics for SchemaVersion / Transform / Visual:
immutable nodes, REVISES edges to parents, write-once decisions, global approval counter, head = max counter."""
import json

from . import graph as g

# kind -> (label, edge to View, id prefix)
KINDS = {
    "schema": ("SchemaVersion", "VERSION_OF", "s"),
    "transform": ("Transform", "COMPUTES", "t"),
    "visual": ("Visual", "RENDERS", "vis"),
}
LABEL_TO_KIND = {label: kind for kind, (label, _, _) in KINDS.items()}
JSON_FIELDS = {"schema", "scope", "preview", "spec", "reads", "warnings"}
VIEW_EDGES = "|".join(rel for _, rel, _ in KINDS.values())


def encode(props: dict) -> dict:
    return {k: (json.dumps(v) if k in JSON_FIELDS else v) for k, v in props.items() if v is not None}


def decode(node: dict) -> dict:
    return {k: (json.loads(v) if k in JSON_FIELDS and isinstance(v, str) else v) for k, v in node.items()}


def view_node(view_id: str) -> dict:
    rows = g.run("MATCH (v:View {id:$id}) RETURN v", id=view_id)
    if not rows:
        raise ValueError(f"no view with id '{view_id}'")
    return rows[0]["v"]


def create(kind: str, view_id: str, props: dict, parent_id: str | None, author: str,
           pid: str | None = None) -> dict:
    label, rel, prefix = KINDS[kind]
    view_node(view_id)
    if parent_id:
        par = g.run(f"MATCH (p:{label} {{id:$id}}) RETURN p.view_id AS view_id", id=parent_id)
        if not par:
            raise ValueError(f"parent '{parent_id}' is not a {kind} proposal")
        if par[0]["view_id"] != view_id:
            raise ValueError(f"parent '{parent_id}' belongs to a different view")
    pid = pid or g.new_id(prefix)
    full = encode({**props, "id": pid, "view_id": view_id, "parent_id": parent_id,
                   "author": author, "status": "pending", "created_at": g.now()})
    g.run(f"MATCH (v:View {{id:$view_id}}) CREATE (p:{label})-[:{rel}]->(v) SET p = $props",
          view_id=view_id, props=full)
    if parent_id:
        g.run(f"MATCH (p:{label} {{id:$id}}), (q:{label} {{id:$parent}}) CREATE (p)-[:REVISES]->(q)",
              id=pid, parent=parent_id)
    return decode(full)


def find(target_id: str) -> tuple[str, dict]:
    rows = g.run("MATCH (p {id:$id}) RETURN labels(p) AS labels, p", id=target_id)
    if not rows:
        raise ValueError(f"nothing with id '{target_id}'")
    return rows[0]["labels"][0], decode(rows[0]["p"])


def decide(target_id: str, decision: str, by: str) -> dict:
    label, p = find(target_id)
    if label not in LABEL_TO_KIND:
        raise ValueError(f"'{target_id}' is a {label}, not a proposal")
    if p["status"] != "pending":
        raise ValueError(f"'{target_id}' is already {p['status']}; propose a sibling instead")
    if decision == "discard":
        g.run("MATCH (p {id:$id}) SET p.status = 'discarded', p.decided_by = $by", id=target_id, by=by)
        return {"id": target_id, "status": "discarded"}
    if decision != "approve":
        raise ValueError("decision must be 'approve' or 'discard'")

    def tx(t):
        c = t.run("MERGE (c:Counter {name:'global'}) ON CREATE SET c.value = 0 "
                  "SET c.value = c.value + 1 RETURN c.value AS v").single()["v"]
        t.run("MATCH (p {id:$id}) SET p.status = 'approved', p.counter = $c, p.decided_by = $by",
              id=target_id, c=c, by=by)
        bundled = []
        if label == "Transform":  # also approve input views' shapes proposed with this transform
            bundled = [r["id"] for r in t.run(
                "MATCH (s:SchemaVersion {proposed_with:$id, status:'pending'}) "
                "SET s.status = 'approved', s.counter = $c, s.decided_by = $by RETURN s.id AS id",
                id=target_id, c=c, by=by)]
        return c, bundled

    counter, bundled = g.write_tx(tx)
    return {"id": target_id, "status": "approved", "counter": counter, "also_approved": bundled}


def head(proposals: list[dict]) -> dict | None:
    approved = [p for p in proposals if p.get("status") == "approved"]
    return max(approved, key=lambda p: p["counter"]) if approved else None
