/**
 * ⚡ SOVEREIGN FOREX PRIME — MAIN SERVER
 * Express REST + WebSocket (shared port) + AutoTrader loop
 */
import express          from 'express';
import cors             from 'cors';
import path             from 'path';
import dotenv           from 'dotenv';
import { createServer } from 'http';
import { OANDAService, priceToStopLoss, priceToTakeProfit } from './src/services/oandaService.js';
import { BrainEngine }  from './src/strategies/brainEngine.js';
import { PropGuard }    from './src/guards/propGuard.js';
import { TradeJournal } from './src/journal/tradeJournal.js';
import { SovereignWS }  from './wsServer.js';
import { AutoTrader }   from './autoTrader.js';import { runMultiBacktest } from './src/backtester/backtester.js';

dotenv.config();

const OANDA_KEY = process.env.OANDA_API_KEY;
const OANDA_ID  = process.env.OANDA_ACCOUNT_ID;

if (!OANDA_KEY || !OANDA_ID || OANDA_ID === 'AUTO') {
    console.error('\n❌ Missing OANDA_API_KEY or OANDA_ACCOUNT_ID env vars\n');
    process.exit(1);
}

const oanda   = new OANDAService({
    apiKey:    OANDA_KEY,
    accountId: OANDA_ID,
    practice:  process.env.OANDA_PRACTICE === 'true',
});
const brain   = new BrainEngine(oanda);
const guard   = new PropGuard();
const journal = new TradeJournal();

// ── Express app ──────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// ── HTTP + WebSocket server (single port) ────────────────────────
const httpServer = createServer(app);
const ws         = new SovereignWS(httpServer);

const trader = new AutoTrader(oanda, brain, guard, journal, ws, {
    pairs:           (process.env.DEFAULT_PAIRS || 'EUR_USD,GBP_USD,USD_JPY,AUD_USD').split(','),
    scanIntervalMs:  parseInt(process.env.SCAN_INTERVAL_MS  || '60000'),
    minConfluence:   parseInt(process.env.MIN_CONFLUENCE     || '65'),
    autoTrade:       process.env.AUTO_TRADE === 'true',
    riskPercent:     parseFloat(process.env.MAX_RISK_PER_TRADE_PCT || '1'),
    weekTarget:      parseInt(process.env.WEEK_TARGET || '3000'),
    dayTarget:       parseInt(process.env.DAY_TARGET  || '600'),
});

// ── REST ENDPOINTS ───────────────────────────────────────────────
app.get('/api/health', async (_, res) =>
    res.json({ status: 'online', ts: new Date().toISOString(), wsClients: ws.clientCount, trader: trader.getState() })
        );

