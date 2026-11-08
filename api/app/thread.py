"""Research threads: a chat on top of Intents.

A thread is a root Intent plus its follow-up intents (parent_id chain). Messages are graph nodes
(Message)-[:IN_THREAD]->(root Intent), so the UI, the MCP agent and the runner all see one conversation.
The runner (scripts/runner.py) picks up queued threads, runs the app agent headless, and posts its reply.
Also: the curated dataset catalog (datasets.json) the agent offers when a question needs data."""
import json
import os
import re
import threading

from . import executor as X
from . import graph as g
from . import ops as O
from . import proposals as P
from .registry import operation

CATALOG_PATH = os.path.join(os.path.dirname(__file__), "datasets.json")
TITLE_MODEL = os.environ.get("BACKTRACE_AGENT_MODEL") or "claude-haiku-5-5"
RAW = "/data/raw"
MSG_JSON = ("datasets", "suggestions", "focus")


# ---------------------------------------------------------------- helpers

def _intents() -> dict[str, dict]:
    return {r["q"]["id"]: dict(r["q"]) for r in g.run("MATCH (q:Intent) RETURN q")}


def _root_of(intent_id: str, intents: dict | None = None) -> str:
    intents = intents or _intents()
    if intent_id not in intents:
        raise ValueError(f"no intent with id '{intent_id}'")
    q = intents[intent_id]
    while q.get("parent_id") in intents:
        q = intents[q["parent_id"]]
    return q["id"]


def _thread_ids(root: str, intents: dict) -> list[str]:
    ids, todo = [], [root]
    while todo:
        x = todo.pop(0)
        ids.append(x)
        todo += sorted((q["id"] for q in intents.values() if q.get("parent_id") == x),
                       key=lambda i: intents[i]["created_at"])
    return ids


def _decode_msg(m: dict) -> dict:
    m = dict(m)
    for k in MSG_JSON:
        if isinstance(m.get(k), str):
            m[k] = json.loads(m[k])
    return m


def _post(root: str, role: str, text: str, kind: str = "chat", **extra) -> dict:
    props = {"id": g.new_id("m"), "intent_id": root, "role": role, "text": text, "kind": kind,
             "created_at": g.now()}
    for k, v in extra.items():
        if v is not None:
            props[k] = json.dumps(v) if k in MSG_JSON else v
    g.run("MATCH (q:Intent {id:$q}) CREATE (m:Message)-[:IN_THREAD]->(q) SET m = $props", q=root, props=props)
    return _decode_msg(props)


def _view_name(view_id: str) -> str | None:
    r = g.run("MATCH (v:View {id:$v}) RETURN v.name AS n", v=view_id)
    return r[0]["n"] if r else None


def _catalog() -> list[dict]:
    with open(CATALOG_PATH, encoding="utf-8") as f:
        cat = json.load(f)
    loaded: dict[str, list] = {}
    for r in g.run("MATCH (t:Transform {kind:'source', status:'approved'})-[:COMPUTES]->(v:View) "
                   "OPTIONAL MATCH (b:Batch)-[:OF]->(v) "
                   "RETURN t.spec AS spec, v.id AS id, v.name AS name, collect(b.path) AS paths"):
        spec = json.loads(r["spec"]) if isinstance(r["spec"], str) else (r["spec"] or {})
        files = sorted({os.path.basename(x) for x in (r["paths"] or [spec.get("path", "")]) if x})
        for f in files:
            loaded.setdefault(f, []).append({"view_id": r["id"], "name": r["name"], "filter": spec.get("filter"),
                                             "files": files})
    for d in cat:
        d["files"] = [f for f in d.get("files", []) if os.path.isfile(os.path.join(RAW, f))]
        d["available"] = bool(d["files"]) and "ingest" in d
        seen, d["loaded_as"] = set(), []
        for f in d["files"]:
            for v in loaded.get(f, []):
                if v["view_id"] not in seen:
                    seen.add(v["view_id"])
                    d["loaded_as"].append(v)
    return cat


