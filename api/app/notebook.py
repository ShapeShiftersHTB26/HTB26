"""Notebook view of a result: the chain of steps that produced a view's latest instance, as readable cells.

Each cell is one view in the chain, sources first, with the code of the transform that ran (ops rendered as
plain pandas), its rationale, the instance it produced (rows, fingerprint) and a few output rows. Cells can be
re-run as a preview and edited into a `python` transform (the escape hatch), which goes through the normal
proposal flow. The whole chain exports as a runnable .py / .ipynb that rebuilds the result from the source files."""
import ast
import json

from . import executor as X
from . import graph as g
from . import proposals as P
from .registry import operation

GLOBALS = {"pd", "np", "len", "str", "int", "float", "abs", "min", "max", "round", "True", "False", "None"}


# ---------------------------------------------------------------- code generation

class _Cols(ast.NodeTransformer):
    def __init__(self, var: str):
        self.var = var

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load) and node.id not in GLOBALS:
            return ast.copy_location(ast.Subscript(value=ast.Name(self.var, ast.Load()),
                                                   slice=ast.Constant(node.id), ctx=ast.Load()), node)
        return node


def expr_code(expr: str, var: str = "df") -> str:
    """'(property_type == "F") & (year > 2023)' -> '(df["property_type"] == "F") & (df["year"] > 2023)'."""
    tree = _Cols(var).visit(ast.parse(expr, mode="eval"))
    return ast.unparse(ast.fix_missing_locations(tree))


def ops_code(spec: dict, input_var: str) -> str:
    lines = [f"df = {input_var}.copy()"]
    lin = "'_rid'"  # aggregations keep lineage: _src collects each group's source row ids (rids helper)
    for o in spec.get("ops", []):
        k = o.get("op")
        if k == "filter":
            lines.append(f"df = df[{expr_code(o['where'])}]")
        elif k == "derive":
            lines.append(f"df[{o['column']!r}] = {expr_code(o['expr'])}")
        elif k == "aggregate":
            by, metrics = o.get("by", []), o.get("metrics", {})
            aggs = ", ".join(f"{out}=({col!r}, {fn!r})" for out, (col, fn) in metrics.items())
            if by:
                lines.append(f"df = df.groupby({by!r}, dropna=False).agg({aggs}, _src=({lin}, rids)).reset_index()")
            else:
                vals = ", ".join(f"{out!r}: df[{col!r}].{fn}()" for out, (col, fn) in metrics.items())
                lines.append(f"df = pd.DataFrame([{{{vals}, '_src': rids(df[{lin}])}}])")
            lin = "'_src'"
        elif k == "sort":
            lines.append(f"df = df.sort_values({o.get('by', [])!r}, ascending={not o.get('desc', False)})")
        elif k == "limit":
            lines.append(f"df = df.head({int(o['n'])})")
    return "\n".join(lines)


def source_code(spec: dict, paths: list[str] | None = None) -> str:
    """A source snapshot: its recipe applied to every batch file, in batch order."""
    files = [p.replace("/data/raw/", "data/raw/") for p in (paths or [spec["path"]])]
    args = ["f"] if len(files) > 1 else [repr(files[0])]
    if spec.get("columns"):
        args += ["header=None", f"names={spec['columns']!r}"]
    if spec.get("dtypes"):
        args.append("dtype=str")
    if spec.get("parse_dates"):
        args.append(f"parse_dates={spec['parse_dates']!r}")
    if spec.get("limit"):
        args.append(f"nrows={spec['limit']}")
    read = f"pd.read_csv({', '.join(args)})"
    lines = [f"df = pd.concat([{read} for f in {files!r}], ignore_index=True)" if len(files) > 1 else f"df = {read}"]
    for c, t in (spec.get("dtypes") or {}).items():
        if t == "integer":
            lines.append(f"df[{c!r}] = pd.to_numeric(df[{c!r}]).astype('Int64')")
        elif t == "number":
            lines.append(f"df[{c!r}] = pd.to_numeric(df[{c!r}])")
    if spec.get("filter"):
        lines.append(f"df = df[{expr_code(spec['filter'])}]")
    return "\n".join(lines)


