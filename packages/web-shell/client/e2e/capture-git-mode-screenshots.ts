/**
 * Standalone Playwright script to capture git mode selector screenshots.
 * Usage: npx tsx client/e2e/capture-git-mode-screenshots.ts
 * Requires: Vite dev server running on port 5174
 */
import { chromium } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5174';
const OUT_DIR = 'client/e2e/test-results';
const WORKSPACE_CWD = '/tmp/qwen-web-shell-e2e';

async function main() {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      workspaces: [
        { id: 'primary', cwd: WORKSPACE_CWD, primary: true, trusted: true },
      ],
    },
    gitStatus: { v: 2, workspaceCwd: WORKSPACE_CWD, branch: 'main' },
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });

  await installMockDaemon(page, scenario, { baseURL: BASE_URL });

  console.log('Navigating to', BASE_URL);
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Screenshot 1: default state with git chip
  const chip = page.locator('[data-testid="git-mode-chip"]');
  try {
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
    console.log('✓ Git mode chip visible');
  } catch {
    console.log('✗ Git mode chip not found, taking screenshot anyway');
  }
  await page.screenshot({
    path: `${OUT_DIR}/git-mode-1-default.png`,
    animations: 'disabled',
  });
  console.log('✓ Screenshot 1: default state');

  // Click chip to open popover
  await chip.click();
  await page.waitForTimeout(500);

  const popover = page.locator('[data-slot="popover-content"]');
  try {
    await popover.waitFor({ state: 'visible', timeout: 5_000 });
    console.log('✓ Popover visible');
  } catch {
    console.log('✗ Popover not found');
  }
  await page.screenshot({
    path: `${OUT_DIR}/git-mode-2-popover.png`,
    animations: 'disabled',
  });
  console.log('✓ Screenshot 2: popover open');

  // Prevent Radix DismissableLayer from closing the popover when
  // interacting inside the portal. Radix uses both pointerdown and
  // focusin heuristics; the portal container fools both.
  await page.evaluate(`
    (() => {
      const guard = (e) => {
        const popover = document.querySelector('[data-slot="popover-content"]');
        if (popover && popover.contains(e.target)) {
          e.stopImmediatePropagation();
        }
      };
      document.addEventListener('pointerdown', guard, true);
      document.addEventListener('focusin', guard, true);
    })()
  `);

  // Click "New branch" option
  const branchOption = popover
    .getByRole('button', { name: /New branch/ })
    .first();
  await branchOption.click();
  await page.waitForTimeout(500);

  const branchInput = page.locator('[data-testid="git-mode-branch-input"]');
  try {
    await branchInput.waitFor({ state: 'visible', timeout: 5_000 });
    console.log('✓ Branch input visible');
  } catch {
    console.log('✗ Branch input not found');
    await page.screenshot({
      path: `${OUT_DIR}/git-mode-debug-no-branch-input.png`,
      animations: 'disabled',
    });
  }
  await branchInput.fill('feat/git-mode-selector');
  await page.waitForTimeout(300);

  await page.screenshot({
    path: `${OUT_DIR}/git-mode-3-branch-input.png`,
    animations: 'disabled',
  });
  console.log('✓ Screenshot 3: branch input with name');

  // Confirm branch
  const confirmBtn = page.locator('[data-testid="git-mode-confirm-branch"]');
  await confirmBtn.click();
  await page.waitForTimeout(500);

  await page.screenshot({
    path: `${OUT_DIR}/git-mode-4-branch-selected.png`,
    animations: 'disabled',
  });
  console.log('✓ Screenshot 4: branch selected, chip updated');

  await browser.close();
  console.log('\nDone! Screenshots saved to', OUT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
