import { Proposal } from "./api";

function describe(o: any): string {
  switch (o.op) {
    case "filter":
      return `keep rows where ${o.where}`;
    case "derive":
      return `${o.column} = ${o.expr}`;
    case "aggregate": {
      const m = Object.entries(o.metrics || {})
        .map(([out, [col, fn]]: [string, any]) => `${out} = ${fn}(${col})`)
        .join(", ");
      return `group by ${(o.by || []).join(", ") || "(all)"} → ${m}`;
    }
    case "sort":
      return `sort by ${(o.by || []).join(", ")}${o.desc ? " (descending)" : ""}`;
    case "limit":
      return `keep the first ${o.n}`;
    default:
      return JSON.stringify(o);
  }
}

export default function TransformBody(props: { p: Proposal; names: Map<string, string> }) {
  const { p } = props;
  const spec = p.spec || {};
  const reads = (p.reads || []).map((id: string) => props.names.get(id) || id);
  return (
    <div className="transform">
      <div>
        <span className={`kind ${p.kind}`}>{p.kind}</span>
        {reads.length > 0 && (
          <span className="muted"> reads {reads.map((r: string) => <code key={r}>{r} </code>)}</span>
        )}
      </div>
      {p.kind === "ops" && (
        <ol className="ops">
          {(spec.ops || []).map((o: any, i: number) => (
            <li key={i}>
              <span className="op">{o.op}</span> <code>{describe(o)}</code>
            </li>
          ))}
        </ol>
      )}
      {p.kind === "source" && (
        <div className="small">
          read <code>{spec.path}</code>
          {spec.filter && (
            <>
              {" "}· filter <code>{spec.filter}</code>
            </>
          )}
        </div>
      )}
      {(p.kind === "agent_map" || p.kind === "agent_reduce") && (
        <div className="prompt">
          <span className="label">{p.kind === "agent_map" ? "per row" : "whole table"} prompt</span>
          {spec.prompt}
        </div>
      )}
      {!!p.warnings?.length && (
        <ul className="warnings">
          {p.warnings.map((w: string, i: number) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