def turn_prompt(t: dict) -> str:
    """The agent's prompt for one queued turn (from next_turn): thread context + the new user messages."""
    q = t["latest_intent"]
    lines = [f"[Backtrace research chat] thread intent_id={t['intent_id']}.",
             f"Latest intent in this thread: {q['id']} ({q['status']}, mode {q.get('mode')}): \"{q['text']}\"."]
    if t["first_turn"]:
        lines.append("This is the start of a new research thread: the first message is the user's question.")
    lines.append("New from the user:")
    for m in t["messages"]:
        about = ", ".join(f"{f['name']} ({f['id']})" for f in m.get("focus") or [])
        lines.append(f"- {'[action] ' if m['kind'] == 'action' else ''}{m['text']}"
                     + (f"   [focused on: {about}]" if about else ""))
    lines.append("Follow the Chat mode rules in CLAUDE.md. Your final message is posted to the chat.")
    return "\n".join(lines)


# ---------------------------------------------------------------- UI + runner plumbing (REST only)

@operation(mcp=False)
def ask(text: str, intent_id: str | None = None, kind: str = "chat", anchors: list[str] | None = None,
        focus: list[str] | None = None, mode: str | None = None, model: str | None = None) -> dict:
    """Post the user's message to a thread (a new thread + Intent when intent_id is empty) and queue the agent.
    kind: "chat" (typed) or "action" (generated by a UI action such as Approve).
    focus: canvas nodes (view ids) the message is about."""
    text = (text or "").strip()
    if not text:
        raise ValueError("empty message")
    if model:  # validate before creating anything
        from .chat import pick_model
        pick_model(model)
    if intent_id:
        root = _root_of(intent_id)
    else:
        root = O.start_intent(text=text, anchors=anchors, author="user", mode=mode)["id"]
        if model:  # the landing page's model choice for this workspace's agent
            set_model(root, model)
        name_later(root, text)
    _post(root, "user", text, kind, focus=focus or None)
    g.run("MATCH (q:Intent {id:$q}) SET q.agent_status = 'queued', q.queued_at = $t, q.agent_error = null"
          + (", q.auto_turns = 0" if kind == "chat" else ""), q=root, t=g.now())
    return {"intent_id": root}


@operation(mcp=False)
def next_turn(reset: bool = False) -> dict:
    """Runner: claim the oldest queued thread. Returns its new user messages, session id and latest intent.
    reset: first call after a runner (re)start - threads left 'working' by a dead runner are queued again."""
    if reset:
        g.run("MATCH (q:Intent {agent_status:'working'}) SET q.agent_status = 'queued'")
    rows = g.run("MATCH (q:Intent {agent_status:'queued'}) RETURN q ORDER BY q.queued_at LIMIT 1")
    if not rows:
        return {"intent_id": None}
    q = dict(rows[0]["q"])
    # each user message is handed to exactly one turn (marked seen), including ones sent while a turn ran
    new = [_decode_msg(r["m"]) for r in g.run(
        "MATCH (m:Message {intent_id:$q, role:'user'}) WHERE m.seen IS NULL RETURN m ORDER BY m.created_at", q=q["id"])]
    if not new:
        g.run("MATCH (q:Intent {id:$q}) SET q.agent_status = 'idle'", q=q["id"])
        return {"intent_id": None}
    g.run("MATCH (m:Message) WHERE m.id IN $ids SET m.seen = true", ids=[m["id"] for m in new])
    started = g.now()
    g.run("MATCH (q:Intent {id:$q}) SET q.agent_status = 'working', q.started_at = $t", q=q["id"], t=started)
    last_agent = 0 if g.run("MATCH (m:Message {intent_id:$q, role:'agent'}) RETURN m.id LIMIT 1", q=q["id"]) else -1
    intents = _intents()
    thread = [intents[i] for i in _thread_ids(q["id"], intents)]
    latest = max(thread, key=lambda x: x["created_at"])
    out = {"intent_id": q["id"], "session_id": q.get("session_id"), "started_at": started,
           "model": q.get("agent_model"),
            "messages": [{"text": m["text"], "kind": m.get("kind", "chat"),
                          "focus": [{"id": f, "name": _view_name(f)} for f in m.get("focus") or []]} for m in new],
            "latest_intent": {"id": latest["id"], "status": latest["status"], "text": latest["text"],
                              "mode": latest.get("mode")},
            "first_turn": last_agent < 0}
    out["prompt"] = turn_prompt(out)
    return out


