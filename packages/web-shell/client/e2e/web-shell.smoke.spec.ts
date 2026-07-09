import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  permissionRequestEvent,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
  type DaemonRequestRecord,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

test('loads replayed transcript and connects to fake daemon @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Hello from replay', { id: 1 }),
      assistantTextEvent('Hello from fake daemon', { id: 2 }),
      turnCompleteEvent('prompt-replay', { id: 3 }),
    ],
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);

  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Hello from replay',
  );
  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Hello from fake daemon',
  );
});

test('submits a prompt and renders a streamed assistant response @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  await fillComposer(page, 'Ping from browser smoke');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  const promptRequest = firstRequest(daemon.promptRequests());
  expect(promptRequest.method).toBe('POST');
  expect(promptRequest.path).toBe(`/session/${scenario.sessionId}/prompt`);
  expectPromptBodyToContainText(
    requestBodyRecord(promptRequest),
    'Ping from browser smoke',
  );

  await daemon.sse.split(assistantTextEvent('Pong from fake SSE', { id: 10 }));
  await daemon.sendEvent(turnCompleteEvent('prompt-e2e', { id: 11 }));

  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Pong from fake SSE',
  );
});

test('keeps later SSE connections alive when an earlier one is cancelled @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  await page.reload();
  await daemon.sse.waitForConnection(scenario.sessionId);
  await completeReplay(page, daemon, scenario.sessionId);
  await fillComposer(page, 'Second connection should still stream');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await daemon.sse.split(
    assistantTextEvent('Reconnect-safe SSE payload', { id: 20 }),
  );
  await daemon.sendEvent(turnCompleteEvent('prompt-reconnect', { id: 21 }));

  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Reconnect-safe SSE payload',
  );
});

test('clears fake SSE connection records when streams close or error @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  const baseURL = String(testInfo.project.use.baseURL);

  await page.goto('data:text/html,<html></html>');
  await openRawSseConnection(page, baseURL, scenario.sessionId);
  const firstConnection = await daemon.sse.waitForConnection(
    scenario.sessionId,
  );
  expect(firstConnection.sessionId).toBe(scenario.sessionId);

  await daemon.sse.close();
  await expect
    .poll(async () => (await daemon.sse.connections()).length)
    .toBe(0);

  await openRawSseConnection(page, baseURL, scenario.sessionId);
  const secondConnection = await daemon.sse.waitForConnection(
    scenario.sessionId,
  );
  expect(secondConnection.sessionId).toBe(scenario.sessionId);

  await daemon.sse.error('test SSE error');
  await expect
    .poll(async () => (await daemon.sse.connections()).length)
    .toBe(0);
});

test('submits permission decisions through the fake daemon @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    events: [permissionRequestEvent('perm-1', { id: 1 })],
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);

  await expect(page.locator('[data-web-shell-permission-panel]')).toBeVisible();
  await page
    .locator('[data-web-shell-permission-option][data-option-id="allow_once"]')
    .click();

  await expect.poll(() => daemon.permissionRequests().length).toBe(1);
  const permissionRequest = firstRequest(daemon.permissionRequests());
  expect(permissionRequest.method).toBe('POST');
  expect(permissionRequest.path).toBe(
    `/session/${scenario.sessionId}/permission/perm-1`,
  );
  expect(requestBodyRecord(permissionRequest)).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
});

test('opens slash menu, resume dialog, model dialog, and theme dialog @smoke', async ({
  page,
}, testInfo) => {
  const resumedSessionId = 'previous-session';
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  await fillComposer(page, '/');
  await expect(page.locator('[data-web-shell-slash-menu]')).toBeVisible();

  await submitLocalCommand(page, '/resume');
  await expect(page.locator('[data-web-shell-resume-dialog]')).toBeVisible();
  await page
    .locator(
      `[data-web-shell-resume-session][data-session-id="${resumedSessionId}"]`,
    )
    .click();
  await expect(page.locator('[data-web-shell-resume-dialog]')).toHaveCount(0);
  await completeReplay(page, daemon, resumedSessionId);

  await submitLocalCommand(page, '/model');
  await expect(page.locator('[data-web-shell-model-dialog]')).toBeVisible();
  await page
    .locator('[data-web-shell-model-option][data-model-id="qwen-test-alt"]')
    .click();
  await expect(page.locator('[data-web-shell-model-dialog]')).toHaveCount(0);
  await expect.poll(() => daemon.modelRequests().length).toBe(1);
  const modelRequest = firstRequest(daemon.modelRequests());
  expect(modelRequest.method).toBe('POST');
  expect(modelRequest.path).toBe(`/session/${resumedSessionId}/model`);
  expect(requestBodyRecord(modelRequest)).toEqual({
    modelId: 'qwen-test-alt',
  });

  await page.reload();
  await completeReplay(page, daemon);
  await submitLocalCommand(page, '/model');
  await expect(page.locator('[data-web-shell-model-dialog]')).toBeVisible();
  await expect(
    page.locator(
      '[data-web-shell-model-option][data-model-id="qwen-test-alt"]',
    ),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'close' }).click();
  await expect(page.locator('[data-web-shell-model-dialog]')).toHaveCount(0);

  await submitLocalCommand(page, '/theme');
  await expect(page.locator('[data-web-shell-theme-dialog]')).toBeVisible();
  await page
    .locator('[data-web-shell-theme-option][data-theme-id="light"]')
    .click();
  await expect(page.locator('[data-web-shell-theme-dialog]')).toHaveCount(0);
});

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
  await completeReplay(
    page,
    daemon,
    scenario.sessionId,
    scenario.events.length,
  );
}

async function completeReplay(
  page: Page,
  daemon: MockDaemonController,
  sessionId?: string,
  replayedCount = 0,
): Promise<void> {
  const connection = await daemon.sse.waitForConnection(sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

async function fillComposer(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
  );
  await page.keyboard.type(text);
}

async function submitLocalCommand(page: Page, text: string): Promise<void> {
  await fillComposer(page, text);
  await page.locator('[data-web-shell-composer-submit]').click();
}

async function openRawSseConnection(
  page: Page,
  baseURL: string,
  sessionId: string,
): Promise<void> {
  await page.evaluate(
    async ({ baseURL, sessionId }) => {
      const response = await fetch(
        `${baseURL}/session/${encodeURIComponent(sessionId)}/events`,
      );
      const holder = window as Window & {
        __webShellRawSseResponses?: Response[];
      };
      holder.__webShellRawSseResponses ??= [];
      holder.__webShellRawSseResponses.push(response);
    },
    { baseURL, sessionId },
  );
}

function firstRequest(
  requests: readonly DaemonRequestRecord[],
): DaemonRequestRecord {
  const request = requests[0];
  if (!request) throw new Error('Expected a recorded daemon request.');
  return request;
}

function requestBodyRecord(
  request: DaemonRequestRecord,
): Record<string, unknown> {
  expect(typeof request.body).toBe('object');
  expect(request.body).not.toBeNull();
  expect(Array.isArray(request.body)).toBe(false);
  return request.body as Record<string, unknown>;
}

function expectPromptBodyToContainText(
  body: Record<string, unknown>,
  text: string,
): void {
  const prompt = body['prompt'];
  expect(Array.isArray(prompt)).toBe(true);
  const blocks = prompt as readonly unknown[];
  expect(
    blocks.some(
      (block) =>
        isRecord(block) && block['type'] === 'text' && block['text'] === text,
    ),
  ).toBe(true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
