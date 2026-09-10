import { expect, test } from '@playwright/test';
import type { DaemonSessionContextUsageStatus } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

for (const theme of ['light', 'dark']) {
  test(`context details stay readable and keyboard accessible in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const scenario = createWebShellDaemonScenario({
      state: {
        models: {
          currentModelId: 'qwen-test',
          availableModels: [
            { modelId: 'qwen-test', name: 'Qwen Test', contextLimit: 100_000 },
          ],
        },
      },
    });
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    const longName =
      'mcp__github__create_repository_issue_with_detailed_context';
    const status: DaemonSessionContextUsageStatus = {
      v: 1,
      sessionId: scenario.sessionId,
      workspaceCwd: scenario.workspaceCwd,
      formattedText: '',
      usage: {
        modelName: 'test-model-with-a-long-context-window-name',
        totalTokens: 60_000,
        contextWindowSize: 100_000,
        breakdown: {
          systemPrompt: 10_000,
          builtinTools: 10_000,
          mcpTools: 5_000,
          memoryFiles: 5_000,
          skills: 10_000,
          messages: 20_000,
          freeSpace: 30_000,
          autocompactBuffer: 10_000,
        },
        builtinTools: [
          { name: 'read_file', tokens: 3_000 },
          { name: 'run_shell_command', tokens: 7_000 },
        ],
        mcpTools: [{ name: longName, tokens: 5_000 }],
        memoryFiles: [
          { path: '/workspace/a/long/project/path/QWEN.md', tokens: 5_000 },
        ],
        skills: [
          { name: 'review', tokens: 5_000, loaded: true, bodyTokens: 5_000 },
        ],
        showDetails: true,
        isEstimated: true,
      },
    };
    const contextRequests: boolean[] = [];
    await page.route(/\/session\/[^/]+\/context-usage(?:\?|$)/, (route) => {
      const detail =
        new URL(route.request().url()).searchParams.get('detail') === 'true';
      contextRequests.push(detail);
      return route.fulfill({
        json: { ...status, usage: { ...status.usage, showDetails: detail } },
      });
    });
    await page.goto(`/session/${scenario.sessionId}?theme=${theme}`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId: scenario.sessionId }),
    );
    await expect(page.getByText('Loading...')).toHaveCount(0);
    await daemon.sendEvent({
      id: 20,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
          _meta: { usage: { inputTokens: 60_000 } },
        },
      },
    });
    const usage = page.locator('[data-web-shell-context-usage]');
    const percentage = usage.getByText('60.0%', { exact: true });
    await expect(percentage).toBeVisible();
    await page.setViewportSize({ width: 500, height: 900 });
    await expect(percentage).toBeHidden();
    await expect(usage).toBeVisible();
    await expect(usage).toHaveAttribute('aria-label', '60.0% context used');
    await expect(
      page.locator('[data-web-shell-composer-submit]'),
    ).toBeInViewport();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(percentage).toBeVisible();
    await usage.hover();
    const tooltip = page.locator('[data-slot="tooltip-content"]');
    await expect(tooltip).toContainText('60,000 tokens');
    await expect(tooltip).toContainText('100,000 tokens');
    await expect(tooltip).toContainText(
      'Click to view the breakdown in the conversation.',
    );
    expect(contextRequests).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`context-hover-${theme}.png`),
    });
    await usage.click();
    const history = page.locator('[data-web-shell-message-list]');
    const cards = history.getByRole('region', {
      name: 'Context Usage',
      exact: true,
    });
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('60.0%');
    expect(contextRequests).toEqual([false]);
    await cards.first().getByRole('button', { name: 'View details' }).click();
    await expect(cards).toHaveCount(2);
    expect(contextRequests).toEqual([false, true]);
    const detailCard = cards.last();
    await expect(detailCard.locator('details[open]')).toHaveCount(4);
    await expect(detailCard.getByText(longName, { exact: true })).toBeVisible();
    const meter = detailCard.locator('[aria-hidden="true"]').first();
    const track = await meter.boundingBox();
    const filled = await meter.locator('span').first().boundingBox();
    expect(Math.round((filled!.width / track!.width) * 100)).toBe(60);
    for (const width of [1440, 700, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await detailCard.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await detailCard.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`context-transcript-${theme}.png`),
    });
    await page
      .getByRole('button', { name: 'Context Usage', exact: true })
      .click();

    const panel = page.locator('[class*="panel"][aria-busy]');
    await expect(panel).toContainText('60.0k tokens (60.0%)');
    const tools = panel
      .locator('details')
      .filter({ hasText: 'Built-in tools' });
    await expect(tools.locator('summary')).toHaveText('Built-in tools (2)');
    await expect(
      panel.getByText('run_shell_command', { exact: true }),
    ).toBeHidden();
    await tools.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(
      panel.getByText('run_shell_command', { exact: true }),
    ).toBeVisible();
    await expect(tools.locator('[title]')).toHaveText([
      'run_shell_command',
      'read_file',
    ]);
    await page.keyboard.press('Space');
    await expect(
      panel.getByText('run_shell_command', { exact: true }),
    ).toBeHidden();
    for (const summary of await panel.locator('summary').all()) {
      await summary.click();
    }
    await expect(panel.getByText(longName, { exact: true })).toBeVisible();
    await expect(panel).toContainText('body loaded');

    const context = panel.locator('[class*="compact"]');
    for (const width of [280, 360, 480]) {
      await context.evaluate((element, width) => {
        (element as HTMLElement).style.width = `${width}px`;
      }, width);
      expect(
        await context.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
      const row = context.locator('[class*="detailRow"]').first();
      const [name, value] = await Promise.all([
        row.locator('[title]').boundingBox(),
        row.locator(':scope > span').last().boundingBox(),
      ]);
      expect(name!.x + name!.width).toBeLessThanOrEqual(value!.x);
      expect(Math.abs(name!.y - value!.y)).toBeLessThanOrEqual(1);
    }
    await context.evaluate((element) => {
      (element as HTMLElement).style.removeProperty('width');
    });
    await page.screenshot({
      path: testInfo.outputPath(`context-${theme}.png`),
    });
  });
}
