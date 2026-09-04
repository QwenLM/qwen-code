import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  thoughtTextEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

test('compact view keeps the thinking block visible while streaming', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({});
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);

  await fillComposer(page, 'Ping from tmp compact test');
  await page.locator('[data-web-shell-composer-submit]').click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);

  // The thinking phase shows the thinking block as its own row; the thought
  // content stays collapsed and the top collapse row keeps its generic live
  // label.
  await daemon.sse.split(
    thoughtTextEvent('private chain of thought about the weather'),
  );
  const list = page.locator('[data-web-shell-message-list]');
  await expect(list).toContainText('Thinking', { timeout: 5000 });
  await expect(list).toContainText('Processing');
  await expect(list).not.toContainText('private chain of thought');

  // Thinking ends once the assistant starts answering: the block's live label
  // flips to its completed summary while the collapse row stays.
  await daemon.sse.split(assistantTextEvent('the weather is rainy'));
  await expect(list).not.toContainText('Thinking', { timeout: 5000 });
  await expect(list).toContainText('Processing');
});

test('compact view merges an agent group and a following tool into one summary row', async ({
  page,
}, testInfo) => {
  // The background agent keeps its own tool group, so the agent group and the
  // grep group only collapse into one aggregate summary row when the
  // app-level CompactModeContext stays on — flipping that provider to false
  // renders two standalone groups and this assertion fails.
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Audit the schema and grep the logs.', { id: 1 }),
      toolCallEvent(
        'call-agent-audit',
        'Agent',
        {
          description: 'Audit the schema drift between services',
          run_in_background: true,
        },
        { id: 2 },
      ),
      toolCallEvent(
        'call-grep-logs',
        'grep_search',
        { pattern: 'compact' },
        {
          id: 3,
        },
      ),
      turnCompleteEvent('prompt-compact-merge', { id: 4 }),
    ],
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);

  const list = page.locator('[data-web-shell-message-list]');
  await expect(list).toContainText('Ran 1 agent · Ran 1 tool', {
    timeout: 5000,
  });
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
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
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
