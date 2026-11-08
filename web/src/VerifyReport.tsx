import { useState } from "react";
import { op } from "./api";
import Icon from "./Icon";

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

/** One line per table in the verified chain, details on hover (for the compact card footer). */
function Line({ n, depth }: { n: any; depth: number }) {
  const ok = n.batch_id ? !Object.values(n.checks).includes(false) : n.ok;
  const checks = Object.entries(n.checks || {}).map(([k, v]) => `${k} ${mark(v as boolean)}`).join(" · ");
  return (
    <>
      <div className="vr-line" style={{ paddingLeft: depth * 14 }} title={`${checks}\n${n.stored_hash || ""}`}>
        <span className={ok ? "good" : "bad"}>{ok ? "✓" : "✗"}</span>
        <span className="vr-name">{n.batch_id ? `source file ${n.batch_id}` : n.view_name}</span>
        <span className="muted">{(n.rows ?? 0).toLocaleString()} rows</span>
      </div>
      {(n.inputs || []).map((c: any) => (
        <Line key={c.instance_id || c.batch_id} n={c} depth={depth + 1} />
      ))}
    </>
  );
}

// Hash of an instance + a Verify button that recomputes the whole hash tree down to the source files.
export default function VerifyReport(props: { instanceId: string; hash?: string; label?: string; compact?: boolean }) {
  const [report, setReport] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const run = () => {
    setBusy(true);
    setErr(null);
    op("verify", { instance_id: props.instanceId })
      .then((r) => (setReport(r), setOpen(true)))
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  if (props.compact)
    return (
      <div className="vr-compact">
        <div className="vr-row">
          <span className="vr-chip" title={`Fingerprint of this result: ${props.hash || "not hashed"}`}>
            <Icon name="shield" size={13} />
            <code>{props.hash ? props.hash.slice(0, 8) : "—"}</code>
          </span>
          {report ? (
            <button className={`vr-status ${report.ok ? "good" : "bad"}`} onClick={() => setOpen(!open)}
                    title={open ? "Hide the checks" : "Show the checks"}>
              {report.ok ? "Verified" : "Mismatch"}
            </button>
          ) : (
            <button className="linkish" disabled={busy || !props.hash} onClick={run}
                    title="Recompute the hashes down to the source files">
              {busy ? "Verifying…" : "Verify"}
            </button>
          )}
        </div>
        {err && <div className="error small">{err}</div>}
        {report && open && (
          <div className="vr-lines">
            <Line n={report} depth={0} />
          </div>
        )}
      </div>
    );
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
