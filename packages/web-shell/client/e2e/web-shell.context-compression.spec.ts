import { expect, test } from '@playwright/test';
import type { DaemonSessionContextUsageStatus } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
} from './utils/mockDaemon';

for (const theme of ['light', 'dark']) {
  test(`@smoke manual context compression refreshes live usage and preserves snapshots in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const scenario = createWebShellDaemonScenario({
      supportedCommands: {
        availableCommands: [
          {
            name: 'compress',
            description: 'Compress context',
            input: null,
            _meta: { source: 'builtin-command' },
          },
        ],
      },
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
    let used = 64_000;
    let readFails = false;
    let reads = 0;
    const submitted: unknown[] = [];
    const reading = (detail: boolean): DaemonSessionContextUsageStatus => ({
      v: 1,
      sessionId: scenario.sessionId,
      workspaceCwd: scenario.workspaceCwd,
      formattedText: '',
      usage: {
        modelName: 'Qwen Test',
        totalTokens: used,
        contextWindowSize: 100_000,
        breakdown: {
          systemPrompt: 5_000,
          builtinTools: 5_000,
          mcpTools: 0,
          memoryFiles: 0,
          skills: 0,
          messages: used - 10_000,
          freeSpace: 90_000 - used,
          autocompactBuffer: 10_000,
        },
        builtinTools: [{ name: 'read_file', tokens: 5_000 }],
        mcpTools: [],
        memoryFiles: [],
        skills: [],
        showDetails: detail,
      },
    });
    await page.route(/\/session\/[^/]+\/context-usage(?:\?|$)/, (route) => {
      reads++;
      return readFails
        ? route.fulfill({
            status: 503,
            json: { error: 'Temporary usage read failure' },
          })
        : route.fulfill({
            json: reading(
              new URL(route.request().url()).searchParams.get('detail') ===
                'true',
            ),
          });
    });
    await page.route(/\/session\/[^/]+\/prompt$/, (route) => {
      submitted.push(route.request().postDataJSON());
      return route.fulfill({
        status: 202,
        json: { promptId: `compression-${submitted.length}`, lastEventId: 20 },
      });
    });
    await page.goto(`/session/${scenario.sessionId}?theme=${theme}`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId: scenario.sessionId }),
    );
    await daemon.sendEvent({
      id: 20,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
          _meta: { usage: { inputTokens: used } },
        },
      },
    });
    const ring = page.locator('[data-web-shell-context-usage]');
    await expect(ring).toHaveAttribute('aria-label', '64.0% context used');
    await ring.click();
    const historical = page
      .getByRole('group', { name: 'Context Usage', exact: true })
      .first();
    await expect(historical).toContainText('Snapshot');
    const editor = page.locator(
      '[data-web-shell-composer-surface] .cm-content[contenteditable="true"]',
    );
    await editor.click();
    await editor.fill('Keep this draft while compressing');
    const readsBeforeHover = reads;
    await ring.hover();
    const hover = page.locator('[data-web-shell-context-popover]');
    await expect(hover).toBeVisible();
    await expect(hover).toContainText('36,000 tokens');
    await expect(editor).toBeFocused();
    expect(reads).toBe(readsBeforeHover);
    expect(submitted).toHaveLength(0);
    await hover.hover();
    await page.mouse.move(5, 5);
    await expect(hover).not.toBeVisible();
    await expect(editor).toBeFocused();
    await ring.hover();
    await expect(hover).toBeVisible();
    await ring.focus();
    await ring.press('Escape');
    await ring.press('ArrowDown');
    const firstAction = hover.getByRole('button', {
      name: 'Compress context',
      exact: true,
    });
    const secondAction = hover.getByRole('button', {
      name: 'View details',
      exact: true,
    });
    await expect(firstAction).toBeFocused();
    await firstAction.press('Tab');
    await expect(secondAction).toBeFocused();
    await secondAction.press('Tab');
    await expect(firstAction).toBeFocused();
    await firstAction.press('Shift+Tab');
    await expect(secondAction).toBeFocused();
    await secondAction.press('Shift+Tab');
    await expect(firstAction).toBeFocused();
    expect(
      daemon.requests.filter((request) =>
        request.path.endsWith('/approval-mode'),
      ),
    ).toHaveLength(0);
    await firstAction.press('Escape');
    await editor.click();
    await expect(hover).not.toBeVisible();
    await expect(editor).toBeFocused();
    await ring.hover();
    await ring.focus();
    await ring.press('ArrowDown');
    await firstAction.press('Tab');
    await secondAction.press('Enter');
    await expect(hover).not.toBeVisible();
    await expect(ring).toBeFocused();
    await expect(
      page
        .getByRole('group', { name: 'Context Usage', exact: true })
        .filter({ hasText: 'Snapshot' }),
    ).toHaveCount(1);
    const panel = page.locator('[class*="panel"][aria-busy]');
    const feedbackColor =
      theme === 'dark' ? 'rgb(160, 160, 160)' : 'rgb(95, 98, 89)';
    const errorColor =
      theme === 'dark' ? 'rgb(252, 129, 129)' : 'rgb(192, 54, 44)';
    const compress = panel.getByRole('button', {
      name: 'Compress context',
      exact: true,
    });
    await expect(compress).toBeEnabled();
    await ring.focus();
    await ring.press('ArrowDown');
    const hoverCompress = hover.getByRole('button', {
      name: 'Compress context',
      exact: true,
    });
    await expect(hoverCompress).toBeFocused();
    await hoverCompress.press('Escape');
    await expect(hover).not.toBeVisible();
    await expect(ring).toBeFocused();
    await ring.press('ArrowDown');
    await expect(hoverCompress).toBeFocused();
    await page.evaluate(() => {
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          document.body.dataset.contextHostEnter = 'true';
        }
      });
    });
    await hoverCompress.press('Enter');
    await expect(hover).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(secondAction).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(secondAction).toBeFocused();
    await hover.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).not.toHaveAttribute(
      'data-context-host-enter',
      'true',
    );
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({
      prompt: [{ type: 'text', text: '/compress' }],
    });
    await expect(
      panel.getByRole('button', { name: 'Compressing…', exact: true }),
    ).toBeDisabled();
    await expect(
      hover.getByRole('button', { name: 'Compressing…', exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole('button', { name: 'Refresh', exact: true }),
    ).toBeDisabled();
    await expect(editor).toHaveText('Keep this draft while compressing');
    await expect(panel.getByRole('status')).toHaveCSS('color', feedbackColor);
    await expect(hover.getByRole('status')).toHaveCSS('color', feedbackColor);
    await page.screenshot({
      path: testInfo.outputPath(`context-compressing-${theme}.png`),
    });
    used = 20_000;
    const readsBeforeCompletion = reads;
    // Deliberately no usage event: /compress emits text, so the completion
    // read must be responsible for reconciling the composer ring.
    await daemon.sendEvent(
      turnCompleteEvent('compression-1', {
        id: 30,
        sessionId: scenario.sessionId,
      }),
    );
    await expect(panel).toContainText(
      'Compression completed. Context usage refreshed.',
    );
    await expect(panel.getByRole('status')).toHaveCSS('color', feedbackColor);
    await expect(hover.getByRole('status')).toHaveCSS('color', feedbackColor);
    await expect.poll(() => reads).toBeGreaterThan(readsBeforeCompletion);
    await expect(ring).toHaveAttribute('aria-label', '20.0% context used');
    await expect(hover).toContainText('20,000 tokens');
    await expect(hover).toContainText(
      'Compression completed. Context usage refreshed.',
    );
    await expect(panel).toContainText('Remaining 80.0k');
    await expect(historical.locator('[class*="percentage"]')).toHaveText(
      '64.0%',
    );
    await expect(editor).toHaveText('Keep this draft while compressing');
    await expect(compress).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath(`context-compressed-${theme}.png`),
    });

    await hover
      .getByRole('button', { name: 'View details', exact: true })
      .click();
    await compress.click();
    await expect.poll(() => submitted.length).toBe(2);
    await ring.hover();
    await expect(hover).toHaveAttribute('data-state', 'open');
    await expect(
      hover.getByRole('button', { name: 'Compressing…', exact: true }),
    ).toBeDisabled();
    await daemon.sendEvent({
      id: 40,
      v: 1,
      type: 'turn_error',
      data: {
        sessionId: scenario.sessionId,
        promptId: 'compression-2',
        message: 'Provider compression failed',
        code: 'internal_error',
      },
    });
    await expect(panel.getByRole('alert')).toHaveText(
      'Compression failed. You can try again.',
    );
    await expect(panel.getByRole('alert')).toHaveCSS('color', errorColor);
    await expect(hover.getByRole('alert')).toHaveText(
      'Compression failed. You can try again.',
    );
    await expect(hover.getByRole('alert')).toHaveCSS('color', errorColor);
    await hover
      .getByRole('button', { name: 'View details', exact: true })
      .click();
    await expect(compress).toBeEnabled();
    await expect(ring).toHaveAttribute('aria-label', '20.0% context used');

    await compress.click();
    await expect.poll(() => submitted.length).toBe(3);
    used = 15_000;
    readFails = true;
    await daemon.sendEvent(
      turnCompleteEvent('compression-3', {
        id: 50,
        sessionId: scenario.sessionId,
      }),
    );
    await expect(panel.getByRole('alert')).toContainText(
      'Compression completed, but usage could not be refreshed.',
    );
    await expect(panel.getByRole('alert')).toHaveCSS('color', errorColor);
    await expect(ring).toHaveAttribute('aria-label', '20.0% context used');
    readFails = false;
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(ring).toHaveAttribute('aria-label', '15.0% context used');
    await expect(panel).toContainText('Remaining 85.0k');
    expect(submitted).toHaveLength(3);
    await expect(historical.locator('[class*="percentage"]')).toHaveText(
      '64.0%',
    );
  });
}

for (const key of ['Enter', 'Space']) {
  test(`@smoke context card keeps a settled btw answer when activated with ${key}`, async ({
    page,
  }, testInfo) => {
    const answer = 'Keep this side answer while managing context.';
    const scenario = createWebShellDaemonScenario({
      btwAnswer: answer,
      supportedCommands: {
        availableCommands: [
          {
            name: 'compress',
            description: 'Compress context',
            input: null,
            _meta: { source: 'builtin-command' },
          },
        ],
      },
    });
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    const submitted: unknown[] = [];
    await page.route(/\/session\/[^/]+\/prompt$/, (route) => {
      submitted.push(route.request().postDataJSON());
      return route.fulfill({
        status: 202,
        json: { promptId: 'btw-compression', lastEventId: 20 },
      });
    });
    await page.goto(`/session/${scenario.sessionId}`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId: scenario.sessionId }),
    );
    await daemon.sendEvent({
      id: 20,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
          _meta: { usage: { inputTokens: 10_000 } },
        },
      },
    });
    const editor = page.locator(
      '[data-web-shell-composer-surface] .cm-content[contenteditable="true"]',
    );
    await editor.fill('/btw keep this answer');
    await editor.press('Enter');
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await expect(editor.locator('.cm-placeholder')).toBeVisible();
    const ring = page.locator('[data-web-shell-context-usage]');
    const card = page.locator('[data-web-shell-context-popover]');
    const compress = card.getByRole('button', {
      name: 'Compress context',
      exact: true,
    });
    await ring.focus();
    await ring.press('ArrowDown');
    await expect(compress).toBeFocused();
    await compress.press('Escape');
    await expect(card).not.toBeVisible();
    await expect(ring).toBeFocused();
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await ring.press('ArrowDown');
    await expect(compress).toBeFocused();
    await compress.press(key);
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({
      prompt: [{ type: 'text', text: '/compress' }],
    });
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await expect(card).toBeFocused();
    await page.keyboard.press(key);
    expect(submitted).toHaveLength(1);
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).not.toBeVisible();
    await expect(ring).toBeFocused();
  });
}
