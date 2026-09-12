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
    await page
      .getByRole('button', { name: 'Context Usage', exact: true })
      .click();
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
    const editor = page.locator(
      '[data-web-shell-composer-surface] .cm-content[contenteditable="true"]',
    );
    await editor.fill('Keep this draft while compressing');
    await compress.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({
      prompt: [{ type: 'text', text: '/compress' }],
    });
    await expect(
      panel.getByRole('button', { name: 'Compressing…', exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole('button', { name: 'Refresh', exact: true }),
    ).toBeDisabled();
    await expect(editor).toHaveText('Keep this draft while compressing');
    await expect(panel.getByRole('status')).toHaveCSS('color', feedbackColor);
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
    await expect.poll(() => reads).toBeGreaterThan(readsBeforeCompletion);
    await expect(ring).toHaveAttribute('aria-label', '20.0% context used');
    await expect(panel).toContainText('Remaining 80.0k');
    await expect(historical.locator('[class*="percentage"]')).toHaveText(
      '64.0%',
    );
    await expect(editor).toHaveText('Keep this draft while compressing');
    await expect(compress).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath(`context-compressed-${theme}.png`),
    });

    await compress.click();
    await expect.poll(() => submitted.length).toBe(2);
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
