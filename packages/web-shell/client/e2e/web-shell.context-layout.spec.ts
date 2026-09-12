import { expect, test } from '@playwright/test';
import type { DaemonSessionContextUsageStatus } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

for (const theme of ['light', 'dark']) {
  test(`@smoke context details stay readable and keyboard accessible in ${theme}`, async ({
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
    const surface = page.locator('[data-web-shell-composer-surface]');
    const composer = page.locator('[data-web-shell-composer-content]');
    const focusColor =
      theme === 'dark' ? 'rgb(74, 158, 255)' : 'rgb(11, 102, 195)';
    const restingColor =
      theme === 'dark' ? 'rgb(42, 45, 52)' : 'rgb(212, 215, 226)';
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await expect(composer).toHaveCSS('border-top-color', restingColor);
    for (const trigger of [
      page.locator('[data-web-shell-mode-button]'),
      page.locator('[data-web-shell-model-button]'),
      page.getByTestId('composer-add-menu-trigger'),
    ]) {
      await trigger.focus();
      await expect(composer).toHaveCSS('border-top-color', focusColor);
      await trigger.press('Enter');
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(composer).toHaveCSS('border-top-color', focusColor);
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toBeFocused();
      await expect(composer).toHaveCSS('border-top-color', focusColor);
    }
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await expect(composer).toHaveCSS('border-top-color', restingColor);
    const editor = surface.locator('.cm-content[contenteditable="true"]');
    await editor.focus();
    await page.keyboard.insertText('@');
    const references = page.locator('[data-at-mention-panel]');
    await expect(references).toBeVisible();
    await page.keyboard.press('Enter');
    const referenceSearch = references.getByRole('textbox', { name: 'Search' });
    await expect(referenceSearch).toBeFocused();
    await referenceSearch.fill('package');
    await expect
      .poll(() =>
        surface.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(false);
    await expect(composer).toHaveCSS('border-top-color', focusColor);
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await expect(references).toHaveCount(0);
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await expect(composer).toHaveCSS('border-top-color', restingColor);
    const usage = page.locator('[data-web-shell-context-usage]');
    const percentage = usage.getByText('60.0%', { exact: true });
    const secondaryColor =
      theme === 'dark' ? 'rgb(160, 160, 160)' : 'rgb(95, 98, 89)';
    const errorColor =
      theme === 'dark' ? 'rgb(252, 129, 129)' : 'rgb(192, 54, 44)';
    await expect(percentage).toBeVisible();
    await expect(percentage).toHaveCSS('color', secondaryColor);
    for (const width of [520, 521]) {
      await surface.evaluate((element, width) => {
        (element as HTMLElement).style.width = `${width}px`;
      }, width);
      if (width === 520) await expect(percentage).toBeHidden();
      else await expect(percentage).toBeVisible();
      await expect(
        page.locator('[data-web-shell-composer-submit]'),
      ).toBeInViewport();
      const [surfaceBox, sendBox] = await Promise.all([
        surface.boundingBox(),
        page.locator('[data-web-shell-composer-submit]').boundingBox(),
      ]);
      expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(
        surfaceBox!.x + surfaceBox!.width,
      );
      const left = surface.locator('[class*="toolbarLeft"]');
      await expect
        .poll(() =>
          left.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        )
        .toBe(true);
      const model = surface.locator('[data-web-shell-model-button]');
      await expect
        .poll(() =>
          model.evaluate((element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return element.contains(
              document.elementFromPoint(x + width / 2, y + height / 2),
            );
          }),
        )
        .toBe(true);
    }
    await surface.evaluate((element) =>
      (element as HTMLElement).style.removeProperty('width'),
    );
    await page.setViewportSize({ width: 500, height: 900 });
    await expect(percentage).toBeHidden();
    await expect(usage).toBeVisible();
    await expect(usage).toHaveAttribute('aria-label', '60.0% context used');
    await expect(
      page.locator('[data-web-shell-composer-submit]'),
    ).toBeInViewport();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(percentage).toBeVisible();
    const tooltip = page.locator('[data-slot="tooltip-content"]');
    await page.getByRole('button', { name: 'Ultra wide', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(usage).toBeFocused();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('60,000 tokens');
    expect(contextRequests).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    await page.getByRole('button', { name: 'Ultra wide', exact: true }).focus();
    await page.getByRole('button', { name: 'Ultra wide', exact: true }).hover();
    await usage.hover();
    await expect(tooltip).toContainText('60,000 tokens');
    await expect(tooltip).toContainText('100,000 tokens');
    await expect(tooltip.locator('dt')).toHaveCount(3);
    await expect(tooltip).toContainText('Remaining40,000 tokens');
    for (const label of await tooltip.locator('dt').all()) {
      await expect(label).toHaveCSS('color', secondaryColor);
    }
    await expect(tooltip).toContainText(
      'Click to view the breakdown in the conversation.',
    );
    await expect(
      tooltip.getByText('Click to view the breakdown in the conversation.', {
        exact: true,
      }),
    ).toHaveCSS('color', secondaryColor);
    expect(contextRequests).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`context-hover-${theme}.png`),
    });
    await usage.click();
    const history = page.locator('[data-web-shell-message-list]');
    const cards = history.getByRole('group', {
      name: 'Context Usage',
      exact: true,
    });
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('60.0%');
    expect(contextRequests).toEqual([false]);
    await cards.first().getByRole('button', { name: 'View details' }).click();
    await expect(cards).toHaveCount(2);
    await expect(
      history.getByRole('region', { name: 'Context Usage', exact: true }),
    ).toHaveCount(0);
    expect(contextRequests).toEqual([false, true]);
    const detailCard = cards.last();
    await expect(detailCard.locator('[class*="total"]')).toHaveText(
      '60.0k / 100.0k tokens',
    );
    await expect(detailCard.locator('details[open]')).toHaveCount(5);
    await expect(
      detailCard.locator('summary').filter({ hasText: 'Built-in tools' }),
    ).toHaveAccessibleName('Built-in tools 10.0k (10.0%)');
    await expect(
      detailCard
        .locator('summary')
        .filter({ hasText: 'Built-in tools' })
        .locator('[class*="ratio"]'),
    ).toHaveCSS('color', secondaryColor);
    await expect(detailCard.getByText(longName, { exact: true })).toBeVisible();
    await expect(detailCard.getByText(longName, { exact: true })).toHaveCSS(
      'color',
      theme === 'dark' ? 'rgb(103, 133, 255)' : 'rgb(0, 51, 255)',
    );
    const meter = detailCard.locator('[data-web-shell-context-meter]');
    await expect(meter).toBeVisible();
    const track = await meter.boundingBox();
    const filled = await meter.locator('span').first().boundingBox();
    expect(track).not.toBeNull();
    expect(filled).not.toBeNull();
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
    await expect(panel).toContainText('60.0k (60.0%)');
    await panel.locator('details > summary').first().click();
    const tools = panel
      .locator('details details')
      .filter({ hasText: 'Built-in tools' });
    await expect(tools.locator('summary')).toHaveText(
      'Built-in tools 10.0k (10.0%)',
    );
    const plainCategoryLabel = await panel
      .getByText('System prompt', { exact: true })
      .boundingBox();
    const expandableCategoryLabel = await tools
      .getByText('Built-in tools', { exact: true })
      .boundingBox();
    expect(plainCategoryLabel).not.toBeNull();
    expect(expandableCategoryLabel).not.toBeNull();
    expect(expandableCategoryLabel!.x).toBe(plainCategoryLabel!.x);
    await expect(tools.locator('summary [class*="ratio"]')).toHaveCSS(
      'color',
      secondaryColor,
    );
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
    for (const summary of await panel
      .locator('details details > summary')
      .all()) {
      await summary.click();
    }
    await expect(panel.getByText(longName, { exact: true })).toBeVisible();
    await expect(panel).toContainText('body loaded');

    const context = panel.locator('[class*="compact"]');
    const rows = context.locator('[class*="detailRow"]');
    await expect(rows).toHaveCount(5);
    for (const width of [280, 360, 480]) {
      await context.evaluate((element, width) => {
        (element as HTMLElement).style.width = `${width}px`;
      }, width);
      expect(
        await context.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
      for (const row of await rows.all()) {
        const [name, value] = await Promise.all([
          row.locator('[title]').boundingBox(),
          row.locator(':scope > span').last().boundingBox(),
        ]);
        expect(name!.x + name!.width).toBeLessThanOrEqual(value!.x);
        expect(Math.abs(name!.y - value!.y)).toBeLessThanOrEqual(1);
      }
    }
    await context.evaluate((element) => {
      (element as HTMLElement).style.removeProperty('width');
    });
    await page.screenshot({
      path: testInfo.outputPath(`context-${theme}.png`),
    });
    await page.getByRole('button', { name: 'Toggle right panel' }).click();
    await expect(panel).toBeHidden();
    for (const [tokens, level, color] of [
      [
        61_000,
        'warning',
        theme === 'dark' ? 'rgb(236, 201, 75)' : 'rgb(154, 106, 0)',
      ],
      [81_000, 'error', errorColor],
      [120_000, 'error', errorColor],
    ] as const) {
      status.usage.totalTokens = tokens;
      status.usage.breakdown.messages = tokens - 40_000;
      status.usage.breakdown.freeSpace = Math.max(0, 90_000 - tokens);
      await page
        .getByRole('button', { name: 'Ultra wide', exact: true })
        .focus();
      await expect(tooltip).toHaveCount(0);
      await daemon.sendEvent({
        id: tokens,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '' },
            _meta: { usage: { inputTokens: tokens } },
          },
        },
      });
      await expect(usage.locator('[data-level]')).toHaveAttribute(
        'data-level',
        level,
      );
      await expect(usage.locator('[data-level]')).toHaveCSS('color', color);
      await usage.focus();
      await expect(tooltip.locator('[data-level]')).toHaveCSS(
        'background-color',
        color,
      );
      await usage.click();
      await expect(tooltip).toHaveCount(0);
      await expect(cards.last().locator('[class*="percentage"]')).toHaveText(
        `${tokens / 1000}.0%`,
      );
      await expect(cards.last().locator('[class*="percentage"]')).toHaveCSS(
        'color',
        color,
      );
      if (tokens > status.usage.contextWindowSize) {
        const usedValue = cards
          .last()
          .locator('[class*="row"]')
          .filter({ has: page.getByText('Used', { exact: true }) })
          .locator('[class*="value"]');
        await expect(usedValue).toHaveText('120.0k (>100%)');
        await expect(usedValue).toHaveCSS('color', errorColor);
        await expect(usedValue).toHaveCSS('text-align', 'right');
      }
    }
  });
}
