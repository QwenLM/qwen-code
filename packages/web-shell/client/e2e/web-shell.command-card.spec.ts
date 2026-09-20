import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const command =
  'for i in $(seq 40); do code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5300/health); if [ "$code" = "200" ]; then echo "health OK"; break; fi; sleep 1; done';
const output = 'health OK after 1s\nfinal: 200\n{"status":"ok"}';
const timeoutOutput =
  'Command timed out after 1000ms before it could complete.' +
  '\npartial output'.repeat(40);

const shellResult = (
  output: string,
  exitCode = 0,
  error: string | null = null,
) => ({
  type: 'shell_result',
  version: 1,
  text: output,
  output,
  directory: '/workspace',
  exitCode,
  signal: null,
  pid: 72187,
  error,
  outcome: exitCode ? 'failed' : 'completed',
  notices: [],
  truncated: false,
  outputFiles: [],
});

test('shell card separates output, reveals and copies commands, and retains failures', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Check daemon health', { id: 1 }),
      toolCallEvent(
        'health',
        'run_shell_command',
        { command, description: 'Wait for daemon health' },
        {
          id: 2,
          rawOutput: shellResult(output),
        },
      ),
      turnCompleteEvent('health-turn', { id: 3 }),
      userTextEvent('Check a failed command', { id: 4 }),
      toolCallEvent(
        'failure',
        'run_shell_command',
        { command: 'cat missing.txt', description: 'Read missing file' },
        {
          id: 5,
          rawOutput: shellResult(
            'cat: missing.txt: No such file',
            2,
            'permission denied',
          ),
        },
      ),
      turnCompleteEvent('failure-turn', { id: 6 }),
      userTextEvent('Check timeout', { id: 7 }),
      toolCallEvent(
        'timeout',
        'run_shell_command',
        { command: 'sleep 5', description: 'Wait briefly' },
        {
          id: 8,
          rawOutput: {
            output: timeoutOutput,
          },
        },
      ),
      turnCompleteEvent('timeout-turn', { id: 9 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?language=zh-CN`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  const collapsedSteps = page.getByRole('button', {
    name: '展开步骤',
    exact: true,
  });
  await expect(collapsedSteps).toHaveCount(2);
  await collapsedSteps.first().click();
  await collapsedSteps.first().click();
  await page
    .getByRole('button', { name: 'Wait for daemon health', exact: true })
    .click();
  const health = page.locator('[data-transcript-tool-call-id="health"]');
  const card = health.locator('[data-shell-command-card]');
  await expect(card).toBeVisible();
  await expect(card.locator('[class*="expandedCardTitle"]')).toHaveText(
    '运行命令',
  );
  await expect(card.locator('[class*="shellDetails"] > pre')).toHaveText(
    output,
  );
  await expect(card.locator('[class*="shellDetails"] > pre')).toBeVisible();
  const outputSummary = card.locator('summary').filter({ hasText: /^输出$/ });
  await outputSummary.click();
  await expect(card.locator('[class*="shellDetails"] > pre')).toBeHidden();
  await outputSummary.press('Enter');
  await expect(card.locator('[class*="shellDetails"] > pre')).toBeVisible();
  await expect(card).toContainText('执行成功');
  await expect(card.getByText(command, { exact: true })).toBeVisible();
  await expect(card.locator('summary')).toHaveText([
    '命令',
    '输出',
    '执行详情',
  ]);
  await expect(card.getByText('72187', { exact: true })).toBeHidden();
  await card.getByRole('button', { name: '复制命令' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    command,
  );
  await expect(
    card.getByRole('button', { name: '复制命令' }).locator('.lucide-check'),
  ).toBeVisible();
  const outputCopy = card.getByRole('button', { name: '复制输出' });
  await expect(outputCopy).toHaveText('');
  await outputCopy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await card.locator('[class*="shellDetails"] > pre').innerText(),
  );
  await expect(outputCopy.locator('.lucide-check')).toBeVisible();
  await card.screenshot({
    path: testInfo.outputPath('command-card-success.png'),
  });
  await card
    .locator('summary')
    .filter({ hasText: /^命令$/ })
    .focus();
  await page.keyboard.press('Enter');
  await expect(card.getByText(command, { exact: true })).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(card.getByText(command, { exact: true })).toBeVisible();
  const commandBounds = await card
    .getByText(command, { exact: true })
    .boundingBox();
  const outputBounds = await card
    .locator('[class*="shellDetails"] > pre')
    .boundingBox();
  expect(commandBounds).not.toBeNull();
  expect(outputBounds).not.toBeNull();
  expect(Math.abs(commandBounds!.width - outputBounds!.width)).toBeLessThan(1);
  await card.locator('summary').filter({ hasText: '执行详情' }).click();
  await expect(card.getByText('72187', { exact: true })).toBeVisible();
  await card.screenshot({
    path: testInfo.outputPath('command-card-expanded.png'),
  });
  await page
    .getByRole('button', { name: 'Read missing file', exact: true })
    .click();
  const failure = page.locator(
    '[data-transcript-tool-call-id="failure"] [data-shell-command-card]',
  );
  await expect(failure).toContainText('退出码 2');
  await expect(
    failure.getByText('permission denied', { exact: true }),
  ).toBeVisible();
  await failure.screenshot({
    path: testInfo.outputPath('command-card-failure.png'),
  });
  await page.getByRole('button', { name: 'Wait briefly', exact: true }).click();
  await expect(
    page
      .locator(
        '[data-transcript-tool-call-id="timeout"] [class*="shellDetails"] > pre',
      )
      .first(),
  ).toHaveText(timeoutOutput);
  const timeoutPre = page
    .locator(
      '[data-transcript-tool-call-id="timeout"] [class*="shellDetails"] > pre',
    )
    .first();
  await expect(timeoutPre).toHaveCSS('max-height', '200px');
  const heights = await timeoutPre.evaluate((el) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
    outer: el.getBoundingClientRect().height,
  }));
  expect(heights.outer).toBe(200);
  expect(heights.scroll).toBeGreaterThan(heights.client);
  await expect(card.getByText(command, { exact: true })).toHaveCSS(
    'max-height',
    '200px',
  );
  await expect(card.locator('dl')).toHaveCSS('max-height', '200px');
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await card.screenshot({
    path: testInfo.outputPath('command-card-mobile.png'),
  });
});

test('running shell renders snapshots and follows output until the reader scrolls up', async ({
  page,
}, testInfo) => {
  let id = 1;
  const sessionUpdateEvent = (update: Record<string, unknown>, id: number) => ({
    v: 1 as const,
    type: 'session_update' as const,
    id,
    data: { update },
  });
  const frame = (count: number) => ({
    ansiOutput: Array.from({ length: count }, (_, i) => [
      { text: `line ${i}`, fg: '#00ff00' },
    ]),
    totalLines: count,
    totalBytes: count * 10,
  });
  const update = (rawOutput: Record<string, unknown>) =>
    sessionUpdateEvent(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'live-shell',
        status: 'in_progress',
        rawOutput,
      },
      ++id,
    );
  const scenario = createWebShellDaemonScenario({
    events: [
      sessionUpdateEvent(
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'live-shell',
          toolName: 'run_shell_command',
          title: 'Run live output',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'long-running-check', timeout: 120000 },
          rawOutput: frame(40),
        },
        id,
      ),
      { ...replayCompleteEvent({ sessionId: 'test-session' }), id: ++id },
    ],
  });
  const daemon = await installMockDaemon(page, scenario);
  await page.goto('/session/test-session?language=zh-CN&theme=light');
  await page.getByRole('button', { name: /正在执行 运行命令/ }).click();
  const card = page.locator('[data-shell-command-card]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('运行中');
  const output = card.locator('[class*="shellDetails"] > pre');
  await expect(output).toContainText('line 39');
  await expect(output).not.toContainText('ansiOutput');
  await expect
    .poll(() =>
      output.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThan(24);
  await output.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await daemon.burstEvents([update(frame(50))]);
  await expect(output).toContainText('line 49');
  await daemon.burstEvents([
    sessionUpdateEvent(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'live-shell',
        status: 'in_progress',
        _meta: { shellProgress: { type: 'shell_progress', elapsedMs: 30000 } },
      },
      ++id,
    ),
  ]);
  await expect(output).toContainText('line 49');
  expect(await output.evaluate((el) => el.scrollTop)).toBe(0);
  await output.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await daemon.burstEvents([update(frame(60))]);
  await expect(output).toContainText('line 59');
  await expect
    .poll(() =>
      output.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThan(24);
  await card.locator('summary').filter({ hasText: '执行详情' }).click();
  await expect(card).toContainText('输出行数');
  await card.screenshot({
    path: testInfo.outputPath('command-card-running.png'),
  });
});
