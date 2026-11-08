// The ADHD tab's economy: coins, XP/levels, combo multiplier, the decaying dopamine meter, boosts, achievements,
// floating "+N" text, toasts and a tiny event bus. Saved per browser (localStorage), nothing leaves the page.
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { confetti, mountConfetti, setMuted, sfx } from "./fx";

export type Pt = { x: number; y: number };
export type Chaos = "shake" | "flip" | "invert" | "disco" | "rain" | "zoo" | "confetti" | "tiny" | "comic";

// ---------------------------------------------------------------- bus (widgets <-> events <-> shell)

const bus = new EventTarget();
export function emit<T>(type: string, detail?: T) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}
export function useBus<T>(type: string, fn: (d: T) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = (e: Event) => ref.current((e as CustomEvent<T>).detail);
    bus.addEventListener(type, h);
    return () => bus.removeEventListener(type, h);
  }, [type]);
}

export const ptOf = (e: { clientX: number; clientY: number }): Pt => ({ x: e.clientX, y: e.clientY });
export const fmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : Math.floor(n).toLocaleString();
export const pick = <T,>(xs: readonly T[]): T => xs[(Math.random() * xs.length) | 0];
export const rand = (a: number, b: number) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- definitions

export const ACHIEVEMENTS: Record<string, [string, string]> = {
  first: ["🩸", "First click. It begins."],
  spin: ["🎡", "Spun the wheel"],
  jackpot: ["💰", "HIT THE JACKPOT"],
  broke: ["🪦", "Went completely broke"],
  pop100: ["🫧", "Popped 100 bubbles"],
  legendary: ["👑", "Pulled a LEGENDARY"],
  corner: ["📺", "THE LOGO HIT THE CORNER"],
  boss: ["👾", "Defeated a boss"],
  combo25: ["🔥", "25x combo"],
  level5: ["⭐", "Reached level 5"],
  level10: ["🌟", "Reached level 10"],
  presser: ["🔴", "Pressed the button 10 times (we said don't)"],
  millionaire: ["🤑", "1,000,000 coins"],
  whack30: ["🔨", "Whacked 30 notifications in one round"],
  rpm: ["🌀", "Fidget spinner over 600 RPM"],
  scratch: ["🎟️", "Won on a scratch card"],
  maths: ["🧮", "Did maths under pressure"],
  maxdopa: ["🧪", "MAX DOPAMINE"],
  collector: ["🗃️", "Collected every loot item"],
  slots777: ["🎰", "Three of a kind on the slots"],
  memes20: ["🗿", "Rated 20 memes"],
  tycoon: ["🏭", "Earning 1,000 coins/sec"],
};
const STAT_ACH: Record<string, [number, string]> = { pops: [100, "pop100"], presses: [10, "presser"], rated: [20, "memes20"] };

/** Clicker upgrades (passive coins per second). */
export const UPGRADES = [
  { id: "scroll", e: "📱", name: "Doomscroll bot", base: 50, cps: 1 },
  { id: "notif", e: "🔔", name: "Notification spam", base: 320, cps: 6 },
  { id: "drink", e: "🥤", name: "Energy drink IV", base: 1600, cps: 30 },
  { id: "tabs", e: "🗂️", name: "47 open tabs", base: 9000, cps: 160 },
  { id: "pure", e: "🧪", name: "Pure dopamine farm", base: 60000, cps: 1000 },
] as const;
export const cost = (base: number, owned: number) => Math.round(base * 1.15 ** owned);

export const levelOf = (xp: number) => Math.floor(Math.sqrt(xp / 40)) + 1;
export const xpFor = (lvl: number) => 40 * (lvl - 1) ** 2;
const comboMult = (c: number) => Math.min(3, 1 + Math.floor(c / 10) * 0.5);

const HYPE = {
  win: ["W", "LETS GOOO", "W W W", "ez", "clean", "+rep", "🔥🔥🔥", "BASED", "certified W", "sheesh"],
  big: ["NO WAYYYY", "CLIP IT", "🚨🚨🚨", "HOLY", "LEGEND", "I'M SHAKING", "GG GO NEXT", "WHAT JUST HAPPENED", "💰💰💰"],
  lose: ["L", "unlucky", "💀", "ratio", "it's so over", "rip bozo", "F", "classic", "skill issue", "one more spin bro trust"],
  event: ["CLICK IT CLICK IT", "GO GO GO", "👀👀", "QUICK", "don't miss it!!", "omg"],
};

