import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type {
  JavaAgentEvent,
  JavaAgentSession,
} from '../components/managed/java-managed-agent-client';
import type { components } from '../components/managed/generated/managed-agent-api';
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
  const detailRequests: Array<{ sessionId: string; itemId: string }> = [];
  const toolDetails = new Map<
    string,
    components['schemas']['WebShellToolDetails']
  >();
  page.on('pageerror', (error) => errors.push(error.message));
  let summary: JavaAgentSession = {
    sessionId: SESSION_ID,
    title: 'Managed progress regression',
    agentId: 'qwen-code',
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
    capabilities: {
      tasks: true,
      artifacts: false,
      actions: false,
      workspaceTurns: false,
    },
  };
  function append(type: string, data: Record<string, unknown> = {}) {
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
    if (path === '/tool-details/get') {
      detailRequests.push({ sessionId: body.sessionId, itemId: body.itemId });
      const details = toolDetails.get(body.itemId);
      if (details) return respond(details);
      return respond(
        { error: { code: 'tool_details_not_found', message: 'Unavailable' } },
        404,
      );
    }
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
      append('turn.accepted', {
        input: body.input.map((block: { text: string }) => ({
          type: 'text',
          text: block.text,
        })),
      });
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
    page
      .getByRole('region', { name: 'Managed conversation' })
      .locator('[data-web-shell-composer-editor] .cm-content'),
  ).toHaveAttribute('contenteditable', 'true');
  await waitForCurrentStream();
  return {
    daemon,
    prompts,
    cancellations,
    errors,
    emit,
    waitForCurrentStream,
    detailRequests,
    toolDetails,
  };
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
  const composer = page
    .getByRole('region', { name: 'Managed conversation' })
    .locator('[data-web-shell-composer-editor] .cm-content');
  const send = page
    .getByRole('region', { name: 'Managed conversation' })
    .getByRole('button', { name: 'Send message', exact: true });
  await composer.fill('Inspect marker.txt');
  await send.click();
  await fixture.waitForCurrentStream();
  await expect(page.locator('[data-managed-progress]')).toContainText(
    'Thinking / responding',
  );
  await expect(page.locator('[data-managed-progress]')).toBeInViewport();
  await expect(composer).toHaveAttribute('contenteditable', 'false');
  await expect(
    page
      .getByRole('region', { name: 'Managed conversation' })
      .locator('[data-web-shell-composer-submit]'),
  ).toHaveAccessibleName('esc to cancel');
  await expect(
    page
      .getByRole('region', { name: 'Managed conversation' })
      .getByRole('button', { name: 'esc to cancel', exact: true }),
  ).toBeEnabled();
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
  await expect(composer).toHaveAttribute('contenteditable', 'true');
  expect(fixture.prompts).toHaveLength(1);
  expect(fixture.prompts[0].key).toBeTruthy();
  expect(fixture.daemon.promptRequests()).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

