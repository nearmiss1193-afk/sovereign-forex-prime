/**
 * ⚡ SOVEREIGN FOREX PRIME — AUTO-TRADE LOOP
 * Pulls live candles every 60s → Brain 2.5 → Execute when confluence ≥ 65
 * Streams all events to dashboard via WebSocket
 * PROP FIRM SAFE: daily loss, drawdown, consistency guards on every tick
 */

import { OANDAService, priceToStopLoss, priceToTakeProfit } from './src/services/oandaService.js';
import { BrainEngine, BrainAnalysis }                        from './src/strategies/brainEngine.js';
import { PropGuard }                                         from './src/guards/propGuard.js';
import { TradeJournal }                                      from './src/journal/tradeJournal.js';
import { SovereignWS }                                       from './wsServer.js';

// ── CONFIG ───────────────────────────────────────────────────────
interface AutoTraderConfig {
  pairs:            string[];
  scanIntervalMs:   number;    // default 60000
  minConfluence:    number;    // default 65
  autoTrade:        boolean;   // if false = signal-only mode
  riskPercent:      number;    // 1.0
  defaultSL:        number;    // default stop loss pips
  weekTarget:       number;    // $3000
  dayTarget:        number;    // $600
}

// ── STATE ────────────────────────────────────────────────────────
interface TraderState {
  running:          boolean;
  paused:           boolean;
  weekPnl:          number;
  dayPnl:           number;
  lastDayReset:     string;   // ISO date
  openTradeIds:     Set<string>;
  scanCount:        number;
  lastScanTime:     Date | null;
  emergencyStopped: boolean;
}

// ── MAIN CLASS ───────────────────────────────────────────────────
export class AutoTrader {
  private oanda:   OANDAService;
  private brain:   BrainEngine;
  private guard:   PropGuard;
  private journal: TradeJournal;
  private ws:      SovereignWS;
  private cfg:     AutoTraderConfig;
  private state:   TraderState;
  private timer:   NodeJS.Timeout | null = null;
  private pnlTimer: NodeJS.Timeout | null = null;
  private priceHistory: Record<string, number[]> = {};

  constructor(
    oanda:   OANDAService,
    brain:   BrainEngine,
    guard:   PropGuard,
    journal: TradeJournal,
    ws:      SovereignWS,
    cfg:     Partial<AutoTraderConfig> = {}
  ) {
    this.oanda   = oanda;
    this.brain   = brain;
    this.guard   = guard;
    this.journal = journal;
    this.ws      = ws;

    this.cfg = {
      pairs:          cfg.pairs          ?? ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD'],
      scanIntervalMs: cfg.scanIntervalMs ?? 60_000,
      minConfluence:  cfg.minConfluence  ?? 65,
      autoTrade:      cfg.autoTrade      ?? false,
      riskPercent:    cfg.riskPercent    ?? 1.0,
      defaultSL:      cfg.defaultSL      ?? 20,
      weekTarget:     cfg.weekTarget     ?? 3000,
      dayTarget:      cfg.dayTarget      ?? 600,
    };

    this.state = {
      running:          false,
      paused:           false,
      weekPnl:          0,
      dayPnl:           0,
      lastDayReset:     new Date().toISOString().slice(0, 10),
      openTradeIds:     new Set(),
      scanCount:        0,
      lastScanTime:     null,
      emergencyStopped: false,
    };

    // Handle incoming WS commands from dashboard
    this.ws.on('client_message', (msg: any) => this.handleDashboardCommand(msg));
  }

  // ══ START ════════════════════════════════════════════════════
  start() {
    if (this.state.running) return;
    this.state.running = true;
    this.state.emergencyStopped = false;

    console.log('\n⚡ AUTO-TRADER STARTING');
    console.log(`   Pairs:      ${this.cfg.pairs.join(', ')}`);
    console.log(`   Interval:   ${this.cfg.scanIntervalMs / 1000}s`);
    console.log(`   Min Conf:   ${this.cfg.minConfluence}`);
    console.log(`   Auto-Trade: ${this.cfg.autoTrade ? '✅ LIVE' : '⏳ SIGNAL-ONLY'}`);
    console.log(`   Target:     $${this.cfg.weekTarget}/week\n`);

    // Immediate first scan
    this.runScanCycle();

    // Schedule recurring scans
    this.timer = setInterval(() => this.runScanCycle(), this.cfg.scanIntervalMs);

    // P&L poll every 5s
    this.pnlTimer = setInterval(() => this.pollPnL(), 5_000);

    this.ws.broadcast('SYSTEM_STATUS', {
      status:     'AUTO_TRADER_STARTED',
      autoTrade:  this.cfg.autoTrade,
      pairs:      this.cfg.pairs,
      interval:   this.cfg.scanIntervalMs,
    });
  }

