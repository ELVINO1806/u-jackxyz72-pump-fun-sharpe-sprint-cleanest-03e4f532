// Pump.fun Sharpe Sprint — dip-bounce reversion bot.
//
// Idea, in one paragraph: most pump.fun curves spike, sag, and then bounce
// part of the way back. This bot waits for that shape instead of chasing the
// spike. For every mint it tracks the recent peak price and the trough after
// the peak; it buys a small probe only once the price has fallen well off the
// peak AND bounced clearly off the trough. It then exits on a wide take-profit,
// a tighter stop, a trailing lock-in once a gain has formed, or a hold limit,
// whichever comes first. Small probes, wide exits and a five-position cap keep
// the equity curve smooth, which is what hourly Sharpe rewards, and trading
// broadly across many mints keeps any single coin from dominating the result.
//
// Determinism: all decisions use only slot numbers and reserve data delivered
// in the batch; no clock, no environment, no unseeded randomness. Iteration
// order is the harness's own first-seen order, so two runs produce identical
// batches of orders per slot.

import { runBot, LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";
import type { Batch, BotState } from "./vendor/makefun-bot.ts";

// ---- tuned parameters (swept with grade-local; see work/ sweep notes) ----
const PROBE_LAMPORTS = 80_000_000n; // 0.08 SOL per probe
const DIP_MIN = 0.12; // price must fall >=12% from its recent peak
const BOUNCE_MIN = 0.05; // ... and bounce >=5% off the trough after the peak
const STILL_BELOW_PEAK = 0.1; // ... while still >=10% below that peak
const PEAK_WINDOW_SLOTS = 300; // peak is only trusted for this many slots
const TROUGH_FRESH_SLOTS = 600; // trough must be recent: a live bounce, not stale
const MIN_TRADES = 12; // ignore curves with almost no trading history
const MIN_REAL_SOL = 500_000_000n; // >=0.5 SOL real reserves (liquidity floor)
const MIN_AGE_SLOTS = 10; // ignore a curve in its first few slots
const TAKE_PROFIT = 0.22; // sell at +22% mark-to-market
const STOP_LOSS = -0.08; // sell at -8% mark-to-market
const TRAIL_TRIGGER = 0.12; // once +12%, lock in gains
const TRAIL_GIVEBACK = 0.05; // ... sell if it gives back 5pts from the peak gain
const MAX_HOLD_SLOTS = 1500; // time stop: ~10 minutes of slots
const MAX_ENTRIES_PER_MINT = 1; // one probe per coin: re-entries into losers cost more than they earn
const COOLDOWN_SLOTS = 300; // wait this long after an exit before re-entering
const MAX_OPEN = 5;
const SLIPPAGE_BPS = 300;

interface MintTrack {
  peak: number;
  peakSlot: number;
  trough: number;
  troughSlot: number;
  firstSlot: number;
  trades: number;
  entries: number;
  cooldownUntil: number;
  lastIsBuy: boolean;
}

interface HeldTrack {
  entrySlot: number;
  peakPnl: number;
}

const tracks = new Map<string, MintTrack>();
const held = new Map<string, HeldTrack>();

function priceOf(state: BotState, mint: string): number {
  const c = state.curves.get(mint);
  if (!c) return 0;
  if (c.virtual_token_reserves <= 0n || c.virtual_quote_reserves <= 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function trackFor(mint: string, slot: number): MintTrack {
  let t = tracks.get(mint);
  if (!t) {
    t = {
      peak: 0,
      peakSlot: slot,
      trough: Number.POSITIVE_INFINITY,
      troughSlot: slot,
      firstSlot: slot,
      trades: 0,
      entries: 0,
      cooldownUntil: 0,
      lastIsBuy: false,
    };
    tracks.set(mint, t);
  }
  return t;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const slot = batch.slot;

    // 1) Fold this slot's events into per-mint peak / trough tracking.
    for (const e of batch.events) {
      if (e.event === "CompleteEvent") {
        tracks.delete(e.mint);
        held.delete(e.mint);
        continue;
      }
      if (e.event !== "TradeEvent") continue;
      const t = trackFor(e.mint, slot);
      // Price this trade from ITS OWN post-trade reserves: reading the bot
      // state here would give every trade in the batch the same end-of-batch
      // price and hide the intra-slot dip/bounce path.
      const vq = BigInt(e.virtual_quote_reserves);
      const vt = BigInt(e.virtual_token_reserves);
      if (vq <= 0n || vt <= 0n) continue;
      const p = Number(vq) / Number(vt);
      t.trades += 1;
      t.lastIsBuy = e.is_buy;
      if (slot - t.peakSlot > PEAK_WINDOW_SLOTS) {
        // Peak is stale: restart the window at the current price.
        t.peak = p;
        t.peakSlot = slot;
        t.trough = p;
        t.troughSlot = slot;
      } else if (p > t.peak) {
        t.peak = p;
        t.peakSlot = slot;
        t.trough = p;
        t.troughSlot = slot;
      } else if (p < t.trough) {
        t.trough = p;
        t.troughSlot = slot;
      }
    }

    const out: {
      side: "buy" | "sell";
      mint: string;
      quote_lamports?: bigint;
      token_amount?: bigint;
      max_slippage_bps: number;
    }[] = [];

    // 2) Exits first: every held position is checked against TP / stop /
    //    trailing lock-in / hold limit. Selling frees a slot for new probes.
    //    A sell already in flight is deliberately re-sent while its outcome
    //    is unknown: if the first is rejected for slippage, the duplicate
    //    resolves one slot sooner than a fresh retry; the engine rejects a
    //    duplicate for free once the first has filled.
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const p = priceOf(state, mint);
      if (p <= 0) continue;
      const value = Number(pos.token_amount) * p;
      const pnl = value / Number(pos.cost_lamports) - 1;
      const h = held.get(mint);
      const entrySlot = h ? h.entrySlot : slot;
      const peakPnl = h ? Math.max(h.peakPnl, pnl) : pnl;
      if (h) h.peakPnl = peakPnl;
      const agedOut = slot - entrySlot >= MAX_HOLD_SLOTS;
      const trailing =
        peakPnl >= TRAIL_TRIGGER && pnl <= peakPnl - TRAIL_GIVEBACK;
      if (pnl >= TAKE_PROFIT || pnl <= STOP_LOSS || trailing || agedOut) {
        out.push({
          side: "sell",
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        const t = tracks.get(mint);
        if (t) t.cooldownUntil = slot + COOLDOWN_SLOTS;
        held.delete(mint);
      }
    }

    // 3) Entries: scan mints in first-seen order and buy the dip-bounce
    //    shape, one small probe each, until the position cap is reached.
    const soldMints = new Set(out.filter((o) => o.side === "sell").map((o) => o.mint));
    // Mints with a buy already in flight (pending is keyed by client id).
    const pendingBuyMints = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === "buy") pendingBuyMints.add(p.order.mint);
    }
    let open = state.committedPositionCount() - soldMints.size;
    if (open < 0) open = 0;
    const freeCash = state.freeCashLamports();
    const txFee = state.txFeeLamports();
    const affordable =
      freeCash >= PROBE_LAMPORTS + txFee * 2n;

    if (affordable) {
      for (const [mint, curve] of state.curves) {
        if (open >= MAX_OPEN) break;
        if (out.length >= 16) break;
        if (curve.complete) continue;
        if (state.positions.has(mint)) continue;
        if (pendingBuyMints.has(mint)) continue;
        if (soldMints.has(mint)) continue;
        const t = tracks.get(mint);
        if (!t) continue;
        if (t.trades < MIN_TRADES) continue;
        if (slot - t.firstSlot < MIN_AGE_SLOTS) continue;
        if (t.entries >= MAX_ENTRIES_PER_MINT) continue;
        if (slot < t.cooldownUntil) continue;
        if (slot - t.troughSlot > TROUGH_FRESH_SLOTS) continue;
        if (!t.lastIsBuy) continue; // bounce must be driven by buyers
        if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
        const p = priceOf(state, mint);
        if (p <= 0 || t.peak <= 0 || t.trough <= 0 || t.trough === Number.POSITIVE_INFINITY) continue;
        const dip = (t.peak - t.trough) / t.peak;
        const bounce = (p - t.trough) / t.trough;
        const belowPeak = (t.peak - p) / t.peak;
        if (dip < DIP_MIN) continue;
        if (bounce < BOUNCE_MIN) continue;
        if (belowPeak < STILL_BELOW_PEAK) continue;
        // Size cap: never spend more than the harness allows on this mint.
        const cap = state.maxBuyLamports(mint);
        if (cap < PROBE_LAMPORTS) continue;
        if (state.freeCashLamports() < PROBE_LAMPORTS + txFee * 2n) break;
        out.push({
          side: "buy",
          mint,
          quote_lamports: PROBE_LAMPORTS,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        t.entries += 1;
        held.set(mint, { entrySlot: slot, peakPnl: 0 });
        open += 1;
      }
    }

    return out;
  },
});
