import { expect, test, type Page } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  turnCompleteEvent,
  userTextEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';
import { completeReplay } from './visuals/harness';

const cronPrompt = [
  'Investigate the release regression.',
  'Automatic cron wakeup: preserve this complete multiline instruction for the next model turn.',
  'Open https://example.test/releases/2026-11-20 and compare the failing checks with the last healthy release.',
  '/loop 5m Continue checking only while the release remains unhealthy.',
  'Do not restart unrelated services, do not edit product source, and report exact evidence rather than guessing.',
  'Keep every constraint in this prompt available to the model even though a person did not type this wakeup manually.',
  'Cron baseline terminator: CRON-END-718.',
].join('\n');

const loopPrompt = [
  'Self-paced loop wakeup: inspect the queue again.',
  'This distinct loop instruction is intentionally long so the baseline presentation cannot be mistaken for a compact card.',
  'Read the prior result, retain unresolved blockers, and do not repeat completed work or fabricate progress.',
  'The next useful action is to reassess the queue and stop when no work remains; otherwise continue the current objective.',
  'Preserve the original user-role content, including this final line, while treating the input as an automatic continuation.',
  'Loop baseline terminator: LOOP-END-529.',
].join('\n');

const ordinaryPrompt =
  'Ordinary human control: leave this ordinary message unchanged. ORDINARY-CONTROL-143';

const perRunPrompt = [
  'Scheduled task: Review PRs',
  'Task ID: task-per-run-control',
  'Schedule: 0 9 * * *',
  'Triggered at: 2026-11-20T01:00:00.000Z',
  'Trigger: scheduled',
  'Session: new chat for this run',
  '',
  'This is a scheduled task run. Execute the instructions below now. Do not create or modify a schedule unless the instructions explicitly ask you to.',
  '',
  '/review Check https://example.test/per-run and review the next PR. PER-RUN-CONTROL-864',
].join('\n');

type SourcedUserEvent = ReturnType<typeof userTextEvent> & {
  data: { update: { _meta?: { source?: string } } };
};

function sourcedUserTextEvent(
  text: string,
  source: 'cron' | 'loop',
  id: number,
): ReturnType<typeof userTextEvent> {
  const event = structuredClone(
    userTextEvent(text, { id }),
  ) as SourcedUserEvent;
  event.data.update._meta = { source };
  return event;
}

async function openFixture(
  page: Page,
  baseURL: string,
  events: WebShellDaemonScenario['events'],
): Promise<{
  scenario: WebShellDaemonScenario;
  daemon: MockDaemonController;
}> {
  await page.clock.setFixedTime(new Date('2026-11-20T03:15:00.000Z'));
  const scenario = createWebShellDaemonScenario({ events });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.route('**/workspace/models', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { models: [] } });
    } else {
      await route.fallback();
    }
  });
  const token =
    process.env['WEB_SHELL_TEST_TOKEN'] ?? 'automatic-trigger-test-token';
  await page.goto(
    `/session/${encodeURIComponent(scenario.sessionId)}?theme=dark&lang=en#token=${encodeURIComponent(token)}`,
  );
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  await completeReplay(
    page,
    daemon,
    scenario.sessionId,
    scenario.events.length,
  );
  return { scenario, daemon };
}

