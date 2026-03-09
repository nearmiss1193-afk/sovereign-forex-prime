import fs from 'fs';
import path from 'path';

export interface JournalEntry {
  id:        string;
  ts:        string;
  tradeId:   string;
  instrument:string;
  direction: string;
  units:     number;
  lotSize:   number;
  entry:     number;
  stopLoss:  number;
  takeProfit:number;
  riskUSD:   number;
  comment:   string;
  [key: string]: any;
}

interface WeeklySummary {
  weekStart: string;
  weekEnd:   string;
  totalTrades: number;
  realizedPnl: number;
}

export class TradeJournal {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(process.cwd(), 'data', 'journal.json');
  }

  private ensureFile() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '[]', 'utf-8');
  }

  private readAll(): JournalEntry[] {
    this.ensureFile();
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    try {
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  private writeAll(entries: JournalEntry[]) {
    this.ensureFile();
    fs.writeFileSync(this.filePath, JSON.stringify(entries, null, 2));
  }

  async addEntry(entry: Omit<JournalEntry, 'id' | 'ts'>): Promise<void> {
    const list = this.readAll();
    const now  = new Date().toISOString();
    const rec: JournalEntry = {
      ...entry,
      id:  `${entry.tradeId}-${now}`,
      ts:  now,
    } as JournalEntry;
    list.push(rec);
    this.writeAll(list);
  }

  async getAll(): Promise<JournalEntry[]> {
    return this.readAll();
  }

  async getWeeklySummary(): Promise<WeeklySummary> {
    const entries = this.readAll();
    const now  = new Date();
    const day  = now.getUTCDay();
    const diff = (day + 6) % 7;
    const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
    const weekEnd   = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + 7));

    const inWeek = entries.filter(e => {
      const t = new Date(e.ts);
      return t >= weekStart && t < weekEnd;
    });

    const realizedPnl = inWeek.reduce((sum, e) => sum + (e.realizedPnl ?? 0), 0);

    return {
      weekStart: weekStart.toISOString(),
      weekEnd:   weekEnd.toISOString(),
      totalTrades: inWeek.length,
      realizedPnl,
    };
  }
}
