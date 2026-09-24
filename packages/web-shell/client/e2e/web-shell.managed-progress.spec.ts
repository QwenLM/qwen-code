import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type {
  DaemonManagedSessionEvent,
  DaemonManagedSessionSummary,
} from '@qwen-code/sdk/daemon';
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
  const scenario = createWebShellDaemonScenario({
    sessions: [],
    capabilities: {
      features: ['managed_sessions', 'managed_session_cancel'],
    },
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const events: DaemonManagedSessionEvent[] = [];
  const prompts: Array<{ prompt: unknown; key?: string }> = [];
  const cancellations: unknown[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let summary: DaemonManagedSessionSummary = {
    sessionId: SESSION_ID,
    promptId: 'p1',
    title: 'Managed progress regression',
    workspaceCwd: scenario.workspaceCwd,
    createdAt: Date.now() - 10_000,
    admittedAt: Date.now() - 10_000,
    updatedAt: Date.now(),
    phase: 'completed',
    runtimeState: 'ready',
    runtimeReady: true,
    capabilities: { canSend: true, canCancel: false },
  };
  function append(type: DaemonManagedSessionEvent['type'], data?: unknown) {
    const event: DaemonManagedSessionEvent = {
      id: events.length + 1,
      at: Date.now(),
      sessionId: SESSION_ID,
      promptId: summary.promptId,
      type,
      data,
    };
    events.push(event);
    return event;
  }
  append('accepted', {
    prompt: [{ type: 'text', text: 'Previous inspection' }],
  });
  append('assistant_delta', { text: LONG_ANSWER });
  append('completed');

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL).origin) return route.abort();
    if (!url.pathname.startsWith('/managed/')) return route.fallback();
    const request = route.request();
    const clientId = request.headers()['x-qwen-managed-client-id'];
    expect(clientId).toBeTruthy();
    const respond = (json: unknown, status = 200) =>
      route.fulfill({ status, json });
    const sessionPath = `/managed/sessions/${SESSION_ID}`;
    if (request.method() === 'GET') {
      if (url.pathname === '/managed/sessions')
        return respond({ sessions: [summary] });
      if (url.pathname === sessionPath) return respond(summary);
      if (url.pathname === `${sessionPath}/transcript`)
        return respond({ events, lastEventId: events.at(-1)!.id });
    }
    if (request.method() === 'POST') {
      if (url.pathname === `${sessionPath}/prompts`) {
        const body = request.postDataJSON() as { prompt: unknown };
        prompts.push({
          prompt: body.prompt,
          key: request.headers()['idempotency-key'],
        });
        summary = {
          ...summary,
          promptId: `p${prompts.length + 1}`,
          admittedAt: Date.now(),
          updatedAt: Date.now(),
          phase: 'agent_running',
          capabilities: { canSend: false, canCancel: true },
        };
        append('accepted', { prompt: body.prompt });
        append('agent_started', { round: 0 });
        return respond(
          {
            managed: true,
            sessionId: SESSION_ID,
            promptId: summary.promptId,
            created: true,
            state: 'processing',
            activationReady: true,
            eventStreamAvailable: true,
            phase: summary.phase,
          },
          202,
        );
      }
      if (url.pathname === `${sessionPath}/cancel`) {
        cancellations.push(request.postDataJSON());
        summary = {
          ...summary,
          phase: 'cancelling',
          capabilities: { canSend: false, canCancel: false },
        };
        append('cancelling');
        return respond({ accepted: true });
      }
    }
    return respond(
      { error: `Unexpected Managed request: ${url.pathname}` },
      500,
    );
  });

  async function emit(type: DaemonManagedSessionEvent['type'], data?: unknown) {
    if (type === 'completed' || type === 'cancelled') {
      // This fixture has a committed first turn, so cancellation permits continuation.
      summary = {
        ...summary,
        phase: type,
        capabilities: { canSend: true, canCancel: false },
      };
    }
    await daemon.sse.split(append(type, data));
    if (type === 'completed' || type === 'cancelled') await daemon.sse.close();
  }

  async function waitForCurrentStream() {
    await expect
      .poll(async () =>
        (await daemon.sse.connections()).some(
          (connection) =>
            connection.sessionId === SESSION_ID &&
            connection.headers['last-event-id'] === String(events.at(-1)!.id),
        ),
      )
      .toBe(true);
  }

  await page.goto(`/?managedSession=${SESSION_ID}`);
  await page.getByRole('button', { name: 'Managed Agents' }).click();
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

  await fixture.emit('assistant_thought', {
    text: 'Checking the requested file.',
  });
  const list = page
    .getByRole('region', { name: 'Managed conversation' })
    .locator('[data-web-shell-message-list]');
  await expect(
    list.getByRole('button', { name: /^Thinking\b/ }),
  ).toBeInViewport();
  await fixture.emit('tool_started', {
    toolCallId: 'read-marker',
    toolName: 'read_file',
    input: { file_path: 'marker.txt' },
  });
  await expect(list.getByText('marker.txt', { exact: true })).toBeInViewport();
  await fixture.emit('tool_completed', {
    toolCallId: 'read-marker',
    toolName: 'read_file',
    failed: false,
    output: 'marker contents',
  });
  await fixture.emit('assistant_delta', { text: `${LONG_ANSWER}\n\n` });
  await fixture.emit('assistant_delta', { text: 'Latest answer marker' });
  await expect(
    list.getByText('Latest answer marker', { exact: true }),
  ).toBeInViewport();
  await expectScrollableTranscript(page);
  await fixture.emit('completed');
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
  expect(fixture.cancellations).toEqual([{ promptId: 'p2' }]);
  await expect(page.locator('[data-managed-progress]')).toContainText(
    'Cancelling',
  );
  await expect(composer).toBeDisabled();
  await expect(send).toBeDisabled();
  await fixture.emit('cancelled');
  await expect(page.locator('[data-managed-progress]')).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await composer.fill('Continue after cancellation');
  await send.click();
  await fixture.waitForCurrentStream();
  await fixture.emit('assistant_delta', { text: 'Continuation succeeded' });
  await fixture.emit('completed');
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