function completedTurnEvents(): WebShellDaemonScenario['events'] {
  return [
    sourcedUserTextEvent(cronPrompt, 'cron', 1),
    assistantTextEvent('Cron turn completed.', { id: 2 }),
    turnCompleteEvent('cron-automatic', { id: 3 }),
    sourcedUserTextEvent(loopPrompt, 'loop', 4),
    assistantTextEvent('Loop turn completed.', { id: 5 }),
    turnCompleteEvent('loop-automatic', { id: 6 }),
    userTextEvent(ordinaryPrompt, { id: 7 }),
    assistantTextEvent('Ordinary turn completed.', { id: 8 }),
    turnCompleteEvent('ordinary-control', { id: 9 }),
    sourcedUserTextEvent(perRunPrompt, 'cron', 10),
    assistantTextEvent('Per-run turn completed.', { id: 11 }),
    turnCompleteEvent('per-run-control', { id: 12 }),
  ];
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test('cron and loop prompts use compact expandable cards @smoke', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(
    page,
    String(testInfo.project.use.baseURL),
    completedTurnEvents(),
  );

  const cards = page.locator('[data-web-shell-automatic-trigger-message]');
  const cron = page.locator(
    '[data-web-shell-automatic-trigger-message][data-source="cron"]',
  );
  const loop = page.locator(
    '[data-web-shell-automatic-trigger-message][data-source="loop"]',
  );
  await expect(cards).toHaveCount(2);
  await expect(cron).toBeVisible();
  await expect(loop).toBeVisible();
  await expect(
    page.locator('[data-web-shell-automatic-trigger-summary]'),
  ).toHaveCount(2);
  await expect(
    page.locator('[data-web-shell-automatic-trigger-instructions]'),
  ).toHaveCount(0);
  await expect(cron).toContainText('Automatic trigger');
  await expect(cron).toContainText('Investigate the release regression.');
  await expect(loop).toContainText('Self-paced loop wakeup');

  const ordinary = page
    .locator('[data-web-shell-user-bubble]')
    .filter({ hasText: 'ORDINARY-CONTROL-143' });
  await expect(ordinary).toHaveText(ordinaryPrompt);
  await expect(
    ordinary.locator('[data-web-shell-automatic-trigger-message]'),
  ).toHaveCount(0);
  const perRun = page.locator('[data-web-shell-scheduled-task-run-message]');
  await expect(perRun).toHaveCount(1);
  await expect(perRun).toContainText('PER-RUN-CONTROL-864');
  await expect(
    perRun.locator('[data-web-shell-automatic-trigger-message]'),
  ).toHaveCount(0);

  await cron.scrollIntoViewIfNeeded();
  const compactHeight = (await cron.boundingBox())?.height;
  expect(compactHeight).toBeDefined();
  expect(compactHeight!).toBeLessThan(140);
  await expectNoHorizontalOverflow(page);
  const desktopPath = testInfo.outputPath('automatic-desktop.png');
  await page.screenshot({ path: desktopPath, animations: 'disabled' });
  await testInfo.attach('automatic-desktop', {
    path: desktopPath,
    contentType: 'image/png',
  });

  const cronToggle = cron.getByRole('button', {
    name: 'Show more',
    exact: true,
  });
  await cronToggle.click();
  const instructions = cron.locator(
    '[data-web-shell-automatic-trigger-instructions]',
  );
  await expect(instructions).toBeVisible();
  await expect(instructions).toHaveText(cronPrompt);
  await expect(
    instructions.locator('a[href="https://example.test/releases/2026-11-20"]'),
  ).toHaveCount(1);
  await expect(
    instructions
      .locator('[data-web-shell-user-slash-command]')
      .filter({ hasText: '/loop' }),
  ).toHaveCount(1);
  await cron.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(instructions).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await loop.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  const mobilePath = testInfo.outputPath('automatic-mobile.png');
  await page.screenshot({ path: mobilePath, animations: 'disabled' });
  await testInfo.attach('automatic-mobile', {
    path: mobilePath,
    contentType: 'image/png',
  });

  await loop.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect(
    loop.locator('[data-web-shell-automatic-trigger-instructions]'),
  ).toHaveText(loopPrompt);
  await expectNoHorizontalOverflow(page);
  const expandedPath = testInfo.outputPath('automatic-mobile-expanded.png');
  await page.screenshot({ path: expandedPath, animations: 'disabled' });
  await testInfo.attach('automatic-mobile-expanded', {
    path: expandedPath,
    contentType: 'image/png',
  });
  expect(pageErrors).toEqual([]);
});

test('preserves an unknown tasks-from source label @smoke', async ({
  page,
}, testInfo) => {
  const content = 'Loop tick — tasks from an unrecognized future source';
  await openFixture(page, String(testInfo.project.use.baseURL), [
    sourcedUserTextEvent(content, 'cron', 1),
    assistantTextEvent('Cron turn completed.', { id: 2 }),
    turnCompleteEvent('loop-prefix-instruction', { id: 3 }),
  ]);
  const card = page.locator(
    '[data-web-shell-automatic-trigger-message][data-source="cron"]',
  );
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect(
    card.locator('[data-web-shell-automatic-trigger-instructions]'),
  ).toHaveText(content);
});

test('canceling automatic-input edit restores the compact card @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openFixture(page, String(testInfo.project.use.baseURL), [
    sourcedUserTextEvent(loopPrompt, 'loop', 1),
    assistantTextEvent('Loop turn completed.', { id: 2 }),
    turnCompleteEvent('loop-edit', { id: 3 }),
  ]);
  const card = page.locator(
    '[data-web-shell-automatic-trigger-message][data-source="loop"]',
  );
  await expect(card).toBeVisible();
  await page
    .getByRole('button', { name: 'More message actions', exact: true })
    .hover();
  await page
    .getByRole('menuitem', { name: 'Edit message', exact: true })
    .click();
  const bubble = page.locator('[data-web-shell-user-bubble]');
  const editor = bubble.getByRole('textbox', { name: 'Edit message' });
  await expect(editor).toHaveValue(loopPrompt);
  await bubble.getByRole('button', { name: 'cancel', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(card).toBeVisible();
  await expect(
    card.locator('[data-web-shell-automatic-trigger-instructions]'),
  ).toHaveCount(0);
});
