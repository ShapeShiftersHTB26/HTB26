// Two ways to look at the same markets:
//  - insights: minimal and read-only, for people who want the odds and what they mean (the default);
//  - trading:  order books, trade panel, positions — for traders.
// The choice is a per-browser preference, so it lives in localStorage.
import { createContext, ReactNode, useCallback, useContext, useState } from "react";

export type Mode = "insights" | "trading";
const KEY = "pm-mode";

interface ModeCtx {
  mode: Mode;
  setMode: (m: Mode) => void;
}
const Ctx = createContext<ModeCtx>({ mode: "insights", setMode: () => {} });

function load(): Mode {
  try {
    return localStorage.getItem(KEY) === "trading" ? "trading" : "insights";
  } catch {
    return "insights";
  }
}

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, set] = useState<Mode>(load);
  const setMode = useCallback((m: Mode) => {
    set(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
  }, []);
  return <Ctx.Provider value={{ mode, setMode }}>{children}</Ctx.Provider>;
}

export const useMode = () => useContext(Ctx);

const LABELS: Record<Mode, [string, string]> = {
  insights: ["Insights", "Odds and what they mean, no trading"],
  trading: ["Trading", "Order books, trading and positions"],
};

export function ModeSwitch() {
  const { mode, setMode } = useMode();
  return (
    <div className="pm-mode" role="radiogroup" aria-label="View">
      {(Object.keys(LABELS) as Mode[]).map((m) => (
        <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} title={LABELS[m][1]} onClick={() => setMode(m)}>
          {LABELS[m][0]}
        </button>
      ))}
    </div>
  );
}
