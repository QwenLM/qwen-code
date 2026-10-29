import { expect, test, type Page } from '@playwright/test';
import type {
  JavaAgentEvent,
  JavaAgentSession,
} from '../components/managed/java-managed-agent-client';

async function installRecovery(page: Page, running = false) {
  const errors: string[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const workspace = {
    workspaceId: 'ws-a',
    displayName: 'Recovery project',
    canCreateSession: true,
    state: 'active',
    defaultCwdRelative: '.',
  };
  const summary: JavaAgentSession = {
    sessionId: 'source',
    title: 'Recover original task',
    agentId: 'agent-b',
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    lastSequence: 6,
    activeTurn: {
      sessionId: 'source',
      turnId: 't2',
      status: 'failed',
      submittedAt: 2,
    },
    workspace: {
      workspaceId: 'ws-a',
      cwdRelative: 'project',
      contextRevision: 1,
      state: 'ready',
    },
    capabilities: {
      actions: false,
      artifacts: false,
      tasks: false,
      workspaceTurns: true,
    },
    recovery: {
      state: 'awaiting_evidence',
      reasonCode: 'input_unsettled',
      turnId: 't2',
      nextTurnAllowed: false,
      actions: { recheck: true, cancel: false, continueInNewSession: true },
    },
  };
  if (running) {
    summary.activeTurn!.status = 'running';
    summary.recovery = undefined;
  }
  const operation = {
    operationId: 'cancel-original',
    sessionId: 'source',
    type: 'cancel',
    status: 'running',
    admissionStage: 'java_durable',
    deliveryState: 'leased',
    replayed: false,
  };
  const operationReads: Record<string, unknown>[] = [];
  const events: JavaAgentEvent[] = [
    {
      sequence: 1,
      turnId: 't1',
      type: 'turn.accepted',
      data: { input: [{ type: 'text', text: 'Inspect repository' }] },
    },
    {
      sequence: 2,
      turnId: 't1',
      type: 'item.output_text.delta',
      data: { text: 'Confirmed inspection complete' },
    },
    { sequence: 3, turnId: 't1', type: 'turn.completed', data: {} },
    {
      sequence: 4,
      turnId: 't2',
      type: 'turn.accepted',
      data: { input: [{ type: 'text', text: 'Apply the checked change' }] },
    },
    {
      sequence: 5,
      turnId: 't2',
      type: 'item.output_text.delta',
      data: { text: 'PARTIAL PRIVATE ANSWER' },
    },
    { sequence: 6, turnId: 't2', type: 'turn.failed', data: {} },
  ].map((event) => ({
    ...event,
    sessionId: 'source',
    eventId: `event-${event.sequence}`,
    createdAt: event.sequence,
  }));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/agent/web-shell/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    if (path.endsWith('/user-messages/query'))
      return route.fulfill({ json: { paused: false, messages: [] } });
    if (path.endsWith('/workspace-extensions/query'))
      return route.fulfill({ json: { supported: false, extensions: [] } });
    if (path.endsWith('/workspaces/worktrees/options'))
      return route.fulfill({
        json: { supported: true, currentBranch: 'main', branches: ['main'] },
      });
    if (path.endsWith('/runtime-nodes/query'))
      return route.fulfill({ json: { supported: false, data: [] } });
    if (path.endsWith('/sessions/query'))
      return route.fulfill({ json: { data: [summary], hasMore: false } });
    if (path.endsWith('/sessions/get')) return route.fulfill({ json: summary });
    if (path.endsWith('/workspaces/query'))
      return route.fulfill({
        json: {
          data: [
            workspace,
            {
              ...workspace,
              workspaceId: 'ws-default',
              displayName: 'Other default',
            },
          ],
          hasMore: false,
          defaultWorkspace: {
            ...workspace,
            workspaceId: 'ws-default',
            displayName: 'Other default',
          },
          capabilities: { workspaceBinding: true },
        },
      });
    if (path.endsWith('/workspaces/get'))
      return route.fulfill({
        json:
          body.workspaceId === 'ws-default'
            ? {
                ...workspace,
                workspaceId: 'ws-default',
                displayName: 'Other default',
              }
            : workspace,
      });
    if (path.endsWith('/transcript/query'))
      return route.fulfill({
        json: { items: [], events, lastSequence: 6, hasMore: false },
      });
    if (path.endsWith('/events/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path.endsWith('/session-recovery/query'))
      return route.fulfill({ json: summary.recovery });
    if (path.endsWith('/turns/cancel')) {
      writes.push({ path, body });
      summary.activeTurn!.status = 'cancelling';
      summary.recovery = {
        state: 'awaiting_evidence',
        reasonCode: 'input_unsettled',
        turnId: 't2',
        nextTurnAllowed: false,
        actions: { recheck: true, cancel: false, continueInNewSession: true },
      };
      return route.fulfill({
        status: 202,
        json: {
          sessionId: 'source',
          turnId: 't2',
          operationId: operation.operationId,
          status: 'accepted',
          replayed: false,
        },
      });
    }
    if (path.endsWith('/operations/query')) {
      operationReads.push(body);
      return route.fulfill({ json: operation });
    }
    if (path.endsWith('/session-recovery/recheck')) {
      writes.push({ path, body });
      summary.recovery = {
        state: 'ready',
        reasonCode: 'ready',
        turnId: 't2',
        nextTurnAllowed: true,
        actions: { recheck: false, cancel: false, continueInNewSession: false },
      };
      return route.fulfill({ status: 202, json: summary.recovery });
    }
    if (path.endsWith('/sessions/create') || path.endsWith('/turns/submit')) {
      writes.push({ path, body });
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'test_stop',
            message: 'No real execution in browser fixture',
          },
        },
      });
    }
    errors.push(`Unexpected request: ${path}`);
    return route.fulfill({
      status: 500,
      json: { error: 'Unexpected request' },
    });
  });
  await page.goto('/e2e/fixtures/managed-usability.html');
  await page.getByRole('button', { name: /^Recover original task\b/ }).click();
  if (!running)
    await expect(
      page.getByRole('region', { name: 'Session recovery' }),
    ).toBeVisible();
  return { errors, writes, summary, operation, operationReads };
}

