"""Wipe the graph. Run inside the api container: python -m app.reset"""
from . import graph

if __name__ == "__main__":
    graph.run("MATCH (n) DETACH DELETE n")
    print("graph wiped")
