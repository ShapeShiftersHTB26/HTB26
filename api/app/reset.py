"""Wipe everything (graph + Postgres data plane), or only views whose name starts with a prefix
(and everything hanging off them). Run inside the api container:
    python -m app.reset <prefix>    remove views named <prefix>*
    python -m app.reset --all       wipe the whole graph and the Postgres data plane (irreversible)"""
import sys

from . import graph, pg, store

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python -m app.reset <view-name-prefix> | --all")
    if sys.argv[1] != "--all":
        p = sys.argv[1]
        ids = [r["id"] for r in graph.run("MATCH (v:View) WHERE v.name STARTS WITH $p RETURN v.id AS id", p=p)]
        insts = [r["id"] for r in graph.run("MATCH (i:Instance) WHERE i.view_id IN $ids RETURN i.id AS id", ids=ids)]
        store.drop_views(ids, insts)
        graph.run("MATCH (c:Comment)-[:ON]->(n) WHERE n.view_id IN $ids DETACH DELETE c", ids=ids)
        graph.run("MATCH (n) WHERE n.view_id IN $ids DETACH DELETE n", ids=ids)
        graph.run("MATCH (v:View) WHERE v.id IN $ids DETACH DELETE v", ids=ids)
        print(f"removed {len(ids)} '{p}*' views")
    else:
        graph.run("MATCH (n) DETACH DELETE n")
        pg.wipe()
        print("graph and postgres data plane wiped")
