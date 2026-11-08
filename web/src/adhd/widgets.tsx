// The ADHD tab's mini-games. Every one pays into the shared coin economy (game.tsx).
import { CSSProperties, PointerEvent as RPointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { confetti, sfx } from "./fx";
import { ACHIEVEMENTS, cost, emit, fmt, Game, pick, Pt, ptOf, rand, UPGRADES, useBus, useGame } from "./game";

type Tone = "pink" | "cyan" | "lime" | "yellow" | "purple" | "orange" | "red" | "blue" | "black";

export function Card(props: { title: string; e: string; tone: Tone; tilt?: number; sticker?: string; className?: string; children: ReactNode }) {
  return (
    <section className={`adhd-card tone-${props.tone} ${props.className ?? ""}`} style={{ "--tilt": `${props.tilt ?? 0}deg` } as CSSProperties}>
      {props.sticker && <span className="adhd-sticker">{props.sticker}</span>}
      <h2 className="adhd-wordart">
        <span className="adhd-wordart-e">{props.e}</span>
        <span className="adhd-wordart-t">{props.title}</span>
      </h2>
      {props.children}
    </section>
  );
}

const centerOf = (el: Element | null): Pt => {
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
};

/** Timers that are cleared when the component unmounts. */
function useTimers() {
  const ids = useRef<number[]>([]);
  useEffect(() => () => ids.current.forEach((i) => (clearTimeout(i), clearInterval(i))), []);
  return {
    after: (ms: number, fn: () => void) => void ids.current.push(window.setTimeout(fn, ms)),
    every: (ms: number, fn: () => void) => {
      const i = window.setInterval(fn, ms);
      ids.current.push(i);
      return i;
    },
  };
}

// ================================================================ prize wheel

type Seg = { l: string; m: number; w: number; c: string; t?: string };
// w = share of the wheel (sums to 100). The jackpot is a 1% sliver between two zeros, for the near misses.
const SEGS: Seg[] = [
  { l: "x2", m: 2, w: 6, c: "#ff2d95" },
  { l: "0", m: 0, w: 8, c: "#1b1b1b" },
  { l: "x1.5", m: 1.5, w: 7, c: "#00c8ff" },
  { l: "0", m: 0, w: 8, c: "#1b1b1b" },
  { l: "x3", m: 3, w: 6, c: "#ffe600", t: "#000" },
  { l: "💀", m: 0, w: 2, c: "#5b00a8" },
  { l: "x1.5", m: 1.5, w: 7, c: "#39ff14", t: "#000" },
  { l: "0", m: 0, w: 8, c: "#1b1b1b" },
  { l: "x5", m: 5, w: 4, c: "#ff6a00" },
  { l: "0", m: 0, w: 8, c: "#1b1b1b" },
  { l: "x2", m: 2, w: 6, c: "#b026ff" },
  { l: "x1.5", m: 1.5, w: 7, c: "#00c8ff" },
  { l: "0", m: 0, w: 8, c: "#1b1b1b" },
  { l: "💰", m: 25, w: 1, c: "#ffd700", t: "#000" },
  { l: "0", m: 0, w: 8, c: "#1b1b1b" },
  { l: "x2", m: 2, w: 6, c: "#ff2d95" },
];
const STARTS = (() => {
  let a = 0;
  return SEGS.map((s) => ((a += s.w * 3.6), a - s.w * 3.6));
})();
const segAt = (deg: number) => {
  const a = ((deg % 360) + 360) % 360;
  let i = 0;
  STARTS.forEach((s, k) => a >= s && (i = k));
  return i;
};
const SPIN_MS = 4600;

export function Roulette() {
  const g = useGame();
  const t = useTimers();
  const [bet, setBet] = useState(50);
  const [rot, setRot] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<{ text: string; good: boolean } | null>(null);
  const [flap, setFlap] = useState(0);
  const wheel = useRef<HTMLDivElement>(null);
  const R = 110;
  const C = 120;
  const P = (a: number, r = R) => [C + r * Math.sin((a * Math.PI) / 180), C - r * Math.cos((a * Math.PI) / 180)];

  const spin = (e: RPointerEvent | React.MouseEvent) => {
    if (spinning) return;
    const free = g.save.freeSpins > 0;
    const stake = free ? 50 : bet < 0 ? Math.floor(g.save.coins) : bet;
    if (stake <= 0) return void g.float("YOU HAVE NOTHING TO BET 💀", ptOf(e), "#ff3b3b");
    if (free) g.update((s) => ({ ...s, freeSpins: s.freeSpins - 1 }));
    else if (!g.spend(stake, ptOf(e))) return;
    let r = Math.random() * 100;
    let i = 0;
    while (r >= SEGS[i].w) r -= SEGS[i++].w;
    const land = STARTS[i] + SEGS[i].w * 3.6 * rand(0.15, 0.85);
    const target = rot + 360 * 6 + ((((-land - rot) % 360) + 360) % 360);
    setRot(target);
    setSpinning(true);
    setResult(null);
    g.stat("spins");
    g.unlock("spin");
    sfx.whoosh();
    // tick + flap the pointer whenever a segment edge passes under it
    let last = -1;
    const t0 = performance.now();
    const track = () => {
      const el = wheel.current;
      if (!el || performance.now() - t0 > SPIN_MS) return;
      try {
        const m = new DOMMatrix(getComputedStyle(el).transform);
        const s = segAt(-(Math.atan2(m.b, m.a) * 180) / Math.PI);
        if (s !== last) {
          last = s;
          sfx.tick();
          setFlap((f) => f + 1);
        }
      } catch {
        /* no transform yet */
      }
      requestAnimationFrame(track);
    };
    requestAnimationFrame(track);
    t.after(SPIN_MS + 80, () => finish(i, stake, free));
  };

  const finish = (i: number, stake: number, free: boolean) => {
    const s = SEGS[i];
    const at = centerOf(wheel.current);
    setSpinning(false);
    if (s.m === 0) {
      setResult({ text: s.l === "💀" ? "💀 BANKRUPT 💀 THE HOUSE THANKS YOU" : `LOST ${fmt(stake)}${free ? " (it was free lol)" : ""}`, good: false });
      sfx.lose();
      g.hype("lose");
      if (s.l === "💀") g.chaos("shake");
      return;
    }
    const won = g.earn(Math.round(stake * s.m), at, { raw: true, big: s.m >= 5, color: s.c === "#1b1b1b" ? "#fff" : s.c });
    setResult({ text: `${s.l === "💰" ? "💰 JACKPOT x25" : s.l} → +${fmt(won)}`, good: true });
    if (s.m >= 25) {
      sfx.jackpot();
      g.unlock("jackpot");
      g.shout("💰💰 JACKPOT 💰💰", "#ffd700");
      confetti(at.x, at.y, g.calm ? 40 : 220, ["🪙", "💰", "💎"]);
      g.chaos("rain");
      g.hype("big");
    } else if (s.m >= 3) {
      sfx.big();
      confetti(at.x, at.y, g.calm ? 25 : 90);
      g.hype("big");
    } else {
      sfx.win();
      g.hype("win");
    }
  };

  const chips: [number, string][] = [
    [10, "10"],
    [50, "50"],
    [100, "100"],
    [500, "500"],
    [-1, "ALL IN"],
  ];
  return (
    <Card title="WHEEL OF FORTUNE(ISH)" e="🎡" tone="purple" tilt={-1.5} sticker="1% JACKPOT!!" className="span2">
      <div className="rl">
        <div className="rl-stage">
          <div key={flap} className="rl-pointer" />
          <div
            className="rl-wheel"
            ref={wheel}
            style={{ transform: `rotate(${rot}deg)`, transition: spinning ? `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.7, 0.08, 1)` : "none" }}
          >
            <svg viewBox="0 0 240 240" width="100%" height="100%">
              {SEGS.map((s, i) => {
                const a0 = STARTS[i];
                const a1 = a0 + s.w * 3.6;
                const [x0, y0] = P(a0);
                const [x1, y1] = P(a1);
                const mid = (a0 + a1) / 2;
                return (
                  <g key={i}>
                    <path d={`M${C},${C} L${x0},${y0} A${R},${R} 0 0 1 ${x1},${y1} Z`} fill={s.c} stroke="#000" strokeWidth={1} />
                    <text
                      transform={`rotate(${mid} ${C} ${C})`}
                      x={C}
                      y={C - R * (s.w < 3 ? 0.86 : 0.7)}
                      textAnchor="middle"
                      fontSize={s.w < 3 ? 10 : 15}
                      fontWeight={900}
                      fill={s.t ?? "#fff"}
                      fontFamily="Impact, sans-serif"
                    >
                      {s.l}
                    </text>
                  </g>
                );
              })}
              {Array.from({ length: 24 }, (_, k) => {
                const [x, y] = P(k * 15, R + 4);
                return <circle key={k} cx={x} cy={y} r={3.2} className={`rl-bulb ${k % 2 ? "b" : "a"}`} />;
              })}
              <circle cx={C} cy={C} r={20} fill="#ffd700" stroke="#000" strokeWidth={3} />
              <text x={C} y={C + 6} textAnchor="middle" fontSize={18}>
                🧠
              </text>
            </svg>
          </div>
        </div>
        <div className="rl-side">
          <div className="adhd-label">BET</div>
          <div className="adhd-chips">
            {chips.map(([v, l]) => (
              <button key={l} className={`adhd-chip${bet === v ? " on" : ""}`} onClick={() => (setBet(v), sfx.click())} disabled={spinning}>
                {l}
              </button>
            ))}
          </div>
          <button className="adhd-big-btn rainbow" onClick={spin} disabled={spinning}>
            {spinning ? "SPINNING…" : g.save.freeSpins > 0 ? `🎟️ FREE SPIN (${g.save.freeSpins})` : `SPIN FOR ${bet < 0 ? fmt(g.save.coins) : bet}`}
          </button>
          <div className={`rl-result ${result ? (result.good ? "good" : "bad") : ""}`}>{result?.text ?? "feeling lucky?"}</div>
          <div className="adhd-fine">x1.5 · x2 · x3 · x5 · 💰x25 · 0 · 💀. Not financial advice.</div>
        </div>
      </div>
    </Card>
  );
}

// ================================================================ slots

const SYMS = [
  { s: "🍒", w: 24, pay: 5 },
  { s: "🍋", w: 22, pay: 8 },
  { s: "🔔", w: 18, pay: 12 },
  { s: "🍀", w: 14, pay: 20 },
  { s: "💎", w: 10, pay: 40 },
  { s: "7️⃣", w: 7, pay: 77 },
  { s: "🧠", w: 5, pay: 150 },
];
const roll = () => {
  let r = Math.random() * 100;
  for (const x of SYMS) if ((r -= x.w) < 0) return x.s;
  return SYMS[0].s;
};

export function Slots() {
  const g = useGame();
  const t = useTimers();
  const [reels, setReels] = useState(["7️⃣", "🧠", "7️⃣"]);
  const [spin, setSpin] = useState([false, false, false]);
  const [bet, setBet] = useState(10);
  const [msg, setMsg] = useState<{ text: string; tone: string }>({ text: "PULL THE LEVER →", tone: "" });
  const [lever, setLever] = useState(false);
  const spinRef = useRef([false, false, false]);
  const box = useRef<HTMLDivElement>(null);

  const pull = (e: React.MouseEvent) => {
    if (spinRef.current.some(Boolean)) return;
    if (!g.spend(bet, ptOf(e))) return;
    const final = [roll(), roll(), roll()];
    if (Math.random() < 0.18) final[1] = final[0]; // near-miss spice
    spinRef.current = [true, true, true];
    setSpin([true, true, true]);
    setLever(true);
    t.after(350, () => setLever(false));
    setMsg({ text: "🤞🤞🤞", tone: "" });
    g.stat("slots");
    const iv = t.every(70, () => setReels((r) => r.map((s, i) => (spinRef.current[i] ? SYMS[(Math.random() * SYMS.length) | 0].s : s))));
    [650, 1050, 1500].forEach((ms, i) =>
      t.after(ms, () => {
        spinRef.current[i] = false;
        setSpin([...spinRef.current]);
        setReels((r) => r.map((s, k) => (k === i ? final[i] : s)));
        sfx.click();
        if (i === 2) {
          clearInterval(iv);
          settle(final);
        }
      }),
    );
  };

  const settle = (f: string[]) => {
    const at = centerOf(box.current);
    const three = f[0] === f[1] && f[1] === f[2];
    const pair = f[0] === f[1] || f[1] === f[2] || f[0] === f[2];
    if (three) {
      const pay = SYMS.find((x) => x.s === f[0])!.pay;
      g.earn(bet * pay, at, { raw: true, big: true, color: "#ffd700" });
      setMsg({ text: `${f[0]}${f[0]}${f[0]} BIG WIN x${pay}!!!`, tone: "win" });
      sfx.jackpot();
      confetti(at.x, at.y, g.calm ? 40 : 180, [f[0]]);
      g.unlock("slots777");
      g.shout(`🎰 x${pay} 🎰`, "#ffd700");
      g.hype("big");
    } else if (pair) {
      g.earn(bet * 2, at, { raw: true });
      setMsg({ text: "PAIR! x2", tone: "win" });
      sfx.win();
      g.hype("win");
    } else if (f.includes("🍒")) {
      g.earn(bet, at, { raw: true, label: "refund" });
      setMsg({ text: "🍒 cherry saves you (refund)", tone: "" });
      sfx.coin();
    } else {
      setMsg({ text: pick(["NOTHING 🫠", "so close (not really)", "the machine is warming up", "one more?", "L"]), tone: "lose" });
      sfx.lose();
    }
  };

  return (
    <Card title="SLOTZ" e="🎰" tone="red" tilt={1.2} sticker="HOT 🔥">
      <div className="sl">
        <div className="sl-machine" ref={box}>
          <div className="sl-lights" />
          <div className="sl-reels">
            {reels.map((s, i) => (
              <div key={i} className={`sl-reel${spin[i] ? " spin" : ""}`}>
                <span>{s}</span>
              </div>
            ))}
          </div>
          <div className={`sl-msg ${msg.tone}`}>{msg.text}</div>
        </div>
        <button className={`sl-lever${lever ? " pulled" : ""}`} onClick={pull} aria-label="Pull the lever">
          <span className="sl-ball" />
          <span className="sl-stick" />
        </button>
      </div>
      <div className="adhd-row">
        <span className="adhd-label">BET</span>
        {[10, 50, 200].map((b) => (
          <button key={b} className={`adhd-chip${bet === b ? " on" : ""}`} onClick={() => (setBet(b), sfx.click())}>
            {b}
          </button>
        ))}
      </div>
      <div className="adhd-fine">🧠🧠🧠 x150 · 7️⃣7️⃣7️⃣ x77 · 💎 x40 · 🍀 x20 · any pair x2 · 🍒 refund</div>
    </Card>
  );
}

// ================================================================ clicker

export function Clicker() {
  const g = useGame();
  const [squish, setSquish] = useState(0);
  const powerLvl = Math.round(Math.log2(g.save.power));
  const powerCost = 100 * 4 ** powerLvl;
  const click = (e: React.MouseEvent) => {
    g.earn(g.save.power, ptOf(e));
    g.stat("clicks");
    sfx.click();
    setSquish((s) => s + 1);
  };
  const buy = (id: string, price: number, e: React.MouseEvent) => {
    if (!g.spend(price, ptOf(e))) return;
    g.update((s) => ({ ...s, owned: { ...s.owned, [id]: (s.owned[id] ?? 0) + 1 } }));
    sfx.coin();
    g.float("PURCHASED ✅", ptOf(e), "#39ff14");
  };
  return (
    <Card title="BRAIN CLICKER" e="🧠" tone="pink" tilt={-0.8} sticker="IDLE GAME!!" className="tall">
      <div className="ck">
        <div className="ck-orbit" aria-hidden>
          {["💊", "⚡", "✨", "🔔", "📱", "☕"].map((x, i) => (
            <span key={i} style={{ "--i": i } as CSSProperties}>
              {x}
            </span>
          ))}
        </div>
        <button key={squish} className="ck-brain" onClick={click} aria-label="Click the brain">
          🧠
        </button>
      </div>
      <div className="ck-stats">
        <b>+{fmt(g.save.power)}</b> per click · <b>+{fmt(g.cps)}</b>/sec
      </div>
      <div className="ck-shop">
        <button className="ck-item" disabled={g.save.coins < powerCost} onClick={(e) => (g.spend(powerCost, ptOf(e)) && (g.update((s) => ({ ...s, power: s.power * 2 })), sfx.levelup()))}>
          <span className="ck-e">💪</span>
          <span className="ck-name">
            Stronger finger <small>x2 click · owned {powerLvl}</small>
          </span>
          <span className="ck-cost">{fmt(powerCost)}</span>
        </button>
        {UPGRADES.map((u) => {
          const n = g.save.owned[u.id] ?? 0;
          const c = cost(u.base, n);
          return (
            <button key={u.id} className="ck-item" disabled={g.save.coins < c} onClick={(e) => buy(u.id, c, e)}>
              <span className="ck-e">{u.e}</span>
              <span className="ck-name">
                {u.name} <small>+{fmt(u.cps)}/s · owned {n}</small>
              </span>
              <span className="ck-cost">{fmt(c)}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

// ================================================================ bubble wrap

const BUBBLES = 35;
export function BubbleWrap() {
  const g = useGame();
  const t = useTimers();
  const [popped, setPopped] = useState<boolean[]>(() => Array(BUBBLES).fill(false));
  const [sheet, setSheet] = useState(1);
  const done = popped.every(Boolean);
  useEffect(() => {
    if (!done) return;
    g.shout("🫧 NEW SHEET 🫧", "#00e5ff");
    g.earn(20, null, { raw: true });
    sfx.win();
    t.after(700, () => (setPopped(Array(BUBBLES).fill(false)), setSheet((s) => s + 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  const pop = (i: number, e: React.PointerEvent) => {
    if (popped[i]) return;
    setPopped((p) => p.map((x, k) => x || k === i));
    sfx.pop();
    g.earn(1, ptOf(e));
    g.stat("pops");
  };
  return (
    <Card title="BUBBLE WRAP" e="🫧" tone="cyan" tilt={1.8} sticker={`SHEET #${sheet}`}>
      <div className="bw" onContextMenu={(e) => e.preventDefault()}>
        {popped.map((p, i) => (
          <button
            key={`${sheet}-${i}`}
            className={`bw-b${p ? " popped" : ""}`}
            onPointerDown={(e) => pop(i, e)}
            onPointerEnter={(e) => e.buttons & 1 && pop(i, e)}
            aria-label={p ? "popped" : "bubble"}
          />
        ))}
      </div>
      <div className="adhd-fine">tip: hold the mouse down and drag. so satisfying.</div>
    </Card>
  );
}

// ================================================================ big red button

type ChaosAct = { name: string; calmOk: boolean; run: (g: Game, at: Pt) => void };
const ACTS: ChaosAct[] = [
  { name: "CONFETTI CANNON 🎉", calmOk: true, run: (g, at) => confetti(at.x, at.y, g.calm ? 40 : 200) },
  { name: "EARTHQUAKE 🌋", calmOk: false, run: (g) => g.chaos("shake") },
  { name: "UPSIDE DOWN 🙃", calmOk: false, run: (g) => g.chaos("flip") },
  { name: "NEGATIVE ZONE 🌚", calmOk: false, run: (g) => g.chaos("invert") },
  { name: "EMOJI ZOO 🦓", calmOk: true, run: (g) => g.chaos("zoo") },
  { name: "EMOJI RAIN 🌧️", calmOk: true, run: (g) => g.chaos("rain") },
  { name: "DISCO 🪩", calmOk: false, run: (g) => g.chaos("disco") },
  { name: "FREE MONEY 💸", calmOk: true, run: (g, at) => (g.earn(77, at, { raw: true, big: true }), sfx.coin()) },
  { name: "TAX TIME 🧾", calmOk: true, run: (g, at) => (g.lose(25, at), sfx.bad()) },
  { name: "2X COINS ⚡", calmOk: true, run: (g) => (g.boost("boost", 10000), g.shout("⚡ 2X COINS 10s ⚡", "#00e5ff")) },
  { name: "COMIC SANS EVERYTHING ✍️", calmOk: true, run: (g) => g.chaos("comic") },
];
const SASS = ["WHY WOULD YOU DO THAT", "we literally said don't", "ok one more time", "the button has feelings", "stop it (don't stop)", "press it again coward", "🫵 you did this", "it's getting worse"];

export function BigButton() {
  const g = useGame();
  const [last, setLast] = useState<string | null>(null);
  const [sass, setSass] = useState("");
  const press = (e: React.MouseEvent) => {
    const n = g.stat("presses");
    const acts = ACTS.filter((a) => !g.calm || a.calmOk);
    const a = pick(acts);
    a.run(g, ptOf(e));
    setLast(a.name);
    setSass(n % 3 === 0 ? pick(SASS) : "");
    sfx.boom();
    emit("chat", { text: `someone pressed it: ${a.name}` });
  };
  return (
    <Card title="DO NOT PRESS" e="⛔" tone="black" tilt={-2} sticker="seriously">
      <div className="bb">
        <button className="bb-btn" onClick={press}>
          <span>DON'T</span>
        </button>
        <div className="bb-last">{last ? <>➜ {last}</> : "nothing bad will happen. probably."}</div>
        {sass && <div className="bb-sass adhd-blink">{sass}</div>}
        <div className="adhd-fine">pressed {g.save.stats.presses ?? 0} times</div>
      </div>
    </Card>
  );
}

// ================================================================ loot box

const RARITY = {
  common: { p: 0.6, c: "#9aa0a6", refund: 25, label: "COMMON" },
  rare: { p: 0.27, c: "#2979ff", refund: 90, label: "RARE" },
  epic: { p: 0.1, c: "#d500f9", refund: 350, label: "EPIC" },
  legendary: { p: 0.03, c: "#ffc400", refund: 1200, label: "LEGENDARY" },
} as const;
type Rarity = keyof typeof RARITY;
const LOOT: { e: string; n: string; r: Rarity }[] = [
  { e: "🧦", n: "Lonely Sock", r: "common" },
  { e: "🥄", n: "Slightly Used Spoon", r: "common" },
  { e: "🪨", n: "Pet Rock", r: "common" },
  { e: "🧻", n: "Half a Roll", r: "common" },
  { e: "🕶️", n: "Very Cool Shades", r: "rare" },
  { e: "🎧", n: "Noise-Cancel Cans", r: "rare" },
  { e: "🛹", n: "Board of Focus", r: "rare" },
  { e: "🦄", n: "Unicorn Juice", r: "epic" },
  { e: "🪐", n: "Pocket Planet", r: "epic" },
  { e: "👑", n: "Golden Brain Crown", r: "legendary" },
  { e: "🐉", n: "Hyperfocus Dragon", r: "legendary" },
];
const BOX_COST = 100;

export function LootBox() {
  const g = useGame();
  const t = useTimers();
  const [phase, setPhase] = useState<"idle" | "shake" | "open">("idle");
  const [item, setItem] = useState<(typeof LOOT)[number] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const open = (at: Pt | null, free = false) => {
    if (phase === "shake") return;
    if (!free && !g.spend(BOX_COST, at)) return;
    setPhase("shake");
    setItem(null);
    for (let k = 0; k < 9; k++) t.after(k * 120, () => sfx.tick());
    t.after(1150, () => {
      let r = Math.random();
      let rar: Rarity = "common";
      for (const k of Object.keys(RARITY) as Rarity[]) {
        r -= RARITY[k].p;
        if (r < 0) {
          rar = k;
          break;
        }
      }
      const it = pick(LOOT.filter((x) => x.r === rar));
      setItem(it);
      setPhase("open");
      const inv = { ...g.save.inv, [it.n]: (g.save.inv[it.n] ?? 0) + 1 };
      g.update((s) => ({ ...s, inv: { ...s.inv, [it.n]: (s.inv[it.n] ?? 0) + 1 } }));
      const c = centerOf(box.current);
      g.earn(RARITY[rar].refund, c, { raw: true, color: RARITY[rar].c, label: `(sold ${it.e})`, big: rar !== "common" });
      g.stat("boxes");
      if (rar === "legendary") {
        sfx.jackpot();
        g.unlock("legendary");
        g.shout(`👑 LEGENDARY ${it.e} 👑`, "#ffc400");
        confetti(c.x, c.y, g.calm ? 40 : 220, [it.e, "✨"]);
        g.hype("big");
      } else if (rar === "epic") {
        sfx.big();
        confetti(c.x, c.y, g.calm ? 25 : 100);
        g.hype("big");
      } else if (rar === "rare") {
        sfx.win();
        g.hype("win");
      } else sfx.blip();
      if (LOOT.every((x) => inv[x.n])) g.unlock("collector");
    });
  };
  useBus("freebox", () => {
    open(null, true);
    g.float("📦 FREE BOX!", centerOf(box.current), "#ffc400", true);
  });
  const rar = item ? RARITY[item.r] : null;
  return (
    <Card title="MYSTERY BOX" e="📦" tone="orange" tilt={1} sticker="3% LEGENDARY">
      <div className="lb" ref={box}>
        {phase === "open" && rar && <div className="lb-rays" style={{ "--rc": rar.c } as CSSProperties} />}
        {phase === "open" && item && rar ? (
          <div className="lb-item">
            <span className="lb-e">{item.e}</span>
            <b style={{ color: rar.c }}>{rar.label}</b>
            <span>{item.n}</span>
          </div>
        ) : (
          <button className={`lb-box${phase === "shake" ? " shake" : ""}`} onClick={(e) => open(ptOf(e))} aria-label="Open the box">
            🎁
          </button>
        )}
      </div>
      <button className="adhd-big-btn" onClick={(e) => open(ptOf(e))} disabled={phase === "shake"}>
        {phase === "shake" ? "OPENING…" : phase === "open" ? `ANOTHER ONE (${BOX_COST})` : `OPEN (${BOX_COST})`}
      </button>
      <div className="lb-shelf">
        {LOOT.map((x) => {
          const n = g.save.inv[x.n] ?? 0;
          return (
            <span key={x.n} className={`lb-slot r-${x.r}${n ? "" : " locked"}`} title={n ? `${x.n} ×${n}` : "???"}>
              {n ? x.e : "❓"}
              {n > 1 && <i>{n}</i>}
            </span>
          );
        })}
      </div>
    </Card>
  );
}

// ================================================================ whack-a-notification

const GOOD = ["📱", "💬", "📧", "🔔", "❤️", "📸", "🎮"];
const BAD = ["💣", "🧾"];
type Mole = { e: string; bad: boolean; id: number } | null;
let moleId = 1;

export function Whack() {
  const g = useGame();
  const [holes, setHoles] = useState<Mole[]>(() => Array(9).fill(null));
  const [running, setRunning] = useState(false);
  const [score, setScore] = useState(0);
  const [left, setLeft] = useState(20);
  const timers = useRef<number[]>([]);
  const scoreRef = useRef(0);
  const stop = () => {
    timers.current.forEach((i) => (clearTimeout(i), clearInterval(i)));
    timers.current = [];
  };
  useEffect(() => stop, []);

  const start = () => {
    stop();
    scoreRef.current = 0;
    setScore(0);
    setHoles(Array(9).fill(null));
    setRunning(true);
    const end = Date.now() + 20000;
    sfx.alert();
    timers.current.push(
      window.setInterval(() => {
        const l = Math.max(0, (end - Date.now()) / 1000);
        setLeft(l);
        if (l <= 0) finish();
      }, 100),
    );
    const spawn = () => {
      setHoles((hs) => {
        const empty = hs.map((h, i) => (h ? -1 : i)).filter((i) => i >= 0);
        if (!empty.length) return hs;
        const i = pick(empty);
        const m: Mole = Math.random() < 0.18 ? { e: pick(BAD), bad: true, id: moleId++ } : { e: pick(GOOD), bad: false, id: moleId++ };
        timers.current.push(window.setTimeout(() => setHoles((h2) => h2.map((x) => (x && x.id === m!.id ? null : x))), rand(650, 1100)));
        return hs.map((h, k) => (k === i ? m : h));
      });
      timers.current.push(window.setTimeout(spawn, rand(330, 650)));
    };
    spawn();
  };
  const finish = () => {
    stop();
    setRunning(false);
    setHoles(Array(9).fill(null));
    const s = scoreRef.current;
    const best = g.save.stats.whackBest ?? 0;
    if (s > best) g.update((x) => ({ ...x, stats: { ...x.stats, whackBest: s } }));
    if (s > 0) g.earn(s * 5, null, { raw: true });
    if (s >= 30) g.unlock("whack30");
    g.shout(s > best ? `🔨 NEW BEST: ${s} 🔨` : `🔨 ${s} WHACKED 🔨`, "#ff6a00");
    sfx.win();
    g.hype(s >= 20 ? "big" : "win");
  };
  const hit = (i: number, e: React.PointerEvent) => {
    const m = holes[i];
    if (!running || !m) return;
    setHoles((hs) => hs.map((h, k) => (k === i ? null : h)));
    if (m.bad) {
      scoreRef.current -= 3;
      sfx.bad();
      g.lose(5, ptOf(e));
      g.chaos("shake");
    } else {
      scoreRef.current += 1;
      sfx.pop();
      g.earn(2, ptOf(e));
    }
    setScore(scoreRef.current);
  };
  return (
    <Card title="WHACK-A-NOTIFICATION" e="🔨" tone="lime" tilt={-1.2} sticker="don't hit 💣">
      <div className="wk-top">
        <span>
          SCORE <b>{score}</b>
        </span>
        <span>
          BEST <b>{g.save.stats.whackBest ?? 0}</b>
        </span>
        <span>
          ⏱ <b>{running ? left.toFixed(1) : "20.0"}</b>
        </span>
      </div>
      <div className="wk-grid">
        {holes.map((m, i) => (
          <button key={i} className="wk-hole" onPointerDown={(e) => hit(i, e)} aria-label="hole">
            {m && <span key={m.id} className={`wk-mole${m.bad ? " bad" : ""}`}>{m.e}</span>}
          </button>
        ))}
      </div>
      <button className="adhd-big-btn" onClick={start} disabled={running}>
        {running ? "WHACK WHACK WHACK" : "START (20s)"}
      </button>
    </Card>
  );
}

// ================================================================ scratch card

const TICKET = 30;
const PRIZES = [
  { e: "💎", pay: 400, w: 1 },
  { e: "🍀", pay: 150, w: 3 },
  { e: "🪙", pay: 70, w: 6 },
];
type Ticket = { id: number; syms: string[]; pay: number; revealed: boolean };

export function Scratch() {
  const g = useGame();
  const cv = useRef<HTMLCanvasElement>(null);
  const [tk, setTk] = useState<Ticket | null>(null);
  const moves = useRef(0);
  const down = useRef(false);

  useEffect(() => {
    const c = cv.current;
    if (!c || !tk || tk.revealed) return;
    const x = c.getContext("2d")!;
    x.globalCompositeOperation = "source-over";
    const grd = x.createLinearGradient(0, 0, c.width, c.height);
    grd.addColorStop(0, "#c0c0c0");
    grd.addColorStop(0.5, "#f5f5f5");
    grd.addColorStop(1, "#9e9e9e");
    x.fillStyle = grd;
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#777";
    for (let i = 0; i < 160; i++) x.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 2);
    x.font = "bold 22px 'Comic Sans MS', cursive";
    x.fillStyle = "#555";
    x.textAlign = "center";
    x.fillText("✨ SCRATCH HERE ✨", c.width / 2, c.height / 2 + 8);
    moves.current = 0;
  }, [tk?.id]);

  const buy = (e: React.MouseEvent) => {
    if (!g.spend(TICKET, ptOf(e))) return;
    const win = Math.random() < 0.3;
    let syms: string[];
    let pay = 0;
    if (win) {
      let r = Math.random() * 10;
      const p = PRIZES.find((x) => (r -= x.w) < 0) ?? PRIZES[2];
      syms = [p.e, p.e, p.e];
      pay = p.pay;
    } else {
      const pool = ["💎", "🍀", "🪙", "🍋", "🧦"];
      do syms = [pick(pool), pick(pool), pick(pool)];
      while (syms[0] === syms[1] && syms[1] === syms[2]);
    }
    setTk({ id: Date.now(), syms, pay, revealed: false });
    sfx.coin();
  };

  const scratch = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = cv.current;
    if (!c || !tk || tk.revealed || !down.current) return;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * c.width;
    const y = ((e.clientY - r.top) / r.height) * c.height;
    const ctx = c.getContext("2d")!;
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x, y, 17, 0, Math.PI * 2);
    ctx.fill();
    if (++moves.current % 6 === 0) {
      sfx.tick();
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let clear = 0;
      for (let i = 3; i < d.length; i += 16) if (d[i] === 0) clear++;
      if (clear / (d.length / 16) > 0.5) reveal();
    }
  };
  const reveal = () => {
    const c = cv.current;
    if (!c || !tk) return;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setTk({ ...tk, revealed: true });
    const at = centerOf(c);
    if (tk.pay) {
      g.earn(tk.pay, at, { raw: true, big: true, color: "#39ff14" });
      sfx.big();
      confetti(at.x, at.y, g.calm ? 30 : 120, [tk.syms[0]]);
      g.unlock("scratch");
      g.hype("big");
    } else {
      g.float("NOTHING 🫠", at, "#ff3b3b", true);
      sfx.lose();
    }
  };

  return (
    <Card title="SCRATCH & WIN" e="🎟️" tone="yellow" tilt={2} sticker="30% WIN RATE">
      <div className="sc">
        <div className="sc-under">
          {tk ? (
            <>
              <div className="sc-syms">
                {tk.syms.map((s, i) => (
                  <span key={i}>{s}</span>
                ))}
              </div>
              <div className="sc-note">{tk.revealed ? (tk.pay ? `WINNER! +${tk.pay}` : "no match. the house wins.") : "MATCH 3 TO WIN"}</div>
            </>
          ) : (
            <div className="sc-note">buy a ticket to scratch</div>
          )}
        </div>
        {tk && !tk.revealed && (
          <canvas
            ref={cv}
            width={300}
            height={130}
            className="sc-cover"
            onPointerDown={(e) => ((down.current = true), e.currentTarget.setPointerCapture(e.pointerId), scratch(e))}
            onPointerMove={scratch}
            onPointerUp={() => (down.current = false)}
            onPointerCancel={() => (down.current = false)}
          />
        )}
      </div>
      <button className="adhd-big-btn" onClick={buy} disabled={!!tk && !tk.revealed}>
        {tk && !tk.revealed ? "SCRATCH IT ☝️" : `BUY TICKET (${TICKET})`}
      </button>
    </Card>
  );
}

// ================================================================ fidget spinner

export function Spinner() {
  const g = useGame();
  const gRef = useRef(g);
  gRef.current = g;
  const rotor = useRef<SVGGElement>(null);
  const rpmEl = useRef<HTMLSpanElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const st = useRef({ angle: 0, vel: 0, drag: false, last: 0, lastT: 0, acc: 0, total: 0, unlocked: false });

  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    const loop = (now: number) => {
      const s = st.current;
      const dt = Math.min(50, now - prev);
      prev = now;
      if (!s.drag) {
        s.vel *= Math.pow(0.9988, dt);
        if (Math.abs(s.vel) < 0.002) s.vel = 0;
        s.angle += s.vel * dt;
        s.acc += Math.abs(s.vel * dt);
      }
      while (s.acc >= 360) {
        s.acc -= 360;
        s.total++;
        gRef.current.earn(1, null, { passive: true });
        if (s.total % 10 === 0) gRef.current.float("+10 🌀", centerOf(svg.current), "#b026ff");
      }
      const rpm = Math.round((Math.abs(s.vel) * 60000) / 360);
      if (rotor.current) rotor.current.setAttribute("transform", `rotate(${s.angle % 360} 100 100)`);
      if (rpmEl.current) rpmEl.current.textContent = String(rpm);
      if (rpm > 600 && !s.unlocked) {
        s.unlocked = true;
        gRef.current.unlock("rpm");
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const angleOf = (e: React.PointerEvent) => {
    const c = centerOf(svg.current);
    return (Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180) / Math.PI;
  };
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const s = st.current;
    s.drag = true;
    s.last = angleOf(e);
    s.lastT = performance.now();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const s = st.current;
    if (!s.drag) return;
    const a = angleOf(e);
    let d = a - s.last;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    const now = performance.now();
    const dt = Math.max(1, now - s.lastT);
    s.angle += d;
    s.acc += Math.abs(d);
    s.vel = Math.max(-8, Math.min(8, 0.5 * s.vel + 0.5 * (d / dt)));
    s.last = a;
    s.lastT = now;
  };
  const onUp = () => {
    st.current.drag = false;
    sfx.whoosh();
  };
  const flick = () => {
    st.current.vel += (st.current.vel >= 0 ? 1 : -1) * 1.5;
    sfx.whoosh();
  };
  return (
    <Card title="FIDGET SPINNER" e="🌀" tone="blue" tilt={-1.6} sticker="drag to spin">
      <div className="fs">
        <svg ref={svg} viewBox="0 0 200 200" className="fs-svg" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <defs>
            <radialGradient id="fsg" cx="50%" cy="40%" r="60%">
              <stop offset="0%" stopColor="#fff" />
              <stop offset="100%" stopColor="#ff2d95" />
            </radialGradient>
          </defs>
          <g ref={rotor}>
            {[0, 120, 240].map((a) => (
              <g key={a} transform={`rotate(${a} 100 100)`}>
                <rect x="88" y="34" width="24" height="60" rx="12" fill="#b026ff" stroke="#000" strokeWidth="3" />
                <circle cx="100" cy="40" r="30" fill="url(#fsg)" stroke="#000" strokeWidth="4" />
                <circle cx="100" cy="40" r="12" fill="#ffe600" stroke="#000" strokeWidth="3" />
              </g>
            ))}
            <circle cx="100" cy="100" r="26" fill="#00e5ff" stroke="#000" strokeWidth="4" />
            <circle cx="100" cy="100" r="10" fill="#fff" stroke="#000" strokeWidth="3" />
          </g>
        </svg>
        <div className="fs-rpm">
          <span ref={rpmEl}>0</span> RPM
        </div>
        <button className="adhd-chip" onClick={flick}>
          FLICK 👆
        </button>
      </div>
    </Card>
  );
}

// ================================================================ memes

// [emoji, top text, bottom text]. Original captions, nobody's images.
const MEMES: [string, string, string][] = [
  ["📑", "ME: I'LL JUST CHECK ONE THING", "47 TABS LATER"],
  ["⏰", "SETS 9 ALARMS", "WAKES UP AT 11"],
  ["🐿️", "FULLY FOCUSED ON MY TASK", "SQUIRREL"],
  ["🧹", "STARTS CLEANING MY ROOM", "READS AN OLD NOTEBOOK FOR 2 HOURS"],
  ["🎸", "NEW HOBBY UNLOCKED", "ABANDONED BY FRIDAY"],
  ["☕", "THIRD COFFEE", "STILL NO THOUGHTS"],
  ["🧺", "DID THE LAUNDRY", "IT'S STILL IN THE MACHINE. DAY 3."],
  ["🧠", "NOBODY:", "MY BRAIN AT 3AM: REMEMBER THAT AWKWARD THING FROM 2014?"],
  ["📈", "PREDICTION MARKET SAYS 64%", "I SAY 100% (VIBES)"],
  ["🎰", "ONE MORE SPIN", "— ME, 400 SPINS AGO"],
  ["🍝", "I'LL COOK A PROPER DINNER", "TOAST. AT 11PM."],
  ["🎮", "5 MORE MINUTES", "THE SUN IS RISING"],
  ["📚", "BUYS 6 BOOKS", "READS PAGE 1 OF EACH"],
  ["🦆", "DEADLINE TOMORROW", "PERFECT TIME TO LEARN ORIGAMI"],
  ["🔑", "WHERE ARE MY KEYS", "THEY WERE IN MY HAND"],
  ["💡", "INCREDIBLE IDEA IN THE SHOWER", "GONE BY THE TOWEL"],
  ["📦", "BOUGHT ALL THE GEAR", "FOR A HOBBY I TRIED ONCE"],
  ["🫧", "POPS ONE BUBBLE", "POPS ALL 35 BUBBLES"],
  ["📊", "BUILT A WHOLE DATA PIPELINE", "TO AVOID ANSWERING ONE EMAIL"],
  ["🗓️", "MAKES A COLOUR-CODED PLANNER", "NEVER OPENS IT AGAIN"],
  ["🚿", "GOES TO SHOWER", "WATCHES 3 VIDEOS ABOUT SHOWERS FIRST"],
  ["🎧", "PUTS ON FOCUS MUSIC", "SPENDS 40 MIN PICKING THE PLAYLIST"],
];
const BGS = [
  "linear-gradient(135deg,#ff2d95,#ffe600)",
  "linear-gradient(135deg,#00e5ff,#b026ff)",
  "linear-gradient(135deg,#39ff14,#00e5ff)",
  "radial-gradient(circle,#ffe600,#ff6a00)",
  "conic-gradient(#ff2d95,#ffe600,#39ff14,#00e5ff,#b026ff,#ff2d95)",
  "repeating-linear-gradient(45deg,#111 0 12px,#ffe600 12px 24px)",
];

export function Memes() {
  const g = useGame();
  const [i, setI] = useState(() => (Math.random() * MEMES.length) | 0);
  const [bg, setBg] = useState(0);
  const [fried, setFried] = useState(false);
  const [hover, setHover] = useState(false);
  const next = () => {
    setI((x) => (x + 1 + ((Math.random() * (MEMES.length - 1)) | 0)) % MEMES.length);
    setBg((b) => (b + 1) % BGS.length);
  };
  useEffect(() => {
    if (hover) return;
    const h = setInterval(next, 8000);
    return () => clearInterval(h);
  }, [hover]);
  const rate = (good: boolean, e: React.MouseEvent) => {
    g.earn(3, ptOf(e), { label: good ? "🔥" : "💀" });
    g.stat("rated");
    g.hype(good ? "win" : "lose");
    good ? sfx.win() : sfx.lose();
    next();
  };
  const [e, top, bottom] = MEMES[i];
  return (
    <Card title="MEME MACHINE" e="🗿" tone="yellow" tilt={0.8} sticker="FRESH" className="memes">
      <div className={`mm${fried ? " fried" : ""}`} style={{ background: BGS[bg] }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <div className="mm-top">{top}</div>
        <div key={i} className="mm-e">
          {e}
        </div>
        <div className="mm-bottom">{bottom}</div>
        {fried && (
          <div className="mm-fry" aria-hidden>
            <span>😂</span>
            <span>👌</span>
            <span>💯</span>
            <span>🔥</span>
          </div>
        )}
      </div>
      <div className="adhd-row">
        <button className="adhd-chip" onClick={(ev) => rate(true, ev)}>
          🔥 BASED
        </button>
        <button className="adhd-chip" onClick={(ev) => rate(false, ev)}>
          💀 CRINGE
        </button>
        <button className="adhd-chip" onClick={() => (next(), sfx.click())}>
          ⏭ NEXT
        </button>
        <button className={`adhd-chip${fried ? " on" : ""}`} onClick={() => (setFried((f) => !f), sfx.boom())}>
          🍳 DEEP FRY
        </button>
      </div>
    </Card>
  );
}

// ================================================================ hype chat

const USERS: [string, string][] = [
  ["dopamine_dan", "#ff2d95"],
  ["tab_hoarder99", "#00c8ff"],
  ["xX_focus_Xx", "#39ff14"],
  ["snack_goblin", "#ff6a00"],
  ["procrastinatrix", "#b026ff"],
  ["certified_squirrel", "#ffe600"],
  ["alarm_clock_9", "#ff3b3b"],
  ["hyperfixation_hal", "#00e5ff"],
  ["coffee_ghost", "#d0d0d0"],
  ["side_quest_sam", "#ff9ff3"],
];
const IDLE = [
  "anyone else have 40 tabs open",
  "spin the wheel coward",
  "first",
  "wait is this the research tab??",
  "my brain is literally a slot machine",
  "brb snacks",
  "who's winning",
  "this page is a cry for help 💀",
  "ok one more game then i'm working",
  "the bubble wrap tho 🫧",
  "the logo is SO close to the corner",
  "hydrate chat 💧",
  "chat is this real",
  "certified hyperfixation moment",
  "i was supposed to be doing taxes",
  "MYSTERY BOX MYSTERY BOX",
  "lost 400 coins and i'd do it again",
  "touch grass? what's grass",
  "the meme machine gets me",
  "do NOT press the button (press it)",
];

type Msg = { id: number; u: string; c: string; t: string; me?: boolean };
let msgId = 1;
export function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const push = (t: string, user?: [string, string], me?: boolean) => {
    const [u, c] = user ?? pick(USERS);
    setMsgs((m) => [...m.slice(-60), { id: msgId++, u, c, t, me }]);
  };
  useBus<{ text: string; user?: string }>("chat", (d) => push(d.text));
  useEffect(() => {
    let h = 0;
    const loop = () => {
      push(pick(IDLE));
      h = window.setTimeout(loop, rand(1400, 3800));
    };
    h = window.setTimeout(loop, 800);
    return () => clearTimeout(h);
  }, []);
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    push(t, ["you", "#fff"], true);
    setText("");
    sfx.blip();
    setTimeout(() => push(pick(["real", "so true", "W take", "LMAO", "based", "+1", "who asked (jk ily)", "this ^", "facts", "🫡"])), 600);
  };
  return (
    <Card title="HYPE CHAT" e="💬" tone="black" tilt={1.4} sticker={`🔴 LIVE · ${(1200 + msgs.length * 7).toLocaleString()} watching`} className="tall">
      <div className="ch-log" ref={log}>
        {msgs.map((m) => (
          <div key={m.id} className={`ch-msg${m.me ? " me" : ""}`}>
            <b style={{ color: m.c }}>{m.u}:</b> {m.t}
          </div>
        ))}
      </div>
      <form
        className="ch-in"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="say something (chat will agree)" maxLength={120} />
        <button className="adhd-chip">SEND</button>
      </form>
    </Card>
  );
}

// ================================================================ trophies

export function Trophies() {
  const g = useGame();
  const s = g.save.stats;
  const all = Object.entries(ACHIEVEMENTS);
  const got = useMemo(() => new Set(g.save.ach), [g.save.ach]);
  return (
    <Card title="TROPHY CASE" e="🏆" tone="purple" tilt={-0.6} sticker={`${got.size}/${all.length}`}>
      <div className="tr-grid">
        {all.map(([id, [e, name]]) => (
          <span key={id} className={`tr${got.has(id) ? " got" : ""}`} title={got.has(id) ? name : "??? keep clicking"}>
            {got.has(id) ? e : "🔒"}
          </span>
        ))}
      </div>
      <div className="tr-stats">
        <span>🧠 clicks {fmt(s.clicks ?? 0)}</span>
        <span>🎡 spins {fmt(s.spins ?? 0)}</span>
        <span>🎰 pulls {fmt(s.slots ?? 0)}</span>
        <span>🫧 pops {fmt(s.pops ?? 0)}</span>
        <span>📦 boxes {fmt(s.boxes ?? 0)}</span>
        <span>⛔ presses {fmt(s.presses ?? 0)}</span>
      </div>
    </Card>
  );
}
