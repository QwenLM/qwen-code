import { expect, test, type Page } from '@playwright/test';
import type { components } from '../components/managed/generated/managed-agent-api';

type Schemas = components['schemas'];

// Public wire: Session, Turn and Event timestamps are epoch seconds.
const EPOCH_SECONDS = 1790777114;

async function installRecovery(page: Page, running = false) {
  const errors: string[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const workspace: Schemas['PublicWorkspace'] = {
    id: 'ws-a',
    object: 'agent.workspace',
    display_name: 'Recovery project',
    can_create_session: true,
    state: 'active',
    default_cwd_relative: '.',
  };
  const defaultWorkspace: Schemas['PublicWorkspace'] = {
    ...workspace,
    id: 'ws-default',
    display_name: 'Other default',
  };
  const summary: Schemas['PublicSession'] = {
    id: 'source',
    object: 'agent.session',
    title: 'Recover original task',
    agent_id: 'agent-b',
    agent_revision: '1',
    status: 'active',
    created_at: EPOCH_SECONDS,
    updated_at: EPOCH_SECONDS + 6,
    last_event_id: 6,
    latest_turn: {
      id: 't2',
      object: 'agent.turn',
      session_id: 'source',
      status: 'failed',
      created_at: EPOCH_SECONDS + 4,
      completed_at: EPOCH_SECONDS + 6,
    },
    workspace: {
      workspace_id: 'ws-a',
      cwd_relative: 'project',
      context_revision: 1,
      state: 'ready',
    },
    capabilities: {
      items: false,
      snapshots: false,
      resync: false,
      actions: false,
      artifacts: false,
      tasks: false,
      workspace_turns: true,
    },
    // SessionRecovery is a shared camelCase body on both wires.
    recovery: {
      state: 'awaiting_evidence',
      reasonCode: 'input_unsettled',
      turnId: 't2',
      nextTurnAllowed: false,
      actions: { recheck: true, cancel: false, continueInNewSession: true },
    },
  };
  if (running) {
    summary.latest_turn!.status = 'running';
    summary.latest_turn!.completed_at = null;
    summary.recovery = undefined;
  }
  const operation: Schemas['PublicCommandOperation'] = {
    id: 'cancel-original',
    session_id: 'source',
    type: 'cancel',
    status: 'running',
    admission_stage: 'java_durable',
    delivery_state: 'leased',
    replayed: false,
  };
  const operationReads: Record<string, unknown>[] = [];
  const events: Schemas['PublicEvent'][] = [
    {
      sequence: 1,
      turn_id: 't1',
      type: 'turn.accepted',
      data: { input: [{ type: 'text', text: 'Inspect repository' }] },
    },
    {
      sequence: 2,
      turn_id: 't1',
      type: 'item.output_text.delta',
      data: { text: 'Confirmed inspection complete' },
    },
    { sequence: 3, turn_id: 't1', type: 'turn.completed', data: {} },
    {
      sequence: 4,
      turn_id: 't2',
      type: 'turn.accepted',
      data: { input: [{ type: 'text', text: 'Apply the checked change' }] },
    },
    {
      sequence: 5,
      turn_id: 't2',
      type: 'item.output_text.delta',
      data: { text: 'PARTIAL PRIVATE ANSWER' },
    },
    { sequence: 6, turn_id: 't2', type: 'turn.failed', data: {} },
  ].map((event) => ({
    ...event,
    schema_version: 1,
    projection_version: 1,
    session_id: 'source',
    event_id: `event-${event.sequence}`,
    created_at: EPOCH_SECONDS + event.sequence,
    terminal: ['turn.completed', 'turn.failed', 'turn.cancelled'].includes(
      event.type,
    ),
  }));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/v1/agents/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON();
    if (path.endsWith('/user-messages'))
      return route.fulfill({ json: { paused: false, messages: [] } });
    if (/^\/v1\/agents\/workspaces\/[^/]+\/extensions$/.test(path))
      return route.fulfill({ json: { supported: false, extensions: [] } });
    if (/^\/v1\/agents\/workspaces\/[^/]+\/worktrees\/options$/.test(path))
      return route.fulfill({
        json: { supported: true, current_branch: 'main', branches: ['main'] },
      });
    if (path === '/v1/agents/runtime-nodes')
      return route.fulfill({ json: { supported: false, data: [] } });
    if (path === '/v1/agents/sessions' && method === 'GET')
      return route.fulfill({
        json: {
          object: 'list',
          data: [summary],
          has_more: false,
          next_cursor: null,
        },
      });
    if (path === '/v1/agents/sessions/source' && method === 'GET')
      return route.fulfill({ json: summary });
    if (path === '/v1/agents/workspaces' && method === 'GET')
      return route.fulfill({
        json: {
          object: 'list',
          data: [workspace, defaultWorkspace],
          has_more: false,
          next_cursor: null,
          default_workspace: defaultWorkspace,
          capabilities: { workspace_context: false, workspace_binding: true },
        },
      });
    if (path === '/v1/agents/workspaces/ws-default')
      return route.fulfill({ json: defaultWorkspace });
    if (path === '/v1/agents/workspaces/ws-a')
      return route.fulfill({ json: workspace });
    if (path === '/v1/agents/sessions/source/transcript')
      return route.fulfill({
        json: {
          items: [],
          events,
          covered_sequence: 6,
          older_cursor: null,
          last_sequence: 6,
          has_more: false,
        },
      });
    if (
      path === '/v1/agents/sessions/source/events' &&
      url.searchParams.get('stream') === 'true'
    )
      return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/v1/agents/sessions/source/recovery')
      return route.fulfill({ json: summary.recovery });
    if (
      path === '/v1/agents/sessions/source/events' &&
      method === 'POST' &&
      body.type === 'agent.session.cancel'
    ) {
      writes.push({ path, body });
      summary.latest_turn!.status = 'cancelling';
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
          session_id: 'source',
          turn_id: 't2',
          operation_id: operation.id,
          admission_stage: 'java_durable',
          delivery_state: 'pending',
          status: 'accepted',
          replayed: false,
        },
      });
    }
    const operationRoute =
      /^\/v1\/agents\/sessions\/([^/]+)\/operations\/([^/]+)$/.exec(path);
    if (operationRoute) {
      expect(method).toBe('GET');
      operationReads.push({
        sessionId: operationRoute[1],
        operationId: operationRoute[2],
      });
      return route.fulfill({ json: operation });
    }
    if (path === '/v1/agents/sessions/source/recovery/recheck') {
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
    if (
      (path === '/v1/agents/sessions' && method === 'POST') ||
      (path === '/v1/agents/sessions/source/events' && method === 'POST')
    ) {
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
  // The recheck body keeps the camelCase turnId; the Session rides the path.
  expect(scenario.writes[0].path).toBe(
    '/v1/agents/sessions/source/recovery/recheck',
  );
  expect(scenario.writes[0].body).toEqual({ turnId: 't2' });
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
  scenario.summary.latest_turn!.status = 'cancelled';
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
  await expect(
    page.getByText('Confirmed inspection complete', { exact: true }),
  ).toBeVisible();
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
  expect(scenario.writes[0].path).toBe('/v1/agents/sessions');
  expect(scenario.writes[0].body).toMatchObject({
    agent_id: 'agent-b',
    workspace: { workspace_id: 'ws-a', cwd_relative: 'project' },
    input: [
      {
        type: 'input_text',
        text: 'Reviewed handoff; inspect effects before continuing',
      },
    ],
  });
  expect(scenario.errors).toEqual([]);
});
