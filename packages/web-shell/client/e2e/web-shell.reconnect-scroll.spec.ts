import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

test('keeps the Mod-enabled transcript mounted during same-session epoch recovery', async ({
  page,
  baseURL,
}) => {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Write a long response', { id: 1 }),
      assistantTextEvent(
        Array.from(
          { length: 100 },
          (_, index) => `Paragraph ${index + 1}: historical reading material.`,
        ).join('\n\n'),
        { id: 2 },
      ),
      turnCompleteEvent('initial-prompt', { id: 3 }),
    ],
  });
  scenario.capabilities.features.push('session_mod_rows');
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const modRowPath = `/session/${scenario.sessionId}/mod-row`;
  await page.route(`**${modRowPath}`, (route) =>
    route.fulfill({ json: { status: 'unhooked' } }),
  );
  let holdLoad = false;
  let reloadStarted = false;
  let resumeLoad = () => {};
  const loadGate = new Promise<void>((resolve) => {
    resumeLoad = resolve;
  });
  const loadPath = `/session/${scenario.sessionId}/load`;
  await page.route(`**${loadPath}`, async (route) => {
    if (holdLoad) {
      reloadStarted = true;
      await loadGate;
    }
    await route.fallback();
  });

  const initialModRow = page.waitForResponse((response) =>
    response.url().endsWith(modRowPath),
  );
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  await initialModRow;
  const list = page.locator('[data-web-shell-message-list]');
  await list.hover();
  await page.mouse.wheel(0, -2000);
  const bottomDistance = () =>
    list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(bottomDistance).toBeGreaterThan(1500);
  await list.evaluate((el) => el.setAttribute('data-epoch-probe', 'mounted'));

  holdLoad = true;
  try {
    await daemon.sendEvent({
      v: 1,
      type: 'state_resync_required',
      data: { reason: 'epoch_reset' },
    });
    await expect.poll(() => reloadStarted).toBe(true);
    await expect(list).toHaveAttribute('data-epoch-probe', 'mounted');
    await expect.poll(bottomDistance).toBeGreaterThan(1500);
  } finally {
    resumeLoad();
  }
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  await expect(list).toHaveAttribute('data-epoch-probe', 'mounted');
});

for (const reading of ['before reconnect', 'during replay', 'at bottom']) {
  test(`preserves scroll follow ${reading} after SSE recovery @smoke`, async ({
    page,
    baseURL,
  }) => {
    const scenario = createWebShellDaemonScenario({
      events: [
        userTextEvent('Write a long response', { id: 1 }),
        assistantTextEvent(
          Array.from(
            { length: 100 },
            (_, index) =>
              `Paragraph ${index + 1}: historical reading material.`,
          ).join('\n\n'),
          { id: 2 },
        ),
        turnCompleteEvent('initial-prompt', { id: 3 }),
      ],
    });
    const daemon = await installMockDaemon(page, scenario, { baseURL });
    await page.goto(`/session/${scenario.sessionId}`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    const finishReplay = () =>
      daemon.sendEvent(
        replayCompleteEvent({
          sessionId: scenario.sessionId,
          replayedCount: 0,
        }),
      );
    await finishReplay();
    const list = page.locator('[data-web-shell-message-list]');
    const bottomDistance = () =>
      list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(bottomDistance).toBeLessThan(5);
    const scrollUp = async () => {
      await list.hover();
      await page.mouse.wheel(0, -2000);
      await expect.poll(bottomDistance).toBeGreaterThan(1500);
    };
    if (reading === 'before reconnect') await scrollUp();

    await daemon.sse.error('Simulated transport failure');
    await daemon.sse.waitForConnection(scenario.sessionId);
    if (reading === 'during replay') await scrollUp();
    await finishReplay();
    await daemon.sendEvent(
      assistantTextEvent('\n\nOutput after reconnect.', { id: 4 }),
    );
    await expect(list).toContainText('Output after reconnect.');

    if (reading === 'at bottom') {
      await expect.poll(bottomDistance).toBeLessThan(5);
    } else {
      await expect.poll(bottomDistance).toBeGreaterThan(1500);
      await page
        .getByRole('button', { name: 'Scroll to bottom', exact: true })
        .click();
      await expect.poll(bottomDistance).toBeLessThan(5);
      await daemon.sendEvent(
        assistantTextEvent('\n\nOutput after returning to latest.', { id: 5 }),
      );
      await expect(list).toContainText('Output after returning to latest.');
      await expect.poll(bottomDistance).toBeLessThan(5);
    }
  });
}