def cell_code(transform: dict, input_vars: list[str], paths: list[str] | None = None) -> str:
    kind, spec = transform["kind"], transform.get("spec") or {}
    if kind == "source":
        return source_code(spec, paths)
    if kind == "ops":
        return ops_code(spec, input_vars[0] if input_vars else "df")
    if kind == "python":
        return spec.get("code", "")
    # agentic: not code; the model's output is stored and hashed
    prompt = (spec.get("prompt") or "").strip().replace("\n", "\n# ")
    return (f"# {kind}: an LLM step (its output is stored and hashed, not re-run)\n# prompt: {prompt}\n"
            f"df = llm_{'map' if kind == 'agent_map' else 'reduce'}({', '.join(input_vars)}, prompt=...)")


LINEAGE = {"source": "source file (sha256)", "ops": "row-level", "agent_map": "row-level (one output per row)",
           "agent_reduce": "cited rows", "python": "coarse unless the code keeps _rid / _src"}


# ---------------------------------------------------------------- chain

def _chain(view_id: str) -> list[dict]:
    """Steps in dependency order. Follows the latest instance's actual inputs (FROM edges) when evaluated,
    otherwise the current head transforms."""
    inst = X.latest_instance(view_id)
    steps, seen = [], set()

    def visit_inst(iid: str):
        if iid in seen:
            return
        seen.add(iid)
        r = g.run("MATCH (i:Instance {id:$i})-[:OF]->(v:View) OPTIONAL MATCH (i)-[:USED_TRANSFORM]->(t) "
                  "OPTIONAL MATCH (i)-[:USED_SCHEMA]->(s) RETURN i, v, t, s", i=iid)[0]
        ins = [x["j"]["id"] for x in g.run("MATCH (:Instance {id:$i})-[:FROM]->(j:Instance) RETURN j ORDER BY j.id",
                                           i=iid)]
        for j in ins:
            visit_inst(j)
        steps.append({"view": r["v"], "transform": P.decode(r["t"]), "shape": P.decode(r["s"]) if r["s"] else None,
                      "instance": r["i"], "inputs": ins})

    def visit_head(vid: str):
        if vid in seen:
            return
        seen.add(vid)
        i = X.latest_instance(vid)
        if i:
            return visit_inst(i["id"])
        ps = {k: [] for k in P.KINDS}
        for r in g.run(f"MATCH (p)-[:{P.VIEW_EDGES}]->(:View {{id:$v}}) RETURN labels(p)[0] AS l, p", v=vid):
            ps[P.LABEL_TO_KIND[r["l"]]].append(P.decode(r["p"]))
        t = P.head(ps["transform"]) or (ps["transform"][-1] if ps["transform"] else None)
        for rd in (t or {}).get("reads") or []:
            visit_head(rd)
        steps.append({"view": P.view_node(vid), "transform": t, "shape": P.head(ps["schema"]), "instance": None,
                      "inputs": []})

    visit_inst(inst["id"]) if inst else visit_head(view_id)
    return steps


@operation
def get_notebook(view_id: str, preview_rows: int = 5) -> dict:
    """The receipt of a view as notebook cells: every step that produced its latest instance, sources first,
    with the code that ran (ops shown as pandas), rationale, output rows and fingerprint per step."""
    steps = _chain(view_id)
    inst_view = {s["instance"]["id"]: s["view"]["name"] for s in steps if s["instance"]}
    cells = []
    for s in steps:
        t, i, v = s["transform"] or {}, s["instance"], s["view"]
        input_vars = [inst_view.get(j, j) for j in s["inputs"]] or [
            P.view_node(r)["name"] for r in (t.get("reads") or [])]
        paths = None
        if i and i.get("batches"):
            ids = json.loads(i["batches"])
            bp = {r["id"]: r["path"] for r in g.run("MATCH (b:Batch) WHERE b.id IN $ids RETURN b.id AS id, b.path AS path",
                                                    ids=ids)}
            paths = [bp[b] for b in ids if b in bp]
        rows = []
        if i:
            try:
                _, rows = X.ST.read(i["id"], limit=preview_rows)
            except Exception:  # noqa: BLE001
                rows = []
        pend = [P.decode(r["t"]) for r in g.run(
            "MATCH (t:Transform {status:'pending'})-[:COMPUTES]->(:View {id:$v}) RETURN t ORDER BY t.created_at", v=v["id"])]
        cells.append({
            "view_id": v["id"], "name": v["name"], "kind": t.get("kind"), "transform_id": t.get("id"),
            "reads": t.get("reads") or [],
            "rationale": t.get("rationale"), "inputs": input_vars, "code": cell_code(t, input_vars, paths) if t else "",
            "lineage": LINEAGE.get(t.get("kind"), ""), "columns": list(((s["shape"] or {}).get("schema") or {})
                                                                       .get("properties", {})),
            "instance": {k: i.get(k) for k in ("id", "hash", "row_count", "formula_hash", "created_at")} if i else None,
            "rows": rows,
            "pending": [{"id": p["id"], "kind": p["kind"], "rationale": p.get("rationale"), "author": p.get("author"),
                         "code": cell_code(p, input_vars)} for p in pend],
        })
    return {"view_id": view_id, "cells": cells}


