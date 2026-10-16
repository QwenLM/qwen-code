import { expect, test } from '@playwright/test';
import type { DaemonSessionStatsStatus } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

for (const width of [390, 1200]) {
  test(`large model statistics stay readable at ${width}px @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const scenario = createWebShellDaemonScenario();
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    const metrics = {
      api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 2345 },
      tokens: {
        prompt: 1234567,
        candidates: 12345,
        total: 1246912,
        cached: 10000,
        thoughts: 12,
      },
    };
    const stats: DaemonSessionStatsStatus = {
      v: 1,
      sessionId: scenario.sessionId,
      workspaceCwd: scenario.workspaceCwd,
      sessionStartTimeMs: 1000,
      durationMs: 42000,
      promptCount: 2,
      models: {
        '通义千问-qwen3-coder-plus-2025-09-23': metrics,
        'claude-sonnet-4-20250514::研究员': metrics,
      },
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        byName: {},
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
      sources: Array.from({ length: 800 }, (_, i) => ({
        id: `agent-${i}`,
        type: 'researcher',
        name: `研究员-${i}`,
        tokens: metrics.tokens,
      })),
    };
    expect(JSON.stringify(stats).length).toBeGreaterThan(100000);
    await page.route('**/session/*/stats', (route) =>
      route.fulfill({ json: stats }),
    );
    await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
    const connection = await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({
        sessionId: connection.sessionId,
        replayedCount: 0,
      }),
    );
    await expect(page.getByText('Loading...')).toHaveCount(0);
    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    await editor.fill('/stats model');
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const table = page
      .getByRole('table')
      .filter({ hasText: '通义千问-qwen3-coder-plus-2025-09-23' });
    await expect(table).toBeVisible();
    await expect(table).toContainText('1,246,912');
    await expect(
      page.locator('[data-web-shell-message-list]'),
    ).not.toContainText('web-shell:session-stats');
    await expect(
      page.locator('[data-web-shell-message-list]'),
    ).not.toContainText('[truncated]');
    const geometry = await table.evaluate((element) => {
      const headers = Array.from(element.querySelectorAll('thead th'));
      const requests = element.querySelectorAll('tbody tr')[1];
      const cells = Array.from(requests.querySelectorAll('td'));
      const textBounds = headers.map((header) => {
        const range = document.createRange();
        range.selectNodeContents(header);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      return {
        textBounds,
        headerLefts: headers.map((cell) => cell.getBoundingClientRect().left),
        valueLefts: cells.map((cell) => cell.getBoundingClientRect().left),
        scrollWidth: element.parentElement!.scrollWidth,
        clientWidth: element.parentElement!.clientWidth,
      };
    });
    expect(geometry.textBounds[1].right).toBeLessThanOrEqual(
      geometry.textBounds[2].left,
    );
    geometry.headerLefts.forEach((left, i) =>
      expect(left).toBeCloseTo(geometry.valueLefts[i], 1),
    );
    if (width === 390)
      expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
    await table.evaluate((element) => {
      element.parentElement!.scrollLeft = element.parentElement!.scrollWidth;
    });
    const lastHeader = table.getByRole('columnheader').last();
    await expect(lastHeader).toBeInViewport();
  });
}