// ---------------------------------------------------------------- state

export interface Save {
  coins: number;
  xp: number;
  owned: Record<string, number>;
  power: number;
  inv: Record<string, number>;
  ach: string[];
  stats: Record<string, number>;
  freeSpins: number;
}
const KEY = "adhd-save-v1";
const FRESH: Save = { coins: 150, xp: 0, owned: {}, power: 1, inv: {}, ach: [], stats: {}, freeSpins: 0 };
function load(): Save {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    return s ? { ...FRESH, ...s } : FRESH;
  } catch {
    return FRESH;
  }
}
const readFlag = (k: string, dflt: boolean) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? dflt : v === "1";
  } catch {
    return dflt;
  }
};
const writeFlag = (k: string, v: boolean) => {
  try {
    localStorage.setItem(k, v ? "1" : "0");
  } catch {
    /* private mode: lasts this visit */
  }
};

type EarnOpts = { raw?: boolean; passive?: boolean; color?: string; label?: string; big?: boolean };
type Float = { id: number; text: string; x: number; y: number; color: string; big?: boolean };
type Toast = { id: number; e: string; title: string };
type Shout = { id: number; text: string; color: string };

export interface Game {
  save: Save;
  level: number;
  combo: number;
  mult: number;
  dopamine: number;
  cps: number;
  boostLeft: number;
  overdriveLeft: number;
  frenzyLeft: number;
  calm: boolean;
  sound: boolean;
  setCalm: (b: boolean) => void;
  setSound: (b: boolean) => void;
  earn: (n: number, at?: Pt | null, o?: EarnOpts) => number;
  spend: (n: number, at?: Pt | null) => boolean;
  lose: (n: number, at?: Pt | null) => void;
  stat: (k: string, by?: number) => number;
  unlock: (id: string) => void;
  float: (text: string, at?: Pt | null, color?: string, big?: boolean) => void;
  shout: (text: string, color?: string) => void;
  update: (fn: (s: Save) => Save) => void;
  boost: (kind: "boost" | "frenzy", ms: number) => void;
  chaos: (kind: Chaos, at?: Pt) => void;
  hype: (kind: keyof typeof HYPE) => void;
  reset: () => void;
}

const Ctx = createContext<Game | null>(null);
export function useGame(): Game {
  const g = useContext(Ctx);
  if (!g) throw new Error("no game");
  return g;
}

let nextId = 1;

