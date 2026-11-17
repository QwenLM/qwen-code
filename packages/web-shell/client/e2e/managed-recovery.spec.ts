import { expect, test, type Page } from '@playwright/test';
import type {
  JavaAgentEvent,
  JavaAgentSession,
} from '../components/managed/java-managed-agent-client';

async function installRecovery(
  page: Page,
  running = false,
  options: {
    state?: 'ready' | 'operator_required';
    language?: 'en' | 'zh-CN';
    theme?: 'light' | 'dark';
  } = {},
) {
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
  if (options.state) {
    summary.recovery = {
      state: options.state,
      reasonCode:
        options.state === 'ready' ? 'ready' : 'recovery_evidence_unavailable',
      turnId: 't2',
      nextTurnAllowed: options.state === 'ready',
      actions: { recheck: false, cancel: false, continueInNewSession: false },
    };
    if (options.state === 'ready') summary.activeTurn!.status = 'completed';
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
    terminal: ['turn.completed', 'turn.failed', 'turn.cancelled'].includes(
      event.type,
    ),
  }));
  if (options.state) events.splice(3);
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
        json: {
          items: [],
          events,
          coveredSequence: 6,
          lastSequence: 6,
          hasMore: false,
        },
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
  const params = new URLSearchParams({
    language: options.language ?? 'en',
    theme: options.theme ?? 'dark',
  });
  await page.goto(`/e2e/fixtures/managed-usability.html?${params}`);
  await page.getByRole('button', { name: /^Recover original task\b/ }).click();
  await expect(
    page.getByText('Confirmed inspection complete', { exact: true }),
  ).toBeVisible();
  return { errors, writes, summary, operation, operationReads };
}

test('recovery evidence controls sending even after Java failure @smoke', async ({
  page,
}) => {
  const scenario = await installRecovery(page);
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).toBeDisabled();
  await expect(
    page.getByRole('region', { name: 'Session recovery' }),
  ).toHaveCount(0);
  scenario.summary.recovery = {
    state: 'ready',
    reasonCode: 'ready',
    turnId: 't2',
    nextTurnAllowed: true,
    actions: { recheck: false, cancel: false, continueInNewSession: false },
  };
  await page
    .locator('[data-web-shell-composer-editor] .cm-content')
    .fill('Verify effects before continuing');
  await expect(send).toBeEnabled();
  expect(scenario.writes).toEqual([]);
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

async function expectNoExtraErrors(page: Page) {
  await expect(
    page.getByRole('region', { name: /Session recovery|会话恢复/ }),
  ).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: /^(Retry the same request|Discard this request|重试同一请求|丢弃本次请求)$/,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({
      hasText: /The previous message was not confirmed|上一条消息未确认/,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: /^(Check again|重新检查|Continue in a new Session)$/,
    }),
  ).toHaveCount(0);
}

async function retryInMessage(
  page: Page,
  scenario: Awaited<ReturnType<typeof installRecovery>>,
  keyboard = false,
) {
  const previous = scenario.writes.length;
  const original = scenario.writes[0].body;
  expect(original.idempotencyKey).toEqual(expect.any(String));
  expect(String(original.idempotencyKey).length).toBeGreaterThan(0);
  const retry = page
    .locator('[data-web-shell-message-list]')
    .getByRole('button', { name: /Ctrl\+Y/ });
  await expect(retry).toHaveCount(1);
  await expect(retry).toBeInViewport();
  if (keyboard) await page.keyboard.press('Control+y');
  else await retry.click();
  await expect.poll(() => scenario.writes.length).toBe(previous + 1);
  expect(scenario.writes[previous].path).toMatch(/\/turns\/submit$/);
  expect(scenario.writes[previous].body).toMatchObject({
    sessionId: original.sessionId,
    input: original.input,
    idempotencyKey: original.idempotencyKey,
  });
  await expect(
    page.locator('[data-web-shell-message-list] pre').filter({
      hasText: 'No real execution in browser fixture',
    }),
  ).toBeInViewport();
  await expectNoExtraErrors(page);
  await test.info().attach(`requests-after-retry-${previous}`, {
    body: JSON.stringify(scenario.writes, null, 2),
    contentType: 'application/json',
  });
}