@operation(mcp=False)
def finish_turn(intent_id: str, reply: str | None = None, session_id: str | None = None,
                error: str | None = None, started_at: str | None = None) -> dict:
    """Runner: post the agent's reply and mark the thread idle (or queued again if the user wrote meanwhile)."""
    if reply and reply.strip():
        _post(intent_id, "agent", reply.strip())
    g.run("MATCH (q:Intent {id:$q}) SET q.agent_activity = null", q=intent_id)
    if not error:
        _auto_continue(intent_id)
    newer = g.run("MATCH (m:Message {intent_id:$q, role:'user'}) WHERE m.seen IS NULL RETURN count(m) AS n",
                  q=intent_id)[0]["n"]
    status = "queued" if newer else ("error" if error else "idle")
    g.run("MATCH (q:Intent {id:$q}) SET q.agent_status = $s, q.agent_error = $e"
          + (", q.session_id = $sid" if session_id else ""), q=intent_id, s=status, e=error, sid=session_id)
    return {"intent_id": intent_id, "agent_status": status}


def _stage(items: list[dict], intents: list[dict]) -> str:
    kinds = {(i["type"], i.get("kind")) for i in items}
    if any(q["status"] == "answered" for q in intents) or ("message", "source") in kinds:
        return "answered" if any(q["status"] == "answered" for q in intents) else "data"
    if ("message", "datasets") in kinds or ("proposal", "transform") in kinds:
        return "data"
    if ("proposal", "schema") in kinds:
        return "shape"
    return "ask"


@operation(mcp=False)
def get_thread(intent_id: str) -> dict:
    """UI: one research thread in order: messages, proposals (with full content, head flag and comments),
    dataset cards and results, plus the agent's status and the journey stage."""
    intents = _intents()
    root = _root_of(intent_id, intents)
    ids = _thread_ids(root, intents)
    views = O._all_views()
    names = {v["id"]: v["name"] for v in views}
    vkind = {v["id"]: v.get("kind") for v in views}
    heads: set[str] = set()
    for v in views:
        for kind, ps in v["_proposals"].items():
            if kind == "visual":
                heads |= {h["id"] for h in P.heads_by_tree(ps)}
            elif (h := P.head(ps)):
                heads.add(h["id"])

    items: list[dict] = []
    for r in g.run("MATCH (m:Message {intent_id:$q}) RETURN m ORDER BY m.created_at", q=root):
        m = _decode_msg(r["m"])
        items.append({"type": "message", "at": m["created_at"], **m})
    pids = []
    for r in g.run(f"MATCH (p)-[:{P.VIEW_EDGES}]->(v:View) WHERE p.intent_id IN $ids "
                   "RETURN labels(p)[0] AS label, p", ids=ids):
        p = P.decode(r["p"])
        pids.append(p["id"])
        items.append({"type": "proposal", "at": p["created_at"], "kind": P.LABEL_TO_KIND[r["label"]],
                      "view_name": names.get(p["view_id"]), "is_head": p["id"] in heads, "proposal": p})
    comments: dict[str, list] = {}
    for r in g.run("MATCH (c:Comment) WHERE c.target_id IN $ids RETURN c ORDER BY c.created_at", ids=pids):
        comments.setdefault(r["c"]["target_id"], []).append(r["c"])
    summaries = {q["id"]: q for q in O._intent_summaries(views) if q["id"] in ids}
    for qid in ids:
        q = summaries.get(qid)
        if q and q["status"] == "answered" and q.get("result_view_id"):
            inst = X.latest_instance(q["result_view_id"])
            items.append({"type": "result", "at": q.get("answered_at") or q["created_at"], "intent_id": qid,
                          "text": q["text"], "summary": q.get("summary"), "result_kind": q.get("result_kind"),
                          "result_current": q.get("result_current"), "view_id": q["result_view_id"],
                          "view_name": names.get(q["result_view_id"]),
                          "instance": {"id": inst["id"], "hash": inst.get("hash"),
                                       "row_count": inst.get("row_count")} if inst else None})
    items.sort(key=lambda i: i["at"])

    ds_ids = {d for i in items if i["type"] == "message" for d in (i.get("datasets") or [])}
    datasets = {d["id"]: d for d in _catalog() if d["id"] in ds_ids} if ds_ids else {}
    rq = intents[root]
    thread_intents = [summaries.get(i, intents[i]) for i in ids]
    canvas = _canvas(ids, items, thread_intents, {v["id"]: v for v in views})
    return {"intent": {"id": root, "text": rq["text"], "title": rq.get("title"), "status": rq["status"],
                       "mode": rq.get("mode"),
                       "auto": rq.get("mode") == "auto",
                       "agent_model": rq.get("agent_model"),
                       "agent_status": rq.get("agent_status") or "idle", "agent_error": rq.get("agent_error"),
                       "agent_activity": rq.get("agent_activity"),
                       "created_at": rq["created_at"]},
            "intents": [{"id": q["id"], "text": q["text"], "status": q["status"]} for q in thread_intents],
            "items": items, "comments": comments, "datasets": datasets, "names": names,
            "view_kinds": vkind, "stage": _stage(items, thread_intents), "canvas": canvas}


