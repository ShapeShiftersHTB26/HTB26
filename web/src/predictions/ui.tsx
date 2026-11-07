// Small UI primitives for the Predictions tab: animated numbers, probability gauge, modal, toasts, menu, skeletons.
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

/** Ease a number towards `target`, so probabilities and prices glide instead of jumping on every poll. */
export function useTween(target: number | null, ms = 500): number | null {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    if (target === null || current.current === null) {
      current.current = target;
      setValue(target);
      return;
    }
    const from = current.current;
    if (Math.abs(from - target) < 1e-6) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      current.current = from + (target - from) * (1 - Math.pow(1 - k, 3));
      setValue(current.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** Half-circle gauge with the YES probability in the middle. */
export function Gauge({ p }: { p: number | null }) {
  const v = useTween(p);
  const len = Math.PI * 22;
  const tone = v === null ? "" : v >= 0.5 ? "yes" : "no";
  return (
    <div className={`pm-gauge ${tone}`} aria-label={v === null ? "no price yet" : `${Math.round(v * 100)}% chance`}>
      <svg viewBox="0 0 56 31" aria-hidden>
        <path d="M6 28 A22 22 0 0 1 50 28" className="pm-gauge-track" />
        <path d="M6 28 A22 22 0 0 1 50 28" className="pm-gauge-fill" style={{ strokeDasharray: `${len * (v ?? 0)} ${len}` }} />
      </svg>
      <div className="pm-gauge-num">{v === null ? "—" : `${Math.round(v * 100)}%`}</div>
      <div className="pm-gauge-label">chance</div>
    </div>
  );
}

export function Skeleton({ h = 16, w = "100%", r = 8 }: { h?: number; w?: number | string; r?: number }) {
  return <div className="pm-skel" style={{ height: h, width: w, borderRadius: r }} />;
}

export function Spinner() {
  return <span className="pm-spin" aria-hidden />;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="pm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="pm-modal-head">
          <h3>{title}</h3>
          <button className="pm-icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Click-to-open menu that closes on outside click or Escape. */
export function Menu({ button, children }: { button: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="pm-menu-wrap" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{button(open)}</div>
      {open && <div className="pm-menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

// ---------------- toasts ----------------

type ToastKind = "ok" | "err" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  href?: string;
}
type Push = (t: Omit<Toast, "id">) => void;
const ToastCtx = createContext<Push>(() => {});
export const useToast = () => useContext(ToastCtx);

let nextToast = 1;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id));
  const push = useCallback<Push>((t) => {
    const id = nextToast++;
    setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
    setTimeout(() => dismiss(id), t.kind === "err" ? 8000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pm-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`pm-toast ${t.kind}`} onClick={() => dismiss(t.id)}>
            <span className="pm-toast-dot" />
            <div>
              <div className="pm-toast-title">{t.title}</div>
              {t.detail && <div className="pm-toast-detail">{t.detail}</div>}
              {t.href && (
                <a href={t.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  View transaction ↗
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