export function GameProvider({ children }: { children: ReactNode }) {
  const [save, setSave] = useState<Save>(load);
  const [combo, setCombo] = useState(0);
  const [dopamine, setDopamine] = useState(35);
  const [now, setNow] = useState(Date.now());
  const [floats, setFloats] = useState<Float[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [shouts, setShouts] = useState<Shout[]>([]);
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [calm, setCalmState] = useState(() => readFlag("adhd-calm", reduced));
  const [sound, setSoundState] = useState(() => readFlag("adhd-sound", true));

  const coins = useRef(save.coins);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => void (coins.current = save.coins), [save.coins]);
  const comboRef = useRef(0);
  const lastHit = useRef(0);
  const dopaRef = useRef(35);
  const until = useRef({ boost: 0, overdrive: 0, frenzy: 0 });
  const calmRef = useRef(calm);
  calmRef.current = calm;

  useEffect(() => setMuted(!sound), [sound]);
  const setCalm = (b: boolean) => (setCalmState(b), writeFlag("adhd-calm", b));
  const setSound = (b: boolean) => (setSoundState(b), writeFlag("adhd-sound", b));

  // persist (throttled)
  useEffect(() => {
    const h = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(save));
      } catch {
        /* storage unavailable */
      }
    }, 600);
    return () => clearTimeout(h);
  }, [save]);

  const float = useCallback((text: string, at?: Pt | null, color = "#ffe600", big?: boolean) => {
    const id = nextId++;
    const p = at ?? { x: window.innerWidth / 2 + rand(-80, 80), y: window.innerHeight / 2 + rand(-40, 40) };
    setFloats((fs) => [...fs.slice(-40), { id, text, x: p.x, y: p.y, color, big }]);
    setTimeout(() => setFloats((fs) => fs.filter((f) => f.id !== id)), 1100);
  }, []);

  const shout = useCallback((text: string, color = "#ff2d95") => {
    const id = nextId++;
    setShouts((s) => [...s.slice(-2), { id, text, color }]);
    setTimeout(() => setShouts((s) => s.filter((x) => x.id !== id)), 1600);
  }, []);

  const unlock = useCallback((id: string) => {
    if (saveRef.current.ach.includes(id) || !ACHIEVEMENTS[id]) return;
    saveRef.current = { ...saveRef.current, ach: [...saveRef.current.ach, id] };
    setSave((s) => (s.ach.includes(id) ? s : { ...s, ach: [...s.ach, id] }));
    const [e, title] = ACHIEVEMENTS[id];
    const tid = nextId++;
    setToasts((t) => [...t.slice(-3), { id: tid, e, title }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== tid)), 4200);
    sfx.levelup();
  }, []);

  const chaos = useCallback((kind: Chaos, at?: Pt) => emit("chaos", { kind, at }), []);
  const hype = useCallback((kind: keyof typeof HYPE) => {
    const n = kind === "big" ? 4 : kind === "event" ? 2 : 1;
    for (let i = 0; i < n; i++) setTimeout(() => emit("chat", { text: pick(HYPE[kind]) }), i * 260);
  }, []);

  const bumpDopamine = useCallback(
    (n: number) => {
      const t = Date.now();
      let d = Math.min(100, dopaRef.current + n);
      if (d >= 100 && t > until.current.overdrive) {
        until.current.overdrive = t + 8000;
        d = 60;
        unlock("maxdopa");
        shout("🧪 MAX DOPAMINE 🧪 x3", "#39ff14");
        confetti(undefined, undefined, calmRef.current ? 30 : 160);
        sfx.big();
        emit("chat", { text: "MAX DOPAMINE LETS GOOOOO" });
      }
      dopaRef.current = d;
      setDopamine(d);
    },
    [shout, unlock],
  );

  const earn = useCallback(
    (n: number, at?: Pt | null, o: EarnOpts = {}) => {
      const t = Date.now();
      let m = 1;
      if (!o.raw) {
        if (!o.passive) {
          const c = t - lastHit.current < 1500 || t < until.current.frenzy ? comboRef.current + 1 : 1;
          comboRef.current = c;
          lastHit.current = t;
          setCombo(c);
          if (c === 25) unlock("combo25");
          m *= comboMult(c);
        }
        if (t < until.current.boost) m *= 2;
        if (t < until.current.overdrive) m *= 3;
      }
      const amt = Math.max(1, Math.round(n * m));
      coins.current += amt;
      setSave((s) => ({ ...s, coins: s.coins + amt, xp: s.xp + amt }));
      if (!o.passive) {
        bumpDopamine(o.raw ? 6 : 3);
        if (at !== null) float(`+${fmt(amt)}${o.label ? ` ${o.label}` : ""}`, at, o.color, o.big);
        if (!saveRef.current.ach.includes("first")) unlock("first");
      }
      if (coins.current >= 1e6) unlock("millionaire");
      return amt;
    },
    [bumpDopamine, float, unlock],
  );

  const spend = useCallback(
    (n: number, at?: Pt | null) => {
      if (coins.current < n) {
        float("NOT ENOUGH COINS 💸", at, "#ff3b3b");
        sfx.bad();
        return false;
      }
      coins.current -= n;
      setSave((s) => ({ ...s, coins: s.coins - n }));
      bumpDopamine(2);
      if (coins.current < 1) unlock("broke");
      return true;
    },
    [bumpDopamine, float, unlock],
  );

  const lose = useCallback(
    (n: number, at?: Pt | null) => {
      const amt = Math.min(coins.current, Math.round(n));
      coins.current -= amt;
      setSave((s) => ({ ...s, coins: Math.max(0, s.coins - amt) }));
      if (at !== null) float(`-${fmt(amt)}`, at, "#ff3b3b");
      if (coins.current < 1) unlock("broke");
    },
    [float, unlock],
  );

  const stat = useCallback(
    (k: string, by = 1) => {
      const v = (saveRef.current.stats[k] ?? 0) + by;
      saveRef.current = { ...saveRef.current, stats: { ...saveRef.current.stats, [k]: v } };
      setSave((s) => ({ ...s, stats: { ...s.stats, [k]: (s.stats[k] ?? 0) + by } }));
      const a = STAT_ACH[k];
      if (a && v >= a[0]) unlock(a[1]);
      return v;
    },
    [unlock],
  );

  const update = useCallback((fn: (s: Save) => Save) => setSave((s) => fn(s)), []);
  const boost = useCallback((kind: "boost" | "frenzy", ms: number) => {
    until.current[kind] = Math.max(Date.now(), until.current[kind]) + ms;
    setNow(Date.now());
  }, []);
  const reset = useCallback(() => {
    coins.current = FRESH.coins;
    setSave({ ...FRESH, ach: [] });
  }, []);

  const cps = UPGRADES.reduce((t, u) => t + (save.owned[u.id] ?? 0) * u.cps, 0);
  const cpsRef = useRef(cps);
  cpsRef.current = cps;
  useEffect(() => {
    if (cps >= 1000) unlock("tycoon");
  }, [cps, unlock]);

  // once a second: passive income, dopamine decay, combo timeout, countdowns
  useEffect(() => {
    const h = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (cpsRef.current > 0) earn(cpsRef.current, null, { passive: true });
      dopaRef.current = Math.max(0, dopaRef.current - 2);
      setDopamine(dopaRef.current);
      if (comboRef.current && t - lastHit.current > 1500 && t > until.current.frenzy) {
        comboRef.current = 0;
        setCombo(0);
      }
    }, 1000);
    return () => clearInterval(h);
  }, [earn]);

  // level ups
  const level = levelOf(save.xp);
  const prevLevel = useRef(level);
  useEffect(() => {
    if (level > prevLevel.current) {
      shout(`⭐ LEVEL ${level} ⭐`, "#ffe600");
      sfx.levelup();
      confetti(undefined, undefined, calmRef.current ? 30 : 120);
      emit("chat", { text: `LEVEL ${level} POG` });
      if (level >= 5) unlock("level5");
      if (level >= 10) unlock("level10");
    }
    prevLevel.current = level;
  }, [level, shout, unlock]);

  const left = (k: keyof typeof until.current) => Math.max(0, Math.ceil((until.current[k] - now) / 1000));
  const game: Game = useMemo(
    () => ({
      save,
      level,
      combo,
      mult: comboMult(combo) * (now < until.current.boost ? 2 : 1) * (now < until.current.overdrive ? 3 : 1),
      dopamine,
      cps,
      boostLeft: left("boost"),
      overdriveLeft: left("overdrive"),
      frenzyLeft: left("frenzy"),
      calm,
      sound,
      setCalm,
      setSound,
      earn,
      spend,
      lose,
      stat,
      unlock,
      float,
      shout,
      update,
      boost,
      chaos,
      hype,
      reset,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [save, level, combo, dopamine, now, cps, calm, sound],
  );

  return (
    <Ctx.Provider value={game}>
      {children}
      <canvas className="adhd-confetti" ref={mountConfetti} aria-hidden />
      <div className="adhd-floats" aria-hidden>
        {floats.map((f) => (
          <span key={f.id} className={`adhd-float${f.big ? " big" : ""}`} style={{ left: f.x, top: f.y, color: f.color }}>
            {f.text}
          </span>
        ))}
      </div>
      <div className="adhd-shouts" aria-live="polite">
        {shouts.map((s) => (
          <div key={s.id} className="adhd-shout" style={{ color: s.color }}>
            {s.text}
          </div>
        ))}
      </div>
      <div className="adhd-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="adhd-toast">
            <span className="adhd-toast-e">{t.e}</span>
            <div>
              <b>ACHIEVEMENT UNLOCKED</b>
              <div>{t.title}</div>
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