def _canvas(ids: list[str], items: list[dict], thread_intents: list[dict], views: dict[str, dict]) -> dict:
    """The thread's working graph: its tables (full current + pending shape versions, transforms, visuals,
    latest instance), upstream lineage down to the sources, notes, and dataset choices still open."""
    order: list[str] = []

    def add(vid):
        if vid in views and vid not in order:
            order.append(vid)
    for q in thread_intents:
        for a in q.get("anchors") or []:
            add(a)
    for i in items:
        if i["type"] == "proposal" and i["proposal"]["status"] != "discarded":
            add(i["proposal"]["view_id"])
            for r in i["proposal"].get("reads") or []:
                add(r)
        elif i["type"] == "message" and i.get("view_id"):
            add(i["view_id"])
    for v in views.values():
        if v.get("intent_id") in ids:
            add(v["id"])
    k = 0
    while k < len(order):  # upstream closure through head transforms (reused views, down to sources)
        h = P.head(views[order[k]]["_proposals"]["transform"])
        for r in (h or {}).get("reads") or []:
            add(r)
        k += 1
    full: dict[str, dict] = {vid: {kind: [] for kind in P.KINDS} for vid in order}
    for r in g.run(f"MATCH (p)-[:{P.VIEW_EDGES}]->(v:View) WHERE v.id IN $vids RETURN labels(p)[0] AS label, p",
                   vids=order):
        p = P.decode(r["p"])
        full[p["view_id"]][P.LABEL_TO_KIND[r["label"]]].append(p)
    answers = {q["result_view_id"]: q.get("summary") for q in thread_intents
               if q.get("status") == "answered" and q.get("result_view_id")}

    def by_time(xs):
        return sorted(xs, key=lambda p: p["created_at"])
    keep = ("id", "kind", "reads", "rationale", "warnings", "spec")
    nodes, edges = [], []
    for vid in order:
        v, ps = views[vid], full[vid]
        hs, ht = P.head(ps["schema"]), P.head(ps["transform"])
        pend_t = [t for t in by_time(ps["transform"]) if t["status"] == "pending"]
        vis_heads = {x["id"] for x in P.heads_by_tree(ps["visual"])}
        visuals = [{"id": x["id"], "status": x["status"], "rationale": x.get("rationale")}
                   for x in by_time(ps["visual"]) if x["id"] in vis_heads or x["status"] == "pending"]
        inst = X.latest_instance(vid)
        nodes.append({
            "id": vid, "name": v["name"], "kind": v.get("kind"), "member": v.get("intent_id") in ids,
            "head_schema": hs, "pending_schemas": [p for p in by_time(ps["schema"]) if p["status"] == "pending"],
            "head_transform": {x: ht.get(x) for x in keep} if ht else None,
            "pending_transforms": [{x: t.get(x) for x in keep} for t in pend_t],
            "visuals": visuals, "answer": answers.get(vid),
            "instance": {"id": inst["id"], "hash": inst.get("hash"), "row_count": inst.get("row_count")}
            if inst else None})
        for t, pending in [(ht, False)] + [(t, True) for t in pend_t]:
            for r in (t or {}).get("reads") or []:
                if r in views:
                    edges.append({"from": vid, "to": r, "pending": pending, "kind": t.get("kind")})
    notes = [dict(r["n"]) for r in g.run("MATCH (n:Note) WHERE n.intent_id IN $ids RETURN n ORDER BY n.created_at",
                                          ids=ids)]
    open_datasets: list[str] = []
    for i in items:
        if i["type"] == "message" and i.get("kind") == "datasets":
            open_datasets = i.get("datasets") or []
        elif i["type"] == "message" and i.get("kind") == "source":
            open_datasets = []
    focus = next((i.get("focus") for i in reversed(items) if i["type"] == "message" and i.get("focus")), None)
    # every question in the workspace, with the tables proposed while serving it and its answer
    on_canvas = {n["id"] for n in nodes}
    questions = []
    for q in thread_intents:
        vids = []
        for i in items:
            p = i.get("proposal") if i["type"] == "proposal" else None
            if p and p.get("intent_id") == q["id"] and p["status"] != "discarded" and p["view_id"] not in vids:
                vids.append(p["view_id"])
        for a in q.get("anchors") or []:
            if a not in vids:
                vids.append(a)
        if q.get("result_view_id") and q["result_view_id"] not in vids:
            vids.append(q["result_view_id"])
        questions.append({"id": q["id"], "text": q["text"], "status": q["status"], "summary": q.get("summary"),
                          "stage": _q_stage(q, items, thread_intents),
                          "parent_id": q.get("parent_id"), "result_view_id": q.get("result_view_id"),
                          "views": [v for v in vids if v in on_canvas]})
    return {"nodes": nodes, "edges": edges, "notes": notes, "open_datasets": open_datasets, "focus": focus,
            "questions": questions}


