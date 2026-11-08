"""Fill in .env after cloning (and, for a server, prediction-market/.env.prod). Stdlib only.

    python scripts/setup_env.py            local dev: API key, Postgres, models
    python scripts/setup_env.py --server   a server (docs/DEPLOY.md): + domain, access code, market admin key,
                                           prediction-market/.env.prod, COMPOSE_FILE for the three compose files
    --non-interactive                      take values from environment variables of the same names (CI / scripts)
    --env PATH / --pm-env PATH             write somewhere else (default: .env, prediction-market/.env.prod)

Existing values are kept as defaults (press Enter to keep). Secrets are read without echo and never printed.
The old file is saved as <file>.bak. Values with $, spaces, quotes or # are single-quoted so compose reads
them literally."""
import argparse
import getpass
import os
import re
import secrets
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRET = {"ANTHROPIC_API_KEY", "PG_DSN", "PM_ADMIN_KEY", "DATABASE_URL", "ADMIN_API_KEY"}


def rel(path: str) -> str:
    try:
        return os.path.relpath(path, ROOT)
    except ValueError:  # another drive (Windows)
        return path


def read_env(path: str) -> dict:
    out = {}
    if os.path.isfile(path):
        for line in open(path, encoding="utf-8"):
            m = re.match(r"\s*([A-Z0-9_]+)=(.*)$", line.rstrip("\n"))
            if m:
                v = m.group(2).strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
                    v = v[1:-1]
                out[m.group(1)] = v
    return out


def quote(v: str) -> str:
    return f"'{v}'" if re.search(r"[\s$#'\"\\]", v) and "'" not in v else v


def ask(name: str, help_: str, current: str, default: str = "", required: bool = False, generate=None,
        check=None, interactive: bool = True) -> str:
    if not interactive:
        v = os.environ.get(name, current or default)
        if not v and generate:
            v = generate()
            if name not in SECRET:
                print(f"generated {name}: {v}")
        if required and not v:
            sys.exit(f"missing {name} (set it in the environment)")
        if v and check and (err := check(v)):
            sys.exit(f"{name}: {err}")
        return v
    shown = ("(set, press Enter to keep)" if name in SECRET else f"[{current}]") if current else \
        (f"[{default}]" if default else ("[Enter to generate one]" if generate else ""))
    while True:
        prompt = f"{name} - {help_} {shown}: "
        v = (getpass.getpass(prompt) if name in SECRET else input(prompt)).strip()
        v = v or current or default
        if not v and generate:
            v = generate()
            if name not in SECRET:
                print(f"  generated {name}: {v}")
        if required and not v:
            print("  required")
            continue
        if v and check and (err := check(v)):
            print(f"  {err}")
            continue
        return v


