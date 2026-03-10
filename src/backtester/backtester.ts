/**
 * ⚡ SOVEREIGN FOREX PRIME — BACKTESTER v1.0
 *
 * Runs Brain 2.5 + ICT Silver Bullet logic over historical candle data.
 * Supports: multi-pair, multi-timeframe, slippage, commission, risk sizing.
 * Data source: OANDA v20 API (fetches up to 5000 candles per request).
 *
 * Metrics: Win Rate, Profit Factor, Max Drawdown, Avg Trades/Day,
 *          Sharpe Ratio, $3K/week projection.
 */

// ── TYPES ──────────────────────────────────────────────────────────────────

export interface BacktestCandle {
    time: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

export interface BacktestConfig {
    pair:             string;           // e.g. 'EUR_USD'
  timeframe:        'M5' | 'M15' | 'H1';
    startDate:        Date;
    endDate:          Date;
    initialBalance:   number;           // e.g. 100000
  riskPercent:      number;           // e.g. 1  (= 1%)
  stopLossPips:     number;           // e.g. 20
  takeProfitRatio:  number;           // e.g. 2  (2:1 RR)
  minConfluence:    number;           // e.g. 65
  slippagePips:     number;           // e.g. 1
  commissionPips:   number;           // e.g. 0.5 (spread equivalent)
  silverBulletOnly: boolean;          // only trade ICT windows
}

export interface BacktestTrade {
    id:           number;
    pair:         string;
    timeframe:    string;
    entryTime:    Date;
    exitTime:     Date;
    direction:    'LONG' | 'SHORT';
    entryPrice:   number;
    exitPrice:    number;
    stopLoss:     number;
    takeProfit:   number;
    lotSize:      number;
    units:        number;
    riskUSD:      number;
    pnl:          number;
    pips:         number;
    result:       'WIN' | 'LOSS' | 'BE';
    confluenceScore: number;
    signals:      string[];
    grade:        string;
}

export interface BacktestResult {
    config:           BacktestConfig;
    trades:           BacktestTrade[];
    // ── PERFORMANCE ──
  totalTrades:      number;
    wins:             number;
    losses:           number;
    breakevens:       number;
    winRate:          number;           // %
  profitFactor:     number;
    netPnL:           number;
    grossProfit:      number;
    grossLoss:        number;
    maxDrawdown:      number;           // %
  maxDrawdownUSD:   number;
    peakBalance:      number;
    finalBalance:     number;
    returnPct:        number;
    sharpeRatio:      number;
    avgWin:           number;
    avgLoss:          number;
    avgRR:            number;
    avgTradesPerDay:  number;
    weeklyProjection: number;           // $
  bestTrade:        number;
    worstTrade:       number;
    consecutiveWins:  number;
    consecutiveLosses:number;
    // ── BY TIMEFRAME / PAIR ──
  byGrade:          Record<string, { trades: number; wins: number; pnl: number }>;
    bySignal:         Record<string, { trades: number; wins: number }>;
    equityCurve:      { time: string; balance: number; drawdown: number }[];
    durationMs:       number;
}

// ── HELPER UTILITIES ───────────────────────────────────────────────────────

function getPipSize(pair: string): number {
    if (pair.includes('JPY')) return 0.01;
    if (pair.startsWith('XAU_')) return 0.1;
    return 0.0001;
}

function pipsToDelta(pair: string, pips: number): number {
    return pips * getPipSize(pair);
}

function isSilverBulletWindow(date: Date): { hit: boolean; label: string | null } {
    const h = date.getUTCHours();
    const windows = [
      { start: 7,  end: 9,  label: 'London AM' },
      { start: 13, end: 15, label: 'NY AM'      },
      { start: 19, end: 21, label: 'NY PM'      },
        ];
    for (const w of windows) {
          if (h >= w.start && h < w.end) return { hit: true, label: w.label };
    }
    return { hit: false, label: null };
}

// ── FVG DETECTION (mirrors BrainEngine) ───────────────────────────────────

interface FVG {
    direction: 'bullish' | 'bearish';
    top:       number;
    bottom:    number;
    size:      number;
    index:     number;
    fresh:     boolean;
}

function detectFVGs(candles: BacktestCandle[]): FVG[] {
    const fvgs: FVG[] = [];
    for (let i = 2; i < candles.length; i++) {
          const c0 = candles[i - 2];
          const c2 = candles[i];
          // Bullish FVG
      if (c0.high < c2.low) {
              fvgs.push({
                        direction: 'bullish',
                        top:    c2.low,
                        bottom: c0.high,
                        size:   c2.low - c0.high,
                        index:  i,
                        fresh:  true,
              });
      }
          // Bearish FVG
      if (c0.low > c2.high) {
              fvgs.push({
                        direction: 'bearish',
                        top:    c0.low,
                        bottom: c2.high,
                        size:   c0.low - c2.high,
                        index:  i,
                        fresh:  true,
              });
      }
    }
    return fvgs;
}

// ── CONFLUENCE SCORER (mirrors BrainEngine) ────────────────────────────────

function scoreConfluence(
    fvgs: FVG[],
    silver: boolean,
    mid: number,
  ): { score: number; signals: string[] } {
    let score = 0;
    const signals: string[] = [];

  if (silver)                  { score += 20; signals.push('Silver Bullet Window'); }
    if (fvgs.length > 0)         { score += 25; signals.push('FVG Present'); }

  const largeFVG = fvgs.some(f => f.size > mid * 0.0005);
    if (largeFVG)                { score += 10; signals.push('Large FVG'); }

  const freshCount = fvgs.filter(f => f.fresh).length;
    if (freshCount > 0)          { score += 15; signals.push('Fresh Imbalance'); }

  // Trend momentum proxy: price above midpoint of FVG range
  if (fvgs.length >= 2) {
        const dirs = fvgs.slice(-3).map(f => f.direction);
        const allSame = dirs.every(d => d === dirs[0]);
        if (allSame)               { score += 10; signals.push('Directional Momentum'); }
  }

  if (score >= 80)             signals.push('High Confluence');

  return { score: Math.min(99, score), signals };
}

function deriveVerdict(
    fvgs: FVG[],
    mid: number,
    silver: boolean,
  ): 'LONG' | 'SHORT' | 'WAIT' {
    if (!fvgs.length) return 'WAIT';
    const last = fvgs[fvgs.length - 1];
    if (silver) return last.direction === 'bullish' ? 'LONG' : 'SHORT';
    if (last.direction === 'bullish' && mid < last.bottom) return 'LONG';
    if (last.direction === 'bearish' && mid > last.top)   return 'SHORT';
    return 'WAIT';
}

function gradeSetup(score: number): string {
    if (score >= 85) return 'A+';
    if (score >= 75) return 'A';
    if (score >= 65) return 'B';
    return 'C';
}

// ── LOT / RISK CALCULATOR ──────────────────────────────────────────────────

function calcUnits(
    balance:      number,
    riskPct:      number,
    slPips:       number,
    pair:         string,
  ): { units: number; lotSize: number; dollarRisk: number } {
    const riskUSD    = balance * (riskPct / 100);
    const pipSize    = getPipSize(pair);
    const unitsFloat = riskUSD / (slPips * pipSize);
    const units      = Math.round(unitsFloat);
    return { units, lotSize: units / 100_000, dollarRisk: riskUSD };
}

// ── CANDLE FETCHER (uses OANDA v20 REST) ──────────────────────────────────

const OANDA_PRACTICE_BASE = 'https://api-fxpractice.oanda.com/v3';

async function fetchCandles(
    pair:       string,
    timeframe:  string,
    from:       Date,
    to:         Date,
    apiKey:     string,
  ): Promise<BacktestCandle[]> {
    const allCandles: BacktestCandle[] = [];
    let cursor = new Date(from);
    const granMap: Record<string, number> = {
          M5: 5, M15: 15, H1: 60,
    };
    const minutesPerCandle = granMap[timeframe] ?? 15;
    const maxPerBatch = 4500; // OANDA limit ~5000, stay safe

  while (cursor < to) {
        const batchEnd = new Date(
                Math.min(
                          cursor.getTime() + maxPerBatch * minutesPerCandle * 60 * 1000,
                          to.getTime(),
                        ),
              );

      const url = new URL(`${OANDA_PRACTICE_BASE}/instruments/${pair}/candles`);
        url.searchParams.set('granularity', timeframe);
        url.searchParams.set('from', cursor.toISOString());
        url.searchParams.set('to',   batchEnd.toISOString());
        url.searchParams.set('price', 'M');
        url.searchParams.set('count', String(maxPerBatch));

      const res = await fetch(url.toString(), {
              headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!res.ok) {
              const txt = await res.text();
              throw new Error(`OANDA candle fetch failed: ${res.status} ${txt}`);
      }

      const data = await res.json() as { candles: any[] };
        const batch: BacktestCandle[] = (data.candles ?? [])
          .filter((c: any) => c.complete)
          .map((c: any) => ({
                    time:   new Date(c.time),
                    open:   parseFloat(c.mid.o),
                    high:   parseFloat(c.mid.h),
                    low:    parseFloat(c.mid.l),
                    close:  parseFloat(c.mid.c),
          }));

      allCandles.push(...batch);
        if (batch.length < 2) break;
        cursor = new Date(batch[batch.length - 1].time.getTime() + 1000);
  }

  return allCandles;
}

// ── MAIN BACKTESTER ────────────────────────────────────────────────────────

export async function runBacktest(
    cfg:    BacktestConfig,
    apiKey: string,
  ): Promise<BacktestResult> {
    const t0 = Date.now();

  // 1. Fetch historical candles
  const candles = await fetchCandles(
        cfg.pair, cfg.timeframe, cfg.startDate, cfg.endDate, apiKey,
      );

  if (candles.length < 50) {
        throw new Error(
                `Not enough candles for ${cfg.pair} ${cfg.timeframe}: got ${candles.length}`,
              );
  }

  // 2. Walk-forward simulation
  const trades: BacktestTrade[] = [];
    let balance = cfg.initialBalance;
    let peak    = balance;
    let tradeId = 0;

  const pip        = getPipSize(cfg.pair);
    const slPips     = cfg.stopLossPips;
    const tpPips     = slPips * cfg.takeProfitRatio;
    const slipPips   = cfg.slippagePips;
    const commPips   = cfg.commissionPips;

  // Equity curve
  const equity: { time: string; balance: number; drawdown: number }[] = [];

  // Track active trade (one at a time per pair)
  let activeTrade: {
        direction:  'LONG' | 'SHORT';
        entry:      number;
        sl:         number;
        tp:         number;
        units:      number;
        lotSize:    number;
        riskUSD:    number;
        entryTime:  Date;
        score:      number;
        signals:    string[];
        grade:      string;
  } | null = null;

  const LOOKBACK = 50; // candles for FVG detection

  for (let i = LOOKBACK; i < candles.length; i++) {
        const c = candles[i];

      // ── A. Check if active trade hits SL or TP ──────────────────
      if (activeTrade) {
              const { direction, entry, sl, tp, units, lotSize, riskUSD, entryTime } = activeTrade;
              let exitPrice: number | null = null;
              let result: 'WIN' | 'LOSS' | 'BE' = 'LOSS';

          if (direction === 'LONG') {
                    if (c.low  <= sl) { exitPrice = sl; result = 'LOSS'; }
                    if (c.high >= tp) { exitPrice = tp; result = 'WIN';  }
          } else {
                    if (c.high >= sl) { exitPrice = sl; result = 'LOSS'; }
                    if (c.low  <= tp) { exitPrice = tp; result = 'WIN';  }
          }

          if (exitPrice !== null) {
                    const priceDiff = direction === 'LONG'
                      ? exitPrice - entry
                                : entry - exitPrice;
                    const pipsRaw  = priceDiff / pip;
                    // Subtract commission (both ways)
                const netPips  = pipsRaw - commPips;
                    const pnl      = netPips * pip * units;

                balance += pnl;
                    if (balance > peak) peak = balance;

                trades.push({
                            id:            ++tradeId,
                            pair:          cfg.pair,
                            timeframe:     cfg.timeframe,
                            entryTime,
                            exitTime:      c.time,
                            direction,
                            entryPrice:    entry,
                            exitPrice,
                            stopLoss:      sl,
                            takeProfit:    tp,
                            lotSize,
                            units,
                            riskUSD,
                            pnl,
                            pips:          netPips,
                            result,
                            confluenceScore: activeTrade.score,
                            signals:       activeTrade.signals,
                            grade:         activeTrade.grade,
                });

                equity.push({
                            time:     c.time.toISOString(),
                            balance:  Math.round(balance * 100) / 100,
                            drawdown: peak > 0 ? ((peak - balance) / peak) * 100 : 0,
                });

                activeTrade = null;
          }
              continue; // don't open new trade while one is active
      }

      // ── B. Signal detection ──────────────────────────────────────
      const window      = candles.slice(i - LOOKBACK, i + 1);
        const fvgs        = detectFVGs(window);
        const { hit: silver } = isSilverBulletWindow(c.time);

      if (cfg.silverBulletOnly && !silver) continue;

      const mid = (c.open + c.close) / 2;
        const { score, signals } = scoreConfluence(fvgs, silver, mid);

      if (score < cfg.minConfluence) continue;

      const verdict = deriveVerdict(fvgs, mid, silver);
        if (verdict === 'WAIT') continue;

      // ── C. Size the trade ────────────────────────────────────────
      const { units, lotSize, dollarRisk } = calcUnits(
              balance, cfg.riskPercent, slPips, cfg.pair,
            );
        if (units <= 0) continue;

      // Apply slippage to entry
      const slipDelta = pipsToDelta(cfg.pair, slipPips);
        const entry = verdict === 'LONG'
          ? c.close + slipDelta
                : c.close - slipDelta;

      const sl = verdict === 'LONG'
          ? entry - pipsToDelta(cfg.pair, slPips)
              : entry + pipsToDelta(cfg.pair, slPips);

      const tp = verdict === 'LONG'
          ? entry + pipsToDelta(cfg.pair, tpPips)
              : entry - pipsToDelta(cfg.pair, tpPips);

      activeTrade = {
              direction: verdict,
              entry,
              sl,
              tp,
              units,
              lotSize,
              riskUSD:   dollarRisk,
              entryTime: c.time,
              score,
              signals,
              grade: gradeSetup(score),
      };
  }

  // 3. Aggregate stats
  const wins   = trades.filter(t => t.result === 'WIN').length;
    const losses = trades.filter(t => t.result === 'LOSS').length;
    const bes    = trades.filter(t => t.result === 'BE').length;
    const total  = trades.length;

  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss   = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const netPnL      = grossProfit - grossLoss;

  const winRate      = total > 0 ? (wins / total) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  // Max drawdown
  let maxDD    = 0;
    let maxDDUSD = 0;
    let runPeak  = cfg.initialBalance;
    let runBal   = cfg.initialBalance;
    for (const t of trades) {
          runBal  += t.pnl;
          if (runBal > runPeak) runPeak = runBal;
          const dd    = runPeak - runBal;
          const ddPct = runPeak > 0 ? (dd / runPeak) * 100 : 0;
          if (ddPct > maxDD) { maxDD = ddPct; maxDDUSD = dd; }
    }

  // Avg trades per day
  const daysRange    = Math.max(1, (cfg.endDate.getTime() - cfg.startDate.getTime()) / 86_400_000);
    const tradingDays  = daysRange * (5 / 7); // ~5/7 are trading days
  const avgPerDay    = total / tradingDays;

  // Sharpe (simplified — daily returns)
  const dailyReturns: number[] = [];
    const tradesByDay: Record<string, number> = {};
    for (const t of trades) {
          const day = t.exitTime.toISOString().slice(0, 10);
          tradesByDay[day] = (tradesByDay[day] ?? 0) + t.pnl;
    }
    for (const pnl of Object.values(tradesByDay)) {
          dailyReturns.push(pnl / cfg.initialBalance);
    }
    const meanReturn = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
    const stdReturn  = Math.sqrt(
          dailyReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (dailyReturns.length || 1),
        );
    const sharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  // Weekly projection (based on avg daily PnL * 5)
  const avgDailyPnL    = netPnL / tradingDays;
    const weeklyProjection = avgDailyPnL * 5;

  // Consecutive streaks
  let maxConsecWins = 0; let curW = 0;
    let maxConsecLoss = 0; let curL = 0;
    for (const t of trades) {
          if (t.result === 'WIN') { curW++; curL = 0; maxConsecWins = Math.max(maxConsecWins, curW); }
          else                   { curL++; curW = 0; maxConsecLoss = Math.max(maxConsecLoss, curL); }
    }

  // By grade
  const byGrade: Record<string, { trades: number; wins: number; pnl: number }> = {};
    for (const t of trades) {
          if (!byGrade[t.grade]) byGrade[t.grade] = { trades: 0, wins: 0, pnl: 0 };
          byGrade[t.grade].trades++;
          byGrade[t.grade].pnl += t.pnl;
          if (t.result === 'WIN') byGrade[t.grade].wins++;
    }

  // By signal
  const bySignal: Record<string, { trades: number; wins: number }> = {};
    for (const t of trades) {
          for (const sig of t.signals) {
                  if (!bySignal[sig]) bySignal[sig] = { trades: 0, wins: 0 };
                  bySignal[sig].trades++;
                  if (t.result === 'WIN') bySignal[sig].wins++;
          }
    }

  const winPnLs  = trades.filter(t => t.pnl > 0).map(t => t.pnl);
    const lossPnLs = trades.filter(t => t.pnl < 0).map(t => t.pnl);
    const avgWin   = winPnLs.length  ? winPnLs.reduce((s,v)=>s+v,0)  / winPnLs.length  : 0;
    const avgLoss  = lossPnLs.length ? lossPnLs.reduce((s,v)=>s+v,0) / lossPnLs.length : 0;

  return {
        config:            cfg,
        trades,
        totalTrades:       total,
        wins,
        losses,
        breakevens:        bes,
        winRate:           Math.round(winRate * 10) / 10,
        profitFactor:      Math.round(profitFactor * 100) / 100,
        netPnL:            Math.round(netPnL * 100) / 100,
        grossProfit:       Math.round(grossProfit * 100) / 100,
        grossLoss:         Math.round(grossLoss * 100) / 100,
        maxDrawdown:       Math.round(maxDD * 100) / 100,
        maxDrawdownUSD:    Math.round(maxDDUSD * 100) / 100,
        peakBalance:       Math.round(peak * 100) / 100,
        finalBalance:      Math.round(balance * 100) / 100,
        returnPct:         Math.round(((balance - cfg.initialBalance) / cfg.initialBalance) * 10000) / 100,
        sharpeRatio:       Math.round(sharpe * 100) / 100,
        avgWin:            Math.round(avgWin * 100) / 100,
        avgLoss:           Math.round(avgLoss * 100) / 100,
        avgRR:             avgLoss !== 0 ? Math.round(Math.abs(avgWin / avgLoss) * 100) / 100 : 0,
        avgTradesPerDay:   Math.round(avgPerDay * 100) / 100,
        weeklyProjection:  Math.round(weeklyProjection * 100) / 100,
        bestTrade:         Math.round(Math.max(0, ...trades.map(t => t.pnl)) * 100) / 100,
        worstTrade:        Math.round(Math.min(0, ...trades.map(t => t.pnl)) * 100) / 100,
        consecutiveWins:   maxConsecWins,
        consecutiveLosses: maxConsecLoss,
        byGrade,
        bySignal,
        equityCurve:       equity,
        durationMs:        Date.now() - t0,
  };
}

// ── MULTI-PAIR / MULTI-TF RUNNER ───────────────────────────────────────────

export interface MultiBacktestResult {
    results:    BacktestResult[];
    combined: {
      totalTrades:     number;
      wins:            number;
      winRate:         number;
      profitFactor:    number;
      netPnL:          number;
      maxDrawdown:     number;
      sharpeRatio:     number;
      weeklyProjection:number;
    };
    durationMs: number;
}

export async function runMultiBacktest(
    pairs:       string[],
    timeframes:  ('M5' | 'M15' | 'H1')[],
    baseConfig:  Omit<BacktestConfig, 'pair' | 'timeframe'>,
    apiKey:      string,
  ): Promise<MultiBacktestResult> {
    const t0 = Date.now();
    const results: BacktestResult[] = [];

  for (const pair of pairs) {
        for (const tf of timeframes) {
                try {
                          const res = await runBacktest({ ...baseConfig, pair, timeframe: tf }, apiKey);
                          results.push(res);
                } catch (e: any) {
                          console.warn(`Backtest skipped ${pair} ${tf}: ${e.message}`);
                }
        }
  }

  // Aggregate combined stats
  const totalTrades  = results.reduce((s, r) => s + r.totalTrades, 0);
    const wins         = results.reduce((s, r) => s + r.wins, 0);
    const netPnL       = results.reduce((s, r) => s + r.netPnL, 0);
    const grossProfit  = results.reduce((s, r) => s + r.grossProfit, 0);
    const grossLoss    = results.reduce((s, r) => s + r.grossLoss, 0);
    const maxDD        = Math.max(...results.map(r => r.maxDrawdown), 0);
    const avgSharpe    = results.length
      ? results.reduce((s, r) => s + r.sharpeRatio, 0) / results.length
          : 0;
    const weeklyProj   = results.reduce((s, r) => s + r.weeklyProjection, 0);

  return {
        results,
        combined: {
                totalTrades,
                wins,
                winRate:          totalTrades > 0 ? Math.round((wins / totalTrades) * 1000) / 10 : 0,
                profitFactor:     grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : 0,
                netPnL:           Math.round(netPnL * 100) / 100,
                maxDrawdown:      Math.round(maxDD * 100) / 100,
                sharpeRatio:      Math.round(avgSharpe * 100) / 100,
                weeklyProjection: Math.round(weeklyProj * 100) / 100,
        },
        durationMs: Date.now() - t0,
  };
}
