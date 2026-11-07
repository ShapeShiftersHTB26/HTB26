"""Chat runner: answers research-thread messages from the web UI by running the app agent headless.

Run on the host next to the stack (needs the `claude` CLI, logged in):  python scripts/runner.py
Each queued thread gets one `claude -p` turn in agent/ (MCP tools only), resuming that thread's session.
The agent's proposals land on the graph as it works; its final reply is posted to the thread.
Env: BACKTRACE_API (default http://localhost:8000), BACKTRACE_CHAT_MODEL (default sonnet: cheaper per turn)."""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

API = os.environ.get("BACKTRACE_API", "http://localhost:8000")
MODEL = os.environ.get("BACKTRACE_CHAT_MODEL", "sonnet")
AGENT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "agent")
TURN_TIMEOUT_S = 20 * 60


def op(name: str, **kwargs):
    req = urllib.request.Request(f"{API}/api/op/{name}", data=json.dumps(kwargs).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def prompt_for(t: dict) -> str:
    q = t["latest_intent"]
    lines = [f"[Backtrace research chat] thread intent_id={t['intent_id']}.",
             f"Latest intent in this thread: {q['id']} ({q['status']}, mode {q.get('mode')}): \"{q['text']}\"."]
    if t["first_turn"]:
        lines.append("This is the start of a new research thread: the first message is the user's question.")
    lines.append("New from the user:")
    lines += [f"- {'[action] ' if m['kind'] == 'action' else ''}{m['text']}" for m in t["messages"]]
    lines.append("Follow the Chat mode rules in CLAUDE.md. Your final message is posted to the chat.")
    return "\n".join(lines)


def run_claude(prompt: str, session_id: str | None) -> dict:
    exe = shutil.which("claude")
    if not exe:
        raise RuntimeError("claude CLI not found on PATH")
    cmd = [exe, "-p", "--output-format", "json", "--model", MODEL,
           "--mcp-config", ".mcp.json", "--strict-mcp-config"]
    if session_id:
        cmd += ["--resume", session_id]
    cmd += ["--allowedTools", "mcp__backtrace", "Skill"]
    p = subprocess.run(cmd, input=prompt, cwd=AGENT_DIR, capture_output=True, text=True, encoding="utf-8",
                       timeout=TURN_TIMEOUT_S)
    try:
        out = json.loads(p.stdout)
    except json.JSONDecodeError:
        raise RuntimeError((p.stderr or p.stdout or f"exit {p.returncode}").strip()[:500])
    if out.get("is_error"):
        raise RuntimeError(str(out.get("result") or out.get("subtype") or "agent error")[:500])
    return out


def serve(t: dict) -> None:
    qid = t["intent_id"]
    prompt = prompt_for(t)
    print(f"[{time.strftime('%H:%M:%S')}] {qid}: {' | '.join(m['text'] for m in t['messages'])[:120]}", flush=True)
    try:
        try:
            out = run_claude(prompt, t.get("session_id"))
        except RuntimeError as e:
            if not t.get("session_id"):
                raise
            print(f"  resume failed ({e}); starting a fresh session", flush=True)
            out = run_claude(prompt, None)
        op("finish_turn", intent_id=qid, reply=out.get("result"), session_id=out.get("session_id"),
           started_at=t["started_at"])
        cost = out.get("total_cost_usd")
        print(f"  done in {out.get('num_turns')} turns" + (f", ${cost:.2f}" if cost else ""), flush=True)
    except Exception as e:  # noqa: BLE001  (report to the thread, keep the runner alive)
        print(f"  error: {e}", flush=True)
        op("finish_turn", intent_id=qid, error=str(e)[:500], started_at=t["started_at"])


def main() -> None:
    print(f"runner: {API}, model {MODEL}, agent dir {AGENT_DIR}", flush=True)
    first = True
    while True:
        try:
            t = op("next_turn", reset=first)
            first = False
        except Exception as e:  # noqa: BLE001  (api restarting)
            print(f"api not reachable: {e}", flush=True)
            time.sleep(5)
            continue
        if t.get("intent_id"):
            serve(t)
        else:
            time.sleep(1.5)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
