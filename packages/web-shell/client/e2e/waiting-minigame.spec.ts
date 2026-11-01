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

async function startWaitingCard(
  page: Page,
  daemon: MockDaemonController,
  prompt: string,
): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.type(prompt);
  await page.locator('[data-web-shell-composer-submit]').click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await daemon.sendEvent(assistantTextEvent('Working on it', { id: 10 }));
  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Working on it',
  );
  const trigger = page.locator('[data-component="waiting-minigame-trigger"]');
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
  const game = page.locator('[data-component="waiting-minigame"]');
  await expect(game).toBeVisible();
}

async function forceRandom(page: Page, value: number): Promise<void> {
  await page.evaluate((forced) => {
    Math.random = () => forced;
  }, value);
}

async function waitForGame(game: ReturnType<Page['locator']>): Promise<void> {
  await expect(
    game.locator('[role="img"][aria-label="Qwen Code"]'),
  ).toHaveCount(0);
}

test('shows the activity heatmap, moves the intro into Tetris and closes when the turn ends @smoke', async ({
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
  await expect(game).toContainText('Q&A activity');
  await expect(game).toContainText('Activity');
  await expect(game.locator('[data-level]')).toHaveCount(44);
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  await game.locator('[data-level]').first().hover();
  await expect(game.locator('[role="tooltip"]')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-heatmap-tooltip.png'),
  });

  const start = game.locator('[data-component="waiting-minigame-start"]');
  await expect(start).toHaveCount(0);
  await expect(start).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-heatmap.png'),
  });

  await forceRandom(page, 0.1);
  await start.click();
  const intro = game.locator('[role="img"][aria-label="Qwen Code"]');
  await expect(intro).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-intro.png'),
  });
  await expect(intro).toHaveAttribute('data-settling', 'true');
  await page.waitForTimeout(200);
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-flight.png'),
  });
  await expect(intro).toHaveAttribute('data-landed', 'true');
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-landed.png'),
  });

  await waitForGame(game);
  await expect(game.locator('[data-state]')).toHaveCount(44 * 7);
  await expect(game).toContainText('Score 0');
  await expect(game).toContainText('clear a column +50');
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

  await page.keyboard.press('Escape');
  await expect(game).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  await daemon.sendEvent(turnCompleteEvent('prompt-e2e', { id: 11 }));
  await expect(trigger).toHaveCount(0);
});

test('keeps the intro blocks still and starts Snake with an apple', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  await startWaitingCard(page, daemon, 'Snake while waiting');
  const game = page.locator('[data-component="waiting-minigame"]');

  const start = game.locator('[data-component="waiting-minigame-start"]');
  await expect(start).toBeVisible({ timeout: 8_000 });
  await forceRandom(page, 0.9);
  await start.click();
  const intro = game.locator('[role="img"][aria-label="Qwen Code"]');
  await expect(intro).toBeVisible();
  await page.waitForTimeout(700);
  await expect(intro).not.toHaveAttribute('data-settling', 'true');
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-snake-intro.png'),
  });

  await waitForGame(game);
  await expect(game).toContainText('Arrows / WASD turn');
  await expect(game.locator('[data-state="3"]')).toContainText('🍎');
  await game.focus();
  await page.keyboard.press('Space');
  await expect(game).toContainText('Paused');
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-snake.png'),
  });
});

test('renders the waiting card in dark theme and Chinese', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('qwen-code-web-shell-theme', 'dark');
    window.localStorage.setItem('qwen-code-web-shell-language', 'zh-CN');
  });
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  await startWaitingCard(page, daemon, 'Wait game');
  const game = page.locator('[data-component="waiting-minigame"]');

  await expect(game).toContainText('问答热度');
  const start = game.locator('[data-component="waiting-minigame-start"]');
  await expect(start).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-dark-zh-heatmap.png'),
  });

  await forceRandom(page, 0.1);
  await start.click();
  await waitForGame(game);
  await expect(game).toContainText('得分 0');
  await page.screenshot({
    path: testInfo.outputPath('waiting-minigame-dark-zh.png'),
  });
  await game.screenshot({
    path: testInfo.outputPath('waiting-minigame-dark-zh-card.png'),
  });
});
