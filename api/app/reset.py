"""Wipe the graph, or only views whose name starts with a prefix (and everything hanging off them).
Run inside the api container: python -m app.reset [prefix]"""
import sys

from . import graph

if __name__ == "__main__":
    if len(sys.argv) > 1:
        p = sys.argv[1]
        ids = [r["id"] for r in graph.run("MATCH (v:View) WHERE v.name STARTS WITH $p RETURN v.id AS id", p=p)]
        graph.run("MATCH (r:Record)-[:IN]->(i:Instance) WHERE i.view_id IN $ids DETACH DELETE r", ids=ids)
        graph.run("MATCH (c:Comment)-[:ON]->(n) WHERE n.view_id IN $ids DETACH DELETE c", ids=ids)
        graph.run("MATCH (n) WHERE n.view_id IN $ids DETACH DELETE n", ids=ids)
        graph.run("MATCH (v:View) WHERE v.id IN $ids DETACH DELETE v", ids=ids)
        print(f"removed {len(ids)} '{p}*' views")
    else:
        graph.run("MATCH (n) DETACH DELETE n")
        print("graph wiped")
