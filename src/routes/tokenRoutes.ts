// src/routes/tokenRoutes.ts
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();
const TOKEN_FILE = path.resolve(process.cwd(), '.oanda_token');

function saveToken(token: string): void {
  process.env.OANDA_API_KEY = token;
  process.env.OANDA_TOKEN = token;
  try {
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
  } catch {
    // Non-fatal
  }
}

// AUTO-FETCH: Validate existing .env credentials against OANDA REST API
router.post('/auto-fetch', async (req: Request, res: Response) => {
  const apiKey    = process.env.OANDA_API_KEY;
  const accountId = process.env.OANDA_ACCOUNT_ID;
  const isPractice = process.env.OANDA_PRACTICE === 'true';

  if (!apiKey || !accountId) {
    return res.json({
      ok: false,
      error: 'OANDA_API_KEY and OANDA_ACCOUNT_ID must be set in your Render environment variables.',
    });
  }

  const baseUrl = isPractice
    ? 'https://api-fxpractice.oanda.com'
    : 'https://api-fxtrade.oanda.com';

  try {
    const response = await fetch(`${baseUrl}/v3/accounts/${accountId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      return res.json({
        ok: false,
        error: `OANDA rejected credentials (HTTP ${response.status}): ${body}`,
      });
    }

    const data = await response.json() as any;
    const account = data?.account ?? data?.Account;

    if (!account) {
      return res.json({ ok: false, error: 'OANDA responded but account data was missing.' });
    }

    saveToken(apiKey);

    return res.json({
      ok: true,
      message: 'OANDA credentials verified and active',
      accountId: account.id ?? accountId,
      balance: account.balance,
      currency: account.currency,
      mode: isPractice ? 'PRACTICE' : 'LIVE',
    });
  } catch (err: any) {
    console.error('[auto-fetch-token]', err);
    return res.json({ ok: false, error: err.message || 'Network error connecting to OANDA' });
  }
});

// RENEW: Reload stored token
router.post('/renew', async (req: Request, res: Response) => {
  try {
    const stored = fs.existsSync(TOKEN_FILE)
      ? fs.readFileSync(TOKEN_FILE, 'utf8').trim()
      : null;

    if (stored) {
      saveToken(stored);
      return res.json({ ok: true, message: 'Token reloaded from disk' });
    }
    const envToken = process.env.OANDA_API_KEY || process.env.OANDA_TOKEN;
    if (envToken) {
      saveToken(envToken);
      return res.json({ ok: true, message: 'Token refreshed from env' });
    }
    return res.json({
      ok: false,
      error: 'No stored token found - use Auto-Fetch instead',
    });
  } catch (err: any) {
    return res.json({ ok: false, error: err.message });
  }
});

export default router;
