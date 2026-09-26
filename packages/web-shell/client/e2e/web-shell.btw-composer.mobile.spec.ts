import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

test('mobile Add drawer prepares a side question and restores textarea focus @smoke', async ({
  page,
}, testInfo) => {
  const answer = 'A mobile side answer.';
  const scenario = createWebShellDaemonScenario({ btwAnswer: answer });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  const editor = page.locator('textarea[data-web-shell-composer-editor]');
  await expect(editor).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await editor.fill('What does this mean?');
  await page.getByTestId('composer-add-menu-trigger').tap();
  const action = page.getByTestId('composer-add-menu-btw');
  await expect(action).toContainText('Ask a side question');
  await expect(action).toContainText('/btw');
  await action.scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('btw-mobile-menu.png'),
  });
  await action.tap();
  await expect(page.locator('[data-web-shell-mobile-add-menu]')).toBeHidden();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('/btw What does this mean?');
  expect(daemon.promptRequests()).toHaveLength(0);
  expect(daemon.requests.filter((r) => r.path.endsWith('/btw'))).toHaveLength(
    0,
  );
  await page.locator('[data-web-shell-composer-submit]').tap();
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  expect(
    daemon.requests.filter(
      (r) => r.method === 'POST' && r.path.endsWith('/btw'),
    ),
  ).toHaveLength(1);
  expect(daemon.promptRequests()).toHaveLength(0);
  expect(
    daemon.requests.filter((r) => r.path.endsWith('/cancel')),
  ).toHaveLength(0);
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('btw-mobile-answer.png'),
  });

  await page.getByTestId('composer-add-menu-trigger').tap();
  await page.getByRole('button', { name: 'Shell mode', exact: true }).tap();
  await page.getByTestId('composer-add-menu-trigger').tap();
  await expect(page.locator('[data-web-shell-mobile-add-menu]')).toBeVisible();
  await expect(page.getByTestId('composer-add-menu-btw')).toHaveCount(0);
});
