import type { MarketInfo } from "./api";
import { useAppConfig } from "./context";
import { useToast } from "./ui";
import { dateLabel, explorer, short } from "./util";

/** How a market resolves, plus the on-chain details anyone can check. Shared by both views. */
export default function Rules({ m }: { m: MarketInfo }) {
  const { cfg } = useAppConfig();
  const toast = useToast();
  const row = (label: string, value: string, href?: string) => (
    <div className="pm-kv">
      <span>{label}</span>
      <span>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">{short(value, 6)} ↗</a>
        ) : (
          <button className="pm-copy" onClick={() => (navigator.clipboard?.writeText(value), toast({ kind: "info", title: `${label} copied` }))}>
            {value.length > 20 ? short(value, 8) : value}
          </button>
        )}
      </span>
    </div>
  );
  return (
    <div className="pm-rules">
      <p>{m.description || "No extra resolution rules were given for this market."}</p>
      <p className="pm-muted pm-small">
        {m.resolution?.source === "backtrace"
          ? "After trading closes, Backtrace re-runs the calculation pinned when the market opened, on the data published by then, checks its fingerprint and posts Yes, No or Void with the evidence. Nobody decides it by hand."
          : "After trading closes, the operator resolves the market Yes, No or Void."}{" "}
        Winning shares redeem for $1 each; if it's voided, every share redeems for 50¢.
      </p>
      <div className="pm-kvs">
        {row("Closes", dateLabel(m.resolution_time))}
        {row("Created", dateLabel(m.created_at))}
        {m.query_hash && row("Query hash", m.query_hash)}
        {m.resolution?.source === "backtrace" && row("Formula hash", m.resolution.formula_hash)}
        {m.market_pda && row("Market account", m.market_pda, explorer("address", m.market_pda, cfg.rpc_url))}
        {m.yes_mint && row("Yes token", m.yes_mint, explorer("address", m.yes_mint, cfg.rpc_url))}
        {m.no_mint && row("No token", m.no_mint, explorer("address", m.no_mint, cfg.rpc_url))}
      </div>
    </div>
  );
}
