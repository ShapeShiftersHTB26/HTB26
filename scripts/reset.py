"""Remove views by name prefix, or wipe everything (runs inside the api container).
    python scripts/reset.py smoke_     remove views named smoke_* and everything hanging off them
    python scripts/reset.py --all      wipe the whole graph AND the Postgres data plane (irreversible)"""
import subprocess
import sys

args = sys.argv[1:]
if not args:
    sys.exit(__doc__)
sys.exit(subprocess.call(["docker", "compose", "exec", "-T", "api", "python", "-m", "app.reset", *args]))
