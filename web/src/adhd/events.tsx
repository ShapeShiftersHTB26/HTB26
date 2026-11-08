// Things that happen to you on the ADHD tab: random events every few seconds, a bouncing logo that pays out when it
// hits a corner, clickable emoji sprites (zoo / rain), and a sparkle cursor trail.
import { PointerEvent as RPointerEvent, ReactNode, useEffect, useRef, useState } from "react";
import { confetti, sfx } from "./fx";
import { Chaos, emit, fmt, Pt, pick, ptOf, rand, useBus, useGame } from "./game";

// ================================================================ random events

type Kind = "coin" | "power" | "visitor" | "boss" | "maths" | "rain" | "disco" | "freespin" | "package" | "tax" | "frenzy";
const WEIGHTS: [Kind, number][] = [
  ["coin", 18],
  ["power", 10],
  ["visitor", 7],
  ["boss", 8],
  ["maths", 10],
  ["rain", 9],
  ["disco", 5],
  ["freespin", 8],
  ["package", 8],
  ["tax", 6],
  ["frenzy", 7],
];
type Ev = { id: number; kind: Kind; x: number; y: number; dir: 1 | -1; value: number; data: Record<string, unknown> };
let evId = 1;

const BOSSES = [
  ["👾", "THE PROCRASTINATOR"],
  ["🦖", "DEADLINE-SAURUS"],
  ["👹", "THE INBOX DEMON"],
  ["🐙", "TAB OCTOPUS"],
  ["🤖", "ALGORITHM-9000"],
] as const;

function maths() {
  const op = pick(["+", "−", "×"] as const);
  const a = op === "×" ? (2 + Math.random() * 10) | 0 : (5 + Math.random() * 40) | 0;
  const b = op === "×" ? (2 + Math.random() * 10) | 0 : (2 + Math.random() * 30) | 0;
  const ans = op === "+" ? a + b : op === "−" ? a - b : a * b;
  const opts = new Set([ans]);
  while (opts.size < 3) opts.add(ans + pick([-10, -3, -2, -1, 1, 2, 3, 10]));
  return { q: `${a} ${op} ${b} = ?`, ans, opts: [...opts].sort(() => Math.random() - 0.5) };
}

