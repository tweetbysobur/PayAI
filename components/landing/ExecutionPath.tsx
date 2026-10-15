"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The Execution Path — PayAI's hero visual.
 *
 * One continuous drawing of the product's idea, in five beats:
 *
 *   1. Intent      a loose scatter of short strokes (an intention, unstructured)
 *   2. Plan        the strokes turn and slide into place, assembling a route
 *   3. Structure   a solid line draws through it; five stages lock on, with
 *                  faint alignment guides extending from each
 *   4. Approval    a signal runs the route and STOPS at Your Wallet until the
 *                  node fills and a signature mark draws — nothing proceeds
 *                  without it
 *   5. Execution   the signal settles into a block at the end of the route
 *
 * Then it lives: the route stays solid purple and light keeps passing
 * through it — a ring opens from each stage it crosses, it waits at Your
 * Wallet while the node is ringed (the approval), and the block answers each
 * arrival as the frame's corners tighten for a beat. The clock only ticks
 * while the drawing is on screen. With reduced motion it renders the finished
 * drawing and never moves.
 *
 * Everything is computed from one clock `t` (seconds), so a frame is a pure
 * function of time; the scatter is seeded, so server and client render the
 * same first frame.
 */

/* ── Geometry (viewBox units) ─────────────────────────────────────────── */

const W = 400;
const H = 440;
/** The route: a descending, orthogonal path — the shape of "in order". */
const PTS: [number, number][] = [[70, 70], [70, 170], [210, 170], [210, 290], [330, 290], [330, 380]];
const SEG = PTS.slice(1).map((p, i) => Math.hypot(p[0] - PTS[i][0], p[1] - PTS[i][1]));
const CUM = SEG.reduce<number[]>((acc, l) => [...acc, acc[acc.length - 1] + l], [0]);
const LEN = CUM[CUM.length - 1];
const ROUTE_D = `M${PTS.map((p) => p.join(",")).join(" L")}`;

/** The five stages sit on the route's first five vertices. */
const STAGES = [
  { n: "01", label: "Intent", at: 0, lx: 18, ly: 4, anchor: "start" },
  { n: "02", label: "Plan", at: 1, lx: 14, ly: 24, anchor: "start" },
  { n: "03", label: "Review", at: 2, lx: 18, ly: 4, anchor: "start" },
  { n: "04", label: "Your wallet", at: 3, lx: -18, ly: 4, anchor: "end" },
  { n: "05", label: "Execution", at: 4, lx: -10, ly: -16, anchor: "end" },
] as const;
const WALLET_FRAC = CUM[3] / LEN;

function pointAt(frac: number): { x: number; y: number; dx: number; dy: number } {
  const d = Math.max(0, Math.min(1, frac)) * LEN;
  let i = 0;
  while (i < SEG.length - 1 && d > CUM[i + 1]) i++;
  const u = SEG[i] === 0 ? 0 : (d - CUM[i]) / SEG[i];
  const [x0, y0] = PTS[i];
  const [x1, y1] = PTS[i + 1];
  return { x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u, dx: (x1 - x0) / SEG[i], dy: (y1 - y0) / SEG[i] };
}

/* ── The scatter: seeded, so SSR and the first client frame agree ─────── */

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const STROKES = (() => {
  const rnd = seeded(0x9a1);
  const count = 34;
  const out: { x0: number; y0: number; a0: number; len: number; op: number; slot: number; x1: number; y1: number; a1: number }[] = [];
  for (let i = 0; i < count; i++) {
    // Slots along the route, kept clear of the corners.
    const frac = (i + 0.5) / count;
    const p = pointAt(frac);
    // Loose cloud around Intent, wider than it is tall — a thought, not a grid.
    const gx = (rnd() + rnd() + rnd()) / 3, gy = (rnd() + rnd() + rnd()) / 3;
    out.push({
      x0: 40 + gx * 250, y0: 26 + gy * 190,
      a0: rnd() * Math.PI,
      len: 6 + rnd() * 10,
      op: 0.35 + rnd() * 0.5,
      slot: frac,
      x1: p.x, y1: p.y, a1: Math.atan2(p.dy, p.dx),
    });
  }
  return out;
})();

