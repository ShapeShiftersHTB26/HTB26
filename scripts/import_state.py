"""Import an exported state into this server's graph. Copy the export folder to data/state/<stamp>/ first, and
point PG_DSN at the same Postgres the export used.
    python scripts/import_state.py <stamp>             (refuses if this graph isn't empty)
    python scripts/import_state.py <stamp> --replace   wipe this server's GRAPH first (Postgres untouched)
    python scripts/import_state.py --check             manifests find their rows; spot-verify"""
import subprocess
import sys

a = sys.argv[1:]
if not a:
    sys.exit(__doc__)
cmd = ["check"] if a[0] == "--check" else ["import", *a]
sys.exit(subprocess.call(["docker", "compose", "exec", "-T", "api", "python", "-m", "app.state", *cmd]))
