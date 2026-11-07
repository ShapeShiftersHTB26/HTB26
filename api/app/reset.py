"""Wipe everything (graph + Postgres data plane), or only views whose name starts with a prefix
(and everything hanging off them). Run inside the api container: python -m app.reset [prefix]"""
import sys

from . import graph, pg

if __name__ == "__main__":
    if len(sys.argv) > 1:
        p = sys.argv[1]
        ids = [r["id"] for r in graph.run("MATCH (v:View) WHERE v.name STARTS WITH $p RETURN v.id AS id", p=p)]
        insts = [r["id"] for r in graph.run("MATCH (i:Instance) WHERE i.view_id IN $ids RETURN i.id AS id", ids=ids)]
        try:
            pg.drop_prefixes(insts)
            pg.drop_raw_for_views(ids)
        except RuntimeError as e:  # PG_DSN not set
            print(f"skipping postgres cleanup: {e}")
        graph.run("MATCH (r:Record) WHERE r._view_id IN $ids DETACH DELETE r", ids=ids)
        graph.run("MATCH (c:Comment)-[:ON]->(n) WHERE n.view_id IN $ids DETACH DELETE c", ids=ids)
        graph.run("MATCH (n) WHERE n.view_id IN $ids DETACH DELETE n", ids=ids)
        graph.run("MATCH (v:View) WHERE v.id IN $ids DETACH DELETE v", ids=ids)
        print(f"removed {len(ids)} '{p}*' views")
    else:
        graph.run("MATCH (n) DETACH DELETE n")
        pg.wipe()
        print("graph and postgres data plane wiped")
