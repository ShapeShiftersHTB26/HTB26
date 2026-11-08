import { lazy, Suspense, useEffect, useState } from "react";
import MainApp from "./MainApp";
import Research from "./research/Research";

// Solana libraries are heavy: load the Predictions tab on first visit only.
const Predictions = lazy(() => import("./predictions/Predictions"));
// The ADHD tab (a side quest): loaded on first visit too.
const Adhd = lazy(() => import("./adhd/Adhd"));

type Tab = "research" | "graph" | "predictions" | "adhd";

/** Tabs live in the URL hash: "#/" = Research (landing), "#/t/<intent>" = a research thread, "#/graph" = the
 * canvas, "#/predictions" and "#/predictions/market/<id>" = Predictions, "#/adhd" = the ADHD zone. */
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
  const tab: Tab = hash.startsWith("#/predictions")
    ? "predictions"
    : hash.startsWith("#/graph")
      ? "graph"
      : hash.startsWith("#/adhd")
        ? "adhd"
        : "research";
  const threadId = hash.match(/^#\/t\/([\w-]+)/)?.[1] ?? null;
  const marketMatch = hash.match(/^#\/predictions\/market\/(\d+)/);
  const marketId = marketMatch ? Number(marketMatch[1]) : null;

  const nav = (
    <nav className="nav-tabs">
      <a href="#/" className={tab === "research" ? "active" : ""}>Research</a>
      <a href="#/graph" className={tab === "graph" ? "active" : ""}>Graph</a>
      <a href="#/predictions" className={tab === "predictions" ? "active" : ""}>Predictions</a>
      {/* ADHD tab hidden from the nav; the page still opens at #/adhd (the link shows only while you're on it) */}
      {tab === "adhd" && <a href="#/adhd" className="adhd-tab active">ADHD</a>}
    </nav>
  );

  return (
    <>
      <Research nav={nav} hidden={tab !== "research"} threadId={threadId} />
      <MainApp nav={nav} hidden={tab !== "graph"} />
      {tab === "predictions" && (
        <Suspense fallback={<div className="pad muted">Loading predictions…</div>}>
          <Predictions nav={nav} marketId={marketId} />
        </Suspense>
      )}
      {tab === "adhd" && (
        <Suspense fallback={<div className="pad muted">Loading dopamine…</div>}>
          <Adhd nav={nav} />
        </Suspense>
      )}
    </>
  );
}