def write_env(path: str, template: str, values: dict) -> None:
    """The template (an .env.example) with its comments, each KEY= line filled in; commented-out '# KEY=' lines
    are switched on when they get a value; keys the template lacks are appended."""
    lines, done = [], set()
    for line in (open(template, encoding="utf-8").read().splitlines() if os.path.isfile(template) else []):
        m = re.match(r"\s*(#\s*)?([A-Z0-9_]+)=(.*)$", line)
        if m and m.group(2) in values and m.group(2) not in done:
            k, v = m.group(2), values[m.group(2)]
            if m.group(1) and not v:
                lines.append(line)  # optional and still unset: keep it commented
            else:
                lines.append(f"{k}={quote(v)}")
                done.add(k)
        else:
            lines.append(line)
    extra = [k for k, v in values.items() if k not in done and v]
    if extra:
        lines += ["", "# set by scripts/setup_env.py"] + [f"{k}={quote(values[k])}" for k in extra]
    if os.path.isfile(path):
        shutil.copyfile(path, path + ".bak")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", action="store_true", help="also set up a server deploy (docs/DEPLOY.md)")
    ap.add_argument("--non-interactive", action="store_true", help="read values from environment variables")
    ap.add_argument("--env", default=os.path.join(ROOT, ".env"))
    ap.add_argument("--pm-env", default=os.path.join(ROOT, "prediction-market", ".env.prod"))
    a = ap.parse_args()
    it = not a.non_interactive
    cur = read_env(a.env)
    is_dsn = lambda v: None if re.match(r"postgres(ql)?://", v) else "should start with postgresql://"  # noqa: E731
    is_host = lambda v: None if re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", v.lower()) else "a host name, e.g. backtrace.example.com"  # noqa: E731

    print(f"Writing {rel(a.env)}{' (server mode)' if a.server else ''}. Enter keeps the value shown.\n")
    v = dict(cur)
    v["ANTHROPIC_API_KEY"] = ask("ANTHROPIC_API_KEY", "Anthropic API key (chat agent, AI steps)", cur.get("ANTHROPIC_API_KEY", ""),
                                 required=True, interactive=it)
    v["PG_DSN"] = ask("PG_DSN", "Postgres for the row data, postgresql://user:pass@host:5432/db?sslmode=require",
                      cur.get("PG_DSN", ""), required=True, check=is_dsn, interactive=it)
    v["BACKTRACE_AGENT_MODEL"] = ask("BACKTRACE_AGENT_MODEL", "chat agent model, empty = claude-haiku-5-5",
                                     cur.get("BACKTRACE_AGENT_MODEL", ""), interactive=it)
    v["BACKTRACE_MODEL"] = ask("BACKTRACE_MODEL", "AI-step model, empty = claude-haiku-5-5", cur.get("BACKTRACE_MODEL", ""),
                               interactive=it)
    v.setdefault("BACKTRACE_THREAD_WORKER", "on")
    v.setdefault("BACKTRACE_STORE", "postgres")

    if a.server:
        v["DOMAIN"] = ask("DOMAIN", "domain the site is served on (its DNS A record points at this server)",
                          cur.get("DOMAIN", ""), required=True, check=is_host, interactive=it)
        v["ACCESS_CODE"] = ask("ACCESS_CODE", "code visitors enter to open the site", cur.get("ACCESS_CODE", ""),
                               required=True, generate=lambda: secrets.token_urlsafe(9), interactive=it)
        pm_cur = read_env(a.pm_env)
        admin = cur.get("PM_ADMIN_KEY") or pm_cur.get("ADMIN_API_KEY", "")
        v["PM_ADMIN_KEY"] = ask("PM_ADMIN_KEY", "market backend admin key (shared with prediction-market/.env.prod)",
                                "" if admin == "change-me" else admin, required=True,
                                generate=lambda: secrets.token_urlsafe(24), interactive=it)
        v["COMPOSE_FILE"] = "docker-compose.yml:docker-compose.prod.yml:docker-compose.vps.yml"

        print(f"\nWriting {rel(a.pm_env)} (prediction-market backend).\n")
        pm = dict(pm_cur)
        pm["DATABASE_URL"] = ask("DATABASE_URL", "hosted Postgres for the market backend (a direct / session connection)",
                                 "" if "USER:PASSWORD" in pm_cur.get("DATABASE_URL", "") else pm_cur.get("DATABASE_URL", ""),
                                 required=True, check=is_dsn, interactive=it)
        pm["RPC_URL"] = ask("RPC_URL", "Solana devnet RPC", pm_cur.get("RPC_URL", ""), default="https://api.devnet.solana.com",
                            interactive=it)
        pm["ADMIN_API_KEY"] = v["PM_ADMIN_KEY"]  # must match: the api calls the backend's admin endpoints with it
        write_env(a.pm_env, os.path.join(ROOT, "prediction-market", ".env.prod.example"), pm)
    else:
        v["ACCESS_CODE"] = ask("ACCESS_CODE", "optional: a code the site asks for first (empty = no gate)",
                               cur.get("ACCESS_CODE", ""), interactive=it)

    write_env(a.env, os.path.join(ROOT, ".env.example"), v)
    print(f"\nSaved {rel(a.env)}" + (f" and {rel(a.pm_env)}" if a.server else "")
          + " (previous versions as .bak).")
    if a.server:
        print(f"Next: point an A record for {v['DOMAIN']} at this server, open ports 80/443, then\n"
              "  docker compose up -d --build        (COMPOSE_FILE in .env selects the three compose files)\n"
              "  python scripts/import_state.py <stamp>   (after copying an export into data/state/)\n"
              "Share the access code with whoever should see the site.")
    else:
        print("Next: docker compose up --build -d, then open http://localhost:5173")


if __name__ == "__main__":
    main()