test('recovery evidence controls sending even after Java failure @smoke', async ({
  page,
}) => {
  const scenario = await installRecovery(page);
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).toBeDisabled();
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Session recovery' }),
  ).toHaveCount(0);
  await page
    .locator('[data-web-shell-composer-editor] .cm-content')
    .fill('Verify effects before continuing');
  await expect(send).toBeEnabled();
  expect(scenario.writes).toHaveLength(1);
  expect(scenario.writes[0].body).toEqual({
    sessionId: 'source',
    turnId: 't2',
  });
  expect(scenario.errors).toEqual([]);
});

test('refresh tracks the original cancel operation until cancellation is confirmed @smoke', async ({
  page,
}) => {
  const scenario = await installRecovery(page, true);
  await page.getByRole('button', { name: 'Cancel turn', exact: true }).click();
  await expect.poll(() => scenario.operationReads.length).toBeGreaterThan(0);
  await expect(
    page.getByText('Stop requested; waiting for confirmation.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(scenario.writes).toHaveLength(1);
  const reads = scenario.operationReads.length;
  await page.reload();
  await page.getByRole('button', { name: /^Recover original task\b/ }).click();
  await expect
    .poll(() => scenario.operationReads.length)
    .toBeGreaterThan(reads);
  expect(scenario.writes).toHaveLength(1);
  expect(
    scenario.operationReads.every(
      (request) =>
        request.sessionId === 'source' &&
        request.operationId === 'cancel-original',
    ),
  ).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeDisabled();
  scenario.summary.activeTurn!.status = 'cancelled';
  scenario.summary.recovery = {
    state: 'ready',
    reasonCode: 'ready',
    turnId: 't2',
    nextTurnAllowed: true,
    actions: { recheck: false, cancel: false, continueInNewSession: false },
  };
  scenario.operation.status = 'completed';
  await expect(
    page.getByText('Stop requested; waiting for confirmation.', {
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .locator('[data-web-shell-composer-editor] .cm-content')
    .fill('Continue after confirmed cancellation');
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled();
  expect(scenario.writes).toHaveLength(1);
  expect(scenario.errors).toEqual([]);
});

test('new Session handoff is editable, preselected and never automatically sent @smoke', async ({
  page,
}) => {
  const scenario = await installRecovery(page);
  await page
    .getByRole('button', { name: 'Continue in a new Session', exact: true })
    .click();
  await expect(
    page.getByText('Review and edit this handoff', { exact: false }),
  ).toBeVisible();
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await expect(editor).toContainText('Confirmed inspection complete');
  await expect(editor).toContainText('Apply the checked change');
  await expect(editor).toContainText('input_unsettled');
  await expect(editor).not.toContainText('PARTIAL PRIVATE ANSWER');
  await expect(
    page.getByRole('button', { name: /Select Model: Model B/ }),
  ).toBeVisible();
  expect(scenario.writes).toEqual([]);
  await editor.fill('Reviewed handoff; inspect effects before continuing');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => scenario.writes.length).toBe(1);
  expect(scenario.writes[0].body).toMatchObject({
    agentId: 'agent-b',
    workspace: { workspaceId: 'ws-a', cwdRelative: 'project' },
    input: [
      {
        type: 'input_text',
        text: 'Reviewed handoff; inspect effects before continuing',
      },
    ],
  });
  expect(scenario.errors).toEqual([]);
});