@operation(mcp=False)
def preview_transform(view_id: str, code: str, rows: int = 20) -> dict:
    """Notebook: run edited Python for a view against its current inputs WITHOUT storing anything.
    Inputs are DataFrames named after the input views (with _rid); the code must assign the output to `df`."""
    _, head_t = X._heads(view_id)
    reads = head_t.get("reads") or []
    frames = {P.view_node(r)["name"]: X.load_frame(X.latest_instance(r)["id"]) for r in reads}
    out = X.run_python(code, frames)
    data = X.to_rows(out.head(rows))
    return {"row_count": len(out), "columns": [c for c in out.columns if not c.startswith("_")], "rows": data,
            "lineage": "row-level" if ("_src" in out.columns or "_rid" in out.columns) else "coarse"}


@operation(mcp=False)
def export_notebook(view_id: str, format: str = "py") -> dict:
    """Notebook as a runnable script (format py) or Jupyter notebook (ipynb) that rebuilds the view from the
    source files with pandas. Agentic steps can't be re-run offline; they're marked."""
    nb = get_notebook(view_id, preview_rows=0)
    name = P.view_node(view_id)["name"]
    head = (f"Backtrace receipt: {name}\nRebuilds the result from the source files, step by step.\n"
            "Run from the repo root (source CSVs in data/raw/).")
    blocks = [("markdown" if format == "ipynb" else "comment", head), ("code", "import pandas as pd\nimport numpy as np\n\n\n"
                                                                         "def rids(s):  # lineage: the source row ids behind each group\n"
                                                                         "    return [r for x in s for r in (x if isinstance(x, list) else [x])]")]
    for c in nb["cells"]:
        fp = (c["instance"] or {}).get("hash")
        code = c["code"]
        if c["kind"] == "source":  # stored rows carry an id; give the CSV rows one so lineage helpers work
            code += f"\ndf = df.reset_index(drop=True)\ndf['_rid'] = [f'{c['name']}:{{i}}' for i in range(len(df))]"
        if c["kind"] in ("agent_map", "agent_reduce") and c["instance"]:
            # can't re-run the model offline: embed its stored (hashed) output instead
            _, stored = X.ST.read(c["instance"]["id"], limit=5000)
            stored = [{k: v for k, v in r.items() if not k.startswith("_")} for r in stored]
            code = (f"# {c['kind']}: LLM step, re-running it needs the model; this is its stored, hashed output\n"
                    f"df = pd.DataFrame({json.dumps(stored, default=str)})")
        blocks.append(("markdown" if format == "ipynb" else "comment",
                       f"{c['name']} ({c['kind']})" + (f": {c['rationale']}" if c["rationale"] else "")
                       + (f"\nfingerprint {fp}" if fp else "")))
        blocks.append(("code", f"{code}\n{c['name']} = df"))
    blocks.append(("code", f"print({name}.drop(columns=['_src', '_rid'], errors='ignore').to_string())\n"
                           f"if '_src' in {name}:  # lineage: which source rows each result row came from\n"
                           f"    print('first row is built from', len({name}['_src'].iloc[0]), 'source rows, e.g.',"
                           f" {name}['_src'].iloc[0][:3])"))
    if format == "ipynb":
        cells = [{"cell_type": k, "metadata": {}, "source": s.splitlines(True),
                  **({"outputs": [], "execution_count": None} if k == "code" else {})} for k, s in blocks]
        content = json.dumps({"cells": cells, "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3",
                              "language": "python"}}, "nbformat": 4, "nbformat_minor": 5}, indent=1)
    else:
        content = "\n\n".join(("# " + s.replace("\n", "\n# ")) if k == "comment" else s for k, s in blocks) + "\n"
    return {"filename": f"{name}.{format}", "content": content}
