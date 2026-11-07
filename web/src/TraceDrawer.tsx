import { useEffect, useState } from "react";
import { op } from "./api";
import RowsTable from "./RowsTable";
import TransformBody from "./TransformBody";

type Level = {
  instance_id: string;
  view_id: string;
  view_name: string;
  view_kind: string;
  transform: any;
  count: number;
  sample: Record<string, any>[];
};

export default function TraceDrawer(props: {
  rid: string;
  names: Map<string, string>;
  onClose: () => void;
  onSelect: (rid: string) => void;
  onOpenView: (viewId: string) => void;
}) {
  const [levels, setLevels] = useState<Level[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLevels(null);
    setError(null);
    op<{ levels: Level[] }>("trace", { rid: props.rid })
      .then((r) => setLevels(r.levels))
      .catch((e) => setError(e.message));
  }, [props.rid]);

  return (
    <div className="trace">
      <div className="trace-head">
        <h3>Trace</h3>
        <code className="small">{props.rid}</code>
        <button className="close" onClick={props.onClose}>×</button>
      </div>
      {error && <div className="error pad">{error}</div>}
      {!levels && !error && <div className="muted pad">tracing…</div>}
      <div className="trace-levels">
        {levels?.map((L, i) => (
          <div key={L.instance_id} className={`trace-level ${L.view_kind}`}>
            {i > 0 && <div className="trace-arrow">↑ derived from</div>}
            <div className="trace-title">
              <a onClick={() => props.onOpenView(L.view_id)}>{L.view_name}</a>
              <span className="muted"> · {L.count.toLocaleString()} record{L.count === 1 ? "" : "s"}</span>
              {L.view_kind === "source" && <span className="vb">raw data</span>}
            </div>
            {L.transform?.kind && L.transform.kind !== "source" && (
              <details>
                <summary className="small muted">how it was computed</summary>
                <TransformBody p={L.transform} names={props.names} />
              </details>
            )}
            <RowsTable cols={[]} rows={L.sample} max={i === 0 ? 1 : 8} onSelect={i > 0 ? props.onSelect : undefined} />
            {L.count > L.sample.length && <div className="muted small">showing {L.sample.length} of {L.count}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
