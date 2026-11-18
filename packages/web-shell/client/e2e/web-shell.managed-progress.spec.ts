import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { components } from '../components/managed/generated/managed-agent-api';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

type Schemas = components['schemas'];

const SESSION_ID = 'managed-progress-session';
const LONG_ANSWER = Array.from(
  { length: 70 },
  (_, index) => `Paragraph ${index}: a previous workspace inspection.`,
).join('\n\n');

// Public wire: Session, Turn and Event timestamps are epoch seconds.
const epochSeconds = () => Math.floor(Date.now() / 1000);

async function installManagedScenario(page: Page, testInfo: TestInfo) {
  const baseURL = String(testInfo.project.use.baseURL);
  const scenario = createWebShellDaemonScenario({ sessions: [] });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const events: Schemas['PublicEvent'][] = [];
  const prompts: Array<{ prompt: unknown; key?: string }> = [];
  const cancellations: unknown[] = [];
  const errors: string[] = [];
  const streamCursors: number[] = [];
  const detailRequests: Array<{ sessionId: string; itemId: string }> = [];
  const toolDetails = new Map<string, Schemas['PublicToolDetails']>();
  page.on('pageerror', (error) => errors.push(error.message));
  let summary: Schemas['PublicSession'] = {
    id: SESSION_ID,
    object: 'agent.session',
    title: 'Managed progress regression',
    agent_id: 'qwen-code',
    agent_revision: '1',
    status: 'active',
    created_at: epochSeconds() - 10,
    updated_at: epochSeconds(),
    latest_turn: {
      id: 'p1',
      object: 'agent.turn',
      session_id: SESSION_ID,
      status: 'completed',
      created_at: epochSeconds() - 10,
      completed_at: epochSeconds() - 9,
    },
    environment: { state: 'ready' },
    last_event_id: 0,
    capabilities: {
      items: false,
      snapshots: false,
      resync: false,
      tasks: true,
      artifacts: false,
      actions: false,
      workspace_turns: false,
    },
  };
  function append(type: string, data: Record<string, unknown> = {}) {
    const sequence = events.length + 1;
    events.push({
      schema_version: 1,
      projection_version: 1,
      sequence,
      event_id: `event-${sequence}`,
      created_at: epochSeconds(),
      session_id: SESSION_ID,
      turn_id: summary.latest_turn!.id,
      type,
      ...(type.startsWith('item.tool_')
        ? { item_id: String(data.itemId ?? data.toolCallId) }
        : {}),
      data,
      terminal: ['turn.completed', 'turn.cancelled'].includes(type),
    });
    summary.last_event_id = sequence;
  }
  append('turn.accepted', {
    input: [{ type: 'text', text: 'Previous inspection' }],
  });
  append('item.output_text.delta', { text: LONG_ANSWER });
  append('turn.completed');

  await page.route('**/v1/agents/**', async (route) => {
    const request = route.request();
    expect(['GET', 'POST']).toContain(request.method());
    expect(request.headers()['x-qwen-tenant-id']).toBe('local-java-demo');
    const url = new URL(request.url());
    const path = url.pathname.replace('/v1/agents', '');
    const method = request.method();
    const body = request.postDataJSON();
    if (path === `/sessions/${SESSION_ID}/user-messages`)
      return route.fulfill({ json: { paused: false, messages: [] } });
    const respond = (json: unknown, status = 200) =>
      route.fulfill({ status, json });
    if (path === '/sessions' && method === 'GET')
      return respond({
        object: 'list',
        data: [summary],
        has_more: false,
        next_cursor: null,
      });
    if (path === `/sessions/${SESSION_ID}`) return respond(summary);
    if (path === `/sessions/${SESSION_ID}/transcript`)
      return respond({
        items: [],
        events,
        covered_sequence: summary.last_event_id,
        older_cursor: null,
        last_sequence: summary.last_event_id,
        has_more: false,
      } satisfies Schemas['PublicTranscript']);
    const detailRoute = new RegExp(
      `^/sessions/${SESSION_ID}/items/([^/]+)/tool-details$`,
    ).exec(path);
    if (detailRoute) {
      const itemId = detailRoute[1];
      detailRequests.push({ sessionId: SESSION_ID, itemId });
      const details = toolDetails.get(itemId);
      if (details) return respond(details);
      return respond(
        { error: { code: 'tool_details_not_found', message: 'Unavailable' } },
        404,
      );
    }
    if (
      path === `/sessions/${SESSION_ID}/events` &&
      url.searchParams.get('stream') === 'true'
    ) {
      const after = Number(url.searchParams.get('after') ?? 0);
      streamCursors.push(after);
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: events
          .filter((event) => event.sequence > after)
          .map(
            (event) =>
              `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(''),
      });
    }
    if (
      path === `/sessions/${SESSION_ID}/events` &&
      method === 'POST' &&
      body.type === 'agent.session.input.message'
    ) {
      prompts.push({
        prompt: body.input,
        key: request.headers()['idempotency-key'],
      });
      summary = {
        ...summary,
        updated_at: epochSeconds(),
        latest_turn: {
          id: `p${prompts.length + 1}`,
          object: 'agent.turn',
          session_id: SESSION_ID,
          status: 'running',
          created_at: epochSeconds(),
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
          session_id: SESSION_ID,
          turn_id: summary.latest_turn!.id,
          status: 'accepted',
          replayed: false,
          operation_id: `operation-${summary.latest_turn!.id}`,
          admission_stage: 'java_durable',
          delivery_state: 'pending',
        },
        202,
      );
    }
    if (
      path === `/sessions/${SESSION_ID}/events` &&
      method === 'POST' &&
      body.type === 'agent.session.cancel'
    ) {
      cancellations.push({ turnId: body.turn_id });
      summary.latest_turn!.status = 'cancelling';
      append('turn.cancel.requested');
      return respond(
        {
          session_id: SESSION_ID,
          turn_id: body.turn_id,
          status: 'accepted',
          replayed: false,
          operation_id: `operation-${summary.latest_turn!.id}`,
          admission_stage: 'java_durable',
          delivery_state: 'pending',
        },
        202,
      );
    }
    const operationRoute = new RegExp(
      `^/sessions/${SESSION_ID}/operations/([^/]+)$`,
    ).exec(path);
    if (operationRoute) {
      return respond({
        session_id: SESSION_ID,
        id: operationRoute[1],
        type: 'cancel',
        status:
          summary.latest_turn?.status === 'cancelled' ? 'completed' : 'running',
        admission_stage: 'java_durable',
        delivery_state: 'leased',
        replayed: false,
      });
    }
    return respond({ error: `Unexpected Managed request: ${path}` }, 500);
  });

  async function emit(type: string, data?: Record<string, unknown>) {
    if (type === 'turn.completed') summary.latest_turn!.status = 'completed';
    if (type === 'turn.cancelled') summary.latest_turn!.status = 'cancelled';
    append(type, data);
  }
  async function waitForCurrentStream() {
    await expect
      .poll(() => streamCursors.includes(summary.last_event_id))
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

test('Managed transcript matches composer edges across viewport widths @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  const fixture = await installManagedScenario(page, testInfo);
  const pane = page.getByRole('region', { name: 'Managed conversation' });
  const message = pane
    .locator('[data-web-shell-message-row]')
    .filter({ hasText: 'Paragraph 0:' });
  const composer = pane.locator('[data-web-shell-composer]');
  await expect(message).toBeVisible();
  await expect(composer).toBeVisible();

  for (const width of [1000, 1116, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(async () => {
        const messageBox = await message.boundingBox();
        const composerBox = await composer.boundingBox();
        if (!messageBox || !composerBox) return Infinity;
        return Math.max(
          Math.abs(messageBox.x - composerBox.x),
          Math.abs(
            messageBox.x + messageBox.width - composerBox.x - composerBox.width,
          ),
        );
      })
      .toBeLessThanOrEqual(1);
  }
  expect(fixture.errors).toEqual([]);
});

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
  await expect(composer).toHaveAttribute('contenteditable', 'true');
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
      shell_result: {
        type: 'shell_result',
        version: 1,
        text: 'saved display text',
        output: 'structured stdout',
        directory: '/workspace/project',
        exit_code: scenario.exitCode,
        signal: scenario.signal,
        pid: 123,
        error: scenario.outcome === 'completed' ? null : 'saved failure',
        outcome: scenario.outcome,
        notices: ['saved notice'],
        truncated: true,
        output_files: ['/tmp/saved.log'],
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
    if (new URL(request.url()).pathname.endsWith('/tool-details')) {
      failedReads.push(request.failure()?.errorText ?? 'request failed');
    }
  });
  let reads = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/v1/agents/sessions/*/items/*/tool-details',
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
  await expect(composer).toHaveAttribute('contenteditable', 'true');
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
  await page.route('**/v1/agents/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    attempts.push(String(route.request().headers()['idempotency-key']));
    await route.fulfill({
      status: 500,
      json: { error: { code: 'create_down', message: 'permanent failure' } },
    });
  });

  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const composer = page
    .getByRole('region', { name: 'Managed conversation' })
    .locator('[data-web-shell-composer-editor] .cm-content');
  await composer.fill('Fragile draft');
  await page
    .getByRole('region', { name: 'Managed conversation' })
    .getByRole('button', { name: 'Send message', exact: true })
    .click();

  await expect(
    page.getByText('The previous message was not confirmed as submitted', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(composer).toHaveAttribute('contenteditable', 'false');

  await page.getByRole('button', { name: 'Discard this request' }).click();
  await expect(
    page.getByText('The previous message was not confirmed as submitted', {
      exact: false,
    }),
  ).toBeHidden();
  await expect(composer).toHaveAttribute('contenteditable', 'true');
  await expect(composer).toHaveText('Fragile draft');

  // Discard is quiet: no resubmission, no new idempotency key for the draft.
  expect(attempts).toHaveLength(1);
});
