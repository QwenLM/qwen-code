import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

function reasoningConfigOptions(
  thinking: 'on' | 'off' = 'on',
  effort: 'low' | 'medium' | 'xhigh' = 'xhigh',
) {
  return [
    { id: 'thinking', currentValue: thinking },
    { id: 'effort', currentValue: effort },
  ];
}

function createReasoningScenario(
  currentModel = 'qwen3.8-max',
): WebShellDaemonScenario {
  const scenario = createWebShellDaemonScenario({
    currentModel,
    state: { configOptions: reasoningConfigOptions() },
  });
  scenario.capabilities.features.push('session_reasoning_control');
  return scenario;
}

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

test('updates qwen3.8-max Thinking and Effort through the mock daemon', async ({
  page,
}, testInfo) => {
  const scenario = createReasoningScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  const modelButton = page.locator('[data-web-shell-model-button]');
  await expect(modelButton).toContainText('Extra High');
  await modelButton.click();

  if (process.env['PLAYWRIGHT_INTERACTIVE_DEMO'] === '1') {
    testInfo.setTimeout(0);
    await page.pause();
  }

  const thinking = page.getByRole('switch', { name: 'Thinking' });
  const medium = page.getByRole('button', { name: 'Medium' });
  await expect(thinking).toBeChecked();
  await medium.click();
  await expect
    .poll(() => daemon.configOptionRequests().at(-1)?.body)
    .toEqual({ configId: 'effort', value: 'medium' });
  await expect(modelButton).toContainText('Medium');

  await thinking.click();
  await expect
    .poll(() => daemon.configOptionRequests().at(-1)?.body)
    .toEqual({ configId: 'thinking', value: 'off' });
  await expect(modelButton).toContainText('Thinking Off');
  await expect(medium).toBeDisabled();
  await expect(medium).toHaveAttribute('aria-pressed', 'true');

  await thinking.click();
  await expect(modelButton).toContainText('Medium');
});

test('does not expose controls for qwen3.8-max-preview', async ({
  page,
}, testInfo) => {
  const scenario = createReasoningScenario('qwen3.8-max-preview');
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  await page.locator('[data-web-shell-model-button]').click();
  await expect(page.getByRole('switch', { name: 'Thinking' })).toHaveCount(0);
});

test('does not expose controls when the daemon lacks the capability', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    currentModel: 'qwen3.8-max',
    state: { configOptions: reasoningConfigOptions() },
  });
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  await page.locator('[data-web-shell-model-button]').click();
  await expect(page.getByRole('switch', { name: 'Thinking' })).toHaveCount(0);
});
