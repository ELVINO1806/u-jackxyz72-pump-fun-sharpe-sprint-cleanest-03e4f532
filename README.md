# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

![competition](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ELVINO1806/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ELVINO1806/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)

A paper-trading bot for the [Pump.fun Sharpe Sprint competition on make.fun](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).
It trades a 6-hour pump.fun forward replay, ranked by hourly Sharpe ratio.

## Strategy

Dip-bounce reversion, tuned for a smooth equity curve rather than max PnL:

- For every mint, track the recent peak price (300-slot window) and the trough
  after that peak.
- Buy one small probe (0.08 SOL) only when the price has fallen at least 12%
  off its peak, bounced at least 5% off the trough, is still at least 10%
  below the peak, and the last trade was a buy — one probe per coin, ever.
- Exit on a +22% take-profit, a −8% stop, a trailing lock-in (once +12%,
  sell after giving back 5 points), or a 1500-slot hold limit.
- At most 5 open positions. Fully deterministic: decisions use only slot
  numbers and reserve data from each batch of orders per slot.

## Run

The entrypoint is `main.ts` (Node 22, TypeScript run as-is). It speaks the
`agent-fun/replay/v2` protocol via the vendored shim in `vendor/`.

## Dev results (kit grader, process driver)

- Sharpe (hourly): +0.144
- Net PnL: +0.161 SOL
- Round trips: 142 across 142 distinct mints, win rate 40.1%
- Max drawdown: 1.6%
