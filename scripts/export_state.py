"""Export this deployment's state (graph + agentic cache) to data/state/<stamp>/ for moving to another server.
Rows stay in Postgres; see api/app/state.py.   Usage: python scripts/export_state.py"""
import subprocess
import sys

sys.exit(subprocess.call(["docker", "compose", "exec", "-T", "api", "python", "-m", "app.state", "export"]))