  stop() {
    this.state.running = false;
    if (this.timer)    { clearInterval(this.timer);    this.timer    = null; }
    if (this.pnlTimer) { clearInterval(this.pnlTimer); this.pnlTimer = null; }
    console.log('⛔ Auto-trader stopped');
    this.ws.broadcast('SYSTEM_STATUS', { status: 'AUTO_TRADER_STOPPED' });
  }

  pause()  { this.state.paused = true;  console.log('⏸  Auto-trader PAUSED'); }
  resume() { this.state.paused = false; console.log('▶️  Auto-trader RESUMED'); this.runScanCycle(); }

  // ══ MAIN SCAN CYCLE ══════════════════════════════════════════
  private async runScanCycle() {
    if (!this.state.running || this.state.paused || this.state.emergencyStopped) return;

    this.state.scanCount++;
    this.state.lastScanTime = new Date();

    console.log(`\n🔍 SCAN #${this.state.scanCount} — ${this.state.lastScanTime.toISOString()}`);

    try {
      // ── 1. RESET DAILY P&L IF NEW DAY ──────────────────────
      this.checkDayReset();

      // ── 2. FETCH ACCOUNT + GUARD CHECK ─────────────────────
      const account = await this.oanda.getAccount();
      const guards  = this.guard.check(account);
      this.guard.update(this.state.dayPnl, this.state.weekPnl, account.balance);

      if (guards.warnings.length > 0) {
        guards.warnings.forEach(w => {
          console.warn('  🛡️', w);
          this.ws.emitGuardAlert({
            level:    w.includes('⛔') ? 'danger' : 'warn',
            message:  w,
            canTrade: guards.canTrade,
          });
        });
      }

      if (!guards.canTrade) {
        console.warn('  ⛔ TRADING HALTED BY GUARD — skipping scan');
        this.pause();
        return;
      }

      // ── 3. GET LIVE PRICES ──────────────────────────────────
      const priceData = await this.oanda.getPrices(this.cfg.pairs);
      const priceMap: Record<string, any> = {};
      priceData.forEach(p => {
        const prev = this.priceHistory[p.instrument]?.slice(-1)[0] || p.mid;
        priceMap[p.instrument] = {
          bid: p.bid, ask: p.ask, mid: p.mid,
          chg: p.mid - prev, spread: p.spread,
        };
        if (!this.priceHistory[p.instrument]) this.priceHistory[p.instrument] = [];
        this.priceHistory[p.instrument].push(p.mid);
        if (this.priceHistory[p.instrument].length > 200)
          this.priceHistory[p.instrument].shift();
      });
      this.ws.emitPrices(priceMap);

      // ── 4. BRAIN 2.5 ANALYSIS — ALL PAIRS ──────────────────
      const analyses: BrainAnalysis[] = [];
      for (const pair of this.cfg.pairs) {
        try {
          const analysis = await this.brain.analyze(pair, 'M15');
          analyses.push(analysis);
          this.ws.emitAnalysis(analysis);
          console.log(`  📊 ${pair}: ${analysis.verdict} | Score:${analysis.confluenceScore} | WR:${analysis.winRate}%`);
        } catch (e: any) {
          console.warn(`  ⚠️ Analysis failed for ${pair}:`, e.message);
        }
      }

      // ── 5. FIND BEST SETUP ─────────────────────────────────
      const qualified = analyses
        .filter(a =>
          a.confluenceScore >= this.cfg.minConfluence &&
          a.verdict !== 'WAIT' &&
          a.ict.fvgs.length > 0   // FVG required
        )
        .sort((a, b) => b.confluenceScore - a.confluenceScore);

      if (qualified.length > 0) {
        const best = qualified[0];
        console.log(`  ⚡ SIGNAL: ${best.instrument} ${best.verdict} | Conf:${best.confluenceScore} | FVG:✓`);

        this.ws.emitSignal({
          instrument:      best.instrument,
          verdict:         best.verdict,
          confluenceScore: best.confluenceScore,
          winRate:         best.winRate,
          signals:         best.signals,
          autoTrading:     this.cfg.autoTrade,
        });

        // ── 6. AUTO-EXECUTE IF ENABLED ──────────────────────
        if (this.cfg.autoTrade && !this.isAlreadyTrading(best.instrument)) {
          await this.executeSignal(best, account.balance);
        }
      } else {
        console.log('  ⏳ No qualified setups this scan');
      }

      // ── 7. MONITOR OPEN TRADES ─────────────────────────────
      await this.monitorOpenTrades();

    } catch (e: any) {
      console.error('  ❌ Scan error:', e.message);
      this.ws.broadcast('SYSTEM_STATUS', { status: 'SCAN_ERROR', error: e.message });
    }
  }

