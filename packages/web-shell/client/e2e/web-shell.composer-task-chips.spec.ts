import type {
  DaemonEvent,
  DaemonSessionWorkflowTaskStatus,
} from '@qwen-code/sdk/daemon';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  permissionRequestEvent,
  replayCompleteEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

test.use({ viewport: { width: 1280, height: 820 } });

function workflowTask(
  overrides: Partial<DaemonSessionWorkflowTaskStatus> = {},
): DaemonSessionWorkflowTaskStatus {
  const now = Date.now();
  return {
    kind: 'workflow',
    id: 'workflow-review',
    toolUseId: 'workflow-call',
    label: 'Review and fix',
    description: 'Review the change and fix what it finds',
    status: 'running',
    startTime: now - 42_000,
    runtimeMs: 42_000,
    isBackgrounded: true,
    currentPhase: 'Review',
    phaseVisits: [
      { id: 'review', index: 0, title: 'Review', startedAt: now - 42_000 },
    ],
    dispatches: (
      [
        ['correctness', 'running', 'agent-correctness'],
        ['tests', 'completed', 'agent-tests'],
      ] as const
    ).map(([id, status, subagentId]) => ({
      id,
      phaseVisitId: 'review',
      label: `review: ${id}`,
      prompt: `Review the change for ${id}.`,
      status,
      subagentId,
      dependsOn: [],
      queuedAt: now - 30_000,
      startedAt: now - 30_000,
    })),
    agentsDispatched: 2,
    agentsCompleted: 1,
    tokensSpent: 1_200,
    tokenBudgetTotal: null,
    recentLogs: [],
    pendingApprovalCount: 0,
    pendingApprovals: [],
    ...overrides,
  };
}

// Enough later conversation that the workflow's row sits far above the fold.
const laterTurns = Array.from({ length: 6 }, (_, index) =>
  assistantTextEvent(
    Array.from(
      { length: 8 },
      (_, line) => `Follow-up note ${index + 1}.${line + 1}: keep going.`,
    ).join('\n\n'),
    { id: 10 + index },
  ),
);

async function openSession(
  page: Page,
  testInfo: TestInfo,
  tasks: DaemonSessionWorkflowTaskStatus[],
  events: DaemonEvent[] = [
    userTextEvent('Review my change and fix what you find.', { id: 1 }),
    toolCallEvent(
      'workflow-call',
      'workflow',
      { name: 'Review and fix' },
      { id: 2, rawOutput: { runId: 'workflow-review' } },
    ),
    ...laterTurns,
    turnCompleteEvent('review', { id: 30 }),
  ],
) {
  const scenario = createWebShellDaemonScenario({
    supportedCommands: { workflowsEnabled: true, savedWorkflows: [] },
    workflowTasks: tasks,
    events,
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  const tasksPolled = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(
      `/session/${scenario.sessionId}/tasks`,
    ),
  );
  await page.goto(`/session/${scenario.sessionId}?theme=dark`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: events.length,
    }),
  );
  return { daemon, scenario, tasksPolled };
}

