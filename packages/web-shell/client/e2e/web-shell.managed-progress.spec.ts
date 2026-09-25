import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type {
  JavaAgentEvent,
  JavaAgentSession,
} from '../components/managed/java-managed-agent-client';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

const SESSION_ID = 'managed-progress-session';
const LONG_ANSWER = Array.from(
  { length: 70 },
  (_, index) => `Paragraph ${index}: a previous workspace inspection.`,
).join('\n\n');

async function installManagedScenario(page: Page, testInfo: TestInfo) {
  const baseURL = String(testInfo.project.use.baseURL);
  const scenario = createWebShellDaemonScenario({ sessions: [] });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const events: JavaAgentEvent[] = [];
  const prompts: Array<{ prompt: unknown; key?: string }> = [];
  const cancellations: unknown[] = [];
  const errors: string[] = [];
  const streamCursors: number[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let summary: JavaAgentSession = {
    sessionId: SESSION_ID,
    title: 'Managed progress regression',
    status: 'active',
    createdAt: Date.now() - 10_000,
    updatedAt: Date.now(),
    activeTurn: {
      turnId: 'p1',
      sessionId: SESSION_ID,
      status: 'completed',
      submittedAt: Date.now() - 10_000,
    },
    environment: { state: 'ready' },
    lastSequence: 0,
  };
  function append(type: string, data?: Record<string, unknown>) {
    const sequence = events.length + 1;
    events.push({
      sequence,
      eventId: `event-${sequence}`,
      createdAt: Date.now(),
      sessionId: SESSION_ID,
      turnId: summary.activeTurn!.turnId,
      type,
      data,
      terminal: ['turn.completed', 'turn.cancelled'].includes(type),
    });
    summary.lastSequence = sequence;
  }
  append('turn.accepted', {
    input: [{ type: 'text', text: 'Previous inspection' }],
  });
  append('item.output_text.delta', { text: LONG_ANSWER });
  append('turn.completed');

  await page.route('**/api/agent/web-shell/v1/**', async (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.headers()['x-qwen-tenant-id']).toBe('local-java-demo');
    const path = new URL(request.url()).pathname.replace(
      '/api/agent/web-shell/v1',
      '',
    );
    const body = request.postDataJSON();
    const respond = (json: unknown, status = 200) =>
      route.fulfill({ status, json });
    if (path === '/sessions/query')
      return respond({ data: [summary], hasMore: false });
    if (path === '/sessions/get') return respond(summary);
    if (path === '/transcript/query')
      return respond({
        events,
        lastSequence: summary.lastSequence,
        hasMore: false,
      });
    if (path === '/events/stream') {
      streamCursors.push(body.afterSequence ?? 0);
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: events
          .filter((event) => event.sequence > (body.afterSequence ?? 0))
          .map(
            (event) =>
              `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(''),
      });
    }
    if (path === '/turns/submit') {
      prompts.push({ prompt: body.input, key: body.idempotencyKey });
      summary = {
        ...summary,
        updatedAt: Date.now(),
        activeTurn: {
          sessionId: SESSION_ID,
          turnId: `p${prompts.length + 1}`,
          status: 'running',
          submittedAt: Date.now(),
        },
      };
      append('turn.accepted', { input: body.input });
      append('turn.started');
      return respond(
        {
          sessionId: SESSION_ID,
          turnId: summary.activeTurn!.turnId,
          status: 'accepted',
          replayed: false,
        },
        202,
      );
    }
    if (path === '/turns/cancel') {
      cancellations.push({ turnId: body.turnId });
      summary.activeTurn!.status = 'cancelling';
      append('turn.cancel.requested');
      return respond(
        {
          sessionId: SESSION_ID,
          turnId: body.turnId,
          status: 'accepted',
          replayed: false,
        },
        202,
      );
    }
    return respond({ error: `Unexpected Managed request: ${path}` }, 500);
  });

  async function emit(type: string, data?: Record<string, unknown>) {
    if (type === 'turn.completed' || type === 'turn.cancelled') {
      summary.activeTurn!.status = type.slice('turn.'.length);
    }
    append(type, data);
  }
  async function waitForCurrentStream() {
    await expect
      .poll(() => streamCursors.includes(summary.lastSequence))
      .toBe(true);
  }
  await page.goto(
    `/?managed=1&managedProvider=java&managedSession=${SESSION_ID}`,
  );
  await expect(
    page.getByRole('textbox', { name: 'Message the managed agent' }),
  ).toBeEnabled();
  await waitForCurrentStream();
  return { daemon, prompts, cancellations, errors, emit, waitForCurrentStream };
}

async function expectScrollableTranscript(page: Page) {
  const list = page
    .getByRole('region', { name: 'Managed conversation' })
    .locator('[data-web-shell-message-list]');
  await expect
    .poll(() =>
      list.evaluate((element) => {
        const parent = element.parentElement!;
        return {
          bounded: element.clientHeight <= parent.clientHeight + 1,
          contained: parent.scrollHeight <= parent.clientHeight + 1,
          overflowing: element.scrollHeight > element.clientHeight + 100,
          atBottom:
            element.scrollTop > 0 &&
            element.scrollHeight - element.clientHeight - element.scrollTop < 5,
        };
      }),
    )
    .toEqual({
      bounded: true,
      contained: true,
      overflowing: true,
      atBottom: true,
    });
}

test('Managed progress stays visible through a long transcript and live thought/tool events @smoke', async ({
  page,
}, testInfo) => {
  const fixture = await installManagedScenario(page, testInfo);
  await expectScrollableTranscript(page);
  const composer = page.getByRole('textbox', {
    name: 'Message the managed agent',
  });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await composer.fill('Inspect marker.txt');
  await send.click();
  await fixture.waitForCurrentStream();
  await expect(page.locator('[data-managed-progress]')).toContainText(
    'Thinking / responding',
  );
  await expect(page.locator('[data-managed-progress]')).toBeInViewport();
  await expect(composer).toBeDisabled();
  await expect(send).toBeDisabled();
  await expect(page.locator('[data-managed-progress]')).toContainText(
    /[1-9]\d*s elapsed/,
  );

  await fixture.emit('item.reasoning.delta', {
    text: 'Checking the requested file.',
  });
  const list = page
    .getByRole('region', { name: 'Managed conversation' })
    .locator('[data-web-shell-message-list]');
  await expect(
    list.getByRole('button', { name: /^Thinking\b/ }),
  ).toBeInViewport();
  await fixture.emit('item.tool_call.updated', {
    toolCallId: 'read-marker',
    status: 'in_progress',
    toolName: 'read_file',
    input: { file_path: 'marker.txt' },
  });
  await expect(list.getByText('marker.txt', { exact: true })).toBeInViewport();
  await fixture.emit('item.tool_call.updated', {
    toolCallId: 'read-marker',
    toolName: 'read_file',
    status: 'completed',
    failed: false,
    output: 'marker contents',
  });
  await fixture.emit('item.output_text.delta', { text: `${LONG_ANSWER}\n\n` });
  await fixture.emit('item.output_text.delta', {
    text: 'Latest answer marker',
  });
  await expect(
    list.getByText('Latest answer marker', { exact: true }),
  ).toBeInViewport();
  await expectScrollableTranscript(page);
  await fixture.emit('turn.completed');
  await expect(page.locator('[data-managed-progress]')).toHaveCount(0);
  await expect(composer).toBeEnabled();
  expect(fixture.prompts).toHaveLength(1);
  expect(fixture.prompts[0].key).toBeTruthy();
  expect(fixture.daemon.promptRequests()).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

test('Managed cancellation waits for settlement before continuing the same session @smoke', async ({
  page,
}, testInfo) => {
  const fixture = await installManagedScenario(page, testInfo);
  const composer = page.getByRole('textbox', {
    name: 'Message the managed agent',
  });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await composer.fill('Turn to cancel');
  await send.click();
  await fixture.waitForCurrentStream();
  await page.getByRole('button', { name: 'Cancel turn', exact: true }).click();
  await fixture.waitForCurrentStream();
  expect(fixture.cancellations).toEqual([{ turnId: 'p2' }]);
  await expect(page.locator('[data-managed-progress]')).toContainText(
    'Cancelling',
  );
  await expect(composer).toBeDisabled();
  await expect(send).toBeDisabled();
  await fixture.emit('turn.cancelled');
  await expect(page.locator('[data-managed-progress]')).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await composer.fill('Continue after cancellation');
  await send.click();
  await fixture.waitForCurrentStream();
  await fixture.emit('item.output_text.delta', {
    text: 'Continuation succeeded',
  });
  await fixture.emit('turn.completed');
  await expect(
    page.getByText('Continuation succeeded', { exact: true }),
  ).toBeInViewport();
  await expect(composer).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`managedSession=${SESSION_ID}`));
  expect(fixture.prompts.map((request) => request.prompt)).toEqual([
    [{ type: 'text', text: 'Turn to cancel' }],
    [{ type: 'text', text: 'Continue after cancellation' }],
  ]);
  expect(new Set(fixture.prompts.map((request) => request.key)).size).toBe(2);
  expect(fixture.daemon.promptRequests()).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});