  // ══ EXECUTE A TRADE SIGNAL ════════════════════════════════════
  private async executeSignal(analysis: BrainAnalysis, balance: number) {
    const { instrument, verdict } = analysis;
    const direction = verdict === 'LONG' ? 'long' : 'short';

    // Determine SL in pips from nearest FVG or default
    const fvg     = analysis.ict.fvgs[0];
    let   slPips  = this.cfg.defaultSL;
    if (fvg) {
      const fvgSize = Math.abs(fvg.top - fvg.bottom);
      const pipSize = instrument.includes('JPY') ? 0.01 : 0.0001;
      slPips = Math.round(fvgSize / pipSize) + 5;   // FVG size + 5 pip buffer
      slPips = Math.max(10, Math.min(50, slPips));   // cap 10-50 pips
    }

    try {
      // 1. Calc lot size (includes consistency cap)
      const lotCalc = await this.oanda.calcLotSize({
        instrument,
        accountBalance: balance,
        riskPercent:    this.cfg.riskPercent,
        stopLossPips:   slPips,
        weeklyPnl:      this.state.weekPnl,
        weekTarget:     this.cfg.weekTarget,
      });

      // 2. Get fresh price
      const [price] = await this.oanda.getPrices([instrument]);
      const entry   = direction === 'long' ? price.ask : price.bid;
      const units   = direction === 'long' ? lotCalc.units : -lotCalc.units;
      const sl      = priceToStopLoss(instrument, entry, slPips, direction);
      const tp      = priceToTakeProfit(instrument, entry, lotCalc.takeProfitPips, direction);

      console.log(`  🟢 EXECUTING: ${instrument} ${direction.toUpperCase()}`);
      console.log(`     Entry:${entry.toFixed(5)} | SL:${sl.toFixed(5)} | TP:${tp.toFixed(5)}`);
      console.log(`     Lots:${lotCalc.lotSize} | Risk:$${lotCalc.dollarRisk.toFixed(2)} | SL:${slPips}pip`);

      // 3. Place the order
      const result = await this.oanda.placeOrder({
        instrument, units, stopLoss: sl, takeProfit: tp,
        type:    'MARKET',
        comment: `SFP-Brain2.5|${analysis.confluenceScore}|${analysis.signals[0]||''}`,
      });

      this.state.openTradeIds.add(result.tradeId);

      // 4. Journal
      await this.journal.addEntry({
        tradeId: result.tradeId, instrument, direction,
        units: lotCalc.units, lotSize: lotCalc.lotSize,
        entry, stopLoss: sl, takeProfit: tp,
        riskUSD: lotCalc.dollarRisk,
        comment: `Confluence:${analysis.confluenceScore} | ${analysis.setupGrade}`,
        patterns: analysis.signals,
        grade:    analysis.setupGrade,
      });

      // 5. Broadcast trade opened
      this.ws.emitTradeOpened({
        id:         result.tradeId,
        instrument, direction,
        units:      lotCalc.units,
        lotSize:    lotCalc.lotSize,
        entry,      stopLoss: sl, takeProfit: tp,
        riskUSD:    lotCalc.dollarRisk,
        patterns:   analysis.signals,
      });

      console.log(`  ✅ TRADE OPEN: ID ${result.tradeId}`);

    } catch (e: any) {
      console.error(`  ❌ Trade execution failed:`, e.message);
      this.ws.broadcast('SYSTEM_STATUS', {
        status: 'TRADE_FAILED',
        instrument, error: e.message,
      });
    }
  }