/* ── Timeline (seconds) ───────────────────────────────────────────────── */

const T = {
  gatherStart: 0.55, gatherStagger: 0.032, gatherDur: 0.95,
  drawStart: 1.75, drawDur: 1.05,
  runStart: 2.95, runToWallet: 0.75,
  signHold: 0.55,
  runToEnd: 0.6,
  settle: 0.4,
};
const SIGN_AT = T.runStart + T.runToWallet;
const RESUME_AT = SIGN_AT + T.signHold;
const ARRIVE_AT = RESUME_AT + T.runToEnd;
export const EXECUTION_PATH_END = ARRIVE_AT + T.settle + 0.1;

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const span = (t: number, a: number, d: number) => clamp((t - a) / d);
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
function lerpAngle(a: number, b: number, u: number) {
  // Strokes are undirected: rotate by the shorter way modulo π.
  let d = (b - a) % Math.PI;
  if (d > Math.PI / 2) d -= Math.PI;
  if (d < -Math.PI / 2) d += Math.PI;
  return a + d * u;
}

/** Where the light is (route fraction) during the intro, and whether it's visible. */
function signalAt(t: number): { frac: number; on: boolean } {
  if (t < T.runStart) return { frac: 0, on: false };
  if (t < SIGN_AT) return { frac: easeInOut(span(t, T.runStart, T.runToWallet)) * WALLET_FRAC, on: true };
  if (t < RESUME_AT) return { frac: WALLET_FRAC, on: true };
  if (t < ARRIVE_AT) return { frac: WALLET_FRAC + easeInOut(span(t, RESUME_AT, T.runToEnd)) * (1 - WALLET_FRAC), on: true };
  return { frac: 1, on: false };
}

/* ── The living loop ──────────────────────────────────────────────────── */

/** After the intro, light keeps passing through the route: Intent → Plan →
 *  Review, a pause at Your Wallet (the approval), then on to Execution, where
 *  the block answers. Then a short rest, and again. */
const LOOP = { delay: 0.6, toWallet: 1.5, hold: 0.6, toEnd: 1.05, rest: 1.25 };
const LOOP_PERIOD = LOOP.toWallet + LOOP.hold + LOOP.toEnd + LOOP.rest;
const LOOP_ARRIVE = LOOP.toWallet + LOOP.hold + LOOP.toEnd;

function loopAt(phase: number): { frac: number; on: boolean } {
  if (phase < LOOP.toWallet) return { frac: easeInOut(phase / LOOP.toWallet) * WALLET_FRAC, on: true };
  if (phase < LOOP.toWallet + LOOP.hold) return { frac: WALLET_FRAC, on: true };
  if (phase < LOOP_ARRIVE) return { frac: WALLET_FRAC + easeInOut((phase - LOOP.toWallet - LOOP.hold) / LOOP.toEnd) * (1 - WALLET_FRAC), on: true };
  return { frac: 1, on: false };
}

/** The light at any moment: the intro run, then the loop. */
/** `holdU` is how far through the pause at Your Wallet the light is (0–1), else -1. */
function lightAt(t: number): { frac: number; on: boolean; holding: boolean; holdU: number; sinceArrive: number } {
  if (t < EXECUTION_PATH_END) {
    const s = signalAt(t);
    const holding = t >= SIGN_AT && t < RESUME_AT;
    return { ...s, holding, holdU: holding ? (t - SIGN_AT) / T.signHold : -1, sinceArrive: t - ARRIVE_AT };
  }
  const lt = t - EXECUTION_PATH_END - LOOP.delay;
  if (lt < 0) return { frac: 1, on: false, holding: false, holdU: -1, sinceArrive: t - ARRIVE_AT };
  const phase = lt % LOOP_PERIOD;
  const s = loopAt(phase);
  const holding = phase >= LOOP.toWallet && phase < LOOP.toWallet + LOOP.hold;
  return { ...s, holding, holdU: holding ? (phase - LOOP.toWallet) / LOOP.hold : -1, sinceArrive: phase - LOOP_ARRIVE };
}

/** Comet tail length: how far the light travelled in the last ~0.2s, so it
 *  stretches with speed and collapses when the light stops at the wallet. */