# ---------------------------------------------------------------- agent tools (MCP)

@operation
def say(intent_id: str, text: str, datasets: list[str] | None = None, suggestions: list[str] | None = None,
        focus: list[str] | None = None) -> dict:
    """Post a message into the user's research chat for this intent's thread, optionally with cards:
    - datasets: dataset ids from list_datasets, shown as DATASET CARDS with a "Use this" button
    - suggestions: up to 4 short quick replies the user can click, e.g. ["Use median", "Number of sales instead"]
    - focus: view ids to highlight on the user's canvas (it pans to the first one)
    Your final reply of a chat turn is posted automatically: use say only when you need cards, chips or focus."""
    root = _root_of(intent_id)
    if datasets:
        known = {d["id"] for d in _catalog()}
        bad = [d for d in datasets if d not in known]
        if bad:
            raise ValueError(f"unknown dataset ids {bad} (see list_datasets)")
    m = _post(root, "agent", text, "datasets" if datasets else "chat", datasets=datasets or None,
              suggestions=(suggestions or [])[:4] or None, focus=focus or None)
    return {"id": m["id"], "thread": root}


@operation
def list_datasets(query: str | None = None) -> dict:
    """The curated catalog of public datasets Backtrace can offer when a question needs data. Each entry:
    id, title, publisher, licence, url, description, coverage, updated, grain, size, notes (column codes),
    available (its files are downloaded and can be loaded now with ingest_dataset), files, and loaded_as
    (source views already loaded from it, with their filter; reuse one when its filter fits).
    query: optional words to rank entries by relevance (e.g. "house prices flats")."""
    cat = _catalog()
    if query:
        words = {w for w in query.lower().split() if len(w) > 2}

        def score(d):
            hay = " ".join([d["title"], d["description"], " ".join(d.get("keywords", []))]).lower()
            return sum(w in hay for w in words)
        cat.sort(key=score, reverse=True)
    for d in cat:
        d.pop("ingest", None)
    return {"datasets": cat}


