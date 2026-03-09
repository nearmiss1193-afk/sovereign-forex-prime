/**
 * 📡 SOVEREIGN FOREX PRIME — WEBSOCKET SERVER
 * Streams live P&L, prices, signals, guard alerts to dashboard
 * Uses ws library — zero external dependencies beyond that
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter }               from 'events';

// ── MESSAGE TYPES ────────────────────────────────────────────────
export type WSMessageType =
  | 'PRICE_UPDATE'
  | 'PNL_UPDATE'
  | 'TRADE_OPENED'
  | 'TRADE_CLOSED'
  | 'SIGNAL_DETECTED'
  | 'GUARD_ALERT'
  | 'ANALYSIS_COMPLETE'
  | 'HEARTBEAT'
  | 'SYSTEM_STATUS'
  | 'EMERGENCY_STOP';

export interface WSMessage {
  type:      WSMessageType;
  ts:        string;
  payload:   Record<string, any>;
}

// ── SOVEREIGN WS SERVER ──────────────────────────────────────────
export class SovereignWS extends EventEmitter {
  private wss:     WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private hbTimer: NodeJS.Timeout | null = null;

  constructor(port: number = 3001) {
    super();

    this.wss = new WebSocketServer({ port });

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      console.log(`📡 WS client connected  [${this.clients.size} total]`);

      // Send welcome + current state
      this.send(ws, 'SYSTEM_STATUS', {
        status:  'ONLINE',
        mode:    '24/7 SMART SCAN',
        clients: this.clients.size,
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.emit('client_message', msg, ws);
        } catch { /* ignore malformed */ }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`📡 WS client disconnected [${this.clients.size} total]`);
      });

      ws.on('error', (err) => {
        console.error('WS client error:', err.message);
        this.clients.delete(ws);
      });
    });

    this.wss.on('error', (err) => {
      console.error('WS Server error:', err.message);
    });

    // Heartbeat every 30s to keep connections alive
    this.hbTimer = setInterval(() => {
      this.broadcast('HEARTBEAT', { ts: Date.now(), clients: this.clients.size });
    }, 30_000);

    console.log(`📡 WebSocket server running on ws://localhost:${port}`);
  }

  // ── SEND TO SINGLE CLIENT ────────────────────────────────────
  send(ws: WebSocket, type: WSMessageType, payload: Record<string, any>) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type, ts: new Date().toISOString(), payload }));
    } catch { /* client gone */ }
  }

  // ── BROADCAST TO ALL CLIENTS ─────────────────────────────────
  broadcast(type: WSMessageType, payload: Record<string, any>) {
    const msg = JSON.stringify({ type, ts: new Date().toISOString(), payload });
    this.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch { this.clients.delete(ws); }
      }
    });
  }

  // ── HELPER BROADCAST METHODS ─────────────────────────────────
  emitPrices(prices: Record<string, { bid: number; ask: number; mid: number; chg: number }>) {
    this.broadcast('PRICE_UPDATE', { prices });
  }

  emitPnL(data: {
    weekPnl:   number;
    dayPnl:    number;
    weekTarget: number;
    dayTarget:  number;
    balance:   number;
    nav:       number;
    openTrades: number;
  }) {
    this.broadcast('PNL_UPDATE', data);
  }

  emitTradeOpened(trade: {
    id:         string;
    instrument: string;
    direction:  string;
    units:      number;
    lotSize:    number;
    entry:      number;
    stopLoss:   number;
    takeProfit: number;
    riskUSD:    number;
    patterns:   string[];
  }) {
    this.broadcast('TRADE_OPENED', trade);
  }

  emitTradeClosed(data: {
    id:         string;
    instrument: string;
    pnl:        number;
    exitPrice:  number;
    reason:     string;
  }) {
    this.broadcast('TRADE_CLOSED', data);
  }

  emitSignal(signal: {
    instrument:      string;
    verdict:         string;
    confluenceScore: number;
    winRate:         number;
    signals:         string[];
    autoTrading:     boolean;
  }) {
    this.broadcast('SIGNAL_DETECTED', signal);
  }

  emitAnalysis(analysis: any) {
    this.broadcast('ANALYSIS_COMPLETE', analysis);
  }

  emitGuardAlert(alert: { level: 'warn' | 'danger'; message: string; canTrade: boolean }) {
    this.broadcast('GUARD_ALERT', alert);
  }

  emitEmergencyStop(reason: string) {
    this.broadcast('EMERGENCY_STOP', { reason, ts: Date.now() });
  }

  get clientCount(): number { return this.clients.size; }

  destroy() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.wss.close();
  }
}
