import { expect, test } from '@playwright/test';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

test('keeps two returned agent results in one user turn with the final answer visible', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  const transcriptRequests: string[] = [];
  const childSessionId = 'rendering-agent-session';
  const detailEvidence =
    'Rendering detail: MessageList keeps both completion cards.';
  await page.route('**/session/**/transcript?*', async (route) => {
    transcriptRequests.push(route.request().url());
    await route.fulfill({
      json: {
        v: 1,
        sessionId: scenario.sessionId,
        hasMore: false,
        events: [
          toolCallEvent(
            'call-agent-b',
            'agent',
            {
              description: 'Rendering investigation',
              prompt: 'Inspect MessageList',
              run_in_background: true,
            },
            { id: 1, rawOutput: { task_id: 'agent-b' } },
          ),
        ],
      },
    });
  });
  await page.route('**/session/**/subagents/call-agent-b', async (route) => {
    await route.fulfill({
      json: { sessionId: childSessionId, status: 'completed' },
    });
  });
  await page.route(`**/session/${childSessionId}/load`, async (route) => {
    await route.fulfill({
      json: {
        sessionId: childSessionId,
        workspaceCwd: scenario.workspaceCwd,
        attached: true,
        clientId: 'rendering-detail-client',
        hasActivePrompt: false,
        createdAt: new Date().toISOString(),
        state: scenario.state,
        compactedReplay: [
          userTextEvent('Inspect rendering evidence', {
            id: 1,
            sessionId: childSessionId,
          }),
          toolCallEvent(
            'read-rendering-evidence',
            'read_file',
            { file_path: 'rendering-evidence.txt' },
            {
              id: 2,
              rawOutput: { output: 'Completion cards retain return order.' },
            },
          ),
          assistantTextEvent(detailEvidence, {
            id: 3,
            sessionId: childSessionId,
          }),
          turnCompleteEvent('rendering-detail-turn', {
            id: 4,
            sessionId: childSessionId,
          }),
        ],
        liveJournal: [],
        lastEventId: 4,
      },
    });
  });
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  let sequence = 0;
  await daemon.sendEvent(
    userTextEvent('Investigate ownership and rendering', {
      id: ++sequence,
      sessionId: scenario.sessionId,
    }),
  );
  for (const [taskId, label] of [
    ['agent-a', 'Ownership investigation'],
    ['agent-b', 'Rendering investigation'],
  ]) {
    await daemon.sendEvent(
      toolCallEvent(
        `call-${taskId}`,
        'agent',
        {
          description: label,
          prompt: label,
          run_in_background: true,
        },
        { id: ++sequence, rawOutput: { task_id: taskId } },
      ),
    );
  }
  await daemon.sendEvent(
    assistantTextEvent('Both investigations are running.', {
      id: ++sequence,
      sessionId: scenario.sessionId,
    }),
  );
  await daemon.sendEvent(
    turnCompleteEvent('user-turn', {
      id: ++sequence,
      sessionId: scenario.sessionId,
    }),
  );
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: sequence,
    }),
  );

  const finalAnswer =
    'Ownership and rendering findings are complete. The final answer includes both results.';
  const intermediateAnswer =
    'Rendering is understood; ownership is still being investigated.';
  for (const [taskId, label, response] of [
    ['agent-b', 'Rendering investigation', intermediateAnswer],
    ['agent-a', 'Ownership investigation', finalAnswer],
  ]) {
    const backgroundTurn = {
      turnId: `automatic-${taskId}`,
      taskId,
      kind: 'agent',
      label,
      toolUseId: `call-${taskId}`,
      sourceTurnId: 'user-turn',
      startedAt: Date.now() - 42000,
    };
    const backgroundTask = {
      taskId,
      kind: 'agent',
      status: 'completed',
      toolUseId: `call-${taskId}`,
      sourceTurnId: 'user-turn',
    };
    const update = async (source: string, text: string) => {
      const event: DaemonEvent = {
        id: ++sequence,
        v: 1,
        type: 'session_update',
        promptId: backgroundTurn.turnId,
        data: {
          sessionId: scenario.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
            _meta: {
              source,
              qwenDiscreteMessage: true,
              backgroundTurn,
              backgroundTask,
            },
          },
        },
      };
      await daemon.sendEvent(event);
    };
    await update('background_task_completed', `${label} finished`);
    await update('background_notification_turn_started', label);
    await expect(
      page.getByText(`Processing ${label} results`, { exact: true }),
    ).toBeVisible();
    await update('background_notification', `${label} raw result`);
    await update('background_notification_response', response);
    await daemon.sendEvent(
      turnCompleteEvent(backgroundTurn.turnId, {
        id: ++sequence,
        sessionId: scenario.sessionId,
      }),
    );
  }

  await expect(page.locator('[data-web-shell-user-row]')).toHaveCount(1);
  const markers = page.locator('[data-background-turn-start]');
  await expect(markers).toHaveCount(2);
  await expect(markers.nth(0)).toContainText('Rendering investigation');
  await expect(markers.nth(1)).toContainText('Ownership investigation');
  for (const marker of [markers.nth(0), markers.nth(1)]) {
    await expect(
      marker.getByRole('img', {
        name: 'Background task completed',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      marker.getByRole('button', { name: 'Source', exact: true }),
    ).toBeVisible();
    await expect(
      marker.getByRole('button', { name: 'View details', exact: true }),
    ).toBeVisible();
  }
  const collapse = page.getByRole('button', {
    name: 'Collapse steps',
    exact: true,
  });
  if (await collapse.count()) await collapse.click();
  await expect(
    page.getByRole('button', { name: 'Expand steps', exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText(finalAnswer, { exact: true })).toBeVisible();
  await expect(page.getByText(intermediateAnswer, { exact: true })).toHaveCount(
    0,
  );
  await expect(markers).toHaveCount(2);
  await page.screenshot({
    path: testInfo.outputPath('two-agents-collapsed.png'),
    fullPage: true,
  });

  await markers
    .nth(0)
    .getByRole('button', { name: 'View details', exact: true })
    .click();
  const rightPanel = page.getByRole('tablist', {
    name: 'Right panel',
    exact: true,
  });
  await expect(rightPanel).toBeVisible();
  await expect(
    rightPanel.getByRole('tab', {
      name: 'Rendering investigation',
      exact: true,
    }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => transcriptRequests.length).toBe(1);
  const detailPanel = page.locator('aside[aria-label="Right panel"]');
  await expect(
    detailPanel.getByText(detailEvidence, { exact: true }),
  ).toBeVisible();
  await detailPanel
    .getByRole('button', { name: 'Expand steps', exact: true })
    .click();
  await expect(
    detailPanel.getByText('rendering-evidence.txt', { exact: false }),
  ).toBeVisible();
  await expect(
    detailPanel.getByText('Loading...', { exact: true }),
  ).toHaveCount(0);

  await expect(page.getByText(finalAnswer, { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('two-agents-details.png'),
    fullPage: true,
  });
  await markers
    .nth(0)
    .getByRole('button', { name: 'Source', exact: true })
    .click();
  await expect(
    page
      .locator('[data-web-shell-message-list]')
      .first()
      .getByRole('button', { name: 'Collapse steps', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(intermediateAnswer, { exact: true }),
  ).toBeVisible();
});

test('keeps the background task sidebar indicator visible on hover and prioritizes the prompt spinner', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  let hasActivePrompt = false;
  let hasRunningBackgroundTasks = true;
  const updateSession = () => {
    scenario.sessions[0] = {
      ...scenario.sessions[0],
      hasActivePrompt,
      hasRunningBackgroundTasks,
      activeWorkState: hasRunningBackgroundTasks ? 'active' : 'idle',
    };
  };
  updateSession();
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.route(
    /\/workspaces\/.*\/sessions\/live-state(?:\?.*)?$/,
    async (route) => {
      await route.fulfill({
        json: {
          v: 1,
          catalogVersion: scenario.sessionCatalogVersion,
          sessions: [
            {
              sessionId: scenario.sessionId,
              clientCount: 1,
              hasActivePrompt,
              hasRunningBackgroundTasks,
              activeWorkState: hasRunningBackgroundTasks ? 'active' : 'idle',
              isWaitingForPermission: false,
              isWaitingForUserQuestion: false,
            },
          ],
        },
      });
    },
  );
  await page.goto(`/session/${scenario.sessionId}`);
  const marker = page.locator('[data-web-shell-session-background-running]');
  await expect(marker).toBeVisible();
  await expect
    .poll(() =>
      marker.evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeGreaterThan(0);
  const row = marker.locator('xpath=ancestor::*[@role="button"][1]');
  const title = row.locator('[data-web-shell-session-title]');
  const dotBox = await marker.boundingBox();
  const titleBox = await title.boundingBox();
  expect(dotBox!.x + dotBox!.width).toBeLessThanOrEqual(titleBox!.x);
  await expect(marker).not.toHaveCSS('animation-name', 'none');
  await expect(
    page.getByText('Background tasks running', { exact: true }),
  ).toHaveCount(0);
  const actions = row.locator('[class*="sessionActions"]').first();
  await row.locator('[data-web-shell-session-title]').hover();
  await expect
    .poll(() =>
      marker.evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeGreaterThan(0);
  await expect(actions).toHaveCSS('opacity', '1');
  await marker.hover();
  await expect(marker).toBeVisible();
  await expect
    .poll(() =>
      marker.evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeGreaterThan(0);
  await expect(actions).toHaveCSS('opacity', '0');
  await expect(actions).toHaveCSS('pointer-events', 'none');
  await row.locator('[data-web-shell-session-title]').hover();
  await expect(actions).toHaveCSS('opacity', '1');
  await expect
    .poll(() =>
      marker.evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeGreaterThan(0);
  await page.screenshot({
    path: testInfo.outputPath('background-sidebar-hover.png'),
    fullPage: true,
  });

  hasActivePrompt = true;
  updateSession();
  await page.reload();
  await expect(marker).toHaveCount(0);
  const running = page.locator('[data-web-shell-session-running]');
  await expect(running).toBeVisible();
  const activeRow = running.locator('xpath=ancestor::*[@role="button"][1]');
  await expect(activeRow.locator('[aria-label="Running"]')).toBeVisible();

  hasActivePrompt = false;
  hasRunningBackgroundTasks = false;
  updateSession();
  await page.reload();
  await expect(
    page.getByText(scenario.displayName, { exact: true }).first(),
  ).toBeVisible();
  await expect(marker).toHaveCount(0);
  await expect(running).toHaveCount(0);
});
