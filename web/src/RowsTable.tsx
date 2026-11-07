import { Column } from "./api";

export default function RowsTable(props: {
  cols: Column[];
  rows: Record<string, any>[];
  onSelect?: (rid: string) => void;
  max?: number;
}) {
  const rows = props.rows.slice(0, props.max ?? 200);
  if (!rows.length) return <div className="muted small">no rows</div>;
  const names = props.cols.length ? props.cols.map((c) => c.name) : Object.keys(rows[0]).filter((k) => !k.startsWith("_"));
  const units = new Map(props.cols.map((c) => [c.name, c.unit]));
  return (
    <div className="rows">
      <table>
        <thead>
          <tr>
            {names.map((n) => (
              <th key={n}>
                {n}
                {units.get(n) && <span className="unit"> {units.get(n)}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r._rid ?? i}
              className={r._rid && props.onSelect ? "clickable" : ""}
              onClick={() => r._rid && props.onSelect?.(r._rid)}
            >
              {names.map((n) => (
                <td key={n}>{fmt(r[n])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmt(v: any) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