test('Managed tool details load only after expansion and remain readable after refresh @smoke', async ({
  page,
}, testInfo) => {
  const fixture = await installManagedScenario(page, testInfo);
  fixture.toolDetails.set('item-saved-read', {
    input: { file_path: '/tmp/example.diff' },
    output:
      'Hosted file tools require file_path relative to the saved Session working directory.',
    truncated: false,
  });
  fixture.toolDetails.set('item-saved-shell', {
    input: { command: "printf 'saved shell output'", directory: 'src' },
    output: 'saved shell output\nExit Code: 0',
    truncated: false,
  });
  await fixture.emit('item.tool_call.updated', {
    itemId: 'item-saved-read',
    toolCallId: 'saved-read',
    name: 'read_file',
    status: 'failed',
  });
  await fixture.emit('item.tool_call.updated', {
    itemId: 'item-saved-shell',
    toolCallId: 'saved-shell',
    name: 'run_shell_command',
    status: 'completed',
  });
  await fixture.emit('item.tool_call.updated', {
    itemId: 'item-old-read',
    toolCallId: 'old-read',
    name: 'read_file',
    status: 'failed',
  });
  await fixture.emit('turn.completed');
  await page.reload();
  const list = page
    .getByRole('region', { name: 'Managed conversation' })
    .locator('[data-web-shell-message-list]');
  const group = list.getByRole('button', {
    name: 'Ran 1 command Read files 2 times',
  });
  await expect(group).toBeVisible();
  expect(fixture.detailRequests).toEqual([]);
  await expect(list).not.toContainText('saved shell output');
  await group.click();
  expect(fixture.detailRequests).toEqual([]);
  const read = list.locator(
    '[data-transcript-tool-call-id="p1:item-saved-read"]',
  );
  const shell = list.locator(
    '[data-transcript-tool-call-id="p1:item-saved-shell"]',
  );
  const old = list.locator('[data-transcript-tool-call-id="p1:item-old-read"]');
  await read.getByRole('button').first().click();
  await expect(read).toContainText(
    'Hosted file tools require file_path relative',
  );
  expect(fixture.detailRequests).toEqual([
    { sessionId: SESSION_ID, itemId: 'item-saved-read' },
  ]);
  await shell.getByRole('button').first().click();
  await expect(shell).toContainText("printf 'saved shell output'");
  await expect(shell).toContainText('saved shell output\nExit Code: 0');
  expect(fixture.detailRequests).toEqual([
    { sessionId: SESSION_ID, itemId: 'item-saved-read' },
    { sessionId: SESSION_ID, itemId: 'item-saved-shell' },
  ]);
  await old.getByRole('button').first().click();
  await expect(old).toContainText('Output is unavailable for this tool call.');
  await expect.poll(() => fixture.detailRequests.length).toBe(3);
  await testInfo.attach('managed-tool-details', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  expect(fixture.prompts).toHaveLength(0);
  expect(fixture.daemon.promptRequests()).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

for (const scenario of [
  { outcome: 'completed', exitCode: 0, signal: null, status: 'Succeeded' },
  {
    outcome: 'failed',
    exitCode: 7,
    signal: null,
    status: 'Exited with code 7',
  },
  { outcome: 'timed_out', exitCode: null, signal: 15, status: 'Timed out' },
  { outcome: 'cancelled', exitCode: null, signal: 15, status: 'Cancelled' },
] as const) {
  test(`Managed saved structured Shell ${scenario.outcome} uses the shared result card @smoke`, async ({
    page,
  }, testInfo) => {
    const fixture = await installManagedScenario(page, testInfo);
    fixture.toolDetails.set('item-structured-shell', {
      input: { command: 'synthetic command' },
      output: 'legacy display text',
      truncated: false,
      shellResult: {
        type: 'shell_result',
        version: 1,
        text: 'saved display text',
        output: 'structured stdout',
        directory: '/workspace/project',
        exitCode: scenario.exitCode,
        signal: scenario.signal,
        pid: 123,
        error: scenario.outcome === 'completed' ? null : 'saved failure',
        outcome: scenario.outcome,
        notices: ['saved notice'],
        truncated: true,
        outputFiles: ['/tmp/saved.log'],
      },
    });
    await fixture.emit('item.tool_call.updated', {
      itemId: 'item-structured-shell',
      toolCallId: 'structured-shell',
      name: 'run_shell_command',
      status: scenario.outcome === 'completed' ? 'completed' : 'failed',
    });
    await fixture.emit('turn.completed');
    await page.reload();
    expect(fixture.detailRequests).toEqual([]);
    await page.getByRole('button', { name: 'Shell', exact: true }).click();
    const shell = page.locator(
      '[data-transcript-tool-call-id="p1:item-structured-shell"]',
    );
    await expect(shell).toContainText(scenario.status);
    await expect(
      shell.getByText('structured stdout', { exact: true }),
    ).toBeVisible();
    await expect(
      shell.getByText('saved notice', { exact: true }),
    ).toBeVisible();
    await expect(shell).toContainText('Output preview truncated');
    await expect(shell).not.toContainText('legacy display text');
    await shell.getByText('Execution details', { exact: true }).click();
    await expect(
      shell.getByText('/workspace/project', { exact: true }),
    ).toBeVisible();
    await expect(
      shell.getByText('/tmp/saved.log', { exact: true }),
    ).toBeVisible();
    if (scenario.exitCode !== null) {
      await expect(
        shell
          .locator('dl')
          .getByText(String(scenario.exitCode), { exact: true }),
      ).toBeVisible();
    } else {
      await expect(shell).toContainText('Signal: 15');
    }
    if (scenario.outcome !== 'completed') {
      await expect(
        shell.getByText('saved failure', { exact: true }),
      ).toBeVisible();
    }
    expect(fixture.detailRequests).toEqual([
      { sessionId: SESSION_ID, itemId: 'item-structured-shell' },
    ]);
    expect(fixture.prompts).toHaveLength(0);
    expect(fixture.daemon.promptRequests()).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
  });
}

test('Managed details distinguish saved empty output from unavailable output @smoke', async ({
  page,
}, testInfo) => {
  const fixture = await installManagedScenario(page, testInfo);
  fixture.toolDetails.set('item-empty-shell', {
    input: { command: 'true' },
    output: '',
    truncated: false,
  });
  await fixture.emit('item.tool_call.updated', {
    itemId: 'item-empty-shell',
    toolCallId: 'empty-shell',
    name: 'run_shell_command',
    status: 'completed',
  });
  await fixture.emit('turn.completed');
  await page.reload();
  await page.getByRole('button', { name: 'Shell', exact: true }).click();
  const shell = page.locator(
    '[data-transcript-tool-call-id="p1:item-empty-shell"]',
  );
  await expect(shell).toContainText('No output');
  await expect(shell).toContainText('true');
  await expect(shell).not.toContainText('Output is unavailable');
  await expect(shell.locator('dl:empty')).toHaveCount(0);
  expect(fixture.detailRequests).toEqual([
    { sessionId: SESSION_ID, itemId: 'item-empty-shell' },
  ]);
  expect(fixture.prompts).toHaveLength(0);
  expect(fixture.daemon.promptRequests()).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

test('collapsing a Managed card cancels its pending detail read @smoke', async ({
  page,
}, testInfo) => {
  const fixture = await installManagedScenario(page, testInfo);
  await fixture.emit('item.tool_call.updated', {
    itemId: 'item-delayed-read',
    toolCallId: 'delayed-read',
    name: 'read_file',
    status: 'failed',
  });
  await fixture.emit('turn.completed');
  await page.reload();
  const failedReads: string[] = [];
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname.endsWith('/tool-details/get')) {
      failedReads.push(request.failure()?.errorText ?? 'request failed');
    }
  });
  let reads = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/agent/web-shell/v1/tool-details/get',
    async (route) => {
      reads += 1;
      const response = {
        status: 200,
        json: {
          input: { file_path: 'saved.txt' },
          output: 'saved detail after reopening',
          truncated: false,
        },
      };
      if (reads === 1) {
        await pending;
        await route.fulfill(response).catch(() => undefined);
        return;
      }
      await route.fulfill(response);
    },
  );
  const read = page.locator(
    '[data-transcript-tool-call-id="p1:item-delayed-read"]',
  );
  const header = page.getByRole('button', { name: 'ReadFile', exact: true });
  try {
    await header.click();
    await expect.poll(() => reads).toBe(1);
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => failedReads.length).toBe(1);
  } finally {
    release();
  }
  await expect(read).toHaveCount(0);
  await header.click();
  await expect(read).toContainText('saved detail after reopening');
  expect(reads).toBe(2);
  expect(fixture.prompts).toHaveLength(0);
  expect(fixture.daemon.promptRequests()).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

test('Managed cancellation waits for settlement before continuing the same session @smoke', async ({
  page,
}, testInfo) => {
  const fixture = await installManagedScenario(page, testInfo);
  const composer = page
    .getByRole('region', { name: 'Managed conversation' })
    .locator('[data-web-shell-composer-editor] .cm-content');
  const send = page
    .getByRole('region', { name: 'Managed conversation' })
    .getByRole('button', { name: 'Send message', exact: true });
  await composer.fill('Turn to cancel');
  await send.click();
  await fixture.waitForCurrentStream();
  await page
    .getByRole('region', { name: 'Managed conversation' })
    .getByRole('button', { name: 'esc to cancel', exact: true })
    .click();
  await fixture.waitForCurrentStream();
  // waitForCurrentStream can pass on the still-running turn's stale cursor
  // while the cancel POST is still on the wire: poll the actual list.
  await expect.poll(() => fixture.cancellations).toEqual([{ turnId: 'p2' }]);
  await expect(page.locator('[data-managed-progress]')).toContainText(
    'Cancelling',
  );
  await expect(composer).toHaveAttribute('contenteditable', 'false');
  await expect(
    page
      .getByRole('region', { name: 'Managed conversation' })
      .locator('[data-web-shell-composer-submit]'),
  ).toBeDisabled();
  await fixture.emit('turn.cancelled');
  await expect(page.locator('[data-managed-progress]')).toHaveCount(0);
  await expect(composer).toHaveAttribute('contenteditable', 'true');
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
  await expect(composer).toHaveAttribute('contenteditable', 'true');
  await expect(page).toHaveURL(new RegExp(`managedSession=${SESSION_ID}`));
  expect(fixture.prompts.map((request) => request.prompt)).toEqual([
    [{ type: 'input_text', text: 'Turn to cancel' }],
    [{ type: 'input_text', text: 'Continue after cancellation' }],
  ]);
  expect(new Set(fixture.prompts.map((request) => request.key)).size).toBe(2);
  expect(fixture.daemon.promptRequests()).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

test('a permanently failing pending create exposes a discard path @smoke', async ({
  page,
}, testInfo) => {
  await installManagedScenario(page, testInfo);
  // Registered after the scenario's catch-all, so it wins for this path:
  // the create fails permanently and the pending prompt would otherwise
  // wedge the whole composer on an indefinite retry.
  const attempts: string[] = [];
  await page.route(
    '**/api/agent/web-shell/v1/sessions/create',
    async (route) => {
      attempts.push(String(route.request().postDataJSON()?.idempotencyKey));
      await route.fulfill({
        status: 500,
        json: { error: { code: 'create_down', message: 'permanent failure' } },
      });
    },
  );

  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const composer = page
    .getByRole('region', { name: 'Managed conversation' })
    .locator('[data-web-shell-composer-editor] .cm-content');
  await composer.fill('Fragile draft');
  await page
    .getByRole('region', { name: 'Managed conversation' })
    .getByRole('button', { name: 'Send message', exact: true })
    .click();

  await expect(
    page.getByText('The request outcome is unconfirmed', { exact: false }),
  ).toBeVisible();
  await expect(composer).toHaveAttribute('contenteditable', 'false');

  await page.getByRole('button', { name: 'Discard this request' }).click();
  await expect(
    page.getByText('The request outcome is unconfirmed', { exact: false }),
  ).toBeHidden();
  await expect(composer).toHaveAttribute('contenteditable', 'true');
  await expect(composer).toHaveText('Fragile draft');

  // Discard is quiet: no resubmission, no new idempotency key for the draft.
  expect(attempts).toHaveLength(1);
});
