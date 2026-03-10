// src/routes/tokenRoutes.ts
import { Router, Request, Response } from 'express';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const router = Router();

const TOKEN_FILE = path.resolve(process.cwd(), '.oanda_token');

// Helper: persist token to disk AND update process.env at runtime
function saveToken(token: string): void {
  process.env.OANDA_TOKEN = token;
  try {
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
  } catch {
    // Non-fatal — token is at least in memory for this session
  }
}

// ── AUTO-FETCH: Playwright headless login ──────────────────────────────────
router.post('/auto-fetch', async (req: Request, res: Response) => {
  const { OANDA_USERNAME, OANDA_PASSWORD } = process.env;

  if (!OANDA_USERNAME || !OANDA_PASSWORD) {
    return res.json({
      ok: false,
      error: 'OANDA_USERNAME and OANDA_PASSWORD must be set in .env / Render env vars',
    });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // 1. Navigate to OANDA login
    await page.goto('https://www.oanda.com/us-en/login/', {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    // 2. Fill credentials
    await page.fill('input[name="username"], input[type="email"]', OANDA_USERNAME);
    await page.fill('input[name="password"], input[type="password"]', OANDA_PASSWORD);
    await page.click('button[type="submit"]');

    // 3. Wait for post-login redirect
    await page.waitForURL(/oanda\.com/, { timeout: 20_000 });

    // 4. Navigate to API access token page
    await page.goto('https://www.oanda.com/account/api/api-access-tokens', {
      waitUntil: 'networkidle',
      timeout: 20_000,
    });

    // 5. Scrape or generate a token
    let token: string | null = null;

    // Try reading an existing visible token first
    const tokenInput = page.locator('input[type="text"][value]').first();
    if (await tokenInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      token = await tokenInput.inputValue();
    }

    // If none visible, click Generate Token button
    if (!token) {
      const genBtn = page.locator('button:has-text("Generate"), button:has-text("Create")').first();
      if (await genBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await genBtn.click();
        await page.waitForTimeout(2_000);
        const newInput = page.locator('input[type="text"][value]').first();
        token = await newInput.inputValue().catch(() => null);
      }
    }

    await browser.close();

    if (!token || token.trim() === '') {
      return res.json({
        ok: false,
        error: 'Could not extract token from OANDA page — may need 2FA or manual step',
      });
    }

    saveToken(token.trim());
    return res.json({ ok: true, message: 'Token fetched and saved' });

  } catch (err: any) {
    if (browser) await browser.close().catch(() => {});
    console.error('[auto-fetch-token]', err);
    return res.json({ ok: false, error: err.message || 'Playwright login failed' });
  }
});

// ── RENEW: Reload stored token ─────────────────────────────────────────────
router.post('/renew', async (req: Request, res: Response) => {
  try {
    const stored = fs.existsSync(TOKEN_FILE)
      ? fs.readFileSync(TOKEN_FILE, 'utf8').trim()
      : null;

    if (stored) {
      saveToken(stored);
      return res.json({ ok: true, message: 'Token reloaded from disk' });
    }

    const envToken = process.env.OANDA_TOKEN;
    if (envToken) {
      saveToken(envToken);
      return res.json({ ok: true, message: 'Token refreshed from env' });
    }

    return res.json({
      ok: false,
      error: 'No stored token found — use Auto-Fetch instead',
    });
  } catch (err: any) {
    return res.json({ ok: false, error: err.message });
  }
});

export default router;
