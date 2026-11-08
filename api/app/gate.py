"""Access-code gate, for Caddy's forward_auth on the VPS (deploy/Caddyfile). The Vite dev server has the same gate
built in (web/access-gate.ts) with the same cookie, so a code entered once works for both.
  GET  /__gate/check   204 if the request carries the unlock cookie (or no ACCESS_CODE is set), else 401 + the page
  POST /__unlock       form field `code`: right code -> cookie + redirect to /, wrong -> the page with an error"""
import hashlib
import hmac
import os
from urllib.parse import parse_qs

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response

COOKIE = "bt_access"
MAX_AGE_S = 30 * 24 * 3600
router = APIRouter()


def _code() -> str:
    return os.environ.get("ACCESS_CODE") or ""


def _token(code: str) -> str:
    return hashlib.sha256(f"backtrace-access:{code}".encode()).hexdigest()


def _page(error: bool) -> str:
    err = '<div class="err">That code isn\'t right.</div>' if error else ""
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Backtrace</title>
<style>
  :root {{ color-scheme: light dark; --bg:#f7f7f5; --panel:#fff; --ink:#1d1d1f; --muted:#6b6b70; --line:#e2e2e0; --accent:#6a4cff; --bad:#c0392b; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --bg:#141416; --panel:#1d1d20; --ink:#ececf0; --muted:#9a9aa2; --line:#2e2e33; }} }}
  body {{ margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--ink);
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding:16px; box-sizing:border-box; }}
  form {{ background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:28px; width:min(380px,100%);
         box-sizing:border-box; display:flex; flex-direction:column; gap:12px; box-shadow:0 8px 30px rgba(0,0,0,.08); }}
  h1 {{ margin:0; font-size:24px; }} p {{ margin:0; color:var(--muted); font-size:14px; }}
  input {{ font:inherit; font-size:16px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); }}
  button {{ font:inherit; font-size:16px; padding:10px; border:none; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }}
  .err {{ color:var(--bad); font-size:14px; }}
</style></head><body>
<form method="POST" action="/__unlock">
  <h1>Backtrace</h1><p>Enter the access code to continue.</p>
  <input name="code" type="password" autocomplete="current-password" autofocus required placeholder="Access code">
  {err}
  <button>Unlock</button>
</form></body></html>"""


def _unlocked(request: Request) -> bool:
    code = _code()
    return not code or hmac.compare_digest(request.cookies.get(COOKIE, ""), _token(code))


@router.get("/__gate/check")
def check(request: Request):
    # forward_auth asks about every request; let the unlock form itself through
    if request.headers.get("x-forwarded-uri", "").startswith("/__unlock") or _unlocked(request):
        return Response(status_code=204)
    return HTMLResponse(_page(False), status_code=401, headers={"Cache-Control": "no-store"})


@router.post("/__unlock")
async def unlock(request: Request):
    code = _code()
    given = (parse_qs((await request.body()).decode(errors="ignore")[:4096]).get("code") or [""])[0]
    if code and hmac.compare_digest(_token(given), _token(code)):
        r = RedirectResponse("/", status_code=303)
        r.set_cookie(COOKIE, _token(code), max_age=MAX_AGE_S, httponly=True, samesite="lax", path="/")
        return r
    return HTMLResponse(_page(bool(code)), status_code=401)
