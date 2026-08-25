import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  assistantTextEvent,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

test('creates a Goal directly from a new task before any chat', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await page.goto('/');
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();

  await submitComposer(page, '/goal start without a prior chat message');
  await expect
    .poll(
      () =>
        daemon.requests.some(
          (request) => request.method === 'POST' && request.path === '/session',
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  await expect.poll(() => goalControlRequests(daemon).length).toBe(1);

  expect(goalControlRequests(daemon)[0]?.body).toEqual({
    action: 'create',
    objective: 'start without a prior chat message',
  });
  expect(daemon.promptRequests()).toHaveLength(0);
  await expect(page.getByTestId('goal-status-strip')).toContainText(
    'start without a prior chat message',
  );
  // Re-check after the strip renders: a regression that forwards the objective
  // as a prompt AFTER the create resolves would land its POST past the
  // synchronous check above and still ship green.
  await expect
    .poll(() => daemon.promptRequests().length, { timeout: 2_000 })
    .toBe(0);
});

test('runs the canonical Goal and active-turn queue interaction chain @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: [
        'session_events',
        'session_mid_turn_message_mutation',
        'session_mid_turn_message_query',
      ],
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  await expect(
    page.getByText('Load goal failed:', { exact: false }),
  ).toHaveCount(0);

  await submitComposer(page, '/goal keep shipping until review passes');
  const strip = page.getByTestId('goal-status-strip');
  await expect(strip).toContainText('keep shipping until review passes');
  await expect.poll(() => goalControlRequests(daemon).length).toBe(1);
  expect(goalControlRequests(daemon).at(-1)?.body).toEqual({
    action: 'create',
    objective: 'keep shipping until review passes',
  });
  expect(daemon.promptRequests()).toHaveLength(0);
  await capture(page, testInfo, '01-goal-active.png');

  await strip.getByRole('button', { name: 'Edit goal' }).click();
  const editDialog = page.getByRole('dialog', { name: 'Edit goal' });
  await editDialog.getByRole('textbox').fill('ship after complete review');
  await editDialog.getByRole('button', { name: 'Save' }).click();
  await expect(strip).toContainText('ship after complete review');
  expect(goalControlRequests(daemon).at(-1)?.body).toMatchObject({
    action: 'edit',
    objective: 'ship after complete review',
    expectedRevision: 1,
  });

  await strip.getByRole('button', { name: 'Pause goal' }).click();
  await expect(strip).toContainText('Paused');
  await strip.getByRole('button', { name: 'Resume goal' }).click();
  await expect(strip).toContainText('In progress');

  await daemon.sendEvent(
    assistantTextEvent('Goal turn running', {
      id: 2,
      sessionId: scenario.sessionId,
    }),
  );
  await submitComposer(page, 'stay queued until I choose');
  const queue = page.locator('[data-web-shell-queued-prompts]');
  await expect(queue).toContainText('stay queued until I choose');
  expect(daemon.promptRequests()).toHaveLength(0);
  await expect.poll(() => midTurnRequests(daemon).length).toBe(1);
  expect(midTurnRequests(daemon)[0]?.body).toMatchObject({
    message: 'stay queued until I choose',
  });
  const [queueWidth, goalWidth] = await Promise.all([
    queue.evaluate((element) => element.getBoundingClientRect().width),
    strip.evaluate((element) => element.getBoundingClientRect().width),
  ]);
  expect(Math.abs(queueWidth - goalWidth)).toBeLessThan(1);
  await expect(queue).toContainText('Queued...');
  await capture(page, testInfo, '02-inserted-during-active-turn.png');
  await daemon.sendEvent(
    turnCompleteEvent('goal-turn-1', {
      id: 3,
      sessionId: scenario.sessionId,
    }),
  );

  await submitComposer(page, 'run while the goal stays active');
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expect(midTurnRequests(daemon)).toHaveLength(1);
  await expect(queue).not.toContainText('run while the goal stays active');

  let confirmationOpened = false;
  page.on('dialog', async (dialog) => {
    confirmationOpened = true;
    await dialog.dismiss();
  });
  await strip.getByRole('button', { name: 'Clear goal' }).click();
  await expect(strip).toHaveCount(0);
  expect(confirmationOpened).toBe(false);
  expect(goalControlRequests(daemon).at(-1)?.body).toMatchObject({
    action: 'clear',
  });
  await capture(page, testInfo, '03-goal-cleared.png');
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
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

async function submitComposer(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
  );
  await page.keyboard.insertText(text);
  await page.locator('[data-web-shell-composer-submit]').click();
}

function goalControlRequests(daemon: MockDaemonController) {
  return daemon.requests.filter(
    (request) =>
      request.method === 'POST' &&
      /\/session\/[^/]+\/goal\/?$/.test(request.path),
  );
}

function midTurnRequests(daemon: MockDaemonController) {
  return daemon.requests.filter((request) =>
    /\/session\/[^/]+\/mid-turn-message\/?$/.test(request.path),
  );
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}
