import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';
import { completeReplay, submitLocalCommand } from './visuals/harness';

test('session model details match resolved CLI modalities @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  scenario.state.models = {
    currentModelId: 'qwen3.8-max(qwen-subscription)',
    availableModels: [
      {
        modelId: 'qwen3.8-max(qwen-subscription)',
        name: 'Qwen Max',
        _meta: {
          authType: 'qwen-subscription',
          baseModelId: 'qwen3.8-max',
          contextLimit: 1_000_000,
          modalities: { image: true, video: true },
        },
      },
      {
        modelId: 'text-model(openai)',
        name: 'Text Model',
        _meta: {
          authType: 'openai',
          modalities: {},
          baseUrl: 'https://models.example/v1',
          envKey: 'MODEL_API_KEY',
        },
      },
    ],
  };
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/e2e/settings-harness.html?sessionId=${scenario.sessionId}`);
  await completeReplay(page, daemon, scenario.sessionId);
  await submitLocalCommand(page, '/model');
  const dialog = page.getByRole('dialog', {
    name: 'Select Model',
    exact: false,
  });
  await expect(dialog).toContainText('text · image · video');
  await expect(dialog).toContainText('1,000,000');
  await page.keyboard.press('ArrowDown');
  await expect(dialog).toContainText('text-only');
  await expect(dialog).toContainText('https://models.example/v1');
  await expect(dialog).toContainText('MODEL_API_KEY');
  await page.keyboard.press('ArrowUp');
  await expect(dialog).toContainText('text · image · video');
  await page.screenshot({
    path: testInfo.outputPath('session-model-details.png'),
  });
});

test('provider wizard supports arrows and Enter with the subscription entry @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.route('**/auth/subscription', (route) =>
    route.fulfill({ json: { enabled: true } }),
  );
  await page.route('**/workspace/auth/providers', (route) =>
    route.fulfill({
      json: {
        v: 1,
        workspaceCwd: scenario.workspaceCwd,
        groups: [
          {
            id: 'third-party',
            label: 'Third-party providers',
            description: '',
            providerIds: ['custom'],
          },
        ],
        providers: [
          {
            id: 'custom',
            label: 'Test Provider',
            protocol: 'openai',
            protocolOptions: ['openai', 'anthropic'],
            steps: ['protocol', 'wireApi', 'baseUrl', 'apiKey'],
            baseUrl: [
              { label: 'Endpoint A', url: 'https://a.example/v1' },
              { label: 'Endpoint B', url: 'https://b.example/v1' },
            ],
          },
        ],
      },
    }),
  );
  await page.goto(
    `/e2e/settings-harness.html?sessionId=${scenario.sessionId}&theme=light`,
  );
  await completeReplay(page, daemon, scenario.sessionId);
  await submitLocalCommand(page, '/auth');
  const dialog = page.getByRole('dialog', { name: 'Connect a Provider' });
  await expect(
    dialog.getByRole('button', { name: 'Qwen Account with Subscription' }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    dialog.getByRole('button', { name: 'Third-party providers' }),
  ).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(
    dialog.getByRole('button', { name: 'Qwen Account with Subscription' }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(
    dialog.getByRole('button', { name: 'Test Provider' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('button', { name: /Anthropic/ })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('button', { name: 'Responses' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(
    dialog.getByRole('button', { name: /Endpoint B/ }),
  ).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath('auth-keyboard-selection.png'),
  });
  await page.keyboard.press('Enter');
  await expect(dialog.locator('input[type="password"]')).toBeFocused();
  await expect(dialog.locator('input[type="password"]')).toBeEmpty();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
});
