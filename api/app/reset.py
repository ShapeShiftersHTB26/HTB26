"""Remove views (and everything hanging off them), or wipe everything. Run inside the api container:
    python -m app.reset <prefix>        remove views named <prefix>*
    python -m app.reset --view <name>   remove exactly the view called <name>
    python -m app.reset --all           wipe the whole graph and the Postgres data plane (irreversible)"""
import sys

from . import graph, pg, store


def remove(ids: list[str]) -> None:
    insts = [r["id"] for r in graph.run("MATCH (i:Instance) WHERE i.view_id IN $ids RETURN i.id AS id", ids=ids)]
    store.drop_views(ids, insts)
    graph.run("MATCH (c:Comment)-[:ON]->(n) WHERE n.view_id IN $ids DETACH DELETE c", ids=ids)
    graph.run("MATCH (n) WHERE n.view_id IN $ids DETACH DELETE n", ids=ids)
    graph.run("MATCH (v:View) WHERE v.id IN $ids DETACH DELETE v", ids=ids)


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        sys.exit("usage: python -m app.reset <view-name-prefix> | --view <name> | --all")
    if args[0] == "--all":
        graph.run("MATCH (n) DETACH DELETE n")
        pg.wipe()
        print("graph and postgres data plane wiped")
    elif args[0] == "--view":
        if len(args) < 2:
            sys.exit("usage: python -m app.reset --view <name>")
        ids = [r["id"] for r in graph.run("MATCH (v:View {name:$n}) RETURN v.id AS id", n=args[1])]
        remove(ids)
        print(f"removed {len(ids)} view(s) named '{args[1]}'")
    else:
        p = args[0]
        ids = [r["id"] for r in graph.run("MATCH (v:View) WHERE v.name STARTS WITH $p RETURN v.id AS id", p=p)]
        remove(ids)
        print(f"removed {len(ids)} '{p}*' views")
