import { OANDAService, PriceQuote } from '../services/oandaService.js';

export interface FVG {
  direction: 'bullish' | 'bearish';
  top:       number;
  bottom:    number;
  size:      number;
  index:     number;
}

export interface ICTContext {
  fvgs:          FVG[];
  silverBullet:  boolean;
  timeWindow:    string | null;
}

export interface BrainAnalysis {
  instrument:       string;
  timeframe:        string;
  verdict:          'LONG' | 'SHORT' | 'WAIT';
  confluenceScore:  number;
  winRate:          number;
  signals:          string[];
  setupGrade:       'A+' | 'A' | 'B' | 'C';
  ict:              ICTContext;
}

interface Candle {
  time:  string;
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

export class BrainEngine {
  private oanda: OANDAService;

  constructor(oanda: OANDAService) {
    this.oanda = oanda;
  }

  private getNowInUTC(): Date {
    return new Date(new Date().toISOString());
  }

  private isSilverBulletWindow(date: Date): { hit: boolean; label: string | null } {
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();

    const windows = [
      { start: 13, end: 15, label: 'NY AM' },
      { start: 19, end: 21, label: 'NY PM' },
      { start: 7,  end: 9,  label: 'London AM' },
    ];

    for (const w of windows) {
      if (hour >= w.start && hour < w.end) return { hit: true, label: w.label };
    }
    return { hit: false, label: null };
  }

  private detectFVG(candles: Candle[]): FVG[] {
    const fvgs: FVG[] = [];
    for (let i = 2; i < candles.length; i++) {
      const c0 = candles[i - 2];
      const c1 = candles[i - 1];
      const c2 = candles[i];

      if (c0.high < c2.low && c1.low > c0.high) {
        const top = c2.low;
        const bottom = c0.high;
        fvgs.push({ direction: 'bullish', top, bottom, size: top - bottom, index: i });
      }

      if (c0.low > c2.high && c1.high < c0.low) {
        const top = c0.low;
        const bottom = c2.high;
        fvgs.push({ direction: 'bearish', top, bottom, size: top - bottom, index: i });
      }
    }
    return fvgs;
  }

  private scoreConfluence(fvgs: FVG[], silver: boolean, price: PriceQuote): { score: number; signals: string[] } {
    let score = 0;
    const signals: string[] = [];

    if (silver) {
      score += 20;
      signals.push('Silver Bullet Window');
    }

    if (fvgs.length > 0) {
      const largeFvg = fvgs.some(f => f.size > (price.mid * 0.0005));
      score += 25;
      signals.push('FVG Present');
      if (largeFvg) {
        score += 10;
        signals.push('Large FVG');
      }
    }

    const recent = fvgs.filter(f => f.index > fvgs[fvgs.length - 1].index - 3);
    if (recent.length > 0) {
      score += 15;
      signals.push('Fresh Imbalance');
    }

    const momentum = price.mid - (price.bid + price.ask) / 2;
    if (momentum !== 0) {
      score += 10;
      signals.push('Directional Momentum');
    }

    if (score > 80) signals.push('High Confluence');

    return { score: Math.min(99, score), signals };
  }

  private deriveVerdict(fvgs: FVG[], price: PriceQuote, silver: boolean): 'LONG' | 'SHORT' | 'WAIT' {
    if (!fvgs.length) return 'WAIT';
    const last = fvgs[fvgs.length - 1];

    if (silver) {
      return last.direction === 'bullish' ? 'LONG' : 'SHORT';
    }

    const below = price.mid < last.bottom;
    const above = price.mid > last.top;

    if (last.direction === 'bullish' && below) return 'LONG';
    if (last.direction === 'bearish' && above) return 'SHORT';

    return 'WAIT';
  }

  private gradeSetup(score: number): 'A+' | 'A' | 'B' | 'C' {
    if (score >= 85) return 'A+';
    if (score >= 75) return 'A';
    if (score >= 65) return 'B';
    return 'C';
  }

  async analyze(instrument: string, timeframe: string = 'M15'): Promise<BrainAnalysis> {
    const now      = this.getNowInUTC();
    const { hit: silver, label } = this.isSilverBulletWindow(now);

    const candlesRaw = await this.oanda.requestCandles(instrument, timeframe as any, 150);
    const candles: Candle[] = candlesRaw.map((c: any) => ({
      time:  c.time,
      open:  parseFloat(c.mid?.o ?? c.o),
      high:  parseFloat(c.mid?.h ?? c.h),
      low:   parseFloat(c.mid?.l ?? c.l),
      close: parseFloat(c.mid?.c ?? c.c),
    }));

    const fvgs = this.detectFVG(candles);
    const [price] = await this.oanda.getPrices([instrument]);

    const { score, signals } = this.scoreConfluence(fvgs, silver, price);
    const verdict   = this.deriveVerdict(fvgs, price, silver);
    const setupGrade = this.gradeSetup(score);

    const winRate = 55 + (score - 50) * 0.4;

    const ict: ICTContext = {
      fvgs,
      silverBullet: silver,
      timeWindow: label,
    };

    return {
      instrument,
      timeframe,
      verdict,
      confluenceScore: score,
      winRate: Math.max(40, Math.min(90, Math.round(winRate))),
      signals,
      setupGrade,
      ict,
    };
  }
}
