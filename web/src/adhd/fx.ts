// Cheap effects for the ADHD tab: 8-bit sounds generated with WebAudio (no files) and a confetti canvas.

let audio: AudioContext | null = null;
let muted = false;
export const setMuted = (m: boolean) => void (muted = m);

function ac(): AudioContext | null {
  if (muted) return null;
  try {
    audio ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}

function tone(freq: number, dur = 0.08, type: OscillatorType = "square", vol = 0.05, at = 0, slide?: number) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}

const seq = (notes: number[], step: number, dur: number, type: OscillatorType = "square", vol = 0.05) =>
  notes.forEach((f, i) => tone(f, dur, type, vol, i * step));

export const sfx = {
  blip: () => tone(600 + Math.random() * 500, 0.05),
  click: () => tone(900 + Math.random() * 300, 0.03, "square", 0.04),
  coin: () => (tone(988, 0.06), tone(1319, 0.14, "square", 0.05, 0.06)),
  pop: () => tone(280 + Math.random() * 520, 0.07, "triangle", 0.09, 0, 70),
  tick: () => tone(1700, 0.015, "square", 0.03),
  win: () => seq([523, 659, 784, 1047], 0.08, 0.12),
  big: () => seq([392, 523, 659, 784, 1047, 1319], 0.07, 0.12),
  jackpot: () => (seq([523, 659, 784, 1047, 1319, 1568, 2093, 1568, 2093], 0.07, 0.1), tone(2093, 0.7, "triangle", 0.05, 0.65)),
  lose: () => seq([392, 370, 349, 311], 0.17, 0.2, "sawtooth", 0.04),
  bad: () => tone(110, 0.25, "sawtooth", 0.06, 0, 70),
  boom: () => (tone(160, 0.5, "sawtooth", 0.07, 0, 30), tone(90, 0.6, "square", 0.05, 0.02, 30)),
  levelup: () => seq([659, 784, 988, 1319, 1568], 0.06, 0.1, "triangle", 0.07),
  alert: () => (tone(880, 0.1, "square", 0.05), tone(660, 0.1, "square", 0.05, 0.12), tone(880, 0.1, "square", 0.05, 0.24)),
  whoosh: () => tone(200, 0.35, "sawtooth", 0.03, 0, 1600),
};

// ---------------------------------------------------------------- confetti

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
  life: number;
  emoji?: string;
};

const COLORS = ["#ff2d95", "#00e5ff", "#ffe600", "#39ff14", "#b026ff", "#ff6a00", "#ffffff"];
let canvas: HTMLCanvasElement | null = null;
let parts: Particle[] = [];
let raf = 0;
let last = 0;

export function mountConfetti(c: HTMLCanvasElement | null) {
  canvas = c;
  if (!c) {
    parts = [];
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

/** Burst of confetti at (x, y) in viewport pixels; `emoji` throws emoji instead of paper. */
export function confetti(x = window.innerWidth / 2, y = window.innerHeight / 3, n = 80, emoji?: string[]) {
  if (!canvas) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 4 + Math.random() * 9;
    parts.push({
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s - 6,
      rot: Math.random() * 360,
      vr: (Math.random() - 0.5) * 20,
      size: emoji ? 18 + Math.random() * 16 : 5 + Math.random() * 7,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      life: 1,
      emoji: emoji ? emoji[(Math.random() * emoji.length) | 0] : undefined,
    });
  }
  if (parts.length > 900) parts = parts.slice(-900);
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(step);
  }
}

function step(now: number) {
  const c = canvas;
  if (!c) return void (raf = 0);
  const dt = Math.min(3, (now - last) / 16.7);
  last = now;
  if (c.width !== window.innerWidth || c.height !== window.innerHeight) {
    c.width = window.innerWidth;
    c.height = window.innerHeight;
  }
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  parts = parts.filter((p) => p.life > 0 && p.y < c.height + 40);
  for (const p of parts) {
    p.vy += 0.35 * dt;
    p.vx *= 0.99;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.life -= 0.006 * dt;
    g.save();
    g.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
    g.translate(p.x, p.y);
    g.rotate((p.rot * Math.PI) / 180);
    if (p.emoji) {
      g.font = `${p.size}px serif`;
      g.fillText(p.emoji, -p.size / 2, p.size / 2);
    } else {
      g.fillStyle = p.color;
      g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    }
    g.restore();
  }
  raf = parts.length ? requestAnimationFrame(step) : 0;
  if (!raf) g.clearRect(0, 0, c.width, c.height);
}