@operation
def ingest_dataset(dataset_id: str, name: str, filter: str | None = None, files: list[str] | None = None,
                   intent_id: str | None = None, reuse: bool = True) -> dict:
    """Load a catalog dataset (list_datasets, available=true) as a new SOURCE view, using the catalog's parsing
    rules plus your `filter` (pandas expression over its columns, e.g. "district == 'READING'"; see the entry's
    notes for codes). The oldest file becomes batch 1 and each later file is appended as a batch, so the
    snapshot covers them all. files: which downloaded files to use (default: all of them).
    intent_id: the thread's intent; a "data loaded" card is posted to the user's chat.
    reuse (default true): if a source view was already loaded from this dataset with the same filter, use it
    instead of loading a duplicate, appending any of the requested files it doesn't have yet as new batches
    (returned with reused=true and the files added)."""
    with open(CATALOG_PATH, encoding="utf-8") as f:
        raw = {d["id"]: d for d in json.load(f)}
    d = next((x for x in _catalog() if x["id"] == dataset_id), None)
    if d is None:
        raise ValueError(f"unknown dataset '{dataset_id}' (see list_datasets)")
    if not d["available"]:
        raise ValueError(f"'{dataset_id}' isn't downloaded yet; offer an available dataset instead")
    use = sorted(files or d["files"])
    missing = [x for x in use if x not in d["files"]]
    if missing:
        raise ValueError(f"not downloaded: {missing} (available: {d['files']})")
    norm = lambda f: "".join((f or "").replace('"', "'").split())  # noqa: E731
    same = [v for v in d["loaded_as"] if norm(v["filter"]) == norm(filter)] if reuse else []
    if same:
        v = max(same, key=lambda x: len(x["files"]))
        added = [f for f in use if f not in v["files"]]
        for f in added:
            O.append_batch(v["view_id"], f)
        inst = X.latest_instance(v["view_id"]) or {}
        rows = inst.get("row_count")
        if intent_id:
            _post(_root_of(intent_id), "agent",
                  f"Using {d['title']}, already loaded as {v['name']}"
                  + (f" where {filter}" if filter else "")
                  + (f"; added {', '.join(added)}" if added else "")
                  + (f": {rows:,} rows across {', '.join(sorted(set(v['files']) | set(added)))}."
                     if isinstance(rows, int) else "."),
                  "source", view_id=v["view_id"], dataset_id=dataset_id, hash=inst.get("hash"))
        return {"view_id": v["view_id"], "name": v["name"], "reused": True, "files_added": added,
                "row_count": rows, "instance_id": inst.get("id"), "hash": inst.get("hash")}
    rules = raw[dataset_id]["ingest"]
    r = O.ingest(path=use[0], name=name, columns=rules.get("columns"), filter=filter,
                 parse_dates=rules.get("parse_dates"))
    view_id, last = r["view_id"], r
    for extra in use[1:]:
        last = O.append_batch(view_id, extra)
    rows = last.get("row_count", r.get("row_count"))
    out = {"view_id": view_id, "name": name, "files": use, "row_count": rows,
           "instance_id": last.get("instance_id", r.get("instance_id")), "hash": last.get("hash", r.get("hash")),
           "schema": r["schema"], "sample": r["sample"]}
    if intent_id:
        _post(_root_of(intent_id), "agent",
              f"Loaded {d['title']} ({', '.join(use)}){' where ' + filter if filter else ''}: "
              f"{rows:,} rows." if isinstance(rows, int) else f"Loaded {d['title']}.",
              "source", view_id=view_id, dataset_id=dataset_id, hash=out["hash"])
    return out


