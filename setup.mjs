/**
 * ⚡ SOVEREIGN FOREX PRIME — ONE-TIME SETUP
 * Auto-discovers OANDA Account ID and writes .env
 * Run: node setup.mjs
 */

import fs from 'fs';

const KEY = '2a6a667ce1c1ff8b40dc50f8d5db33d0-22e9470bf3ee4972f0a66d3b20df9a38';
const BASE = 'https://api-fxpractice.oanda.com/v3';

console.log('\n⚡ SOVEREIGN FOREX PRIME — SETUP\n');
console.log('   Connecting to OANDA DEMO...\n');

try {
  const res  = await fetch(`${BASE}/accounts`, {
    headers: { Authorization: `Bearer ${KEY}` }
  });
  const data = await res.json();

  if (!res.ok) {
    console.error('❌ OANDA Error:', data.errorMessage || JSON.stringify(data));
    process.exit(1);
  }

  const accounts = data.accounts;
  console.log(`✅ Found ${accounts.length} account(s):\n`);

  accounts.forEach((a, i) => {
    console.log(`   [${i+1}] ID: ${a.id}  |  Tags: ${a.tags?.join(', ')||'none'}`);
  });

  const accountId = accounts[0].id;
  console.log(`\n   → Using: ${accountId}`);

  // Write .env
  const env = `# ⚡ SOVEREIGN FOREX PRIME — AUTO-CONFIGURED
OANDA_API_KEY=${KEY}
OANDA_ACCOUNT_ID=${accountId}
OANDA_PRACTICE=true

PORT=3000
WS_PORT=3001

WEEK_TARGET=3000
DAY_TARGET=600
MAX_DAILY_LOSS_PCT=5
MAX_DRAWDOWN_PCT=10
MAX_RISK_PER_TRADE_PCT=1
CONSISTENCY_CAP_PCT=45

# Set AUTO_TRADE=true ONLY when you are ready to go live
AUTO_TRADE=false
MIN_CONFLUENCE=65
DEFAULT_PAIRS=EUR_USD,GBP_USD,USD_JPY,AUD_USD
SCAN_INTERVAL_MS=60000
`;

  fs.writeFileSync('.env', env);
  console.log('\n✅ .env written with Account ID');
  console.log('✅ Ready to run: npm run dev\n');

  // Quick account summary
  const sumRes = await fetch(`${BASE}/accounts/${accountId}/summary`, {
    headers: { Authorization: `Bearer ${KEY}` }
  });
  const sum = await sumRes.json();
  const a   = sum.account;
  console.log(`   Balance:    ${a.currency} ${parseFloat(a.balance).toLocaleString()}`);
  console.log(`   NAV:        ${a.currency} ${parseFloat(a.NAV).toLocaleString()}`);
  console.log(`   Open trades: ${a.openTradeCount}`);
  console.log('\n⚡ MAX PROFIT MODE READY\n');

} catch(e) {
  console.error('❌ Setup failed:', e.message);
}
