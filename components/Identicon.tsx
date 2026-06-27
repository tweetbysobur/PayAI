/**
 * Deterministic on-chain identicon — a blockies-style symmetric block avatar
 * derived purely from a wallet address, so the same address always renders the
 * same image (the way MetaMask/Etherscan show accounts). Pure SVG, no deps, no
 * network — just a hash of the address turned into colors + a 5×5 grid.
 */

/** xorshift128 PRNG seeded from the address — same address ⇒ same sequence. */
function makeRand(seed: string) {
  const s = new Int32Array([0x9e3779b9, 0x243f6a88, 0xb7e15162, 0xdeadbeef]);
  for (let i = 0; i < seed.length; i++) {
    const j = i & 3;
    s[j] = (s[j] ^ ((s[j] << 5) + (s[j] >> 2) + seed.charCodeAt(i))) | 0;
  }
  return () => {
    let t = s[3];
    const w = s[0];
    s[3] = s[2];
    s[2] = s[1];
    s[1] = w;
    t ^= t << 11;
    t ^= t >>> 8;
    s[0] = (t ^ w ^ (w >>> 19)) | 0;
    return (s[0] >>> 0) / 4294967296;
  };
}

function color(rand: () => number) {
  const h = Math.floor(rand() * 360);
  const sat = 50 + Math.floor(rand() * 35); // 50–85%
  const lum = 45 + Math.floor(rand() * 25); // 45–70%
  return `hsl(${h} ${sat}% ${lum}%)`;
}

const CELLS = 5;
const HALF = Math.ceil(CELLS / 2);
const UNIT = 100 / CELLS;

export function Identicon({ address, size = 20, className = "" }: { address: string; size?: number; className?: string }) {
  const rand = makeRand((address || "0x").toLowerCase());
  const bg = color(rand);
  const fg = color(rand);
  const spot = color(rand);

  // Build the mirrored left half, then read it symmetrically for each cell.
  const half: number[] = [];
  for (let i = 0; i < CELLS * HALF; i++) {
    const v = rand();
    half.push(v < 0.5 ? 0 : v < 0.88 ? 1 : 2); // 0 = bg, 1 = fg, 2 = accent
  }
  const cellAt = (x: number, y: number) => {
    const xx = x < HALF ? x : CELLS - 1 - x;
    return half[y * HALF + xx];
  };

  const rects = [];
  for (let y = 0; y < CELLS; y++) {
    for (let x = 0; x < CELLS; x++) {
      const v = cellAt(x, y);
      if (v === 0) continue;
      rects.push(
        <rect key={`${x}-${y}`} x={x * UNIT} y={y * UNIT} width={UNIT} height={UNIT} fill={v === 1 ? fg : spot} />,
      );
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      style={{ borderRadius: "50%" }}
      aria-hidden="true"
    >
      <rect width="100" height="100" fill={bg} />
      {rects}
    </svg>
  );
}