@operation
def note(intent_id: str, text: str, about: str | None = None, author: str = "agent") -> dict:
    """Pin a short TEXT NODE on the user's research canvas for this thread: the question broken into parts,
    an assumption, a finding, a caveat. about: the view id it refers to (drawn next to it), or none for the
    thread as a whole. Keep it to 1-3 lines; use it for things worth keeping in view, not chat."""
    root = _root_of(intent_id)
    if about:
        P.view_node(about)
    text = (text or "").strip()
    if not text:
        raise ValueError("empty note")
    props = {k: v for k, v in {"id": g.new_id("n"), "intent_id": root, "text": text, "about": about,
                               "author": author, "created_at": g.now()}.items() if v is not None}
    g.run("MATCH (q:Intent {id:$q}) CREATE (n:Note)-[:IN_THREAD]->(q) SET n = $props", q=root, props=props)
    return {"id": props["id"], "thread": root}


def _q_stage(q: dict, items: list[dict], thread_intents: list[dict]) -> str:
    """Where one question is in ask -> shape -> data -> answer (-> answered): from its own proposals, the
    dataset/source cards posted while it was the latest question, and whether it's answered."""
    if q.get("status") == "answered":
        return "answered"
    later = sorted(x["created_at"] for x in thread_intents if x["created_at"] > q["created_at"])
    until = later[0] if later else "~"
    own = {i["kind"] for i in items if i["type"] == "proposal" and i["proposal"].get("intent_id") == q["id"]
           and i["proposal"]["status"] != "discarded"}
    cards = {i.get("kind") for i in items if i["type"] == "message" and q["created_at"] <= i["at"] < until}
    if any(i["type"] == "proposal" and i["kind"] == "transform" and i["proposal"].get("intent_id") == q["id"]
           and i["proposal"]["status"] == "approved" for i in items):
        return "answer"  # the steps are agreed: the answer is being computed
    if "transform" in own or cards & {"datasets", "source"}:
        return "data"
    return "shape" if "schema" in own else "ask"


# ---------------------------------------------------------------- workspace names

def _fallback_title(text: str) -> str:
    words = re.sub(r"[?.!]+$", "", text.strip()).split()
    return " ".join(words[:6])[:60] or "Untitled research"


def make_title(text: str) -> str:
    """A short workspace title from the first question (one quick structured-output call; falls back to the
    question's first words)."""
    try:
        from .transforms.agentic import client
        r = client().beta.messages.create(
            model=TITLE_MODEL, max_tokens=200, thinking={"type": "disabled"},
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": {
                "type": "object", "additionalProperties": False, "required": ["title"],
                "properties": {"title": {"type": "string"}}}}},
            system=("Name a data-research workspace from the user's first question: 2-6 words, Title Case, naming "
                    "the subject (place, thing, measure), no quotes, no trailing punctuation. Examples: "
                    "'Reading Flat Prices', 'Coventry Commercial vs Residential', 'US Airline Delays 2025'."),
            messages=[{"role": "user", "content": text[:2000]}])
        title = json.loads(next(b.text for b in r.content if b.type == "text"))["title"].strip().strip("'\"")
        return title[:60] or _fallback_title(text)
    except Exception:  # noqa: BLE001  (no key, refusal, network: the question's first words will do)
        return _fallback_title(text)


def name_later(root: str, text: str) -> None:
    def work():
        g.run("MATCH (q:Intent {id:$q}) WHERE q.title IS NULL SET q.title = $t", q=root, t=make_title(text))
    threading.Thread(target=work, daemon=True).start()


