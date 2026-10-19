import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

test('refreshes the model picker without selecting or replaying a session @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  scenario.capabilities.features.push('workspace_model_reload');
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.route('**/workspace/models', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    }),
  );
  let reloads = 0;
  let fail = true;
  await page.route('**/workspaces/*/models/reload', async (route) => {
    reloads += 1;
    if (fail) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Catalog offline' }),
      });
      return;
    }
    scenario.state.models = {
      currentModelId: scenario.currentModel,
      availableModels: [
        { modelId: scenario.currentModel, name: 'Qwen Test' },
        { modelId: 'new-platform-model', name: 'New Platform Model' },
      ],
    };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'applied' }),
    });
  });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  const selector = page.locator('[data-web-shell-model-button]');
  await selector.click();
  await expect(
    page.getByRole('button', { name: 'Refresh models', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('model-refresh-before.png'),
  });
  await page
    .getByRole('button', { name: 'Refresh models', exact: true })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Unable to refresh models' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Qwen Test Alt', exact: true }),
  ).toBeVisible();
  expect(scenario.currentModel).toBe('qwen-test');
  fail = false;
  await page
    .getByRole('button', { name: 'Refresh models', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'New Platform Model', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Unable to refresh models' }),
  ).toHaveCount(0);
  await expect(selector).toContainText('Qwen Test');
  expect(scenario.currentModel).toBe('qwen-test');
  expect(reloads).toBe(2);
  await page.screenshot({
    path: testInfo.outputPath('model-refresh-after.png'),
  });
  await page
    .getByRole('button', { name: 'New Platform Model', exact: true })
    .click();
  await expect.poll(() => scenario.currentModel).toBe('new-platform-model');
});

test('does not offer model refresh for an older daemon', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.route('**/workspace/models', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    }),
  );
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  await page.locator('[data-web-shell-model-button]').click();
  await expect(
    page.getByRole('button', { name: 'Refresh models', exact: true }),
  ).toHaveCount(0);
});
