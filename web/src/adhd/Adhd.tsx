// The ADHD tab: a deliberately chaotic, cheap-looking page of dopamine. Mini-games share one coin economy
// (game.tsx); random events, chaos effects and a hype chat keep things moving. Calm mode tones it all down.
import { ReactNode, useEffect, useRef, useState } from "react";
import "./adhd.css";
import { Bouncer, CursorTrail, EventLayer, Sprites, summon, SUMMONABLE } from "./events";
import { confetti, sfx } from "./fx";
import { Chaos, fmt, GameProvider, levelOf, Pt, useBus, useGame, xpFor } from "./game";
import { BigButton, BubbleWrap, Chat, Clicker, LootBox, Memes, Roulette, Scratch, Slots, Spinner, Trophies, Whack } from "./widgets";

export default function Adhd({ nav }: { nav: ReactNode }) {
  return (
    <GameProvider>
      <Page nav={nav} />
    </GameProvider>
  );
}

const FX_MS: Partial<Record<Chaos, number>> = { shake: 600, flip: 1800, invert: 2200, disco: 10000, comic: 9000 };
const LOUD: Chaos[] = ["shake", "flip", "invert", "disco"];

function Page({ nav }: { nav: ReactNode }) {
  const g = useGame();
  const [fx, setFx] = useState<Partial<Record<Chaos, number>>>({});
  useBus<{ kind: Chaos; at?: Pt }>("chaos", ({ kind, at }) => {
    if (kind === "confetti") return confetti(at?.x, at?.y, g.calm ? 30 : 150);
    const ms = FX_MS[kind];
    if (!ms) return; // zoo / rain: the sprite layer handles them
    if (g.calm && LOUD.includes(kind)) return void g.float("(calm mode blocked that)", at ?? null, "#fff");
    const until = Date.now() + ms;
    setFx((f) => ({ ...f, [kind]: until }));
    setTimeout(() => setFx((f) => (f[kind] === until ? { ...f, [kind]: 0 } : f)), ms);
    if (kind === "shake") sfx.boom();
  });
  // fast track (../FastTrack.tsx): the research answer landed while you were here
  useEffect(() => {
    const on = (e: Event) => {
      if (!(e as CustomEvent<{ ready: boolean }>).detail?.ready) return void sfx.bad();
      sfx.jackpot();
      confetti(undefined, undefined, g.calm ? 40 : 220);
      g.float("ANSWER READY!!!", { x: window.innerWidth / 2, y: window.innerHeight / 3 }, "#7CFC00", true);
    };
    window.addEventListener("bt:answer-ready", on);
    return () => window.removeEventListener("bt:answer-ready", on);
  }, [g.calm]);
  const fxClass = (Object.keys(fx) as Chaos[])
    .filter((k) => fx[k])
    .map((k) => `fx-${k}`)
    .join(" ");

  return (
    <div className={`app adhd-root${g.calm ? " adhd-calm" : ""}`}>
      <header>
        <strong>Backtrace</strong>
        {nav}
      </header>
      <div className={`adhd ${fxClass}`}>
        <Marquee />
        <div className="adhd-hero">
          <h1 className="adhd-title">
            <span className="adhd-star">★</span>
            <span className="adhd-title-t">ADHD ZONE</span>
            <span className="adhd-star">★</span>
          </h1>
          <p className="adhd-sub">
            a totally normal amount of stimulation · <span className="adhd-blink">NEW!!!</span> · everything is clickable · nothing is real money
          </p>
        </div>
        <StatsBar />
        <div className="adhd-grid">
          <Roulette />
          <Clicker />
          <Slots />
          <Memes />
          <BubbleWrap />
          <BigButton />
          <LootBox />
          <Whack />
          <Scratch />
          <Spinner />
          <Chat />
          <Trophies />
        </div>
        <Footer />
      </div>
      <Ticker />
      <Sprites />
      <Bouncer />
      <EventLayer />
      <CursorTrail on={!g.calm} />
    </div>
  );
}

