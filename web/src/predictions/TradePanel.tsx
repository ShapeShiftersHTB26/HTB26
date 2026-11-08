import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useMemo, useState } from "react";
import type { MarketInfo } from "./api";
import { useAppConfig } from "./context";
import { Balances, Books, useFaucet, useTx } from "./hooks";
import { BASE_LOTS_PER_TOKEN, bookAddrs, ensureAtasIxs, estimateFill, newTx, placeTakeOrderIx } from "./solana";
import { Modal, Spinner } from "./ui";
import { cents, fmt, Outcome, outcomeLabel, sharesForBudget, usd } from "./util";
import { useSigner } from "./wallet";

type Side = "buy" | "sell";
/** Ask before an order whose average price is this many cents worse than the best price. */
const SLIPPAGE_WARN_CENTS = 5;
const lots = (n: number) => Math.floor(n * 100) / 100; // 0.01-share lots

export default function TradePanel({
  market,
  books,
  bal,
  initialOutcome,
  onDone,
}: {
  market: MarketInfo;
  books: Books;
  bal: Balances;
  initialOutcome: Outcome;
  onDone: () => void;
}) {
  const { addrs } = useAppConfig();
  const { publicKey, useBurner } = useSigner();
  const { setVisible } = useWalletModal();
  const faucet = useFaucet();
  const tx = useTx();
  const [side, setSide] = useState<Side>("buy");
  const [outcome, setOutcome] = useState<Outcome>(initialOutcome);
  const [amount, setAmount] = useState(""); // buy: dollars, sell: shares
  const [confirming, setConfirming] = useState(false); // the high-slippage warning is open

  const book = outcome === "yes" ? books.yes : books.no;
  const levels = side === "buy" ? book?.asks : book?.bids;
  const best = levels?.[0]?.price;
  // No price limit: the order takes whatever the book offers (buys still never spend more than the amount).
  const limitCents = best === undefined ? null : side === "buy" ? 99 : 1;
  const n = Number(amount) || 0;
  const held = outcome === "yes" ? bal.yes : bal.no;
  const priceOf = (o: Outcome) => (side === "buy" ? (o === "yes" ? books.yes : books.no)?.asks[0]?.price : (o === "yes" ? books.yes : books.no)?.bids[0]?.price);

  const est = useMemo(() => {
    if (!levels || limitCents === null || n <= 0) return null;
    const shares = side === "buy" ? lots(sharesForBudget(levels, n, limitCents / 100)) : lots(n);
    return estimateFill(levels, shares, limitCents / 100, side);
  }, [levels, limitCents, n, side]);

  const shortBy = !est ? 0 : side === "buy" ? n - est.total : n - est.filled; // more than the book can take
  // how much worse than the best price the average fill is
  const slipCents = est && est.filled > 0 && best !== undefined ? Math.round(Math.abs(est.avgPrice - best) * 100) : 0;
  const hint: { text: string; fix?: { label: string; run: () => void } } | null = !publicKey
    ? null
    : bal.usdc <= 0 && bal.sol <= 0
      ? { text: "Your wallet is empty.", fix: { label: "Get demo funds", run: faucet.claim } }
      : limitCents === null
      ? { text: "No liquidity on this side right now." }
      : side === "buy" && n > bal.usdc + 1e-9
        ? { text: `You have ${usd(bal.usdc)} mUSDC.`, fix: { label: "Get funds", run: faucet.claim } }
        : side === "sell" && n > held + 1e-9
          ? { text: `You have ${fmt(held)} ${outcomeLabel(outcome)} shares.`, fix: held > 0 ? { label: "Sell all", run: () => setAmount(String(lots(held))) } : undefined }
          : bal.sol < 0.0005
            ? { text: "You need a little SOL for fees.", fix: { label: "Get funds", run: faucet.claim } }
            : est && est.filled > 0 && shortBy > 0.05
              ? {
                  text:
                    side === "buy"
                      ? `The book only has ${usd(est.total)} for sale right now.`
                      : `Only ${fmt(est.filled)} shares can be sold right now.`,
                  fix: { label: "Use that", run: () => setAmount(String(side === "buy" ? Math.floor(est.total * 100) / 100 : lots(est.filled))) },
                }
              : null;
  const canSubmit = !!publicKey && !hint && !!est && est.filled >= 0.01 && !tx.busy;

  /** Big orders get a warning first; "Buy anyway" sends it. */
  const trySubmit = () => {
    if (!canSubmit) return;
    if (slipCents > SLIPPAGE_WARN_CENTS) setConfirming(true);
    else submit();
  };

  const submit = async () => {
    setConfirming(false);
    if (!publicKey || !canSubmit || !est || limitCents === null) return;
    const row = outcome === "yes" ? market.yes_book! : market.no_book!;
    const mint = outcome === "yes" ? market.yes_mint! : market.no_mint!;
    const baseLots = Math.round(est.filled * BASE_LOTS_PER_TOKEN);
    const ok = await tx.run(
      newTx([...ensureAtasIxs(addrs, market, publicKey), placeTakeOrderIx(addrs, bookAddrs(row, mint), publicKey, side, limitCents, baseLots, side === "buy" ? n : undefined)]),
      `${side === "buy" ? "Bought" : "Sold"} ${fmt(est.filled)} ${outcomeLabel(outcome)}`,
      `${side === "buy" ? "Paid" : "Received"} ~${usd(est.total)} at ~${cents(est.avgPrice)} avg`,
    );
    if (ok) {
      setAmount("");
      onDone();
    }
  };

  const add = (v: number) => setAmount((a) => String(Math.round(((Number(a) || 0) + v) * 100) / 100));

  return (
    <div className="pm-card pm-trade">
      <div className="pm-trade-head">
        <div className="pm-tabs pm-tabs-sm">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} className={side === s ? "on" : ""} onClick={() => (setSide(s), setAmount(""))}>
              {s === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
      </div>

      <div className="pm-outcomes">
        {(["yes", "no"] as const).map((o) => {
          const p = priceOf(o);
          return (
            <button key={o} className={`pm-outcome-btn ${o}${outcome === o ? " on" : ""}`} onClick={() => setOutcome(o)}>
              {outcomeLabel(o)} <span>{p !== undefined ? cents(p) : "—"}</span>
            </button>
          );
        })}
      </div>

      <label className="pm-amount">
        <span className="pm-amount-label">{side === "buy" ? "Amount" : "Shares"}</span>
        <span className="pm-amount-input">
          {side === "buy" && <span className="pm-amount-unit">$</span>}
          <input
            inputMode="decimal"
            placeholder="0"
            aria-label={side === "buy" ? "Amount in mUSDC" : "Number of shares"}
            style={{ width: `${Math.max(1, amount.length) + 0.3}ch` }} // grow with the digits so "$" stays next to them
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"))}
            onKeyDown={(e) => e.key === "Enter" && trySubmit()}
          />
        </span>
      </label>
      <div className="pm-chips pm-chips-sm pm-quick">
        {side === "buy" ? (
          <>
            {[1, 5, 10, 50].map((v) => (
              <button key={v} onClick={() => add(v)}>+${v}</button>
            ))}
            <button onClick={() => setAmount(String(Math.floor(bal.usdc * 100) / 100))} disabled={!publicKey}>Max</button>
          </>
        ) : (
          <>
            {[0.25, 0.5].map((f) => (
              <button key={f} onClick={() => setAmount(String(lots(held * f)))} disabled={held <= 0}>{f * 100}%</button>
            ))}
            <button onClick={() => setAmount(String(lots(held)))} disabled={held <= 0}>Max</button>
          </>
        )}
      </div>

      <div className={`pm-summary${est && est.filled > 0 ? " show" : ""}`}>
        <div><span>Avg price</span><b>{est && est.filled > 0 ? cents(est.avgPrice) : "—"}</b></div>
        <div className={slipCents > SLIPPAGE_WARN_CENTS ? "pm-slip-high" : ""}>
          <span>Slippage</span>
          <b>{est && est.filled > 0 ? `${slipCents}¢` : "—"}</b>
        </div>
        {side === "buy" ? (
          <>
            <div><span>Shares</span><b>{est ? fmt(est.filled) : "—"}</b></div>
            <div className="pm-win">
              <span>Payout if {outcomeLabel(outcome)}</span>
              <b>
                {est && est.filled > 0 ? usd(est.filled) : "—"}
                {est && est.total > 0 && <em> +{((est.filled / est.total - 1) * 100).toFixed(0)}%</em>}
              </b>
            </div>
          </>
        ) : (
          <div className="pm-win"><span>You'll receive</span><b>{est && est.filled > 0 ? usd(est.total) : "—"}</b></div>
        )}
      </div>

      {hint && (
        <div className="pm-hint">
          {hint.text}
          {hint.fix && (
            <button className="pm-link" onClick={hint.fix.run} disabled={faucet.busy}>
              {faucet.busy ? "…" : hint.fix.label}
            </button>
          )}
        </div>
      )}

      {publicKey ? (
        <button className={`pm-btn pm-btn-block pm-btn-lg pm-trade-btn ${outcome}`} disabled={!canSubmit} onClick={trySubmit}>
          {tx.busy ? (
            <>
              <Spinner /> Confirming…
            </>
          ) : (
            `${side === "buy" ? "Buy" : "Sell"} ${outcomeLabel(outcome)}`
          )}
        </button>
      ) : (
        <>
          <button className="pm-btn pm-btn-primary pm-btn-block pm-btn-lg" onClick={() => useBurner(true)}>
            Try it with a demo wallet
          </button>
          <button className="pm-link pm-center pm-small" onClick={() => setVisible(true)}>
            or connect your own wallet
          </button>
        </>
      )}
      <p className="pm-fine">
        Fills instantly at the best prices in the order book. Big orders move the price: you'll be asked to confirm above{" "}
        {SLIPPAGE_WARN_CENTS}¢ of slippage.
      </p>

      {confirming && est && best !== undefined && (
        <Modal title="High slippage" onClose={() => setConfirming(false)}>
          <div className="pm-slip">
            <p>
              This order moves the price by about <b>{slipCents}¢</b>. The best price is {cents(best)}, but you'd{" "}
              {side === "buy" ? "pay" : "get"} <b>{cents(est.avgPrice)}</b> per share on average, and the last shares go at{" "}
              {cents(est.worst)}.
            </p>
            <div className="pm-slip-sum">
              <span>{side === "buy" ? `${fmt(est.filled)} ${outcomeLabel(outcome)} shares` : `${fmt(est.filled)} shares sold`}</span>
              <b>{side === "buy" ? `for ${usd(est.total)}` : `for ${usd(est.total)}`}</b>
            </div>
            <p className="pm-muted pm-small">A smaller order fills closer to the best price.</p>
            <div className="pm-slip-actions">
              <button className="pm-btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className={`pm-btn pm-trade-btn ${outcome}`} onClick={submit} autoFocus>
                {side === "buy" ? "Buy" : "Sell"} anyway
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