async function capture(page: Page, name: string) {
  const output = process.env['MANAGED_RECOVERY_SCREENSHOTS'];
  if (output)
    await page.screenshot({
      path: `${output}/${name}.png`,
      animations: 'disabled',
    });
}

for (const theme of ['light', 'dark'] as const) {
  for (const state of [
    'request-error',
    'operator_required',
    'ready',
  ] as const) {
    test(`${state} uses the shared message stream zh-CN ${theme}`, async ({
      page,
    }) => {
      const scenario = await installRecovery(page, false, {
        state: state === 'operator_required' ? state : 'ready',
        language: 'zh-CN',
        theme,
      });
      const root = page.locator('[data-web-shell-root]');
      await expect(root).toHaveAttribute('lang', 'zh-CN');
      if (theme === 'dark') await expect(root).toHaveClass(/\bdark\b/);
      else await expect(root).not.toHaveClass(/\bdark\b/);
      const stream = page.locator('[data-web-shell-message-list]');
      const send = page.getByRole('button', { name: '发送消息', exact: true });
      if (state === 'operator_required') {
        const error = stream
          .locator('pre')
          .filter({ hasText: '请运维核对原执行、Workspace 身份和恢复凭证' });
        await expect(error).toBeVisible();
        await expect(error).toHaveCount(1);
        await expect(error.locator('../..')).toHaveClass(/error/);
        await expect(send).toBeDisabled();
      } else {
        await page
          .locator('[data-web-shell-composer-editor] .cm-content')
          .fill('继续检查');
        await expect(send).toBeEnabled();
        if (state === 'request-error') {
          await send.click();
          await expect.poll(() => scenario.writes.length).toBe(1);
          expect(scenario.writes[0].path).toMatch(/\/turns\/submit$/);
          const error = stream
            .locator('pre')
            .filter({ hasText: 'No real execution in browser fixture' });
          await expect(error).toBeVisible();
          await expect(error).toHaveCount(1);
          await expect(error.locator('../..')).toHaveClass(/error/);
          await expect(
            page.getByText('No real execution in browser fixture', {
              exact: false,
            }),
          ).toHaveCount(1);
          await retryInMessage(page, scenario, theme === 'light');
        } else {
          await expect(stream.locator('pre')).toHaveCount(0);
          expect(scenario.writes).toEqual([]);
        }
      }
      await expectNoExtraErrors(page);
      expect(scenario.errors).toEqual([]);
      await capture(page, `${state}-zh-${theme}`);
    });
  }
}

test('request failure stays in the message stream on a narrow English screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scenario = await installRecovery(page, false, {
    state: 'ready',
    language: 'en',
    theme: 'light',
  });
  await expect(page.locator('[data-web-shell-root]')).toHaveAttribute(
    'lang',
    'en',
  );
  await page
    .locator('[data-web-shell-composer-editor] .cm-content')
    .fill('Continue inspection');
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  const error = page
    .locator('[data-web-shell-message-list] pre')
    .filter({ hasText: 'No real execution in browser fixture' });
  await expect(error).toBeVisible();
  await expect(error).toHaveCount(1);
  await expect(error.locator('../..')).toHaveClass(/error/);
  await expectNoExtraErrors(page);
  expect(scenario.writes).toHaveLength(1);
  expect(scenario.errors).toEqual([]);
  await expect(error).toBeInViewport();
  await retryInMessage(page, scenario);
  await capture(page, 'request-error-en-light-narrow');
  await page.reload();
  await page.getByRole('button', { name: /^Recover original task\b/ }).click();
  const uncertain = page.locator('[data-web-shell-message-list] pre').filter({
    hasText: 'The previous message was not confirmed',
  });
  await expect(uncertain).toBeInViewport();
  await expectNoExtraErrors(page);
  await capture(page, 'request-error-en-light-narrow-reloaded');
  await retryInMessage(page, scenario);
  expect(scenario.errors).toEqual([]);
});
