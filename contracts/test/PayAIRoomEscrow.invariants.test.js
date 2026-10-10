const { expect } = require("chai");
const hre = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Stateful, seeded random-operation testing on Hardhat's local EVM. NOT a
// substitute for a coverage-guided fuzzer (Echidna/Medusa/Foundry) — see the
// pre-audit package. Every operation runs against the real contract; a JS
// shadow model tracks what SHOULD be true, and the invariants are checked
// against on-chain state after every operation.
//
//  INV-1  a contributor never receives more than they contributed to a room
//  INV-2  a beneficiary never receives more than raised - fee for a room
//  INV-3  fees withdrawn per token never exceed fees accrued by claims
//  INV-4  a claim succeeds only for a completed, unclaimed room
//  INV-5  a room that wasn't completed is never claimed
//  INV-6  a completed room is never refunded
//  INV-7  raised == sum of every contribution ever accepted (no double counting)
//  INV-8  solvency: per token, escrow balance == unclaimed (raised - refunded) + sum of feesOwed
//  INV-9  (PA-11) whoever triggers claim(), the room's fixed beneficiary receives exactly raised - fee
//  INV-10 (PA-01) recoverFees conserves sum(feesOwed), moves value only to the CURRENT treasury,
//         transfers nothing, and only the owner can do it
//  INV-11 fees accrue to the room's snapshotted treasury (never the treasury current at claim time)
//  INV-12 (PA-05) a room is created iff its share / minContribution / target meet the token's floor at that
//         moment; every accepted contribution is >= the room's minimum or exactly the remainder

const SEEDS = (process.env.ESCROW_FUZZ_SEEDS || "1,2,3,4,5").split(",").map(Number);
const STEPS = Number(process.env.ESCROW_FUZZ_STEPS || 300);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

