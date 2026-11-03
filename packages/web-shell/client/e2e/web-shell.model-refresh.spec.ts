import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';
import { submitLocalCommand } from './visuals/harness';

test('shows Qwen models after authentication in an existing conversation @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const tokenPlanModel = {
    modelId: scenario.currentModel,
    name: '[ModelStudio Token Plan] qwen3.8-max',
  };
  const subscriptionModelId = 'qwen3.8-max(qwen-subscription)';
  scenario.state.models = {
    currentModelId: scenario.currentModel,
    availableModels: [tokenPlanModel],
  };
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.route('**/workspace/models', (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.route('**/workspace/auth/providers', (route) =>
    route.fulfill({
      json: {
        v: 1,
        workspaceCwd: scenario.workspaceCwd,
        providers: [],
        groups: [],
      },
    }),
  );
  await page.route('**/auth/subscription', (route) =>
    route.fulfill({
      json: { enabled: true, plansUrl: 'https://plans.example' },
    }),
  );
  await page.route('**/auth/subscription/flows', (route) =>
    route.fulfill({
      json: {
        id: 'signed-in',
        status: 'ready',
        userInfo: {
          sub: 'test-user',
          email: 'user@example.test',
          member_type: 'pro',
        },
      },
    }),
  );
  await page.route('**/workspaces/*/auth/subscription', async (route) => {
    scenario.state.models = {
      currentModelId: scenario.currentModel,
      availableModels: [
        tokenPlanModel,
        { modelId: subscriptionModelId, name: 'Qwen Max' },
        { modelId: 'qwen3.8-flash(qwen-subscription)', name: 'Qwen Flash' },
      ],
    };
    await route.fulfill({
      json: {
        authType: 'qwen-subscription',
        modelId: 'qwen3.8-max',
        runtimeSync: { status: 'applied' },
      },
    });
  });
  await page.goto(`/e2e/settings-harness.html?sessionId=${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  await page.locator('[data-web-shell-model-button]').click();
  await expect(
    page.getByRole('button', { name: tokenPlanModel.name, exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await submitLocalCommand(page, '/auth');
  await page
    .getByRole('button', {
      name: 'Qwen Account with Subscription',
      exact: true,
    })
    .click();
  await expect(
    page.getByText('Qwen Pro is active', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('[data-web-shell-model-button]').click();
  await expect(
    page.getByRole('button', { name: 'Qwen Max', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Qwen Flash', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: tokenPlanModel.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-web-shell-model-button]')).toContainText(
    'Qwen Max',
  );
  expect(scenario.currentModel).toBe(subscriptionModelId);
  await page.screenshot({ path: testInfo.outputPath('qwen-auth-models.png') });
});

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