  // ══ MONITOR OPEN POSITIONS ════════════════════════════════════
  private async monitorOpenTrades() {
    try {
      const open = await this.oanda.getOpenTrades();

      // Detect newly closed trades
      const openIds = new Set(open.map(t => t.id));
      for (const id of this.state.openTradeIds) {
        if (!openIds.has(id)) {
          // Trade closed externally (TP/SL hit)
          this.state.openTradeIds.delete(id);
          console.log(`  📗 Trade ${id} closed (TP/SL hit)`);
          // In production: fetch transaction to get exact PnL
        }
      }

      // Update open trade set
      open.forEach(t => this.state.openTradeIds.add(t.id));

      if (open.length > 0) {
        const totalPnl = open.reduce((s, t) => s + t.currentPnl, 0);
        console.log(`  📊 ${open.length} open trade(s) | Floating P&L: $${totalPnl.toFixed(2)}`);
      }

    } catch (e: any) {
      console.warn('  ⚠️ Monitor open trades failed:', e.message);
    }
  }

  // ══ P&L POLLING (every 5s) ════════════════════════════════════
  private async pollPnL() {
    if (!this.state.running || this.state.emergencyStopped) return;
    try {
      const account = await this.oanda.getAccount();
      this.ws.emitPnL({
        weekPnl:    this.state.weekPnl,
        dayPnl:     this.state.dayPnl,
        weekTarget: this.cfg.weekTarget,
        dayTarget:  this.cfg.dayTarget,
        balance:    account.balance,
        nav:        account.nav,
        openTrades: account.openTradeCount,
      });
    } catch { /* silent — OANDA may rate limit */ }
  }

  // ══ EMERGENCY STOP ════════════════════════════════════════════
  async emergencyStop(reason: string = 'Manual stop') {
    this.state.emergencyStopped = true;
    this.state.paused = true;
    console.error(`\n🛑 EMERGENCY STOP: ${reason}`);

    try {
      await this.oanda.emergencyCloseAll();
      console.log('  ✅ All positions closed');
    } catch (e: any) {
      console.error('  ❌ Close all failed:', e.message);
    }

    this.ws.emitEmergencyStop(reason);
    this.stop();
  }

  // ══ DASHBOARD COMMAND HANDLER ═════════════════════════════════
  private async handleDashboardCommand(msg: any) {
    switch (msg.cmd) {
      case 'START_AUTO':
        this.cfg.autoTrade = true;
        this.resume();
        console.log('▶️  Auto-trading ENABLED from dashboard');
        break;

      case 'STOP_AUTO':
        this.cfg.autoTrade = false;
        console.log('⏸  Auto-trading DISABLED from dashboard');
        break;

      case 'EMERGENCY_STOP':
        await this.emergencyStop('Dashboard emergency stop');
        break;

      case 'SET_RISK':
        if (msg.riskPct) this.cfg.riskPercent = msg.riskPct;
        console.log(`⚙️  Risk updated to ${this.cfg.riskPercent}%`);
        break;

      case 'CLOSE_TRADE':
        if (msg.tradeId) {
          const pnl = await this.oanda.closeTrade(msg.tradeId);
          this.state.openTradeIds.delete(msg.tradeId);
          this.ws.emitTradeClosed({ id: msg.tradeId, instrument: '', pnl, exitPrice: 0, reason: 'Manual close' });
        }
        break;

      case 'RUN_SCAN':
        await this.runScanCycle();
        break;

      case 'FORCE_PAIR':
        if (msg.pair && msg.direction) {
          const account = await this.oanda.getAccount();
          const fakeAnalysis = await this.brain.analyze(msg.pair, 'M15');
          fakeAnalysis.verdict = msg.direction;
          await this.executeSignal(fakeAnalysis, account.balance);
        }
        break;

      default:
        console.log('⚠️ Unknown dashboard command:', msg.cmd);
    }
  }

  // ── HELPERS ─────────────────────────────────────────────────
  private isAlreadyTrading(instrument: string): boolean {
    // Simplified: in production, cross-reference with open trades by instrument
    return false;
  }

  private checkDayReset() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.state.lastDayReset) {
      this.state.dayPnl      = 0;
      this.state.lastDayReset = today;
      console.log('  📅 New trading day — daily P&L reset');
    }
  }

  // ── PUBLIC STATE GETTER ──────────────────────────────────────
  getState() {
    return {
      running:          this.state.running,
      paused:           this.state.paused,
      autoTrade:        this.cfg.autoTrade,
      scanCount:        this.state.scanCount,
      lastScan:         this.state.lastScanTime?.toISOString() || null,
      weekPnl:          this.state.weekPnl,
      dayPnl:           this.state.dayPnl,
      openTrades:       this.state.openTradeIds.size,
      emergencyStopped: this.state.emergencyStopped,
      pairs:            this.cfg.pairs,
      minConfluence:    this.cfg.minConfluence,
    };
  }
}