describe("PayAIRoomEscrow — stateful invariants (seeded)", function () {
  this.timeout(1_800_000);
  for (const seed of SEEDS) {
    it(`seed ${seed}: ${STEPS} random operations keep INV-1..INV-12`, async () => {
      const R = rng(seed);
      const pick = (arr) => arr[Math.floor(R() * arr.length)];
      const signers = await hre.ethers.getSigners();
      const [owner, tA, tB, tC, ...rest] = signers;
      const treasuries = [tA, tB, tC];
      const actors = rest.slice(0, 8);
      const escrow = await (await hre.ethers.getContractFactory("PayAIRoomEscrow")).deploy(owner.address, tA.address, 50, 10n ** 15n); // floors scaled to this suite's units
      const E = await escrow.getAddress();
      const token = await (await hre.ethers.getContractFactory("MockERC20")).deploy();
      const T = await token.getAddress();
      for (const a of actors) { await token.mint(a.address, 10n ** 15n); await token.connect(a).approve(E, 2n ** 255n); }
      await escrow.connect(owner).setTokenSupported(T, true);
      await escrow.connect(owner).setMinContributionFloor(T, 1000n);
      const Z = hre.ethers.ZeroAddress;
      const floor = { [Z]: 10n ** 15n, [T]: 1000n }; // shadow of minContributionFloor

      // Shadow model.
      let currentTreasury = tA.address;
      const rooms = [];
      const received = new Map();                // `${roomId}:${addr}` -> refunded to them
      const benReceived = new Map();             // roomId -> net paid
      const owed = new Map();                    // `${treasury}:${token}` -> fees owed
      const key = (t, tk) => `${t}:${tk}`;
      const owedOf = (t, tk) => owed.get(key(t, tk)) ?? 0n;
      const addOwed = (t, tk, v) => owed.set(key(t, tk), owedOf(t, tk) + v);
      const accrued = { [Z]: 0n, [T]: 0n }, withdrawn = { [Z]: 0n, [T]: 0n };
      const unit = (tk) => (tk === Z ? 10n ** 15n : 1000n);
      const ok = async (p) => { try { await (await p).wait(); return true; } catch { return false; } };
      const now = async () => BigInt(await time.latest());
      const balOf = (tk, who) => (tk === Z ? hre.ethers.provider.getBalance(who) : token.balanceOf(who));

      async function check() {
        let liab = { [Z]: 0n, [T]: 0n };
        for (const r of rooms) {
          const c = await escrow.getRoom(r.id);
          let sum = 0n; for (const v of r.contribAll.values()) sum += v;
          expect(c.raised).to.equal(sum, `INV-7 room ${r.id}`);
          expect(c.raised).to.equal(r.raised);
          expect(c.refunded).to.equal(r.refunded);
          expect(c.claimed).to.equal(r.claimed);
          expect(c.treasury).to.equal(r.treasury, `INV-11 snapshot room ${r.id}`);
          if (c.claimed) expect(c.completedAt).to.not.equal(0n, `INV-5 room ${r.id}`);
          if (c.completedAt !== 0n) expect(c.refunded).to.equal(0n, `INV-6 room ${r.id}`);
          expect(benReceived.get(r.id) ?? 0n).to.be.lte(r.raised - (r.raised * 50n) / 10000n, `INV-2 room ${r.id}`);
          if (!c.claimed) liab[r.token] += c.raised - c.refunded;
          for (const [k, got] of received) if (k.startsWith(`${r.id}:`)) expect(got).to.be.lte(r.contribAll.get(k.split(":")[1]) ?? 0n, `INV-1 ${k}`);
        }
        for (const tk of [Z, T]) {
          expect(withdrawn[tk]).to.be.lte(accrued[tk], "INV-3");
          let chainOwed = 0n;
          for (const t of treasuries) {
            const v = await escrow.feesOwed(t.address, tk);
            expect(v).to.equal(owedOf(t.address, tk), `fees owed ${t.address}`);
            chainOwed += v;
          }
          expect(chainOwed).to.equal(accrued[tk] - withdrawn[tk], "INV-10 conservation");
          expect(await balOf(tk, E)).to.equal(liab[tk] + chainOwed, `INV-8 ${tk === Z ? "MON" : "token"}`);
        }
      }

      const stats = { createBelowFloor: 0, setFloor: 0, belowMinRemainder: 0, create: 0, contribute: 0, claim: 0, claimByStranger: 0, refund: 0, cancel: 0, withdraw: 0, setTreasury: 0, recover: 0, warp: 0, rejected: 0 };
      for (let step = 0; step < STEPS; step++) {
        const roll = R();
        if (rooms.length < 2 || roll < 0.11) {
          const tk = R() < 0.5 ? Z : T;
          const u = unit(tk);
          const fixed = R() < 0.5;
          const creator = pick(actors), ben = pick(actors);
          const dl = (await now()) + BigInt((1 + Math.floor(R() * 4)) * 86400);
          const half = u / 2n;
          const share = fixed ? half * BigInt(1 + Math.floor(R() * 10)) : 0n;           // may fall below the floor
          const slots = fixed ? 2 + Math.floor(R() * 3) : 0;
          const target = fixed ? share * BigInt(slots) : (R() < 0.1 ? half : u * BigInt(5 + Math.floor(R() * 20)));
          const min = fixed ? 0n : pick([0n, 1n, half, u, u, 2n * u]);
          const f = floor[tk];
          const expectOk = fixed ? share >= f : target >= f && min >= f && min <= target;
          const did = await ok(escrow.connect(creator).createRoom(fixed ? 0 : 1, tk, ben.address, share, slots, target, min, dl, hre.ethers.id(`s${seed}-${step}`)));
          expect(did).to.equal(expectOk, `INV-12 createRoom vs floor (share ${share}, min ${min}, target ${target}, floor ${f})`);
          if (did) {
            rooms.push({ id: (await escrow.roomCount()) - 1n, token: tk, fixed, share, target, min, creator, ben, treasury: currentTreasury, contribAll: new Map(), contrib: new Map(), raised: 0n, refunded: 0n, completed: false, claimed: false, cancelled: false, deadline: dl });
            stats.create++;
          } else stats.createBelowFloor++;
        } else if (roll < 0.5) {
          const open = rooms.filter((x) => !x.completed && !x.cancelled);
          const r = R() < 0.8 && open.length ? pick(open) : pick(rooms), who = pick(actors);
          const remaining = r.target - r.raised;
          const amt = r.fixed ? (R() < 0.1 ? 1n : r.share)                       // 1-unit grief attempts too
            : (R() < 0.3 ? remaining : R() < 0.1 ? 1n
              : R() < 0.2 && remaining > r.min + 1n ? remaining - 1n - BigInt(Math.floor(R() * Number(r.min > 1000n ? 1000n : r.min))) // leave a sub-minimum remainder
              : unit(r.token) * BigInt(1 + Math.floor(R() * 8)) + (R() < 0.2 ? 1n : 0n));
          const t0 = await now();
          const expectOk = !r.cancelled && !r.completed && t0 + 1n < r.deadline && amt > 0n &&
            (r.fixed ? amt === r.share && !r.contribAll.get(who.address) : amt <= remaining && (amt >= r.min || amt === remaining));
          const did = await ok(escrow.connect(who).contribute(r.id, amt, r.token === Z ? { value: amt } : {}));
          if (did) {
            expect(amt >= (r.fixed ? r.share : r.min) || amt === remaining, `INV-12 accepted amount ${amt} below minimum (room ${r.id})`).to.equal(true);
            if (amt < (r.fixed ? r.share : r.min)) stats.belowMinRemainder++;
            r.raised += amt;
            r.contrib.set(who.address, (r.contrib.get(who.address) ?? 0n) + amt);
            r.contribAll.set(who.address, (r.contribAll.get(who.address) ?? 0n) + amt);
            if (r.raised === r.target) r.completed = true;
            stats.contribute++;
          } else stats.rejected++;
          if (expectOk) expect(did, `contribution should succeed (room ${r.id})`).to.equal(true);
        } else if (roll < 0.63) {
          const done = rooms.filter((x) => x.completed && !x.claimed);
          const r = R() < 0.7 && done.length ? pick(done) : pick(rooms);
          const caller = R() < 0.5 ? pick(actors) : (R() < 0.5 ? r.creator : owner); // anyone, including the owner
          const before = await balOf(r.token, r.ben.address);
          const callerBefore = r.token === T ? await token.balanceOf(caller.address) : 0n;
          const did = await ok(escrow.connect(caller).claim(r.id));
          if (did) {
            expect(r.completed && !r.claimed, `INV-4 claim of room ${r.id}`).to.equal(true);
            const f = (r.raised * 50n) / 10000n;
            r.claimed = true;
            accrued[r.token] += f;
            addOwed(r.treasury, r.token, f); // INV-11 at the SNAPSHOT
            benReceived.set(r.id, r.raised - f);
            if (caller.address !== r.ben.address) {
              expect((await balOf(r.token, r.ben.address)) - before).to.equal(r.raised - f, "INV-9 beneficiary paid exactly");
              if (r.token === T) expect(await token.balanceOf(caller.address)).to.equal(callerBefore, "INV-9 caller paid nothing");
            }
            if (caller.address !== r.creator.address && caller.address !== r.ben.address) stats.claimByStranger++;
            stats.claim++;
          } else {
            expect(r.completed && !r.claimed).to.equal(false, `eligible claim reverted (room ${r.id})`);
            stats.rejected++;
          }
        } else if (roll < 0.75) {
          const holders = rooms.flatMap((x) => [...x.contrib.entries()].filter(([, v]) => v > 0n).map(([addr]) => [x, addr]));
          let r, who;
          if (R() < 0.75 && holders.length) { const [x, addr] = pick(holders); r = x; who = actors.find((a) => a.address === addr); }
          else { r = pick(rooms); who = pick(actors); }
          const mine = r.contrib.get(who.address) ?? 0n;
          const t0 = await now();
          const eligible = !r.completed && (r.cancelled || t0 + 1n >= r.deadline) && mine > 0n;
          const did = await ok(escrow.connect(who).refund(r.id));
          if (did) {
            expect(!r.completed && mine > 0n, `refund of room ${r.id}`).to.equal(true);
            r.contrib.set(who.address, 0n);
            r.refunded += mine;
            received.set(`${r.id}:${who.address}`, (received.get(`${r.id}:${who.address}`) ?? 0n) + mine);
            stats.refund++;
          } else stats.rejected++;
          if (eligible && t0 + 2n < r.deadline) expect(did).to.equal(true);
        } else if (roll < 0.8) {
          const r = pick(rooms);
          const did = await ok(escrow.connect(R() < 0.8 ? r.creator : pick(actors)).cancel(r.id));
          if (did) { expect(r.completed).to.equal(false); r.cancelled = true; stats.cancel++; } else stats.rejected++;
        } else if (roll < 0.86) {
          const tk = R() < 0.5 ? Z : T, t = pick(treasuries).address;
          const due = owedOf(t, tk);
          const before = await balOf(tk, t);
          const did = await ok(escrow.connect(pick(actors)).withdrawFees(t, tk));
          if (did) {
            expect(due).to.be.greaterThan(0n);
            if (tk === T) expect((await token.balanceOf(t)) - before).to.equal(due);
            owed.set(key(t, tk), 0n); withdrawn[tk] += due; stats.withdraw++;
          } else { expect(due).to.equal(0n); stats.rejected++; }
        } else if (roll < 0.89) {
          const t = pick(treasuries).address;
          await (await escrow.connect(owner).setTreasury(t)).wait();
          currentTreasury = t; stats.setTreasury++;
        } else if (roll < 0.93) {
          // 70%: a non-current treasury that actually holds fees (meaningful); else random.
          const candidates = treasuries.flatMap((t) => [Z, T].map((x) => [t.address, x])).filter(([t, x]) => t !== currentTreasury && owedOf(t, x) > 0n);
          const [from, tk] = R() < 0.7 && candidates.length ? pick(candidates) : [pick(treasuries).address, R() < 0.5 ? Z : T];
          const stranger = R() < 0.2;
          const due = owedOf(from, tk);
          const balBefore = await balOf(tk, E);
          const did = await ok(escrow.connect(stranger ? pick(actors) : owner).recoverFees(from, tk));
          if (did) {
            expect(stranger, "INV-10 only the owner recovers").to.equal(false);
            expect(from !== currentTreasury && due > 0n).to.equal(true);
            owed.set(key(from, tk), 0n); addOwed(currentTreasury, tk, due);
            expect(await balOf(tk, E)).to.equal(balBefore, "INV-10 recovery transfers nothing");
            stats.recover++;
          } else stats.rejected++;
        } else if (roll < 0.95) {
          // Owner changes a floor (future rooms only); strangers can't.
          const tk = R() < 0.5 ? Z : T, u = unit(tk);
          const v = pick([u / 2n, u, 2n * u]);
          const stranger = R() < 0.2;
          const did = await ok(escrow.connect(stranger ? pick(actors) : owner).setMinContributionFloor(tk, v));
          expect(did).to.equal(!stranger, "INV-12 only the owner sets floors");
          if (did) { floor[tk] = v; stats.setFloor++; } else stats.rejected++;
          expect(await escrow.minContributionFloor(tk)).to.equal(floor[tk]);
        } else {
          await time.increase(Math.floor(R() * 2 * 86400));
          stats.warp++;
        }
        await check();
      }
      console.log(`      seed ${seed}:`, JSON.stringify(stats));
    });
  }
});
