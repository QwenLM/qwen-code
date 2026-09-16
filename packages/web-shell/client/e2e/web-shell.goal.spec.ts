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
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();

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

for (const failure of ['service', 'capacity'] as const) {
  test(`shows retained verification evidence and resumes after ${failure} pause`, async ({
    page,
  }, testInfo) => {
    const lastReason =
      failure === 'capacity'
        ? 'Goal verification capacity is insufficient. Evidence and the proposal are retained. Adjust the verifier model/context capacity before resuming.'
        : 'Goal verification could not finish: provider unavailable. Evidence and the proposal are retained. Resume the Goal to retry verification.';
    const scenario = createWebShellDaemonScenario({
      goalSnapshot: {
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'goal-retained-verification',
          revision: 3,
          objective: 'Deliver the reviewed result',
          status: 'paused',
          evidenceCursor: { recordId: 'original-goal-scope' },
          turnCount: 4,
          activeTimeMs: 5000,
          tokensUsed: 1234,
          createdAt: 1234,
          updatedAt: 2345,
          lastReason,
        },
      },
    });
    const daemon = await installScenario(page, scenario, testInfo);
    await gotoSession(page, scenario, daemon);
    await daemon.sendEvent({
      id: 10,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
          _meta: {
            goalState: scenario.goalSnapshot,
            goalStatus: {
              kind: 'paused',
              condition: 'Deliver the reviewed result',
              iterations: 4,
              durationMs: 5000,
              lastReason,
            },
          },
        },
      },
    });
    const strip = page.getByTestId('goal-status-strip');
    await expect(strip).toContainText('Paused');
    await expect(
      page.getByText(`Last check: ${lastReason}`, { exact: true }),
    ).toBeVisible();
    await expect(
      strip.getByRole('button', { name: 'Resume goal' }),
    ).toBeEnabled();
    await capture(page, testInfo, `verification-${failure}-paused.png`);
    await strip.getByRole('button', { name: 'Resume goal' }).click();
    await expect.poll(() => goalControlRequests(daemon).length).toBe(1);
    expect(goalControlRequests(daemon)[0]?.body).toEqual({
      action: 'resume',
      expectedGoalId: 'goal-retained-verification',
      expectedRevision: 3,
    });
    expect(daemon.promptRequests()).toHaveLength(0);
    await expect(strip).toContainText('In progress');
  });
}

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

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
]) {
  test(`goal approval keeps actions stable while reading ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const scenario = createWebShellDaemonScenario();
    const daemon = await installScenario(page, scenario, testInfo);
    await gotoSession(page, scenario, daemon);
    const objective = `Outcome: Review all open PRs. Done when: ${'Each PR has evidence. '.repeat(100)}Must not: Push or comment. Budget: 20 turns. On block: Report missing access. Context: Preserve this exact text.`;
    const content = `Replace the paused Goal and start working toward this objective?\n\n${objective}`;
    await daemon.sendEvent({
      id: 10,
      v: 1,
      type: 'permission_request',
      data: {
        requestId: 'goal-review',
        sessionId: scenario.sessionId,
        toolCall: {
          toolCallId: 'goal-review',
          title: `Propose Goal: ${objective}`,
          kind: 'other',
          rawInput: { objective },
          _meta: { toolName: 'propose_goal' },
          content: [
            { type: 'content', content: { type: 'text', text: content } },
          ],
        },
        options: [
          { optionId: 'allow_once', label: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', label: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    const card = page.locator('[data-web-shell-goal-approval]');
    await expect(card).toBeVisible();
    const approve = card.getByRole('radio', { name: 'Set goal and continue' });
    const beforeCard = await card.boundingBox();
    const beforeButton = await approve.boundingBox();
    expect(beforeCard).not.toBeNull();
    expect(beforeButton).not.toBeNull();
    expect(beforeButton!.y).toBeGreaterThanOrEqual(beforeCard!.y);
    expect(beforeButton!.y + beforeButton!.height).toBeLessThanOrEqual(
      Math.min(viewport.height, beforeCard!.y + beforeCard!.height),
    );
    await card.getByRole('tabpanel').hover();
    expect(await card.boundingBox()).toEqual(beforeCard);
    expect(await approve.boundingBox()).toEqual(beforeButton);
    await page.mouse.move(0, 0);
    expect(await card.boundingBox()).toEqual(beforeCard);
    await card.getByRole('tab', { name: 'Full content' }).click();
    const reading = card.getByRole('tabpanel');
    expect(await reading.textContent()).toBe(content);
    await reading.hover();
    await page.mouse.wheel(0, 800);
    await expect
      .poll(() => reading.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await card.boundingBox()).toEqual(beforeCard);
    expect(await approve.boundingBox()).toEqual(beforeButton);
    expect(daemon.permissionRequests()).toHaveLength(0);
    await approve.click();
    await expect.poll(() => daemon.permissionRequests().length).toBe(1);
    expect(daemon.permissionRequests()[0].body).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  });
}
