"""Memgraph access: driver, query helpers, index setup."""
import os
import time
import uuid
from datetime import datetime, timezone

from neo4j import GraphDatabase

URI = os.environ.get("MEMGRAPH_URI", "bolt://localhost:7687")
_driver = None

INDEXES = ["View(id)", "SchemaVersion(id)", "Transform(id)", "Visual(id)",
           "Comment(id)", "Instance(id)", "Intent(id)", "Counter(name)"]


def driver():
    global _driver
    if _driver is None:
        _driver = GraphDatabase.driver(URI, auth=("", ""))
    return _driver


def wait_until_ready(timeout_s: int = 60) -> None:
    deadline = time.time() + timeout_s
    while True:
        try:
            driver().verify_connectivity()
            return
        except Exception:
            if time.time() > deadline:
                raise
            time.sleep(1)


def ensure_indexes() -> None:
    for ix in INDEXES:
        try:
            run(f"CREATE INDEX ON :{ix}")
        except Exception:
            pass  # already exists


def run(query: str, **params) -> list[dict]:
    with driver().session() as s:
        return [r.data() for r in s.run(query, **params)]


def write_tx(fn):
    """Run fn(tx) in a single write transaction."""
    with driver().session() as s:
        return s.execute_write(fn)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")
