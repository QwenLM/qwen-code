import type { DaemonSessionWorkflowTaskStatus } from '@qwen-code/sdk/daemon';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
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
) {
  const events = [
    userTextEvent('Review my change and fix what you find.', { id: 1 }),
    toolCallEvent(
      'workflow-call',
      'workflow',
      { name: 'Review and fix' },
      { id: 2, rawOutput: { runId: 'workflow-review' } },
    ),
    ...laterTurns,
    turnCompleteEvent('review', { id: 30 }),
  ];
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
  return { tasksPolled };
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
