"""One-off: wrap work done before Intents existed into Intents (python -m app.migrate_intents)."""
from . import graph as g
from . import ops
from . import proposals as P


def view_id(name: str) -> str | None:
    r = g.run("MATCH (v:View {name:$n}) RETURN v.id AS id", n=name)
    return r[0]["id"] if r else None


def tag_view(vid: str, qid: str, only_visuals: list[str] | None = None, skip_visuals: list[str] | None = None):
    g.run("MATCH (v:View {id:$v}) SET v.intent_id = $q", v=vid, q=qid)
    g.run("MATCH (p) WHERE (p:SchemaVersion OR p:Transform) AND p.view_id = $v SET p.intent_id = $q", v=vid, q=qid)
    for r in g.run("MATCH (p:Visual {view_id:$v}) RETURN p.id AS id", v=vid):
        if (only_visuals is None or r["id"] in only_visuals) and r["id"] not in (skip_visuals or []):
            g.run("MATCH (p:Visual {id:$id}) SET p.intent_id = $q", id=r["id"], q=qid)


if __name__ == "__main__":
    if g.run("MATCH (q:Intent) RETURN count(q) AS n")[0]["n"]:
        raise SystemExit("intents already exist; nothing to do")
    prices, locs, old_map = view_id("flat_prices_by_district"), view_id("district_locations"), \
        view_id("flat_prices_by_district_map")
    question = g.run("MATCH (v:View {id:$v}) RETURN v.question AS q", v=prices)[0]["q"]
    visuals = [P.decode(r["p"]) for r in g.run("MATCH (p:Visual {view_id:$v}) RETURN p", v=prices)]
    maps = [v["id"] for v in visuals if "leaflet" in (v.get("html") or "").lower()]
    bars = [v["id"] for v in visuals if v["id"] not in maps]

    q1 = ops.start_intent(question, mode="guided", author="user")["id"]
    tag_view(prices, q1, only_visuals=bars)
    bar_head = next((h["id"] for h in P.heads_by_tree([v for v in visuals if v["id"] in bars])), bars[0])
    ops.resolve_intent(q1, bar_head, "Average 2025 flat price per Reading postcode district (one year of data).")

    q2 = ops.start_intent("can the visual have a map of reading with districts rendering the average price "
                          "in that postcode?", anchors=[prices], mode="guided", parent_id=q1, author="user")["id"]
    for r in g.run("MATCH (p:Visual) WHERE p.id IN $ids SET p.intent_id = $q", ids=maps, q=q2):
        pass
    for vid in (locs, old_map):
        if vid:
            tag_view(vid, q2)
    map_heads = P.heads_by_tree([v for v in visuals if v["id"] in maps])
    if map_heads:
        ops.resolve_intent(q2, map_heads[-1]["id"], "Map of Reading postcode districts; circles coloured by "
                           "average flat price and sized by number of sales (locations model-inferred).")
    print("intents:", q1, q2)
