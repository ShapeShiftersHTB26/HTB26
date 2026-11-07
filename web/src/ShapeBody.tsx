import { columns, Proposal } from "./api";
import RowsTable from "./RowsTable";

export default function ShapeBody({ p }: { p: Proposal }) {
  const cols = columns(p.schema);
  return (
    <div className="shape">
      <div className="grain">
        <span className="label">grain</span> {p.grain}
      </div>
      {!!p.scope?.length && (
        <div className="chips">
          <span className="label">scope</span>
          {p.scope.map((s: string) => (
            <span key={s} className="chip">{s}</span>
          ))}
        </div>
      )}
      <table className="cols">
        <tbody>
          {cols.map((c) => (
            <tr key={c.name}>
              <td><code>{c.name}</code></td>
              <td className="muted">{c.type}</td>
              <td>{c.role && <span className={`role ${c.role}`}>{c.role}</span>}</td>
              <td className="muted">{c.unit}</td>
              <td className="muted small">{c.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!!p.preview?.length && (
        <>
          <div className="label">preview</div>
          <RowsTable cols={cols} rows={p.preview} max={8} />
        </>
      )}
    </div>
  );
}
