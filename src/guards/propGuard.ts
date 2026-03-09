export interface GuardResult {
  canTrade: boolean;
  warnings: string[];
}

export class PropGuard {
  private maxDailyLossPct = 4;
  private maxDrawdownPct  = 8;
  private minEquityPct    = 50;

  private dayStartEquity: number | null = null;

  update(dayPnl: number, weekPnl: number, balance: number) {
    if (this.dayStartEquity === null) {
      this.dayStartEquity = balance - dayPnl;
    }
  }

  check(account: any): GuardResult {
    const warnings: string[] = [];
    let   canTrade = true;

    const balance = Number(account.balance ?? 0);
    const nav     = Number(account.NAV ?? account.nav ?? account.balance ?? 0);
    const unreal  = Number(account.unrealizedPL ?? 0);

    const ddPct = balance > 0 ? ((balance - nav) / balance) * 100 : 0;
    if (ddPct < -this.maxDrawdownPct) {
      warnings.push(`⛔ Max drawdown exceeded: ${ddPct.toFixed(2)}%`);
      canTrade = false;
    }

    if (this.dayStartEquity && balance < this.dayStartEquity * (1 - this.maxDailyLossPct / 100)) {
      warnings.push('⛔ Daily loss limit breached');
      canTrade = false;
    }

    if (nav < balance * (this.minEquityPct / 100)) {
      warnings.push('⚠️ Equity below healthy threshold');
    }

    return { canTrade, warnings };
  }
}
