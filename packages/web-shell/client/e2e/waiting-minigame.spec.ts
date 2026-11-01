import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

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
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

test('shows the waiting minigame during a running prompt and closes it when the turn ends @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.type('Ping while waiting');
  await page.locator('[data-web-shell-composer-submit]').click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);

  await daemon.sendEvent(assistantTextEvent('Working on it', { id: 10 }));
  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Working on it',
  );

  const trigger = page.locator('[data-component="waiting-minigame-trigger"]');
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-trigger.png'),
  });

  await trigger.click();
  const game = page.locator('[data-component="waiting-minigame"]');
  await expect(game).toBeVisible();
  await expect(game).toContainText('Juust Relax');
  await expect(game).toContainText('Activity');
  await expect(game.locator('[data-level]')).toHaveCount(44);
  await expect(
    game.locator('[data-component="waiting-minigame-start"]'),
  ).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-heatmap.png'),
  });

  await game.locator('[data-component="waiting-minigame-start"]').click();
  await expect(game).toContainText('Choose a game');
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-picker.png'),
  });
  await game.getByRole('button', { name: 'Tetris', exact: true }).click();
  await expect(game.locator('[data-state]')).toHaveCount(44 * 7);
  await expect(game).toContainText('Score 0');
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-board.png'),
  });

  await game.focus();
  await page.keyboard.press('Space');
  await expect(game).toContainText('Paused');
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-paused.png'),
  });
  await page.keyboard.press('Space');
  await expect(game).not.toContainText('Paused');

  await game.getByRole('button', { name: 'Switch game' }).click();
  await game.getByRole('button', { name: 'Snake', exact: true }).click();
  await expect(game).toContainText('Arrows / WASD turn');
  await game.focus();
  await page.keyboard.press('Space');
  await expect(game).toContainText('Paused');
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-snake.png'),
  });
  await page.keyboard.press('Space');

  await page.keyboard.press('Escape');
  await expect(game).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  await daemon.sendEvent(turnCompleteEvent('prompt-e2e', { id: 11 }));
  await expect(trigger).toHaveCount(0);
});

test('renders the waiting minigame in dark theme and Chinese', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('qwen-code-web-shell-theme', 'dark');
    window.localStorage.setItem('qwen-code-web-shell-language', 'zh-CN');
  });
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.type('Wait game');
  await page.locator('[data-web-shell-composer-submit]').click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await daemon.sendEvent(assistantTextEvent('正在处理', { id: 10 }));
  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    '正在处理',
  );

  const trigger = page.locator('[data-component="waiting-minigame-trigger"]');
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
  const game = page.locator('[data-component="waiting-minigame"]');
  await expect(game).toBeVisible();
  await expect(game).toContainText('热力图');
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-dark-zh-heatmap.png'),
  });
  await game.locator('[data-component="waiting-minigame-start"]').click();
  await expect(game).toContainText('选择一个游戏');
  await game.getByRole('button', { name: '俄罗斯方块', exact: true }).click();
  await expect(game).toContainText('得分 0');
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-dark-zh.png'),
  });
  await game.screenshot({
    path: testInfo.outputPath('waiting-minigame-dark-zh-card.png'),
  });
});
