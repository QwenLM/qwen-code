import { expect, test } from '@playwright/test';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

for (const message of [
  '403 用户 Token 限额已触发（每5小时）',
  '429 Rate limit exceeded. Try again later.',
  '403 Invalid API key',
]) {
  test(`explicitly waits and resumes only quota interruptions: ${message}`, async ({
    page,
  }, testInfo) => {
    const scenario = createWebShellDaemonScenario();
    const errorEvent = (id: number, promptId: string): DaemonEvent => ({
      v: 1,
      id,
      type: 'turn_error',
      sessionId: scenario.sessionId,
      promptId,
      data: { sessionId: scenario.sessionId, promptId, message },
    });
    scenario.events = [
      userTextEvent('Finish the original task', {
        id: 1,
        sessionId: scenario.sessionId,
      }),
      errorEvent(2, 'original'),
    ];
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    let canContinue = true;
    let continuations = 0;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/session/*/context', (route) =>
      route.fulfill({
        json: {
          v: 1,
          sessionId: scenario.sessionId,
          workspaceCwd: scenario.workspaceCwd,
          state: scenario.state,
          recovery: {
            kind: canContinue ? 'interrupted_prompt' : 'clean',
            canContinue,
          },
        },
      }),
    );
    await page.route('**/session/*/continue', async (route) => {
      continuations++;
      const promptId = `continuation-${continuations}`;
      await route.fulfill({
        status: 202,
        json: {
          accepted: true,
          interruption: 'interrupted_prompt',
          promptId,
          lastEventId: continuations === 1 ? 2 : 3,
        },
      });
    });
    await page.clock.install();
    await page.goto(`/session/${scenario.sessionId}`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId: scenario.sessionId, lastEventId: 2 }),
    );
    const banner = page.getByTestId('session-recovery-banner');
    await expect(
      banner.getByRole('button', { name: 'Continue execution', exact: true }),
    ).toBeVisible();
    await page.clock.pauseAt(await page.evaluate(() => Date.now()));
    const resume = banner.getByRole('button', {
      name: 'Resume when available',
    });
    if (message.includes('Invalid API key')) {
      await expect(resume).toHaveCount(0);
      await page.clock.fastForward(60_000);
      expect(continuations).toBe(0);
      return;
    }
    await expect(resume).toBeVisible();
    expect(continuations).toBe(0);
    await resume.click();
    await expect(banner).toContainText('Waiting for model availability');
    await banner.getByRole('button', { name: 'Cancel waiting' }).click();
    await page.clock.fastForward(60_000);
    expect(continuations).toBe(0);
    await resume.click();
    await page.clock.fastForward(59_999);
    expect(continuations).toBe(0);
    await page.clock.fastForward(1);
    await expect.poll(() => continuations).toBe(1);
    await page.clock.runFor(100);
    await daemon.sendEvent(errorEvent(3, 'continuation-1'));
    await page.clock.runFor(100);
    await expect(
      banner.getByRole('button', { name: 'Cancel waiting' }),
    ).toBeVisible();
    await page.clock.fastForward(120_000);
    await expect.poll(() => continuations).toBe(2);
    await page.clock.runFor(100);
    canContinue = false;
    await daemon.sendEvent(
      assistantTextEvent('Original task completed', {
        id: 4,
        sessionId: scenario.sessionId,
      }),
    );
    await daemon.sendEvent(
      turnCompleteEvent('continuation-2', {
        id: 5,
        sessionId: scenario.sessionId,
      }),
    );
    await page.clock.runFor(100);
    await expect(
      page.getByText('Original task completed', { exact: true }),
    ).toBeVisible();
    await expect(banner).toHaveCount(0);
    await page.clock.fastForward(30 * 60_000);
    expect(continuations).toBe(2);
    expect(daemon.promptRequests()).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  });
}
