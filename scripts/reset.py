"""Wipe the graph (runs inside the api container)."""
import subprocess
import sys

sys.exit(subprocess.call(["docker", "compose", "exec", "-T", "api", "python", "-m", "app.reset"]))