test('a workflow chip above the composer locates and opens the run', async ({
  page,
}, testInfo) => {
  await openSession(page, testInfo, [workflowTask()]);

  const chip = page
    .getByTestId('composer-task-chips')
    .getByRole('button', { name: '1 workflow' });
  await expect(chip).toBeVisible();
  const node = page.locator('[data-workflow-dispatch="correctness"]');
  await expect(node).not.toBeInViewport();
  await testInfo.attach('chip', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await chip.click();

  await expect(node).toBeVisible();
  await expect(node).toBeInViewport();
  await testInfo.attach('located', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('a located workflow stays open as the same turn adds tools @smoke', async ({
  page,
}, testInfo) => {
  const { daemon } = await openSession(
    page,
    testInfo,
    [workflowTask()],
    [
      userTextEvent('Start a background review, then inspect the project.', {
        id: 1,
      }),
      toolCallEvent(
        'workflow-call',
        'workflow',
        { name: 'Review and fix' },
        { id: 2, rawOutput: { runId: 'workflow-review' } },
      ),
    ],
  );
  const chip = page
    .getByTestId('composer-task-chips')
    .getByRole('button', { name: '1 workflow' });
  const node = page.locator('[data-workflow-dispatch="correctness"]');
  await chip.click();
  await expect(node).toBeVisible();

  await daemon.sendEvent(
    toolCallEvent('shell-call', 'shell', { command: 'pwd' }, { id: 3 }),
  );

  await expect(
    page.locator('[data-transcript-tool-call-id="shell-call"]'),
  ).toBeVisible();
  await expect(node).toBeVisible();
  await expect(chip).toBeVisible();
});

test('a chip for several runs lists them to pick from', async ({
  page,
}, testInfo) => {
  await openSession(page, testInfo, [
    workflowTask(),
    workflowTask({
      id: 'workflow-docs',
      toolUseId: undefined,
      label: 'Update the docs',
      status: 'paused',
    }),
  ]);

  await page
    .getByTestId('composer-task-chips')
    .getByRole('button', { name: '2 workflows' })
    .click();
  const list = page.getByTestId('composer-task-list');
  await expect(list).toBeVisible();
  await testInfo.attach('list', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  // A run with no row in this transcript opens in the tasks dialog.
  await list.getByRole('button', { name: /Update the docs/ }).click();
  await expect(
    page.getByRole('dialog', { name: 'Background tasks' }),
  ).toBeVisible();
});

test('an expired reveal does not reopen a collapsed workflow on sibling approval', async ({
  page,
}, testInfo) => {
  const { daemon, scenario } = await openSession(
    page,
    testInfo,
    [workflowTask()],
    [
      userTextEvent('Run a workflow and inspect the project.', { id: 1 }),
      toolCallEvent(
        'workflow-call',
        'workflow',
        { name: 'Review and fix' },
        { id: 2, rawOutput: { runId: 'workflow-review' } },
      ),
      toolCallEvent('shell-call', 'shell', { command: 'pwd' }, { id: 3 }),
    ],
  );
  await page
    .getByTestId('composer-task-chips')
    .getByRole('button', { name: '1 workflow' })
    .click();
  const graph = page.locator('[data-workflow-dispatch="correctness"]');
  await expect(graph).toBeVisible();
  await page
    .locator('[data-transcript-tool-call-id="workflow-call"] [role="button"]')
    .first()
    .click();
  await expect(graph).toHaveCount(0);
  // Let the one-second reveal/remount grace expire before changing branches.
  await page.waitForTimeout(1300);
  await daemon.sendEvent(
    permissionRequestEvent('approval-sibling', {
      id: 4,
      sessionId: scenario.sessionId,
      toolCall: {
        toolCallId: 'shell-call',
        title: 'shell',
        kind: 'execute',
        _meta: { toolName: 'shell' },
        rawInput: { command: 'pwd' },
      },
    }),
  );

  await expect(page.locator('[data-web-shell-permission-panel]')).toBeVisible();
  await expect(graph).toHaveCount(0);
});

test('keyboard focus leaving task choices closes the list', async ({
  page,
}, testInfo) => {
  await openSession(page, testInfo, [
    workflowTask(),
    workflowTask({ id: 'workflow-docs', label: 'Update the docs' }),
  ]);
  const chip = page
    .getByTestId('composer-task-chips')
    .getByRole('button', { name: '2 workflows' });
  const list = page.getByTestId('composer-task-list');
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(
    list.getByRole('button', { name: /Review and fix/ }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    list.getByRole('button', { name: /Update the docs/ }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(chip).toBeFocused();
  await expect(list).toBeVisible();
  await page.keyboard.press('Tab');

  const composer = page.locator('.cm-content').first();
  await expect(composer).toBeFocused();
  await expect(list).toHaveCount(0);
  await page.keyboard.type('keep typing');
  await expect(composer).toHaveText('keep typing');
});

test('selection and task completion keep focus near the composer', async ({
  page,
}, testInfo) => {
  const first = workflowTask();
  const second = workflowTask({
    id: 'workflow-docs',
    label: 'Update the docs',
  });
  const { scenario } = await openSession(page, testInfo, [first, second]);
  const chip = page
    .getByTestId('composer-task-chips')
    .locator('[data-kind="workflow"]');
  const list = page.getByTestId('composer-task-list');
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(
    list.getByRole('button', { name: /Review and fix/ }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(
    page.locator('[data-workflow-dispatch="correctness"]'),
  ).toBeVisible();
  await expect(chip).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(
    list.getByRole('button', { name: /Review and fix/ }),
  ).toBeFocused();
  scenario.workflowTasks = [first, { ...second, status: 'completed' }];
  await expect(chip).toHaveText('1 workflow');
  await expect(list).toHaveCount(0);
  await expect(chip).toBeFocused();

  scenario.workflowTasks = [
    { ...first, status: 'completed' },
    { ...second, status: 'completed' },
  ];
  await expect(chip).toHaveCount(0);
  const composer = page.locator('.cm-content').first();
  await expect(composer).toBeFocused();
  await page.keyboard.type('next task');
  await expect(composer).toHaveText('next task');
});

test('a multi-task chip opens keyboard choices and returns focus on Escape @smoke', async ({
  page,
}, testInfo) => {
  await openSession(page, testInfo, [
    workflowTask(),
    workflowTask({
      id: 'workflow-docs',
      toolUseId: undefined,
      label: 'Update the docs',
      status: 'paused',
    }),
  ]);

  const chip = page
    .getByTestId('composer-task-chips')
    .getByRole('button', { name: '2 workflows' });
  const list = page.getByTestId('composer-task-list');
  const first = list.getByRole('button', { name: /Review and fix/ });
  const second = list.getByRole('button', { name: /Update the docs/ });
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(first).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(chip).toBeFocused();

  await page.keyboard.press('Space');
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(second).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('dialog', { name: 'Background tasks' }),
  ).toBeVisible();
});

test('a finished workflow leaves no chip behind', async ({
  page,
}, testInfo) => {
  const { tasksPolled } = await openSession(page, testInfo, [
    workflowTask({ status: 'completed', endTime: Date.now() }),
  ]);

  // Prove the snapshot with the finished run reached the page — its inline
  // view renders from it — before checking that no chip came with it.
  await tasksPolled;
  await page.getByRole('button', { name: 'Expand steps' }).first().click();
  await page
    .getByRole('button', { name: 'Workflow', exact: true })
    .first()
    .click();
  await expect(page.locator('[data-workflow-dispatch="tests"]')).toBeVisible();
  await expect(page.getByTestId('composer-task-chips')).toHaveCount(0);
});
