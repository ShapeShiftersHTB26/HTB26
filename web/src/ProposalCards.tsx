import { ReactNode, useState } from "react";
import { Comment, op, Proposal } from "./api";

// Revision tree rendered as generations: each row holds siblings (same parent depth), root at top.
function generations(ps: Proposal[]): Proposal[][] {
  const byId = new Map(ps.map((p) => [p.id, p]));
  const depth = (p: Proposal): number => (p.parent_id && byId.has(p.parent_id) ? depth(byId.get(p.parent_id)!) + 1 : 0);
  const rows: Proposal[][] = [];
  ps.forEach((p) => {
    const d = depth(p);
    (rows[d] ||= []).push(p);
  });
  return rows.map((r) => r.sort((a, b) => a.created_at.localeCompare(b.created_at)));
}

export default function ProposalCards(props: {
  proposals: Proposal[];
  headIds: string[];
  comments: Record<string, Comment[]>;
  renderBody: (p: Proposal) => ReactNode;
  onChange: () => void;
  empty: string;
}) {
  if (!props.proposals.length) return <div className="muted pad">{props.empty}</div>;
  return (
    <div className="generations">
      {generations(props.proposals).map((row, i) => (
        <div className="generation" key={i}>
          {row.map((p) => (
            <Card key={p.id} p={p} isHead={props.headIds.includes(p.id)} comments={props.comments[p.id] || []}
                  body={props.renderBody(p)} onChange={props.onChange} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Card(props: { p: Proposal; isHead: boolean; comments: Comment[]; body: ReactNode; onChange: () => void }) {
  const { p } = props;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      props.onChange();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`card ${p.status} ${props.isHead ? "head" : ""} by-${p.author}`}>
      <div className="card-top">
        <span className={`badge ${p.status}`}>{props.isHead ? "current" : p.status}</span>
        <span className="muted small">
          {p.author}
          {p.counter ? ` · #${p.counter}` : ""}
          {p.decided_by === "auto" ? " · auto" : ""}
        </span>
      </div>
      {p.rationale && <div className="rationale">{p.rationale}</div>}
      <div className="card-body">{props.body}</div>
      {props.comments.map((c) => (
        <div key={c.id} className="comment">
          <b>{c.author}:</b> {c.text}
        </div>
      ))}
      <div className="card-actions">
        {p.status === "pending" && (
          <>
            <button disabled={busy} className="approve" onClick={() => act(() => op("decide", { target_id: p.id, decision: "approve" }))}>
              Approve
            </button>
            <button disabled={busy} onClick={() => act(() => op("decide", { target_id: p.id, decision: "discard" }))}>
              Discard
            </button>
          </>
        )}
        {p.status === "approved" && !props.isHead && <span className="muted small">superseded</span>}
        <form
          className="comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) act(() => op("comment", { target_id: p.id, text: text.trim() }).then(() => setText("")));
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="comment / request a change…" />
        </form>
      </div>
      {err && <div className="error small">{err}</div>}
    </div>
  );
}
