/**
 * Standalone Playwright script to capture session content-search screenshots
 * for PR #10261. Usage: npx tsx client/e2e/capture-session-search-screenshots.ts
 * Requires: Vite dev server running on port 5174
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5174';
const OUT_DIR = 'client/e2e/test-results';
mkdirSync(OUT_DIR, { recursive: true });
const WORKSPACE_CWD = '/tmp/qwen-web-shell-e2e';
const now = new Date().toISOString();

async function main() {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: WORKSPACE_CWD,
    capabilities: {
      workspaces: [
        { id: 'primary', cwd: WORKSPACE_CWD, primary: true, trusted: true },
      ],
    },
    sessions: [
      {
        sessionId: 'session-refactor-auth',
        workspaceCwd: WORKSPACE_CWD,
        createdAt: now,
        updatedAt: now,
        displayName: 'Refactor auth module',
        clientCount: 0,
        hasActivePrompt: false,
      },
      {
        sessionId: 'session-fix-login',
        workspaceCwd: WORKSPACE_CWD,
        createdAt: now,
        updatedAt: now,
        displayName: 'Fix login redirect loop',
        clientCount: 0,
        hasActivePrompt: false,
      },
      {
        sessionId: 'session-generic-title',
        workspaceCwd: WORKSPACE_CWD,
        createdAt: now,
        updatedAt: now,
        displayName: 'New Session',
        clientCount: 0,
        hasActivePrompt: false,
      },
    ],
  });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    await installMockDaemon(page, scenario, { baseURL: BASE_URL });

    // The scenario mock answers content search with no hits by default;
    // override it (Playwright matches the most recently registered route
    // first) so the demo keyword hits a session whose title doesn't contain
    // it — the #10261 case.
    await page.route('**/sessions/search?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [
            {
              session: {
                sessionId: 'session-qdrant-hit',
                workspaceCwd: WORKSPACE_CWD,
                createdAt: now,
                updatedAt: now,
                displayName: 'New Session',
                clientCount: 0,
                hasActivePrompt: false,
              },
              snippet:
                '...the qdrant indexing pipeline batches upserts every 500ms...',
            },
          ],
        }),
      });
    });

    console.log('Navigating to', BASE_URL);
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Open the sidebar session search.
    const searchToggle = page.locator(
      '[aria-label="Search sessions"], [aria-label="搜索会话"]',
    );
    await searchToggle.first().waitFor({ state: 'visible', timeout: 10_000 });
    await searchToggle.first().click();
    await page.waitForTimeout(300);

    const searchInput = page.locator(
      'input[aria-label="Search sessions"], input[aria-label="搜索会话"]',
    );
    await searchInput.waitFor({ state: 'visible', timeout: 5_000 });

    // Type a keyword that only exists inside a session's messages.
    await searchInput.fill('qdrant');
    // Wait past the 300ms debounce + server round-trip.
    await page.waitForTimeout(1200);

    await page.screenshot({
      path: `${OUT_DIR}/session-content-search.png`,
      animations: 'disabled',
    });
    console.log('✓ Screenshot: content search hit with snippet');

    const sidebar = page.locator('aside, [data-web-shell-sidebar]').first();
    await sidebar
      .screenshot({
        path: `${OUT_DIR}/session-content-search-sidebar.png`,
        animations: 'disabled',
      })
      .catch(() => console.log('(sidebar-only capture skipped)'));
  } finally {
    await browser.close();
  }
}

await main();
