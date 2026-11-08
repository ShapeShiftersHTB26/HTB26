"""Move a Backtrace deployment's state to another server.

State = the graph (views, versions, threads, messages, data manifests, fingerprints) + the agentic-step cache.
Row data is NOT copied: it lives in the row store (Postgres, PG_DSN), so point the new server at the same database
and the imported manifests find their rows by id. Source CSVs (data/raw) are optional: only needed for new ingests,
appending batches, exported notebooks and the file-checksum step of verify.

Run inside the api container (host wrappers: scripts/export_state.py, scripts/import_state.py):
    python -m app.state export                  -> /data/state/<stamp>/ graph.jsonl, cache.tar.gz, manifest.json
    python -m app.state import <dir> [--replace] load an export into this server's (empty) graph
    python -m app.state check                   every manifest finds its rows; spot-verify a few small results
--replace wipes this server's GRAPH first (never Postgres). Without it, import refuses a non-empty graph."""
import json
import os
import re
import sys
import tarfile
import time

from . import executor as X
from . import graph as g
from . import store as ST

STATE_DIR = "/data/state"
CACHE_DIR = "/data/cache"


def _counts() -> dict:
    return {r["l"]: r["n"] for r in g.run("MATCH (n) UNWIND labels(n) AS l RETURN l, count(*) AS n ORDER BY l")}


def _pg_host() -> str | None:
    """A fingerprint of the Postgres host (never the DSN or the host itself) to spot a mismatched import."""
    import hashlib
    dsn = os.environ.get("PG_DSN", "")
    m = re.search(r"@([^/:?]+)", dsn) or re.search(r"host=(\S+)", dsn)
    return hashlib.sha256(m.group(1).encode()).hexdigest()[:12] if m else None


def export(out: str | None = None) -> str:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = out or os.path.join(STATE_DIR, stamp)
    os.makedirs(out, exist_ok=True)
    stmts = [r["QUERY"] for r in g.run("DUMP DATABASE")]
    with open(os.path.join(out, "graph.jsonl"), "w", encoding="utf-8") as f:
        for s in stmts:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    n_cache = 0
    with tarfile.open(os.path.join(out, "cache.tar.gz"), "w:gz") as tar:
        if os.path.isdir(CACHE_DIR):
            for name in sorted(os.listdir(CACHE_DIR)):
                tar.add(os.path.join(CACHE_DIR, name), arcname=name)
                n_cache += 1
    files = {}
    for r in g.run("MATCH (b:Batch) RETURN b.path AS p, b.file_sha256 AS sha, b.row_count AS n"):
        f = files.setdefault(r["p"], {"sha256": r["sha"], "rows_loaded": 0, "present_here": os.path.isfile(r["p"])})
        f["rows_loaded"] += r["n"] or 0
    manifest = {"created_at": stamp, "memgraph": g.run("SHOW VERSION")[0]["version"], "statements": len(stmts),
                "nodes": _counts(), "cache_files": n_cache, "row_store": {"postgres_host_id": _pg_host()},
                "source_files": files, "check": check(sample=0)}
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print(f"exported {len(stmts)} statements, {sum(manifest['nodes'].values())} labelled nodes, "
          f"{n_cache} cache files -> {out}")
    return out


def import_(src: str, replace: bool = False) -> None:
    src = src if src.startswith("/") else os.path.join(STATE_DIR, src)
    with open(os.path.join(src, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    existing = _counts()
    if existing:
        if not replace:
            sys.exit(f"this server's graph isn't empty ({existing}); re-run with --replace to wipe the GRAPH "
                     "(Postgres is never touched) and load the export")
        print(f"--replace: wiping this server's graph ({sum(existing.values())} labelled nodes); Postgres untouched")
        g.run("MATCH (n) DETACH DELETE n")
        print("graph wiped; dropping indexes", flush=True)
        for r in g.run("SHOW INDEX INFO"):
            if r.get("label") and r.get("property"):
                props = r["property"] if isinstance(r["property"], list) else [r["property"]]
                g.run(f"DROP INDEX ON :`{r['label']}`({', '.join(f'`{p}`' for p in props)})")
    n = 0
    print("loading the export", flush=True)
    with open(os.path.join(src, "graph.jsonl"), encoding="utf-8") as f:
        for line in f:
            stmt = json.loads(line)
            try:
                g.run(stmt)
            except Exception as e:  # noqa: BLE001
                sys.exit(f"statement {n + 1} failed: {e}\n{stmt[:300]}")
            n += 1
    g.ensure_indexes()
    restored = 0
    cache = os.path.join(src, "cache.tar.gz")
    if os.path.isfile(cache):
        os.makedirs(CACHE_DIR, exist_ok=True)
        with tarfile.open(cache) as tar:
            for m in tar.getmembers():
                if m.isfile() and not os.path.exists(os.path.join(CACHE_DIR, m.name)):
                    tar.extract(m, CACHE_DIR)
                    restored += 1
    now, expected = _counts(), manifest["nodes"]
    nodes = "match the export" if now == expected else f"DIFFER from the export: {now} vs {expected}"
    print(f"imported {n} statements; nodes {nodes}; {restored} cache files restored")
    if manifest.get("row_store", {}).get("postgres_host_id") != _pg_host():
        print("note: this server's PG_DSN points at a different Postgres host than the export's; rows are found "
              "by id, so it must hold the same data")
    report = check()
    print(json.dumps(report, indent=1))


def check(sample: int = 3) -> dict:
    """Every Batch / Instance manifest finds its rows in its store; then verify a few small recent results."""
    missing, total = [], 0
    for r in g.run("MATCH (x) WHERE x:Batch OR x:Instance RETURN x.id AS id, labels(x)[0] AS l, x.row_count AS n"):
        total += 1
        try:
            ST.read(r["id"], limit=1)
        except Exception as e:  # noqa: BLE001
            missing.append({"id": r["id"], "label": r["l"], "error": str(e)[:120]})
    verified = []
    # spot-verify cheaply: tables over a few thousand rows are checked from their stored roots, so this doesn't
    # stream big sources back from a remote Postgres (that's what made a full check take minutes)
    full_max, X.VERIFY_FULL_MAX = X.VERIFY_FULL_MAX, min(X.VERIFY_FULL_MAX, 5000)
    if sample:
        small = g.run("MATCH (i:Instance) WHERE i.hash IS NOT NULL AND i.row_count < $m "
                      "RETURN i.id AS id, i.view_id AS v ORDER BY i.created_at DESC LIMIT $k",
                      m=X.VERIFY_FULL_MAX, k=sample)
        for r in small:
            try:
                verified.append({"instance": r["id"], "ok": X.verify(r["id"], recompute=False)["ok"]})
            except Exception as e:  # noqa: BLE001
                verified.append({"instance": r["id"], "ok": False, "error": str(e)[:120]})
    X.VERIFY_FULL_MAX = full_max
    return {"manifests": total, "rows_missing": missing, "verified": verified,
            "ok": not missing and all(v["ok"] for v in verified)}


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] not in ("export", "import", "check"):
        sys.exit(__doc__)
    if a[0] == "export":
        export(a[1] if len(a) > 1 else None)
    elif a[0] == "import":
        if len(a) < 2:
            sys.exit("usage: python -m app.state import <dir> [--replace]")
        import_(a[1], replace="--replace" in a)
    else:
        r = check()
        print(json.dumps(r, indent=1))
        sys.exit(0 if r["ok"] else 1)
