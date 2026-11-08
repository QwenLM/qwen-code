import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

// Simulated daemon: this covers browser state, not real filesystem or Git operations.
test('first prompt still runs when switching sessions during creation', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  // Hold the create response so the session switch lands while the first
  // prompt's session creation is still in flight.
  let releaseCreate!: () => void;
  const createHeld = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let createObserved!: () => void;
  const createSeen = new Promise<void>((resolve) => {
    createObserved = resolve;
  });
  await page.route('**/session', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    createObserved();
    await createHeld;
    await route.fallback();
  });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?language=en');
  await page.locator('[data-web-shell-composer-editor] .cm-content').click();
  const promptText = 'Run me even if I switch away';
  await page.keyboard.type(promptText);
  await page.locator('[data-web-shell-composer-submit]').click();
  await createSeen;

  // Leave the draft while creation is in flight. Wait for the switch to
  // settle on the connection (SSE attaches after load publishes), not just
  // the optimistic URL change.
  const sidebar = page.locator('[data-sidebar-shell]');
  await sidebar.getByText('Previous Session', { exact: true }).click();
  await daemon.sse.waitForConnection('previous-session');
  await expect(page).toHaveURL(/\/session\/previous-session/);
  releaseCreate();

  // The submitted prompt must still reach the newly created session.
  await expect
    .poll(() => daemon.promptRequests().length, { timeout: 10_000 })
    .toBe(1);
  const promptRequest = daemon.promptRequests()[0];
  expect(promptRequest.path).toBe(`/session/${scenario.sessionId}/prompt`);
  expect(JSON.stringify(promptRequest.body)).toContain(promptText);
  // The user's navigation is honored: they stay on the session they clicked.
  await expect(page).toHaveURL(/\/session\/previous-session/);
  await testInfo.attach('daemon-requests', {
    body: JSON.stringify(
      daemon.requests.map(({ method, path }) => ({ method, path })),
      null,
      2,
    ),
    contentType: 'application/json',
  });
});