function tailAt(t: number): number {
  const a = lightAt(t), b = lightAt(t - 0.2);
  if (!a.on) return 0;
  return Math.max(0, Math.min(110, (a.frac - b.frac) * LEN));
}

/* Dashes use real lengths, never pathLength: Safari ignores pathLength in
   dash maths, which rendered the solid route as a dotted line there. */
const CHECK_LEN = 10;

/* ── Component ────────────────────────────────────────────────────────── */

export function ExecutionPath({ reduce, className = "" }: { reduce: boolean; className?: string }) {
  const [t, setT] = useState(0);
  const ref = useRef<SVGSVGElement>(null);
  const time = reduce ? EXECUTION_PATH_END : t;
  const done = time >= EXECUTION_PATH_END;

  // One clock: it starts when the drawing is on screen, and pauses (no frames
  // at all) whenever it scrolls out of view.
  useEffect(() => {
    if (reduce) return;
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let t0 = -1;
    let visible = false;
    const tick = (now: number) => {
      if (t0 < 0) t0 = now;
      setT((now - t0) / 1000);
      if (visible) raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((entries) => {
      const v = entries.some((e) => e.isIntersecting);
      if (v && !visible) { visible = true; raf = requestAnimationFrame(tick); }
      else if (!v && visible) { visible = false; cancelAnimationFrame(raf); }
    }, { threshold: 0.15 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [reduce]);

  const draw = easeInOut(span(time, T.drawStart, T.drawDur));
  const intro = signalAt(time);
  const executed = done ? 1 : time >= T.runStart ? intro.frac : 0;
  const signed = easeOut(span(time, SIGN_AT + 0.08, 0.32));
  const settle = easeOut(span(time, ARRIVE_AT - 0.05, T.settle));
  const light = reduce ? { frac: 1, on: false, holding: false, holdU: -1, sinceArrive: 99 } : lightAt(time);
  const lightD = light.frac * LEN;
  const tail = reduce ? 0 : tailAt(time);
  // The block's answer when the light arrives, and the frame tightening with it.
  const arrive = light.sinceArrive >= 0 && light.sinceArrive < 0.8 ? light.sinceArrive / 0.8 : -1;
  const frameIn = easeOut(span(time, 0.05, 0.7));
  const snap = arrive >= 0 ? Math.sin(Math.PI * arrive) * 3 : 0;
  const inset = (1 - frameIn) * 10 - snap;

  const dash = (len: number, upto: number) => ({ strokeDasharray: `${len} ${LEN * 3}`, strokeDashoffset: len - upto });

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      className={className}
      role="img"
      aria-label="An intent becomes a plan, is reviewed, approved by your wallet, and executed onchain."
    >
      {/* Alignment guides — structure emerging around each stage as it locks. */}
      <g stroke="currentColor" strokeWidth="1" className="text-frame" style={{ opacity: "var(--guide-opacity)" }} shapeRendering="crispEdges">
        {STAGES.map((s) => {
          const [x, y] = PTS[s.at];
          const u = easeOut(span(time, T.drawStart + (CUM[s.at] / LEN) * T.drawDur, 0.6));
          return (
            <g key={s.n}>
              <line x1={x} y1={y} x2={x + (W - x) * u} y2={y} />
              <line x1={x} y1={y} x2={x - x * u} y2={y} />
              <line x1={x} y1={y} x2={x} y2={y + (H - y) * u} />
              <line x1={x} y1={y} x2={x} y2={y - y * u} />
            </g>
          );
        })}
      </g>

      {/* Ruler ticks where the guides meet the frame. */}
      <g stroke="currentColor" strokeWidth="1" className="text-tick" shapeRendering="crispEdges"
        opacity={0.55 * easeOut(span(time, T.drawStart + 0.4, 0.6))}>
        {[...new Set(PTS.slice(0, 5).map((p) => p[0]))].map((x) => (
          <g key={`x${x}`}><line x1={x} y1={0} x2={x} y2={6} /><line x1={x} y1={H - 6} x2={x} y2={H} /></g>
        ))}
        {[...new Set(PTS.slice(0, 5).map((p) => p[1]))].map((y) => (
          <g key={`y${y}`}><line x1={0} y1={y} x2={6} y2={y} /><line x1={W - 6} y1={y} x2={W} y2={y} /></g>
        ))}
      </g>

      {/* The frame: four sharp registration corners. They slide in at the
          start and tighten for a beat each time an action executes. */}
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" className="text-frame"
        opacity={0.7 * frameIn} fill="none" shapeRendering="crispEdges">
        <path d={`M${12 - inset},${30 - inset} V${12 - inset} H${30 - inset}`} />
        <path d={`M${W - 30 + inset},${12 - inset} H${W - 12 + inset} V${30 - inset}`} />
        <path d={`M${12 - inset},${H - 30 + inset} V${H - 12 + inset} H${30 - inset}`} />
        <path d={`M${W - 30 + inset},${H - 12 + inset} H${W - 12 + inset} V${H - 30 + inset}`} />
      </g>

      {/* 1–2. The scatter gathering into the route. */}
      <g stroke="currentColor" strokeLinecap="round" className="text-frame">
        {STROKES.map((s, i) => {
          const u = easeInOut(span(time, T.gatherStart + i * T.gatherStagger, T.gatherDur));
          const drift = (1 - u) * 3;
          const cx = s.x0 + (s.x1 - s.x0) * u + Math.sin(time * 1.4 + i) * drift;
          const cy = s.y0 + (s.y1 - s.y0) * u + Math.cos(time * 1.1 + i * 1.7) * drift;
          const a = lerpAngle(s.a0, s.a1, u);
          const half = (s.len + (9 - s.len) * u) / 2;
          // Once the solid line has passed a stroke, the stroke dissolves into it.
          const passed = clamp((draw - s.slot) / 0.06);
          const op = (s.op + (0.7 - s.op) * u) * (1 - passed);
          if (op <= 0.01) return null;
          return (
            <line key={i} x1={cx - Math.cos(a) * half} y1={cy - Math.sin(a) * half} x2={cx + Math.cos(a) * half} y2={cy + Math.sin(a) * half}
              strokeWidth={1.5} opacity={op} />
          );
        })}
      </g>

      {/* 3. The route, drawn; then the executed part of it, solid purple. */}
      <path d={ROUTE_D} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="miter" className="text-frame"
        opacity="0.3" {...dash(LEN, draw * LEN)} />
      {executed > 0 && (
        <path d={ROUTE_D} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="miter" strokeLinecap="butt" className="text-primary"
          {...dash(LEN, executed * LEN)} />
      )}

      {/* The light: a crisp head with a tail that bends round the corners. */}
      {light.on && (
        <g fill="none" stroke="hsl(var(--spark))" strokeLinejoin="miter" strokeLinecap="butt">
          {/* A lavender afterglow on the line the light has just charged… */}
          {tail > 1 && <path d={ROUTE_D} strokeWidth="2.5" className="text-primary-ink" stroke="currentColor" opacity="0.6" {...dash(tail * 2.4, lightD)} />}
          {/* …and the light itself, stacked thinner and brighter toward the head. */}
          {tail > 1 && [1, 0.75, 0.5, 0.32, 0.18].map((k, i) => (
            <path key={k} d={ROUTE_D} strokeWidth={2.5 + i * 0.2} opacity={0.16 + i * 0.2} {...dash(tail * k, lightD)} />
          ))}
        </g>
      )}

      {/* Stages. */}
      {STAGES.map((s) => {
        const [x, y] = PTS[s.at];
        const lockAt = T.drawStart + (CUM[s.at] / LEN) * T.drawDur;
        const u = easeOut(span(time, lockAt - 0.05, 0.4));
        const reached = executed >= CUM[s.at] / LEN - 0.001 && time >= T.runStart;
        const isWallet = s.at === 3;
        // How far the light has gone past this stage: drives a ring that opens out from it.
        const past = light.on ? (lightD - CUM[s.at]) / 80 : -1;
        const ring = !isWallet && past >= 0 && past < 1 ? past : -1;
        const lit = light.on && (Math.abs(lightD - CUM[s.at]) < 10 || (isWallet && light.holding));
        return (
          <g key={s.n} opacity={u}>
            {ring >= 0 && (
              <circle cx={x} cy={y} r={7 + 12 * easeOut(ring)} fill="none" stroke="currentColor" className="text-primary-ink"
                strokeWidth="1.25" opacity={0.9 * (1 - ring)} />
            )}
            <circle cx={x} cy={y} r={3.5 + 3.5 * u} className={lit ? "text-spark" : reached ? "text-primary" : "text-frame"} stroke="currentColor"
              strokeWidth="1.5" fill="hsl(var(--background))" />
            {!isWallet && reached && <circle cx={x} cy={y} r={lit ? 2.6 : 1.8} fill={lit ? "hsl(var(--spark))" : "currentColor"} className="text-primary" />}
            {isWallet && (
              <>
                {/* The approval beat: while the light waits here, a square
                    signature frame closes in on the node. */}
                {light.holdU >= 0 && (() => {
                  const k = 26 - 12 * easeOut(light.holdU);
                  return (
                    <rect x={x - k / 2} y={y - k / 2} width={k} height={k} fill="none" stroke="currentColor" className="text-primary-ink"
                      strokeWidth="1.25" shapeRendering="crispEdges" opacity={Math.sin(Math.PI * light.holdU)} />
                  );
                })()}
                {lit && <circle cx={x} cy={y} r={10.5} fill="none" stroke="hsl(var(--spark))" strokeWidth="1.5" />}
                <circle cx={x} cy={y} r={7.5 * signed} className="text-primary" fill="currentColor" />
                <path d={`M${x - 3.2},${y + 0.2} L${x - 0.8},${y + 2.6} L${x + 3.4},${y - 2.4}`} fill="none"
                  stroke="white" strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter"
                  strokeDasharray={`${CHECK_LEN} ${CHECK_LEN}`} strokeDashoffset={CHECK_LEN * (1 - easeOut(span(time, SIGN_AT + 0.25, 0.3)))} />
              </>
            )}
            <text
              x={x + s.lx} y={y + s.ly} textAnchor={s.anchor}
              transform={`translate(${(1 - u) * (s.anchor === "end" ? 4 : -4)} 0)`}
              className="font-mono uppercase" fontSize="10" letterSpacing="0.12em"
            >
              <tspan className="fill-primary-ink">{s.n}</tspan>
              <tspan dx="7" className={lit ? "fill-spark" : reached || done ? "fill-foreground" : "fill-muted-foreground"}>{s.label}</tspan>
            </text>
          </g>
        );
      })}

      {/* 5. Settled: a block at the end of the route, with registration ticks.
          It answers each arrival with a square that opens out from it. */}
      {(() => {
        const [x, y] = PTS[PTS.length - 1];
        const s = 15;
        const o = arrive >= 0 ? 15 + 18 * easeOut(arrive) : 0;
        return (
          <g opacity={settle} shapeRendering="crispEdges">
            {arrive >= 0 && (
              <rect x={x - o / 2} y={y - o / 2} width={o} height={o} fill="none" stroke="currentColor" className="text-primary"
                strokeWidth="1" opacity={0.85 * (1 - arrive)} />
            )}
            <rect x={x - s / 2} y={y - s / 2} width={s} height={s} className={arrive >= 0 && arrive < 0.25 ? "text-spark" : "text-primary"} fill="currentColor"
              transform={`rotate(${(1 - settle) * 45} ${x} ${y})`} />
            <g stroke="currentColor" className="text-tick" strokeWidth="1">
              <line x1={x - 20} y1={y} x2={x - 13} y2={y} /><line x1={x + 13} y1={y} x2={x + 20} y2={y} />
              <line x1={x} y1={y + 13} x2={x} y2={y + 20} />
            </g>
          </g>
        );
      })()}

      {/* The light's head — drawn last so it sits above the nodes it passes. */}
      {/* While it waits at Your Wallet the node itself lights up instead. */}
      {light.on && !light.holding && (() => {
        const p = pointAt(light.frac);
        return (
          <g>
            <circle cx={p.x} cy={p.y} r={light.holding ? 10 : 7} fill="none" stroke="currentColor" className="text-primary-ink" strokeWidth="1" opacity={light.holding ? 0.9 : 0.6} />
            <circle cx={p.x} cy={p.y} r={3.2} fill="hsl(var(--spark))" />
          </g>
        );
      })()}
    </svg>
  );
}
