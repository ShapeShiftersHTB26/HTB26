"""Expression evaluation for filter/derive: Python over columns-as-Series, with pd and np.
HACK: eval of agent-written code — local demo only."""
import ast

import numpy as np
import pandas as pd

SAFE_BUILTINS = {"len": len, "str": str, "int": int, "float": float, "abs": abs, "min": min, "max": max,
                 "round": round, "True": True, "False": False, "None": None}
GLOBAL_NAMES = {"pd", "np", *SAFE_BUILTINS}


def ev(expr: str, df: pd.DataFrame):
    env = {c: df[c] for c in df.columns if isinstance(c, str) and c.isidentifier()}
    return eval(expr, {"pd": pd, "np": np, "__builtins__": SAFE_BUILTINS}, env)  # noqa: S307


def names(expr: str) -> set[str]:
    """Bare names an expression reads (used for static column checks)."""
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as e:
        raise ValueError(f"syntax error in expression {expr!r}: {e.msg}") from e
    return {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} - GLOBAL_NAMES
