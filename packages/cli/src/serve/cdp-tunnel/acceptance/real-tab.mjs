/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan C real-Chrome local verification (issue #5626).
 *
 * Connects puppeteer to a RUNNING daemon's `/cdp` and reads the user's REAL
 * active tab through the extension's `chrome.debugger`. Unlike
 * `cdp-tunnel-acceptance.mjs` (mock extension, no browser), this needs a real
 * Chrome with the extension loaded.
 *
 * Prereqs:
 *   1. Build: `npm run build` (cli + extension).
 *   2. Start the daemon with the tunnel on:
 *        QWEN_SERVE_CDP_TUNNEL_OVER_WS=1 QWEN_SERVE_CLIENT_MCP_OVER_WS=1 \
 *          npm start -- serve --port 4170 --hostname 127.0.0.1 --no-web \
 *          --workspace <abs-repo> --allow-origin chrome-extension://<ext-id>
 *   3. chrome://extensions → Load unpacked →
 *        packages/chrome-extension/dist/extension
 *   4. Open the extension's "Service Worker" DevTools to keep the worker awake
 *      (until the extension ships a chrome.alarms keepalive), and have a normal
 *      page as the active tab.
 *
 * Run: `node packages/cli/src/serve/cdp-tunnel/acceptance/real-tab.mjs`
 * PASS = it prints your real tab's url/title/body (a debugger banner appears).
 */
import puppeteer from 'puppeteer-core';

const WS = process.env.WS || `ws://127.0.0.1:${process.env.PORT || 4170}/cdp`;
const out = { connected: false, pages: 0, url: null, title: null, bodyText: null, error: null };

try {
  console.log('[real-tab] connecting puppeteer to', WS);
  const browser = await puppeteer.connect({ browserWSEndpoint: WS, protocolTimeout: 25000 });
  out.connected = true;
  const pages = await browser.pages();
  out.pages = pages.length;
  const page = pages[0];
  if (page) {
    out.url = page.url();
    out.title = await page.title().catch((e) => 'TITLE-ERR:' + e.message);
    out.bodyText = await page
      .evaluate(() => document.body?.innerText?.slice(0, 240) || '(no body text)')
      .catch((e) => 'EVAL-ERR:' + e.message);
  }
  await browser.disconnect();
} catch (e) {
  out.error = e.message;
}

console.log('\n=== REAL-CHROME /cdp RESULT ===');
console.log(JSON.stringify(out, null, 2));
console.log(
  '\nREAL-TAB READ:',
  out.connected && out.pages > 0 && typeof out.title === 'string' && !out.title.startsWith('TITLE-ERR')
    ? 'PASS — read your real tab'
    : out.error
      ? `FAIL — ${out.error}`
      : 'FAIL',
);
process.exit(0);