@operation
def rename_workspace(intent_id: str, title: str) -> dict:
    """Rename the research workspace (the thread) this intent belongs to, e.g. when the user switches subject
    (Edinburgh -> Coventry). 2-6 words, Title Case. The thread list and canvas header show it."""
    root = _root_of(intent_id)
    title = (title or "").strip()
    if not title:
        raise ValueError("empty title")
    g.run("MATCH (q:Intent {id:$q}) SET q.title = $t", q=root, t=title[:60])
    return {"id": root, "title": title[:60]}


# ---------------------------------------------------------------- auto-accept

AUTO_TURN_LIMIT = 8  # consecutive agent turns auto-accept may trigger without a word from the user


def _pending_agent_proposals(ids: list[str]) -> list[str]:
    return [r["id"] for r in g.run(
        f"MATCH (p)-[:{P.VIEW_EDGES}]->(:View) WHERE p.intent_id IN $ids AND p.status = 'pending' "
        "AND p.author = 'agent' RETURN p.id AS id ORDER BY p.created_at", ids=ids)]


def _accept_all(root: str) -> int:
    """Approve every pending agent proposal in the workspace, oldest first (a transform also approves the input
    shapes it brought, so skip anything already decided)."""
    n = 0
    for pid in _pending_agent_proposals(_thread_ids(root, _intents())):
        if g.run("MATCH (p {id:$p}) WHERE p.status = 'pending' RETURN p.id", p=pid):
            P.decide(pid, "approve", "auto")
            n += 1
    return n


def _auto_continue(root: str) -> None:
    """After an agent turn in an auto-accept workspace: accept what it proposed and queue it to carry on, until
    every question is answered or AUTO_TURN_LIMIT turns pass without the user."""
    q = g.run("MATCH (q:Intent {id:$q}) RETURN q", q=root)[0]["q"]
    if q.get("mode") != "auto":
        return
    accepted = _accept_all(root)
    intents = _intents()
    open_q = [i for i in _thread_ids(root, intents) if intents[i]["status"] != "answered"]
    turns = int(q.get("auto_turns") or 0)
    if accepted and open_q and turns < AUTO_TURN_LIMIT:
        _post(root, "user", f"Auto-accepted {accepted} proposal{'s' if accepted > 1 else ''}. Carry on to the answer.",
              "action")
        g.run("MATCH (q:Intent {id:$q}) SET q.auto_turns = $n", q=root, n=turns + 1)


@operation(mcp=False)
def set_auto(intent_id: str, on: bool) -> dict:
    """Turn auto-accept on/off for a workspace (all its questions). Turning it on accepts every pending agent
    proposal right away and lets the agent carry on to the answer."""
    root = _root_of(intent_id)
    ids = _thread_ids(root, _intents())
    g.run("MATCH (q:Intent) WHERE q.id IN $ids SET q.mode = $m", ids=ids, m="auto" if on else "guided")
    accepted = 0
    if on:
        g.run("MATCH (q:Intent {id:$q}) SET q.auto_turns = 0", q=root)
        accepted = _accept_all(root)
        intents = _intents()
        if any(intents[i]["status"] != "answered" for i in ids):
            ask(text=f"Auto-accept is on{f' (accepted {accepted} proposals)' if accepted else ''}. "
                     "Carry on to the answer, approving your own steps.", intent_id=root, kind="action")
    return {"intent_id": root, "auto": on, "accepted": accepted}


@operation(mcp=False)
def set_model(intent_id: str, model: str) -> dict:
    """Chat model for a workspace's agent turns: haiku | sonnet | opus (or the model id). Applies from the next
    turn; the conversation carries on in the same session. AI steps inside calculations keep BACKTRACE_MODEL."""
    from .chat import MODELS
    mid = MODELS.get(model, model)
    if mid not in MODELS.values():
        raise ValueError(f"model must be one of {sorted(MODELS)}")
    root = _root_of(intent_id)
    g.run("MATCH (q:Intent {id:$q}) SET q.agent_model = $m", q=root, m=mid)
    return {"intent_id": root, "agent_model": mid}