export function EventLayer() {
  const g = useGame();
  const gRef = useRef(g);
  gRef.current = g;
  const [evs, setEvs] = useState<Ev[]>([]);
  const evsRef = useRef(evs);
  evsRef.current = evs;
  const remove = (id: number) => setEvs((e) => e.filter((x) => x.id !== id));

  const fire = (forced?: Kind) => {
    const G = gRef.current;
    let kind: Kind = forced ?? "coin";
    if (!forced) {
      let r = Math.random() * WEIGHTS.reduce((t, w) => t + w[1], 0);
      for (const [k, w] of WEIGHTS) {
        r -= w;
        if (r < 0) {
          kind = k;
          break;
        }
      }
    }
    // random events: at most 3 at once and one popup window at a time; a summon from the menu always happens
    const modal = ["visitor", "maths", "tax"];
    const cap = forced ? 8 : 3;
    if (evsRef.current.length >= cap || (!forced && modal.includes(kind) && evsRef.current.some((e) => modal.includes(e.kind)))) kind = "coin";
    const id = evId++;
    const base: Ev = {
      id,
      kind,
      x: rand(0.08, 0.8) * window.innerWidth,
      y: rand(0.2, 0.7) * window.innerHeight,
      dir: Math.random() < 0.5 ? 1 : -1,
      value: 0,
      data: {},
    };
    sfx.alert();
    G.hype("event");
    switch (kind) {
      case "coin":
        return setEvs((e) => [...e, { ...base, value: Math.round(rand(40, 160)) }]);
      case "power":
        setTimeout(() => remove(id), 7000);
        return setEvs((e) => [...e, base]);
      case "visitor":
        setTimeout(() => remove(id), 14000);
        return setEvs((e) => [...e, { ...base, value: Math.round(rand(90, 220)), data: { dodges: 2 } }]);
      case "boss": {
        const [e, name] = pick(BOSSES);
        const hp = Math.round(rand(12, 22));
        G.shout(`⚔️ BOSS: ${name} ⚔️`, "#ff3b3b");
        return setEvs((x) => [...x, { ...base, value: 300, data: { e, name, hp, max: hp } }]);
      }
      case "maths":
        setTimeout(() => remove(id), 7000);
        return setEvs((e) => [...e, { ...base, value: 80, data: maths() }]);
      case "tax":
        setTimeout(() => {
          if (evsRef.current.some((x) => x.id === id)) {
            gRef.current.lose(Math.max(10, gRef.current.save.coins * 0.1), null);
            gRef.current.float("TAX AUTO-PAID 🧾", null, "#ff3b3b", true);
            remove(id);
          }
        }, 9000);
        return setEvs((e) => [...e, { ...base, data: { dodges: 3 } }]);
      case "package":
        return setEvs((e) => [...e, base]);
      case "rain":
        G.shout("🌧️ EMOJI RAIN: CATCH THEM 🌧️", "#00e5ff");
        return G.chaos("rain");
      case "disco":
        G.shout("🪩 DISCO MODE 🪩", "#ff2d95");
        G.boost("frenzy", 10000);
        return G.chaos("disco");
      case "freespin":
        G.update((s) => ({ ...s, freeSpins: s.freeSpins + 1 }));
        return G.shout("🎟️ FREE SPIN ON THE WHEEL 🎟️", "#b026ff");
      case "frenzy":
        G.boost("frenzy", 12000);
        return G.shout("🔥 COMBO FRENZY 12s 🔥", "#ff6a00");
    }
  };

  useBus<Kind | undefined>("summon", (k) => fire(k));
  useEffect(() => {
    let h = 0;
    const loop = (first = false) => {
      h = window.setTimeout(
        () => {
          fire();
          loop();
        },
        first ? 3500 : gRef.current.calm ? rand(16000, 26000) : rand(6000, 12000),
      );
    };
    loop(true);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (id: number, data: Record<string, unknown>) => setEvs((e) => e.map((x) => (x.id === id ? { ...x, data: { ...x.data, ...data } } : x)));

  return (
    <div className="ev-layer">
      {evs.map((ev) => {
        switch (ev.kind) {
          case "coin":
            return (
              <button
                key={ev.id}
                className={`ev-coin ${ev.dir > 0 ? "ltr" : "rtl"}`}
                style={{ top: ev.y }}
                onAnimationEnd={() => remove(ev.id)}
                onPointerDown={(e) => {
                  g.earn(ev.value, ptOf(e), { big: true, color: "#ffd700" });
                  sfx.coin();
                  confetti(e.clientX, e.clientY, g.calm ? 15 : 40, ["🪙"]);
                  g.hype("win");
                  remove(ev.id);
                }}
              >
                🪙
              </button>
            );
          case "power":
            return (
              <button
                key={ev.id}
                className="ev-power"
                style={{ left: ev.x, top: ev.y }}
                onClick={(e) => {
                  g.boost("boost", 15000);
                  g.shout("⚡ 2X COINS 15s ⚡", "#00e5ff");
                  sfx.big();
                  confetti(e.clientX, e.clientY, 40);
                  remove(ev.id);
                }}
              >
                ⚡ 2X
              </button>
            );
          case "package":
            return (
              <button
                key={ev.id}
                className="ev-package"
                style={{ left: ev.x }}
                onAnimationEnd={() => remove(ev.id)}
                onClick={() => {
                  emit("freebox");
                  sfx.coin();
                  remove(ev.id);
                }}
              >
                <span>🪂</span>
                <span>📦</span>
              </button>
            );
          case "boss":
            return <Boss key={ev.id} ev={ev} onHit={(hp) => patch(ev.id, { hp })} onDone={() => remove(ev.id)} />;
          case "visitor":
            return (
              <Win98 key={ev.id} title="🎉 CONGRATULATIONS!!!.exe" x={ev.x} y={ev.y} dodges={ev.data.dodges as number} onDodge={() => patch(ev.id, { dodges: (ev.data.dodges as number) - 1 })} onClose={() => remove(ev.id)}>
                <p className="w98-blink">YOU ARE THE 1,000,000th VISITOR!!!</p>
                <p>You have been selected to receive a FREE PRIZE. No catch. (There is a catch: none.)</p>
                <button
                  className="w98-btn primary"
                  onClick={(e) => {
                    g.earn(ev.value, ptOf(e), { big: true, raw: true, color: "#39ff14" });
                    confetti(e.clientX, e.clientY, g.calm ? 30 : 120);
                    sfx.big();
                    remove(ev.id);
                  }}
                >
                  CLAIM {ev.value} COINS
                </button>
              </Win98>
            );
          case "maths": {
            const d = ev.data as ReturnType<typeof maths>;
            return (
              <Win98 key={ev.id} title="🧮 QUICK MATHS.exe" x={ev.x} y={ev.y} dodges={0} onClose={() => remove(ev.id)}>
                <p className="w98-q">{d.q}</p>
                <div className="w98-timer" />
                <div className="w98-row">
                  {d.opts.map((o) => (
                    <button
                      key={o}
                      className="w98-btn"
                      onClick={(e) => {
                        if (o === d.ans) {
                          g.earn(ev.value, ptOf(e), { big: true, label: "🧠" });
                          g.unlock("maths");
                          sfx.win();
                        } else {
                          g.float("WRONG 🤡", ptOf(e), "#ff3b3b", true);
                          sfx.lose();
                        }
                        remove(ev.id);
                      }}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </Win98>
            );
          }
          case "tax": {
            const dodges = ev.data.dodges as number;
            const owed = Math.max(10, Math.round(g.save.coins * 0.1));
            return (
              <Win98 key={ev.id} title="🧾 Department of Fun Taxes" x={ev.x} y={ev.y} dodges={0} onClose={() => (g.lose(owed, null), g.float("closing it doesn't help 🧾", null, "#ff3b3b"), remove(ev.id))}>
                <p>
                  You owe <b>{fmt(owed)} coins</b> (10%) for excessive fun.
                </p>
                <div className="w98-row">
                  <button className="w98-btn" onClick={(e) => (g.lose(owed, ptOf(e)), sfx.lose(), remove(ev.id))}>
                    PAY 😭
                  </button>
                  <button
                    className="w98-btn primary"
                    style={dodges > 0 ? { transform: `translate(${rand(-60, 60)}px, ${rand(-30, 30)}px)` } : undefined}
                    onPointerEnter={() => dodges > 0 && (patch(ev.id, { dodges: dodges - 1 }), sfx.blip())}
                    onClick={(e) => {
                      if (dodges > 0) return patch(ev.id, { dodges: dodges - 1 });
                      g.earn(25, ptOf(e), { raw: true, label: "APPEAL WON ⚖️" });
                      sfx.win();
                      remove(ev.id);
                    }}
                  >
                    APPEAL ⚖️
                  </button>
                </div>
              </Win98>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}

function Win98(props: { title: string; x: number; y: number; dodges: number; onDodge?: () => void; onClose: () => void; children: ReactNode }) {
  const [pos] = useState(() => ({
    left: Math.min(Math.max(12, props.x), window.innerWidth - 340),
    top: Math.min(Math.max(70, props.y), window.innerHeight - 260),
  }));
  return (
    <div className="w98" style={pos} role="dialog" aria-label={props.title}>
      <div className="w98-title">
        <span>{props.title}</span>
        <button
          className="w98-x"
          style={props.dodges > 0 ? { transform: `translate(${rand(-140, -20)}px, ${rand(0, 60)}px)` } : undefined}
          onPointerEnter={() => props.dodges > 0 && (props.onDodge?.(), sfx.blip())}
          onClick={() => (props.dodges > 0 ? props.onDodge?.() : props.onClose())}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="w98-body">{props.children}</div>
    </div>
  );
}

function Boss({ ev, onHit, onDone }: { ev: Ev; onHit: (hp: number) => void; onDone: () => void }) {
  const g = useGame();
  const [hitKey, setHitKey] = useState(0);
  const hp = ev.data.hp as number;
  const max = ev.data.max as number;
  const dead = useRef(false);
  const hit = (e: RPointerEvent) => {
    if (dead.current) return;
    const n = hp - 1;
    setHitKey((k) => k + 1);
    sfx.blip();
    g.earn(1, ptOf(e), { color: "#ff3b3b" });
    if (n <= 0) {
      dead.current = true;
      g.earn(ev.value, ptOf(e), { raw: true, big: true, label: "BOSS DOWN", color: "#ffd700" });
      confetti(e.clientX, e.clientY, g.calm ? 40 : 200, [ev.data.e as string, "💥", "⭐"]);
      sfx.jackpot();
      g.unlock("boss");
      g.shout("💥 BOSS DEFEATED 💥", "#ffd700");
      g.hype("big");
      g.stat("bosses");
      onDone();
    } else onHit(n);
  };
  return (
    <div
      className={`ev-boss ${ev.dir > 0 ? "ltr" : "rtl"}`}
      onAnimationEnd={(e) => {
        if (e.target !== e.currentTarget || dead.current) return;
        emit("chat", { text: `${ev.data.name as string} got away 💀` });
        sfx.lose();
        onDone();
      }}
    >
      <div className="ev-boss-name">{ev.data.name as string}</div>
      <div className="ev-boss-hp">
        <i style={{ width: `${(hp / max) * 100}%` }} />
      </div>
      <button key={hitKey} className="ev-boss-e" onPointerDown={hit} aria-label="Hit the boss">
        {ev.data.e as string}
      </button>
    </div>
  );
}

// ================================================================ sprites: emoji zoo + emoji rain

type Sprite = { id: number; e: string; x: number; y: number; vx: number; vy: number; fall: boolean; born: number; value: number; el?: HTMLButtonElement | null };
const ZOO = ["🦓", "🦒", "🐸", "🦄", "🐙", "🦖", "🐌", "🦩", "🐧", "🦔", "🐢", "🦜"];
const RAIN = ["🍬", "💎", "🍩", "⭐", "🪙", "🍕", "💊", "🧃", "🎈", "🍭"];
let spriteId = 1;

export function Sprites() {
  const g = useGame();
  const map = useRef(new Map<number, Sprite>());
  const [ids, setIds] = useState<number[]>([]);
  const spawn = (n: number, fall: boolean) => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const fresh: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = spriteId++;
      map.current.set(id, {
        id,
        e: pick(fall ? RAIN : ZOO),
        x: rand(20, W - 60),
        y: fall ? rand(-400, -40) : rand(80, H - 120),
        vx: fall ? rand(-0.03, 0.03) : rand(-0.35, 0.35),
        vy: fall ? rand(0.05, 0.15) : rand(-0.35, 0.35),
        fall,
        born: performance.now(),
        value: fall ? 3 : 8,
      });
      fresh.push(id);
    }
    if (map.current.size > 80) {
      const drop = [...map.current.keys()].slice(0, map.current.size - 80);
      drop.forEach((k) => map.current.delete(k));
    }
    setIds([...map.current.keys()]);
  };
  useBus<{ kind: Chaos }>("chaos", ({ kind }) => {
    if (kind === "zoo") spawn(g.calm ? 6 : 14, false);
    if (kind === "rain") spawn(g.calm ? 10 : 30, true);
  });

  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(50, now - prev);
      prev = now;
      const W = window.innerWidth;
      const H = window.innerHeight;
      let changed = false;
      for (const s of map.current.values()) {
        if (s.fall) {
          s.vy += 0.00025 * dt;
          if (s.y > H + 40) {
            map.current.delete(s.id);
            changed = true;
            continue;
          }
        } else {
          if (s.x < 0 || s.x > W - 48) s.vx = -s.vx;
          if (s.y < 60 || s.y > H - 60) s.vy = -s.vy;
          if (now - s.born > 15000) {
            map.current.delete(s.id);
            changed = true;
            continue;
          }
        }
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        if (s.el) s.el.style.transform = `translate(${s.x}px, ${s.y}px)${s.fall ? "" : ` rotate(${Math.sin(now / 200 + s.id) * 15}deg)`}`;
      }
      if (changed) setIds([...map.current.keys()]);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="sp-layer">
      {ids.map((id) => {
        const s = map.current.get(id);
        if (!s) return null;
        return (
          <button
            key={id}
            className="sp"
            ref={(el) => void (s.el = el)}
            style={{ transform: `translate(${s.x}px, ${s.y}px)` }}
            onPointerDown={(e) => {
              g.earn(s.value, ptOf(e));
              sfx.pop();
              map.current.delete(id);
              setIds([...map.current.keys()]);
            }}
          >
            {s.e}
          </button>
        );
      })}
    </div>
  );
}

// ================================================================ the bouncing logo

const LOGO_COLORS = ["#ff2d95", "#00e5ff", "#ffe600", "#39ff14", "#b026ff", "#ff6a00", "#ffffff"];
export function Bouncer() {
  const g = useGame();
  const gRef = useRef(g);
  gRef.current = g;
  const el = useRef<HTMLButtonElement>(null);
  const st = useRef({ x: 120, y: 160, vx: 0.11, vy: 0.08, c: 0, hitX: 0, hitY: 0, boostUntil: 0 });
  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    const loop = (now: number) => {
      const s = st.current;
      const b = el.current;
      const dt = Math.min(50, now - prev);
      prev = now;
      if (b) {
        const w = b.offsetWidth;
        const h = b.offsetHeight;
        const top = 56; // under the app header
        const W = window.innerWidth;
        const H = window.innerHeight;
        const sp = now < s.boostUntil ? 2.2 : 1;
        s.x += s.vx * dt * sp;
        s.y += s.vy * dt * sp;
        let bounced = false;
        if (s.x <= 0 || s.x + w >= W) {
          s.vx = -s.vx;
          s.x = Math.max(0, Math.min(W - w, s.x));
          s.hitX = now;
          bounced = true;
        }
        if (s.y <= top || s.y + h >= H) {
          s.vy = -s.vy;
          s.y = Math.max(top, Math.min(H - h, s.y));
          s.hitY = now;
          bounced = true;
        }
        if (bounced) {
          s.c = (s.c + 1) % LOGO_COLORS.length;
          b.style.color = LOGO_COLORS[s.c];
          b.style.borderColor = LOGO_COLORS[s.c];
          if (Math.abs(s.hitX - s.hitY) < 160) corner({ x: s.x + w / 2, y: s.y + h / 2 });
        }
        b.style.transform = `translate(${s.x}px, ${s.y}px)`;
      }
      raf = requestAnimationFrame(loop);
    };
    const corner = (at: Pt) => {
      const G = gRef.current;
      st.current.hitX = -1e9;
      G.earn(500, at, { raw: true, big: true, label: "CORNER", color: "#ffd700" });
      G.shout("📺 IT HIT THE CORNER!!! 📺", "#ffd700");
      G.unlock("corner");
      confetti(at.x, at.y, G.calm ? 40 : 220);
      sfx.jackpot();
      G.hype("big");
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <button
      ref={el}
      className="bouncer"
      onClick={(e) => {
        const s = st.current;
        g.earn(15, ptOf(e), { label: "📺" });
        s.vx = (Math.random() < 0.5 ? -1 : 1) * rand(0.09, 0.16);
        s.vy = (Math.random() < 0.5 ? -1 : 1) * rand(0.07, 0.13);
        s.boostUntil = performance.now() + 2500;
        sfx.coin();
      }}
      title="click me. or wait for the corner."
    >
      ADHD<small>™</small>
    </button>
  );
}

// ================================================================ sparkle cursor trail

const TRAIL = ["✨", "⭐", "💖", "🌈", "💫", "🔸", "🫧", "⚡"];
export function CursorTrail({ on }: { on: boolean }) {
  useEffect(() => {
    if (!on) return;
    const layer = document.createElement("div");
    layer.className = "adhd-trail";
    document.body.appendChild(layer);
    let last = 0;
    const move = (e: PointerEvent) => {
      const t = performance.now();
      if (t - last < 40) return;
      last = t;
      const s = document.createElement("span");
      s.textContent = pick(TRAIL);
      s.style.left = `${e.clientX}px`;
      s.style.top = `${e.clientY}px`;
      s.style.setProperty("--dx", `${rand(-30, 30)}px`);
      layer.appendChild(s);
      setTimeout(() => s.remove(), 750);
    };
    window.addEventListener("pointermove", move);
    return () => {
      window.removeEventListener("pointermove", move);
      layer.remove();
    };
  }, [on]);
  return null;
}

export const SUMMONABLE: [Kind, string][] = [
  ["coin", "🪙"],
  ["boss", "👾"],
  ["maths", "🧮"],
  ["rain", "🌧️"],
  ["package", "📦"],
  ["visitor", "🎉"],
];
export type { Kind as EventKind };
export const summon = (k?: Kind) => emit("summon", k);