app.get('/api/account', async (_, res) => {
    try { res.json({ ok: true, account: await oanda.getAccount() }); }
    catch(e:any){ res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/api/prices', async (req, res) => {
    try {
          const i = (req.query.i as string || 'EUR_USD,GBP_USD,USD_JPY,AUD_USD').split(',');
          res.json({ ok:true, prices: await oanda.getPrices(i) });
    } catch(e:any){ res.status(500).json({ok:false, error:e.message}); }
});

app.get('/api/candles/:instrument', async (req,res) => {
    try {
          const c = await oanda.getCandles(req.params.instrument, (req.query.gran as any)||'M15', parseInt(req.query.count as string||'100'));
          res.json({ok:true, candles:c});
    } catch(e:any){ res.status(500).json({ok:false, error:e.message}); }
});

app.get('/api/trades', async (_, res) => {
    try { res.json({ ok:true, trades: await oanda.getOpenTrades() }); }
    catch(e:any){ res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/api/guards', async (_, res) => {
    try { const a=await oanda.getAccount(); res.json({ ok:true, ...guard.check(a) }); }
    catch(e:any){ res.status(500).json({ok:false, error:e.message}); }
});

app.get('/api/journal', async (_, res) => {
    try {
          const [e,s] = await Promise.all([journal.getAll(), journal.getWeeklySummary()]);
          res.json({ok:true, entries:e, summary:s});
    } catch(e:any){ res.status(500).json({ok:false, error:e.message}); }
});

app.get('/api/summary', async (_, res) => {
    try {
          const [a,s] = await Promise.all([oanda.getAccount(), journal.getWeeklySummary()]);
          res.json({ok:true, account:a, summary:s, traderState:trader.getState()});
    } catch(e:any){ res.status(500).json({ok:false, error:e.message}); }
});

app.get('/api/trader/state', (_, res) => res.json({ ok:true, state:trader.getState() }));

app.post('/api/calc-lot', async (req, res) => {
    try { res.json({ ok:true, result: await oanda.calcLotSize(req.body) }); }
    catch(e:any){ res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/analyze', async (req, res) => {
    try {
          const { instrument='EUR_USD', timeframe='M15' } = req.body;
          const analysis = await brain.analyze(instrument, timeframe);
          ws.emitAnalysis(analysis);
          res.json({ ok:true, analysis });
    } catch(e:any){ res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/trade', async (req, res) => {
    try {
          const { instrument, direction, riskPercent, stopLossPips, comment } = req.body;
          const account  = await oanda.getAccount();
          const guards   = guard.check(account);
          if (!guards.canTrade) return res.status(403).json({ ok:false, blocked:true, warnings:guards.warnings });
          const lotCalc  = await oanda.calcLotSize({ instrument, accountBalance:account.balance, riskPercent:riskPercent||1, stopLossPips:stopLossPips||20 });
          const [price]  = await oanda.getPrices([instrument]);
          const entry    = direction==='long' ? price.ask : price.bid;
          const units    = direction==='long' ? lotCalc.units : -lotCalc.units;
          const sl       = priceToStopLoss(instrument, entry, stopLossPips||20, direction);
          const tp       = priceToTakeProfit(instrument, entry, lotCalc.takeProfitPips, direction);
          const result   = await oanda.placeOrder({ instrument, units, stopLoss:sl, takeProfit:tp, type:'MARKET', comment });
          await journal.addEntry({ tradeId:result.tradeId, instrument, direction, units:lotCalc.units, lotSize:lotCalc.lotSize, entry, stopLoss:sl, takeProfit:tp, riskUSD:lotCalc.dollarRisk, comment:comment||'' });
          ws.emitTradeOpened({ id:result.tradeId, instrument, direction, units:lotCalc.units, lotSize:lotCalc.lotSize, entry, stopLoss:sl, takeProfit:tp, riskUSD:lotCalc.dollarRisk, patterns:[] });
          res.json({ ok:true, result, lotCalc, entry, stopLoss:sl, takeProfit:tp });
    } catch(e:any){ res.status(500).json({ ok:false, error:e.message }); }
});

app.delete('/api/trade/:id', async (req, res) => {
    try {
          const pnl = await oanda.closeTrade(req.params.id);
          ws.emitTradeClosed({id:req.params.id, instrument:'', pnl, exitPrice:0, reason:'Manual'});
          res.json({ok:true, pnl});
    } catch(e:any){ res.status(500).json({ok:false, error:e.message}); }
});

app.post('/api/emergency-stop', async (_, res) => {
    try { await trader.emergencyStop('API emergency stop'); res.json({ ok:true, message:'⛔ ALL POSITIONS CLOSED' }); }
    catch(e:any){ res.status(500).json({ok:false, error:e.message}); }
});

app.post('/api/trader/start',  (_, res) => { trader.start();  res.json({ ok:true, state:trader.getState() }); });
app.post('/api/trader/stop',   (_, res) => { trader.stop();   res.json({ ok:true, state:trader.getState() }); });
app.post('/api/trader/pause',  (_, res) => { trader.pause();  res.json({ ok:true }); });
app.post('/api/trader/resume', (_, res) => { trader.resume(); res.json({ ok:true }); });

// ── BACKTEST ENDPOINT ────────────────────────────────────────────app.post('/api/backtest', async (req, res) => {
    try {
          const acct = await oanda.getAccount();
          res.json({ ok:true, connected:true, accountId: acct.id ?? OANDA_ID, balance: acct.balance });
    } catch(e:any){ res.status(500).json({ ok:false, connected:false, error:e.message }); }
});

app.use((req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// ── START ────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`\n⚡ ═══════════════════════════════════`);
    console.log(` SOVEREIGN FOREX PRIME — ONLINE`);
    console.log(` Dashboard  : http://localhost:${PORT}`);
    console.log(` WebSocket  : wss://host/ws`);
    console.log(` Mode       : ${process.env.OANDA_PRACTICE==='true'?'📊 PAPER':'💰 LIVE'}`);
    console.log(` Account    : ${OANDA_ID}`);
    console.log(` Target     : $${process.env.WEEK_TARGET||3000}/week`);
    (async () => {
          try {
                  const acct = await oanda.getAccount();
                  console.log(` OANDA      : CONNECTED — Balance ${acct.currency||''} ${acct.balance}`);
          } catch(e:any) {
                  console.error(` OANDA      : CONNECTION ERROR — ${e.message}`);
          }
          console.log(`⚡ ═══════════════════════════════════\n`);
    })();
    trader.start();
});

process.on('SIGINT',  async () => { await trader.emergencyStop('Shutdown'); process.exit(0); });
process.on('SIGTERM', async () => { await trader.emergencyStop('Shutdown'); process.exit(0); });

export { app, ws, trader };
