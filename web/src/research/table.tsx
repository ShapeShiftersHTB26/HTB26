// Shared bits for showing tables on the research canvas and in the notebook: readable names, cell formatting and
// one quiet data grid (numbers right-aligned, long values truncated with the full value on hover).
import { ReactNode } from "react";
import { Column } from "../api";

export type DiffState = "same" | "added" | "removed" | "changed" | "new";
export type GridCol = Column & { st?: DiffState };

/** "reading_sales_by_month_2025_2026" -> "Reading sales by month 2025–2026". A single short token reads as an acronym. */
export function prettyName(name: string) {
  const s = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return name;
  if (!s.includes(" ") && s.length <= 4) return s.toUpperCase();
  return (s[0].toUpperCase() + s.slice(1)).replace(/\b((?:19|20)\d\d) ((?:19|20)\d\d)\b/g, "$1–$2");
}

export const rowsLabel = (n: number) => `${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`;

/** First letter up, the rest as written (for grain / scope sentences written in lower case). */
export const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const isTime = (c?: Column) => !!c && (c.role === "time" || /^(year|period|month|date|day|week|quarter)/i.test(c.name));

export function fmtCell(v: any, c?: Column): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number" && isTime(c)) return String(v);
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  // monthly buckets come back as the 1st of the month; the day is noise
  if (c && /month/i.test(c.name)) return s.replace(/^(\d{4}-\d{2})-01(?:[T ]00:00(?::00)?)?$/, "$1");
  return s;
}

/** Right-align a column when it holds quantities (not years / periods / ids). */
export function isNumeric(c: Column, rows: Record<string, any>[]) {
  if (isTime(c) || /(^|_)(id|code|postcode)$/i.test(c.name)) return false;
  if (c.type === "number" || c.type === "integer") return true;
  const vals = rows.map((r) => r[c.name]).filter((x) => x !== null && x !== undefined && x !== "");
  return vals.length > 0 && vals.every((x) => typeof x === "number");
}

export function DataGrid(props: {
  cols: GridCol[];
  rows: Record<string, any>[];
  className?: string;
  ghost?: boolean;
  empty?: string;
  onRow?: (r: Record<string, any>) => void;
  rowTitle?: string;
  rowClass?: (r: Record<string, any>, i: number) => string;
  cell?: (r: Record<string, any>, c: GridCol) => ReactNode | undefined;
  tail?: ReactNode;
}) {
  const { cols, rows } = props;
  const num = new Map(cols.map((c) => [c.name, isNumeric(c, rows)]));
  const cls = (c: GridCol) => `${num.get(c.name) ? "num" : ""} ${c.st && c.st !== "same" && c.st !== "new" ? c.st : ""}`;
  return (
    <div className={`grid nodrag nowheel ${props.ghost ? "ghost" : ""} ${props.className ?? ""}`}>
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.name} className={cls(c)} title={[c.description, c.unit && `unit: ${c.unit}`].filter(Boolean).join(" · ") || c.name}>
                {c.st === "added" && "+ "}
                {c.name}
                {c.unit && <span className="unit">{c.unit}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const click = props.onRow && r._rid;
            return (
              <tr key={r._rid ?? i} className={`${click ? "clickable" : ""} ${props.rowClass?.(r, i) ?? ""}`}
                  title={click ? props.rowTitle : undefined} onClick={click ? () => props.onRow!(r) : undefined}>
                {cols.map((c) => {
                  const custom = props.cell?.(r, c);
                  const text = fmtCell(r[c.name], c);
                  return (
                    <td key={c.name} className={cls(c)} title={text.length > 18 ? text : undefined}>
                      {custom !== undefined ? custom : text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {!rows.length && props.empty && (
            <tr>
              <td className="grid-empty" colSpan={cols.length}>{props.empty}</td>
            </tr>
          )}
          {props.tail}
        </tbody>
      </table>
    </div>
  );
}