// ---------------------------------------------------------------- top + bottom strips

function Marquee() {
  const t = "🔥 FREE DOPAMINE 🔥 CLICK EVERYTHING 💥 WIN BIG 💰 NO THOUGHTS 🧠 ONLY VIBES ✨ ONE MORE SPIN 🎰 HYDRATE 💧 ";
  return (
    <div className="adhd-marquee" aria-hidden>
      <div className="adhd-marquee-track">
        <span>{t.repeat(3)}</span>
        <span>{t.repeat(3)}</span>
      </div>
    </div>
  );
}

const NEWS = [
  "BREAKING: LOCAL BRAIN OPENS 48TH TAB, CLOSES NONE",
  "SCIENTISTS CONFIRM ONE MORE SPIN HAS NEVER HURT ANYONE (UNVERIFIED)",
  "MARKETS: DOPAMINE DOWN 40% AFTER USER LOOKED AWAY FOR 3 SECONDS",
  "WEATHER: 100% CHANCE OF SIDE QUESTS",
  "SPORTS: BUBBLE WRAP CHAMPIONSHIP ENTERS SHEET #400",
  "STUDY: 9 OUT OF 10 ALARMS GO IGNORED; 10TH ALSO IGNORED",
  "TECH: NEW APP TURNS YOUR TO-DO LIST INTO A LOOT BOX. IT'S THIS ONE.",
  "OPINION: THE LOGO WILL HIT THE CORNER THIS TIME",
  "HEALTH: EXPERTS RECOMMEND TOUCHING GRASS; PUBLIC ASKS FOR A TUTORIAL",
  "LOCAL: MAN WHO SAID 'JUST 5 MINUTES' FOUND 3 HOURS LATER, HAPPY",
];
function Ticker() {
  return (
    <div className="adhd-ticker" aria-hidden>
      <b>📰 BREAKING</b>
      <div className="adhd-ticker-track">
        <span>{NEWS.join("  •  ")}  •  </span>
        <span>{NEWS.join("  •  ")}  •  </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- stats bar

function useCountUp(target: number) {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    const from = cur.current;
    if (from === target) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 400);
      cur.current = from + (target - from) * (1 - (1 - k) ** 3);
      setV(cur.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

function StatsBar() {
  const g = useGame();
  const coins = useCountUp(g.save.coins);
  const lvl = levelOf(g.save.xp);
  const lo = xpFor(lvl);
  const hi = xpFor(lvl + 1);
  const xpPct = Math.min(100, ((g.save.xp - lo) / (hi - lo)) * 100);
  const [bump, setBump] = useState(0);
  const prev = useRef(g.save.coins);
  useEffect(() => {
    if (g.save.coins > prev.current) setBump((b) => b + 1);
    prev.current = g.save.coins;
  }, [g.save.coins]);
  const low = g.dopamine < 12;

  return (
    <div className="adhd-stats">
      <div className="st-coins">
        <span className="st-coin-e">🪙</span>
        <b key={bump} className="st-coin-n">
          {fmt(coins)}
        </b>
        {g.cps > 0 && <small>+{fmt(g.cps)}/s</small>}
      </div>
      <div className="st-block">
        <div className="st-label">
          LVL <b>{lvl}</b>
        </div>
        <div className="st-bar xp">
          <i style={{ width: `${xpPct}%` }} />
        </div>
      </div>
      <div className={`st-block${low ? " low" : ""}`}>
        <div className="st-label">
          DOPAMINE <b>{Math.round(g.dopamine)}%</b>
        </div>
        <div className="st-bar dopa">
          <i style={{ width: `${g.dopamine}%` }} />
        </div>
      </div>
      <div className={`st-combo${g.combo >= 10 ? " hot" : ""}`}>
        {g.combo > 1 ? (
          <>
            COMBO <b key={g.combo}>x{g.combo}</b>
          </>
        ) : (
          <span className="st-dim">no combo</span>
        )}
        {g.mult > 1 && <span className="st-mult">×{+g.mult.toFixed(1)} coins</span>}
      </div>
      <div className="st-boosts">
        {g.boostLeft > 0 && <span className="st-chip cyan">⚡2X {g.boostLeft}s</span>}
        {g.overdriveLeft > 0 && <span className="st-chip lime">🧪x3 {g.overdriveLeft}s</span>}
        {g.frenzyLeft > 0 && <span className="st-chip orange">🔥FRENZY {g.frenzyLeft}s</span>}
        {g.save.freeSpins > 0 && <span className="st-chip purple">🎟️×{g.save.freeSpins}</span>}
      </div>
      <div className="st-tools">
        {g.save.coins < 10 && (
          <button
            className="st-btn bail"
            onClick={(e) => {
              g.earn(150, { x: e.clientX, y: e.clientY }, { raw: true, label: "BAILOUT" });
              sfx.coin();
              g.hype("lose");
            }}
          >
            💸 BAILOUT
          </button>
        )}
        <SummonMenu />
        <button className="st-btn" title={g.sound ? "Mute" : "Unmute"} onClick={() => g.setSound(!g.sound)}>
          {g.sound ? "🔊" : "🔇"}
        </button>
        <button className={`st-btn${g.calm ? " on" : ""}`} title="Calm mode: less motion, fewer events, no flips or flashes" onClick={() => g.setCalm(!g.calm)}>
          {g.calm ? "😌 CALM" : "😵 TOO MUCH?"}
        </button>
      </div>
      {low && <div className="st-nag adhd-blink">😴 DOPAMINE CRITICALLY LOW. CLICK SOMETHING. ANYTHING.</div>}
    </div>
  );
}

function SummonMenu() {
  const [open, setOpen] = useState(false);
  return (
    <span className="st-summon">
      <button className="st-btn rainbow" onClick={() => (summon(), sfx.alert())} title="Something random happens">
        🎲 SUMMON CHAOS
      </button>
      <button className="st-btn" onClick={() => setOpen((o) => !o)} aria-label="Pick an event">
        ▾
      </button>
      {open && (
        <span className="st-summon-menu" onMouseLeave={() => setOpen(false)}>
          {SUMMONABLE.map(([k, e]) => (
            <button key={k} onClick={() => (summon(k), setOpen(false))} title={k}>
              {e}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- footer: the 1999 part

function Footer() {
  const g = useGame();
  const [visitors, setVisitors] = useState(() => 1337000 + Math.floor(Math.random() * 999));
  useEffect(() => {
    const h = setInterval(() => setVisitors((v) => v + Math.floor(Math.random() * 3)), 1300);
    return () => clearInterval(h);
  }, []);
  return (
    <footer className="adhd-footer">
      <div className="adhd-construction">🚧 UNDER CONSTRUCTION SINCE 1999 🚧</div>
      <div className="adhd-counter">
        YOU ARE VISITOR #
        {String(visitors)
          .padStart(8, "0")
          .split("")
          .map((d, i) => (
            <span key={i}>{d}</span>
          ))}
      </div>
      <div className="adhd-badges">
        {["BEST VIEWED AT 3AM", "MADE WITH 100% CAFFEINE", "NO THOUGHTS HEAD EMPTY", "HTML 4 LIFE", "Y2K READY", "SIGN MY GUESTBOOK"].map((b, i) => (
          <span key={b} className={`adhd-badge b${i}`}>
            {b}
          </span>
        ))}
      </div>
      <div className="adhd-fine">
        © 1999 Dopamine Industries · fake coins, real fun · progress saved in this browser ·{" "}
        <button
          className="adhd-linkbtn"
          onClick={() => {
            if (window.confirm("Reset all coins, upgrades and trophies?")) g.reset();
          }}
        >
          reset everything
        </button>
      </div>
    </footer>
  );
}
