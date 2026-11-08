/** Access-code gate for the whole web server (dev server included): with ACCESS_CODE set, every request — app,
 * assets, the /api and /pm-api proxies — needs the unlock cookie; otherwise it gets a small "enter access code"
 * page. Unset ACCESS_CODE = no gate (local dev). In prod the api port isn't published, so this is the only way in. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const COOKIE = "bt_access";
const MAX_AGE_S = 30 * 24 * 3600;

const page = (error: boolean) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Backtrace</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f5; --panel:#fff; --ink:#1d1d1f; --muted:#6b6b70; --line:#e2e2e0; --accent:#6a4cff; --bad:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141416; --panel:#1d1d20; --ink:#ececf0; --muted:#9a9aa2; --line:#2e2e33; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--ink);
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding:16px; box-sizing:border-box; }
  form { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:28px; width:min(380px,100%);
         box-sizing:border-box; display:flex; flex-direction:column; gap:12px; box-shadow:0 8px 30px rgba(0,0,0,.08); }
  h1 { margin:0; font-size:24px; } p { margin:0; color:var(--muted); font-size:14px; }
  input { font:inherit; font-size:16px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); }
  button { font:inherit; font-size:16px; padding:10px; border:none; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
  .err { color:var(--bad); font-size:14px; }
</style></head><body>
<form method="POST" action="/__unlock">
  <h1>Backtrace</h1><p>Enter the access code to continue.</p>
  <input name="code" type="password" autocomplete="current-password" autofocus required placeholder="Access code">
  ${error ? '<div class="err">That code isn\'t right.</div>' : ""}
  <button>Unlock</button>
</form></body></html>`;

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((kv) => kv.length === 2) as [string, string][],
  );
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export default function accessGate(code: string | undefined): Plugin {
  return {
    name: "backtrace-access-gate",
    configureServer(server) {
      if (!code) return;
      const token = createHash("sha256").update(`backtrace-access:${code}`).digest("hex");
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (same(cookies(req)[COOKIE] || "", token)) return next();
        if (req.method === "POST" && req.url?.startsWith("/__unlock")) {
          let body = "";
          req.on("data", (d) => (body = (body + d).slice(0, 4096)));
          req.on("end", () => {
            const given = new URLSearchParams(body).get("code") || "";
            if (same(createHash("sha256").update(`backtrace-access:${given}`).digest("hex"), token)) {
              res.writeHead(303, {
                Location: "/",
                "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}`,
              });
              return res.end();
            }
            res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
            res.end(page(true));
          });
          return;
        }
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(page(false));
      });
    },
  };
}
