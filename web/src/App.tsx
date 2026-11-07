import { lazy, Suspense, useEffect, useState } from "react";
import MainApp from "./MainApp";

// Solana libraries are heavy: load the Predictions tab on first visit only.
const Predictions = lazy(() => import("./predictions/Predictions"));

type Tab = "main" | "predictions";

/** Tabs live in the URL hash: "#/" = Main, "#/predictions" and "#/predictions/market/<id>" = Predictions. */
function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHash();
  const tab: Tab = hash.startsWith("#/predictions") ? "predictions" : "main";
  const marketMatch = hash.match(/^#\/predictions\/market\/(\d+)/);
  const marketId = marketMatch ? Number(marketMatch[1]) : null;

  const nav = (
    <nav className="nav-tabs">
      <a href="#/" className={tab === "main" ? "active" : ""}>Main</a>
      <a href="#/predictions" className={tab === "predictions" ? "active" : ""}>Predictions</a>
    </nav>
  );

  return (
    <>
      <MainApp nav={nav} hidden={tab !== "main"} />
      {tab === "predictions" && (
        <Suspense fallback={<div className="pad muted">Loading predictions…</div>}>
          <Predictions nav={nav} marketId={marketId} />
        </Suspense>
      )}
    </>
  );
}
