import type {
  DaemonEvent,
  DaemonSessionShellTaskStatus,
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
  await list
    .getByTestId('composer-task-open')
    .filter({ hasText: 'Update the docs' })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Background tasks' }),
  ).toBeVisible();
});

test('clicking an expanded multi-task chip again collapses its list', async ({
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

  await chip.click();
  await expect(list).toBeVisible();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');

  await chip.click();
  await expect(list).toHaveCount(0);
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await expect(chip).toBeFocused();

  // Pressing a non-focusable part of the list must not leave an expanded
  // list with keyboard focus outside its handling container.
  await chip.click();
  await expect(page.getByTestId('composer-task-open').first()).toBeFocused();
  await list.locator('div').first().click();
  await expect(list).toBeVisible();
  await expect(page.getByTestId('composer-task-open').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(chip).toBeFocused();
});

test('a task refresh during pointer press does not undo the chip collapse', async ({
  page,
}, testInfo) => {
  const tasks = [
    workflowTask(),
    workflowTask({
      id: 'workflow-docs',
      toolUseId: undefined,
      label: 'Update the docs',
      status: 'paused',
    }),
  ];
  const { daemon, scenario } = await openSession(page, testInfo, tasks);
  await page.route(`**/session/${scenario.sessionId}/tasks`, async (route) => {
    await route.fulfill({
      json: {
        v: 1,
        sessionId: scenario.sessionId,
        now: Date.now(),
        tasks: tasks.map((task) => ({
          ...task,
          runtimeMs: task.runtimeMs + 3000,
        })),
      },
    });
  });
  const chip = page
    .getByTestId('composer-task-chips')
    .getByRole('button', { name: '2 workflows' });
  const list = page.getByTestId('composer-task-list');
  await chip.click();
  await expect(list).toBeVisible();
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();

  await daemon.sendEvent(
    toolCallEvent('workflow-refresh-tool', 'workflow', {
      name: 'Keep the task list active',
    }),
  );
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes(`/session/${scenario.sessionId}/tasks`) &&
      response.request().method() === 'GET',
    { timeout: 6000 },
  );
  await refreshed;
  await page.mouse.up();

  await expect(list).toHaveCount(0);
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
});

test('keyboard focus leaving during a pointer press closes the task list', async ({
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
  await chip.click();
  await expect(page.getByTestId('composer-task-open').first()).toBeFocused();

  const titleBox = (await list.locator('div').first().boundingBox())!;
  await page.mouse.move(
    titleBox.x + titleBox.width / 2,
    titleBox.y + titleBox.height / 2,
  );
  await page.mouse.down();
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press('Tab');
    if (
      await editor.evaluate((element) => element === document.activeElement)
    ) {
      break;
    }
  }
  await expect(editor).toBeFocused();
  await expect(list).toHaveCount(0);
  await page.mouse.up();
  await expect(list).toHaveCount(0);
});

test('clicking an expanded single-task shell chip again collapses its detail panel', async ({
  page,
}, testInfo) => {
  const shellTask: DaemonSessionShellTaskStatus = {
    kind: 'shell',
    id: 'shell-collapse',
    label: 'npm run dev',
    description: 'npm run dev',
    status: 'running',
    startTime: Date.now() - 20_000,
    runtimeMs: 20_000,
    command: 'npm run dev',
    cwd: '/workspace',
  };
  const events: DaemonEvent[] = [
    userTextEvent('Run the dev server in the background.', { id: 1 }),
    toolCallEvent(
      'shell-call',
      'run_shell_command',
      { command: 'npm run dev', is_background: true },
      { id: 2 },
    ),
    turnCompleteEvent('shell-collapse', { id: 3 }),
  ];
  const scenario = createWebShellDaemonScenario({
    workflowTasks: [shellTask],
    events,
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?theme=dark`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: events.length,
    }),
  );

  const chip = page
    .getByTestId('composer-task-chips')
    .getByRole('button', { name: '1 shell' });
  const panelExplain = page.getByTestId('artifact-panel-explain');

  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await chip.click();
  await expect(panelExplain).toBeVisible();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');

  await chip.click();
  await expect(panelExplain).toHaveCount(0);
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
});

test('mouse presses on a task-row button preserve list focus until selection', async ({
  page,
}, testInfo) => {
  const firstShell: DaemonSessionShellTaskStatus = {
    kind: 'shell',
    id: 'shell-first',
    command: 'First command',
    label: 'First command',
    description: 'First command',
    status: 'running',
    startTime: Date.now() - 20_000,
    runtimeMs: 20_000,
    cwd: '/workspace',
  };
  await openSession(page, testInfo, [
    firstShell,
    {
      ...firstShell,
      id: 'shell-second',
      command: 'Second command',
      label: 'Second command',
      description: 'Second command',
    },
  ]);
  await page
    .getByTestId('composer-task-chips')
    .getByRole('button', { name: '2 shells' })
    .click();
  const list = page.getByTestId('composer-task-list');
  const firstRow = list.getByTestId('composer-task-open').first();
  const secondRow = list.getByTestId('composer-task-open').nth(1);
  await expect(firstRow).toBeFocused();

  await secondRow.hover();
  await page.mouse.down();
  await expect(list).toBeVisible();
  await expect(firstRow).toBeFocused();
  await page.mouse.up();
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId('artifact-panel-explain')).toBeVisible();
});

test('clicking an unlinked workflow chip again cancels its pending dialog', async ({
  page,
}, testInfo) => {
  const { scenario, tasksPolled } = await openSession(page, testInfo, [
    workflowTask({ toolUseId: undefined }),
  ]);
  await tasksPolled;
  const chip = page
    .getByTestId('composer-task-chips')
    .getByRole('button', { name: '1 workflow' });
  await expect(chip).toBeVisible();
  let requests = 0;
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route(
    (url) =>
      url.pathname.endsWith(`/session/${scenario.sessionId}/tasks`) &&
      url.searchParams.get('includeWorkflows') === 'true',
    async (route) => {
      requests += 1;
      await responseGate;
      await route.fulfill({
        json: {
          v: 1,
          sessionId: scenario.sessionId,
          now: Date.now(),
          tasks: scenario.workflowTasks ?? [],
        },
      });
    },
  );
  const dialogRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname.endsWith(`/session/${scenario.sessionId}/tasks`) &&
      url.searchParams.get('includeWorkflows') === 'true' &&
      request.method() === 'GET'
    );
  });

  await chip.click();
  await dialogRequest;
  await chip.click();
  releaseResponse();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );

  expect(requests).toBe(1);
  await expect(
    page.getByRole('dialog', { name: 'Background tasks' }),
  ).toHaveCount(0);
});

test('a "?" on a task choice asks a side question for an explanation', async ({
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
  await list.getByTestId('composer-task-explain').first().click();

  // The mock daemon's stock side answer streams into the btw panel; the
  // list stays open so another task can be asked about next. The panel
  // echoes a short display line, not the composed fact dump.
  const panel = page.locator('[class*="btwPanel"]');
  await expect(panel).toContainText('A side answer.');
  await expect(panel).toContainText(
    'Explain what this task is doing: Review and fix',
  );
  await expect(panel).not.toContainText('Task facts:');
  await expect(list).toBeVisible();
});

test('Escape on a "?" closes the list without dismissing the explanation', async ({
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
  await list.getByTestId('composer-task-explain').first().click();
  const panel = page.locator('[class*="btwPanel"]');
  await expect(panel).toContainText('A side answer.');

  // App's window-capture btw shortcut must leave Escape inside the chips
  // to the chips: the list closes, the panel survives.
  await list.getByTestId('composer-task-explain').last().focus();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(panel).toContainText('A side answer.');
});

test('the row highlight is the open click target and the "?" keeps the chip focus ring', async ({
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
  await chip.click();
  const list = page.getByTestId('composer-task-list');
  const row = list.locator('[data-testid="composer-task-row"]').first();
  await expect(row).toBeVisible();

  // Every painted point of the row must belong to one of its two buttons:
  // the left gutter and the column left of the "?" to the open button, the
  // strips above/below the "?" to the "?" itself. A null hit (point outside
  // the viewport, unpainted row) is a failure, not a pass.
  const owners = await row.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const explainEl = el.querySelector(
      '[data-testid="composer-task-explain"]',
    ) as HTMLElement;
    const er = explainEl.getBoundingClientRect();
    const sample = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      if (!(hit instanceof Element)) return 'none';
      if (hit.closest('[data-testid="composer-task-open"]')) return 'open';
      if (hit.closest('[data-testid="composer-task-explain"]'))
        return 'explain';
      return 'row';
    };
    return {
      gutter: sample(rect.left + 4, rect.top + rect.height / 2),
      gapColumn: sample(er.left - 2, rect.top + rect.height / 2),
      aboveExplain: sample(er.left + er.width / 2, rect.top + 1),
      belowExplain: sample(er.left + er.width / 2, rect.bottom - 1),
    };
  });
  expect(owners).toEqual({
    gutter: 'open',
    gapColumn: 'open',
    aboveExplain: 'explain',
    belowExplain: 'explain',
  });

  // Keyboard focus on the row "?" draws the same ring as the chip itself.
  // Reopen via keyboard so every focus step below has keyboard origin.
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  const explain = list.getByTestId('composer-task-explain').first();
  await expect(explain).toBeFocused();
  const explainRing = await page.evaluate(
    () => getComputedStyle(document.activeElement as HTMLElement).boxShadow,
  );
  expect(explainRing).not.toBe('none');
  // Escape returns focus to the chip (keyboard origin): its ring is the control.
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
  const chipRing = await page.evaluate(() => {
    const el = document.querySelector('[data-kind="workflow"]') as HTMLElement;
    return getComputedStyle(el).boxShadow;
  });
  expect(explainRing).toBe(chipRing);
});

test('the shell detail panel offers "?" and mirrors the explanation in place', async ({
  page,
}, testInfo) => {
  const shellTask: DaemonSessionShellTaskStatus = {
    kind: 'shell',
    id: 'shell-panel',
    label: 'npm run dev',
    description: 'npm run dev',
    status: 'running',
    startTime: Date.now() - 20_000,
    runtimeMs: 20_000,
    command: 'npm run dev',
    cwd: '/workspace',
  };
  const events: DaemonEvent[] = [
    userTextEvent('Run the dev server in the background.', { id: 1 }),
    toolCallEvent(
      'shell-call',
      'run_shell_command',
      { command: 'npm run dev', is_background: true },
      { id: 2 },
    ),
    turnCompleteEvent('shell-panel', { id: 3 }),
  ];
  const scenario = createWebShellDaemonScenario({
    workflowTasks: [shellTask],
    events,
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?theme=dark`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: events.length,
    }),
  );

  // The single-task shell chip opens its detail panel.
  await page
    .getByTestId('composer-task-chips')
    .getByRole('button', { name: '1 shell' })
    .click();
  const panelExplain = page.getByTestId('artifact-panel-explain');
  await expect(panelExplain).toBeVisible();
  await panelExplain.click();

  // The answer mirrors in place inside the panel, with the display line
  // rather than the fact dump; the btw panel above the composer has it too.
  // A button-triggered explanation is not a typed /btw command: neither
  // copy may carry the slash-command prefix.
  const block = page.getByTestId('artifact-panel-explanation');
  await expect(block).toContainText('A side answer.');
  await expect(block).not.toContainText('Task facts:');
  await expect(block.locator('[class*="question"]')).toHaveText(
    /^Explain what this task is doing: npm run dev/,
  );
  const composerPanel = page.locator('[class*="btwPanel"]');
  await expect(composerPanel).toContainText('A side answer.');
  await expect(composerPanel.locator('[class*="question"]')).toHaveText(
    /^Explain what this task is doing: npm run dev/,
  );
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
  const firstOpen = list
    .getByTestId('composer-task-open')
    .filter({ hasText: 'Review and fix' });
  const secondOpen = list
    .getByTestId('composer-task-open')
    .filter({ hasText: 'Update the docs' });
  const explains = list.getByTestId('composer-task-explain');
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(firstOpen).toBeFocused();
  // Each row offers two actions: open the task, then ask "?" about it.
  await page.keyboard.press('Tab');
  await expect(explains.first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(secondOpen).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(explains.last()).toBeFocused();
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
  const firstOpen = list
    .getByTestId('composer-task-open')
    .filter({ hasText: 'Review and fix' });
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(firstOpen).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(
    page.locator('[data-workflow-dispatch="correctness"]'),
  ).toBeVisible();
  await expect(chip).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(firstOpen).toBeFocused();
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
  const first = list
    .getByTestId('composer-task-open')
    .filter({ hasText: 'Review and fix' });
  const second = list
    .getByTestId('composer-task-open')
    .filter({ hasText: 'Update the docs' });
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(first).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(chip).toBeFocused();

  await page.keyboard.press('Space');
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(list.getByTestId('composer-task-explain').first()).toBeFocused();
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
