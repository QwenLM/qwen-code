#!/usr/bin/env node
/**
 * PR2 pr-ui-verify: the SSE admission row in DaemonStatusDialog, four
 * states against REAL daemons (issue #17554 follow-up 3, closeout hold).
 *
 *   paired    → bundle daemon (cap 204) + 6 held REST streams → "6 / 204"
 *   cap-only  → base-commit daemon (#17502, no occupancy)     → "204"
 *   unlimited → bundle daemon --max-sse-connections 0         → "0 / unlimited"
 *   no-row    → global qwen 0.28.0 (pre-#17502)               → row absent
 *
 * Each state has its own vite dev server (QWEN_DAEMON_URL) and daemon.
 * Assertions read the DOM text; screenshots saved per state.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = '/tmp/sse-uni-e2e/r2';
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? process.argv[onlyArg + 1].split(',') : undefined;
const shots = `${ROOT}/shots`;
mkdirSync(shots, { recursive: true });
const token = (port) => readFileSync(`${ROOT}/token-${port}`, 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const states = [
  { name: 'paired', vite: 5195, daemon: 4195, expectRow: '6 / 204', holdStreams: 6 },
  { name: 'cap-only', vite: 5197, daemon: 4197, expectRow: '204', exactRow: 'SSE admission (used / cap)204' },
  { name: 'unlimited', vite: 5198, daemon: 4198, expectRow: '0 / unlimited' },
  { name: 'no-row', vite: 5196, daemon: 4196, expectAbsent: true },
];

const results = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const state of states.filter((s) => !only || only.includes(s.name))) {
    const held = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    try {
      if (state.holdStreams) {
        // Create one session, then hold N REST event streams open so the
        // daemon's aggregate occupancy reads N while the dialog is open.
        const auth = { Authorization: `Bearer ${token(state.daemon)}` };
        const created = await (
          await fetch(`http://127.0.0.1:${state.daemon}/session`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: '{}',
          })
        ).json();
        for (let i = 0; i < state.holdStreams; i++) {
          const controller = new AbortController();
          const res = await fetch(
            `http://127.0.0.1:${state.daemon}/session/${created.sessionId}/events`,
            { headers: auth, signal: controller.signal },
          );
          if (res.status !== 200) throw new Error(`stream ${i}: ${res.status}`);
          held.push({ controller, res });
        }
        await sleep(500);
      }
      await page.goto(`http://127.0.0.1:${state.vite}/?token=${token(state.daemon)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      let trigger = page.locator('button[aria-label="Daemon Status"]');
      if (!(await trigger.isVisible().catch(() => false))) {
        // Rail layout folds the footer items into the More overflow menu.
        await page.locator('button[aria-label="More"]').first().click();
        trigger = page.locator('button, [role="menuitem"]', { hasText: 'Daemon Status' }).first();
      }
      await trigger.waitFor({ state: 'visible', timeout: 45_000 });
      const lang = await page.locator('html').getAttribute('lang');
      await trigger.click();
      // The Transport card (and the SSE admission row) live on the default
      // Overview tab, below the fold — scroll it into view for the shot.
      await page.locator('text=Transport').first().waitFor({ state: 'visible', timeout: 20_000 });
      await sleep(1500); // let the full status report land and re-render
      if (!state.expectAbsent) {
        const rowLabel = page.locator('span', { hasText: 'SSE admission (used / cap)' }).first();
        await rowLabel.waitFor({ state: 'visible', timeout: 20_000 });
        await rowLabel.scrollIntoViewIfNeeded();
        await sleep(300);
      } else {
        await page.locator('text=Transport').first().scrollIntoViewIfNeeded();
      }

      const rowInfo = await page.evaluate(() => {
        const spans = [...document.querySelectorAll('span')];
        const label = spans.find((s) => s.textContent === 'SSE admission (used / cap)');
        if (!label) return { present: false };
        const row = label.closest('div');
        return { present: true, rowText: row?.textContent ?? '', labelText: label.textContent };
      });
      const dialogText = await page.evaluate(() => document.body.innerText);
      const shotPath = `${shots}/${state.name}.png`;
      await page.screenshot({ path: shotPath, fullPage: false });

      let pass;
      let detail;
      if (state.expectAbsent) {
        pass = !rowInfo.present && !dialogText.includes('SSE admission');
        detail = { rowPresent: rowInfo.present, lang, pageErrors };
      } else {
        const valueOk = rowInfo.present && rowInfo.rowText.includes(state.expectRow);
        const exactOk = state.exactRow ? rowInfo.rowText === state.exactRow : true;
        // The paired value must not be the REST-only counter or a listener share.
        pass = valueOk && exactOk && pageErrors.length === 0;
        detail = { rowText: rowInfo.rowText, expected: state.expectRow, exact: state.exactRow, lang, pageErrors };
      }
      results.push({ state: state.name, pass, detail, shot: shotPath });
      console.log(`${pass ? 'PASS' : 'FAIL'} ${state.name} :: ${JSON.stringify(detail)}`);
    } catch (err) {
      results.push({ state: state.name, pass: false, detail: { error: String(err), pageErrors } });
      console.log(`FAIL ${state.name} :: ${String(err)}`);
      await page.screenshot({ path: `${shots}/${state.name}-error.png` }).catch(() => {});
    } finally {
      for (const h of held) {
        h.controller.abort();
        await h.res.body?.cancel().catch(() => {});
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} states passed`);
process.exit(failed.length ? 1 : 0);