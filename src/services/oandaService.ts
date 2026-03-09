import dotenv from 'dotenv';

dotenv.config();

export interface OandaConfig {
  apiKey:    string;
  accountId: string;
  practice?: boolean;
}

export interface PriceQuote {
  instrument: string;
  bid:        number;
  ask:        number;
  mid:        number;
  spread:     number;
}

export interface LotSizeRequest {
  instrument:      string;
  accountBalance:  number;
  riskPercent:     number;   // e.g. 1 = 1%
  stopLossPips:    number;
  weeklyPnl?:      number;
  weekTarget?:     number;
}

export interface LotSizeResult {
  units:          number;
  lotSize:        number;
  pipValue:       number;
  dollarRisk:     number;
  stopLossPips:   number;
  takeProfitPips: number;
}

export interface OrderRequest {
  instrument: string;
  units:      number;
  stopLoss:   number;
  takeProfit: number;
  type:       'MARKET';
  comment?:   string;
}

export interface OrderResult {
  tradeId: string;
  raw:     any;
}

function getPipSize(instrument: string): number {
  if (instrument.includes('JPY')) return 0.01;
  if (instrument.startsWith('XAU_')) return 0.1;
  return 0.0001;
}

function getBaseUrl(practice: boolean | undefined): string {
  return practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3';
}

export function priceToStopLoss(
  instrument: string,
  entry:      number,
  stopLossPips: number,
  direction:  'long' | 'short',
): number {
  const pip = getPipSize(instrument);
  const dist = stopLossPips * pip;
  return direction === 'long' ? entry - dist : entry + dist;
}

export function priceToTakeProfit(
  instrument: string,
  entry:      number,
  takeProfitPips: number,
  direction:  'long' | 'short',
): number {
  const pip = getPipSize(instrument);
  const dist = takeProfitPips * pip;
  return direction === 'long' ? entry + dist : entry - dist;
}

export class OANDAService {
  private apiKey:    string;
  private accountId: string;
  private practice:  boolean;
  private baseUrl:   string;

  constructor(cfg: OandaConfig) {
    this.apiKey    = cfg.apiKey;
    this.accountId = cfg.accountId;
    this.practice  = !!cfg.practice;
    this.baseUrl   = getBaseUrl(this.practice);
  }

  private get headers() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type':  'application/json',
    };
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        ...this.headers,
        ...(init.headers || {}),
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OANDA ${res.status}: ${text}`);
    }
    return res.json();
  }

  async getAccount(): Promise<any> {
    const data = await this.request(`/accounts/${this.accountId}`);
    const a = data.account;
    return {
      ...a,
      balance:        parseFloat(a.balance),
      nav:            parseFloat(a.NAV ?? a.balance),
      openTradeCount: (a.openTradeCount ?? (a.trades ? a.trades.length : 0)) as number,
    };
  }

  async getPrices(instruments: string[]): Promise<PriceQuote[]> {
    const q = encodeURIComponent(instruments.join(','));
    const data = await this.request(`/accounts/${this.accountId}/pricing?instruments=${q}`);
    return (data.prices || []).map((p: any) => {
      const bids = p.bids?.[0]?.price ?? p.closeoutBid;
      const asks = p.asks?.[0]?.price ?? p.closeoutAsk;
      const bid  = parseFloat(bids);
      const ask  = parseFloat(asks);
      const mid  = (bid + ask) / 2;
      const spread = ask - bid;
      return { instrument: p.instrument, bid, ask, mid, spread } as PriceQuote;
    });
  }

  async calcLotSize(req: LotSizeRequest): Promise<LotSizeResult> {
    const { instrument, accountBalance, riskPercent, stopLossPips } = req;

    const pipSize   = getPipSize(instrument);
    const riskFrac  = Math.max(0.01, riskPercent / 100);
    const riskUSD   = accountBalance * riskFrac;
    const pips      = Math.max(1, stopLossPips);

    const pipValuePerUnit = pipSize;
    const unitsFloat      = riskUSD / (pips * pipValuePerUnit);
    const units           = Math.round(unitsFloat);
    const lotSize         = units / 100_000;

    const takeProfitPips  = Math.round(stopLossPips * 2);

    return {
      units,
      lotSize,
      pipValue:       pipValuePerUnit,
      dollarRisk:     riskUSD,
      stopLossPips:   pips,
      takeProfitPips,
    };
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const body = {
      order: {
        instrument: req.instrument,
        units:      req.units,
        type:       req.type,
        timeInForce:'FOK',
        positionFill: 'DEFAULT',
        stopLossOnFill: {
          price: req.stopLoss.toFixed(5),
        },
        takeProfitOnFill: {
          price: req.takeProfit.toFixed(5),
        },
        clientExtensions: req.comment ? { comment: req.comment } : undefined,
      },
    };

    const data = await this.request(`/accounts/${this.accountId}/orders`, {
      method: 'POST',
      body:   JSON.stringify(body),
    });

    const trade = data.orderFillTransaction || data.orderCreateTransaction || data;
    const tradeId = String(trade.id ?? trade.tradeOpened?.tradeID ?? trade.tradeReduced?.tradeID ?? trade.trades?.[0]?.tradeID ?? 'UNKNOWN');

    return { tradeId, raw: data };
  }

  async getCandles(instrument: string, granularity: string = 'M15', count: number = 100): Promise<any[]> {
    const data = await this.request(
      `/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`
    );
    return data.candles || [];
  }

  /** Alias used by BrainEngine */
  async requestCandles(instrument: string, granularity: string = 'M15', count: number = 100): Promise<any[]> {
    return this.getCandles(instrument, granularity, count);
  }

  async getOpenTrades(): Promise<Array<{ id: string; instrument: string; currentPnl: number }>> {
    const data = await this.request(`/accounts/${this.accountId}/openTrades`);
    return (data.trades || []).map((t: any) => ({
      id:         String(t.id),
      instrument: t.instrument,
      currentPnl: parseFloat(t.unrealizedPL ?? '0'),
    }));
  }

  async closeTrade(tradeId: string): Promise<number> {
    const data = await this.request(`/accounts/${this.accountId}/trades/${tradeId}/close`, { method: 'PUT' });
    const trx  = data.orderFillTransaction || data.orderCancelTransaction || data;
    const realized = parseFloat(trx.pl ?? trx.realizedPL ?? '0');
    return realized;
  }

  async emergencyCloseAll(): Promise<void> {
    const open = await this.getOpenTrades();
    for (const t of open) {
      try {
        await this.closeTrade(t.id);
      } catch (e) {
        console.error('Emergency close failed for', t.id, (e as any).message);
      }
    }
  }
}
