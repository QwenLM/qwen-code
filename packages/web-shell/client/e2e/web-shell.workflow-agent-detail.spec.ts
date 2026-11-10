import type { DaemonSessionWorkflowTaskStatus } from '@qwen-code/sdk/daemon';
import { test, expect } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  userTextEvent,
  toolCallEvent,
  assistantTextEvent,
  turnCompleteEvent,
  replayCompleteEvent,
} from './utils/mockDaemon';
test.use({ viewport: { width: 1600, height: 1000 } });
for (const surface of ['inline', 'workflows', 'history'] as const) {
  test(`workflow dispatch opens actual Agent detail from ${surface}`, async ({
    page,
  }, testInfo) => {
    const now = Date.now();
    const task: DaemonSessionWorkflowTaskStatus = {
      kind: 'workflow',
      id: 'workflow-poem',
      toolUseId: 'workflow-call',
      label: 'Write a poem',
      description: 'Write three poems about autumn',
      status: 'running',
      startTime: now - 26000,
      runtimeMs: 26000,
      isBackgrounded: true,
      currentPhase: 'Composition',
      phaseVisits: [
        {
          id: 'compose',
          index: 0,
          title: 'Composition',
          startedAt: now - 26000,
        },
      ],
      dispatches: (
        [
          ['lvshi', 'running', 'agent-lvshi'],
          ['modern', 'completed', 'agent-modern'],
          ['ci', 'queued', undefined],
        ] as const
      ).map(([id, status, subagentId]) => ({
        id,
        phaseVisitId: 'compose',
        label: `poet: ${id}`,
        prompt: `Write an autumn poem in ${id} form.`,
        status,
        subagentId,
        dependsOn: [],
        queuedAt: now - 11000,
        startedAt: status === 'queued' ? undefined : now - 11000,
      })),
      agentsDispatched: 3,
      agentsCompleted: 1,
      tokensSpent: 680,
      tokenBudgetTotal: null,
      recentLogs: [],
      pendingApprovalCount: 0,
      pendingApprovals: [],
    };
    const historicalParent = 'original-chat-a';
    if (surface === 'history') {
      task.parentSessionId = historicalParent;
      task.isHistorical = true;
      task.status = 'completed';
      task.endTime = now;
      task.agentsCompleted = 2;
      task.dispatches = task.dispatches.map((dispatch) => ({
        ...dispatch,
        status: dispatch.subagentId ? 'completed' : 'cancelled',
        endedAt: now,
      }));
    }
    const scenario = createWebShellDaemonScenario({
      supportedCommands: { workflowsEnabled: true, savedWorkflows: [] },
      workflowTasks: [task],
      events: [
        userTextEvent('Write three poems about autumn.', { id: 1 }),
        toolCallEvent(
          'workflow-call',
          'workflow',
          { name: 'Write a poem' },
          { id: 2, rawOutput: { runId: task.id } },
        ),
        turnCompleteEvent('poem', { id: 3 }),
      ],
    });
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      const children = new Map<
        string,
        ReadableStreamDefaultController<Uint8Array>
      >();
      Object.assign(window, {
        workflowHasChild(sessionId: string) {
          return children.has(sessionId);
        },
        workflowSendChild(sessionId: string, event: unknown) {
          const controller = children.get(sessionId);
          if (!controller)
            throw new Error(`Missing child SSE connection: ${sessionId}`);
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        },
      });
      window.fetch = (input, init) => {
        const request = new Request(input, init);
        const match = new URL(request.url).pathname.match(
          /^\/session\/(child-[^/]+)\/events$/,
        );
        if (!match) return originalFetch(input, init);
        const sessionId = match[1];
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            children.set(sessionId, controller);
          },
          cancel() {
            children.delete(sessionId);
          },
        });
        return Promise.resolve(
          new Response(stream, {
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
      };
    });
    const expectedParent =
      surface === 'history' ? historicalParent : scenario.sessionId;
    const refs: string[] = [];
    const childLoadBodies: unknown[] = [];
    await page.route('**/session/**/subagents/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      refs.push(path);
      if (!path.startsWith(`/session/${expectedParent}/subagents/`)) {
        await route.fulfill({
          status: 404,
          json: {
            error: 'subagent_not_found',
            message: 'Child does not belong to this parent',
          },
        });
        return;
      }
      const id = path.split('/').pop();
      await route.fulfill({
        json: {
          sessionId: `child-${id}`,
          status:
            surface === 'history' || id === 'agent-modern'
              ? 'completed'
              : 'running',
        },
      });
    });
    await page.route('**/session/child-*/load', async (route) => {
      childLoadBodies.push(route.request().postDataJSON());
      const id = new URL(route.request().url()).pathname.split('/')[2];
      await route.fulfill({
        json: {
          sessionId: id,
          workspaceCwd: scenario.workspaceCwd,
          attached: true,
          clientId: `detail-${id}`,
          hasActivePrompt: false,
          createdAt: new Date().toISOString(),
          state: scenario.state,
          compactedReplay: [
            userTextEvent(`Write an autumn poem: ${id}`, {
              id: 1,
              sessionId: id,
            }),
            toolCallEvent(
              'read-poetry',
              'read_file',
              { file_path: 'poetry-notes.md' },
              {
                id: 2,
                rawOutput: {
                  output: 'Autumn imagery: moonlight and falling leaves.',
                },
              },
            ),
            assistantTextEvent(
              `I am checking the meter and autumn imagery for ${id}.`,
              { id: 3, sessionId: id },
            ),
          ],
          liveJournal: [],
          lastEventId: 3,
        },
      });
    });
    await page.goto(`/session/${scenario.sessionId}?theme=dark`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId: scenario.sessionId, replayedCount: 3 }),
    );
    const node = page.locator('[data-workflow-dispatch="lvshi"]');
    if (surface !== 'inline') {
      await page
        .getByRole('button', { name: 'Workflows', exact: true })
        .first()
        .click();
      await page
        .getByRole('tab', {
          name: surface === 'history' ? /History/ : /Running/,
        })
        .click();
      await page
        .getByRole('tabpanel')
        .getByRole('button', { expanded: false })
        .first()
        .click();
    }
    if (surface === 'inline' && (await node.count()) === 0)
      await page
        .getByRole('button', { name: 'Workflow', exact: true })
        .first()
        .click();
    await expect(node).toBeVisible();
    await node.focus();
    await expect(
      page.getByRole('tab', { name: 'Agent: poet: lvshi', exact: true }),
    ).toHaveCount(0);
    await node.click();
    await expect
      .poll(() => refs[0])
      .toBe(`/session/${expectedParent}/subagents/agent-lvshi`);
    await expect(
      page.getByText(
        'I am checking the meter and autumn imagery for child-agent-lvshi.',
      ),
    ).toBeVisible();
    const panel = page.getByRole('complementary', {
      name: 'Right panel',
      exact: true,
    });
    await expect(
      panel
        .locator('[class*="descriptionRow"]')
        .getByText('poet: lvshi', { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole('tab', { name: 'Agent: poet: lvshi', exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Stop', exact: true }),
    ).toHaveCount(0);
    expect(childLoadBodies[0]).toMatchObject({ cwd: scenario.workspaceCwd });
    if (surface !== 'history') {
      const streamedText =
        'The next line now has the correct seven-syllable meter.';
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as unknown as { workflowHasChild: (id: string) => boolean }
            ).workflowHasChild('child-agent-lvshi'),
          ),
        )
        .toBe(true);
      await page.evaluate(
        ({ sessionId, event }) => {
          (
            window as unknown as {
              workflowSendChild: (id: string, event: unknown) => void;
            }
          ).workflowSendChild(sessionId, event);
        },
        {
          sessionId: 'child-agent-lvshi',
          event: assistantTextEvent(` ${streamedText}`, {
            id: 4,
            sessionId: 'child-agent-lvshi',
          }),
        },
      );
      await expect(
        panel.getByText(streamedText, { exact: false }),
      ).toBeVisible();
      await expect(page.getByText(streamedText, { exact: false })).toHaveCount(
        1,
      );
    }
    await page.screenshot({
      path: testInfo.outputPath(`workflow-agent-${surface}.png`),
      animations: 'disabled',
    });
    await node.click();
    await expect(
      page.getByRole('tab', { name: 'Agent: poet: lvshi', exact: true }),
    ).toHaveCount(1);
    await page.locator('[data-workflow-dispatch="modern"]').focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText(
        'I am checking the meter and autumn imagery for child-agent-modern.',
      ),
    ).toBeVisible();
    const count = refs.length;
    await page.locator('[data-workflow-dispatch="ci"]').click();
    expect(refs.length).toBe(count);
  });
}
