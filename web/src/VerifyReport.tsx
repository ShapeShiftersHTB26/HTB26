import { useState } from "react";
import { op } from "./api";

const short = (h?: string) => (h ? `${h.slice(0, 10)}…` : "—");
const mark = (v: boolean | null | undefined) => (v === true ? "✓" : v === false ? "✗" : "–");

function Node({ n, depth }: { n: any; depth: number }) {
  if (n.batch_id)
    return (
      <div className="vr-node" style={{ marginLeft: depth * 16 }}>
        <span className={Object.values(n.checks).includes(false) ? "bad" : "good"}>▤</span> batch <code>{n.batch_id}</code>{" "}
        <span className="muted small">
          {n.rows.toLocaleString()} rows · rows {mark(n.checks.data_root)} · hash {mark(n.checks.hash)} · source file{" "}
          {mark(n.checks.file)} · <code title={n.stored_hash}>{short(n.stored_hash)}</code>
        </span>
      </div>
    );
  return (
    <>
      <div className="vr-node" style={{ marginLeft: depth * 16 }}>
        <span className={n.ok ? "good" : "bad"}>{n.ok ? "✓" : "✗"}</span> <b>{n.view_name}</b>{" "}
        <span className="muted small">
          [{n.kind}] {n.rows.toLocaleString()} rows · rows {mark(n.checks.data_root)} · formula {mark(n.checks.formula)} ·
          hash {mark(n.checks.hash)}
          {"recomputed" in n.checks && <> · re-run {mark(n.checks.recomputed)}</>} ·{" "}
          <code title={n.stored_hash}>{short(n.stored_hash)}</code>
        </span>
        {n.note && <div className="muted small" style={{ marginLeft: 20 }}>{n.note}</div>}
      </div>
      {n.inputs.map((c: any) => (
        <Node key={c.instance_id || c.batch_id} n={c} depth={depth + 1} />
      ))}
    </>
  );
}

// Hash of an instance + a Verify button that recomputes the whole hash tree down to the source files.
export default function VerifyReport(props: { instanceId: string; hash?: string; label?: string }) {
  const [report, setReport] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = () => {
    setBusy(true);
    setErr(null);
    op("verify", { instance_id: props.instanceId })
      .then(setReport)
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="verify">
      <div className="verify-bar">
        <span className="label">{props.label || "hash"}</span>
        <code className="hash" title={props.hash}>{props.hash ? props.hash.slice(0, 16) + "…" : "not hashed"}</code>
        <button disabled={busy} onClick={run}>{busy ? "verifying…" : "Verify"}</button>
        {report && <span className={report.ok ? "good" : "bad"}>{report.ok ? "verified ✓" : "MISMATCH ✗"}</span>}
        {err && <span className="error small">{err}</span>}
      </div>
      {report && (
        <div className="vr-tree">
          <Node n={report} depth={0} />
        </div>
      )}
    </div>
  );
}
