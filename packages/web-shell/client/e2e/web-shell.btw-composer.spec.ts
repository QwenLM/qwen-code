import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

const EDITOR = '[data-web-shell-composer-surface] .cm-content';
const ANSWER = 'This side answer stays outside the main conversation.';

async function openSession(page: Page, testInfo: TestInfo, streaming = true) {
  const scenario = createWebShellDaemonScenario({ btwAnswer: ANSWER });
  if (!streaming) {
    scenario.capabilities.features = scenario.capabilities.features.filter(
      (feature) => feature !== 'session_btw_stream',
    );
    scenario.capabilities.features.push('session_btw');
  }
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  await expect(page.locator(EDITOR)).toBeEditable();
  return daemon;
}

for (const busy of [false, true]) {
  test(`prepares and submits a BTW question while main task is ${busy ? 'running' : 'idle'}`, async ({
    page,
  }, testInfo) => {
    const daemon = await openSession(page, testInfo);
    const editor = page.locator(EDITOR);
    if (busy) {
      await editor.fill('Continue the main task');
      await editor.press('Enter');
      await expect.poll(() => daemon.promptRequests().length).toBe(1);
      await expect(
        page.getByRole('button', { name: 'esc to cancel', exact: true }),
      ).toBeVisible();
    }
    const question = 'What does this term mean?';
    await editor.fill(busy ? `/BTW ${question}` : question);
    await page.getByTestId('composer-add-menu-trigger').click();
    const action = page.getByTestId('composer-add-menu-btw');
    await expect(action).toContainText('Ask a side question');
    await expect(action).toContainText('/btw');
    await expect(action).toContainText('Keep the main task running');
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('btw-menu.png'),
    });
    const mutationsBefore = daemon.requests.filter((r) => r.method === 'POST');
    await action.click();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText(`/btw ${question}`);
    expect(daemon.requests.filter((r) => r.method === 'POST')).toEqual(
      mutationsBefore,
    );
    await editor.press('Enter');
    await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
    const btwRequests = daemon.requests.filter(
      (r) => r.method === 'POST' && r.path.endsWith('/btw/stream'),
    );
    expect(btwRequests).toHaveLength(1);
    expect(
      daemon.requests.filter(
        (request) => request.method === 'POST' && /\/btw$/.test(request.path),
      ),
    ).toHaveLength(0);
    expect(btwRequests[0]?.body).toMatchObject({ question });
    expect(daemon.promptRequests()).toHaveLength(busy ? 1 : 0);
    expect(
      daemon.requests.filter(
        (r) =>
          r.method === 'POST' && /\/(cancel|pending-prompts)$/.test(r.path),
      ),
    ).toHaveLength(0);
    await expect(
      page.locator('[data-web-shell-message-list]'),
    ).not.toContainText(ANSWER);
    if (busy) {
      await expect(
        page.getByRole('button', { name: 'esc to cancel', exact: true }),
      ).toBeVisible();
    }
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('btw-answer.png'),
    });
  });
}

test('prepares empty drafts and preserves an existing BTW prefix', async ({
  page,
}, testInfo) => {
  const daemon = await openSession(page, testInfo);
  const editor = page.locator(EDITOR);
  for (const [draft, expected] of [
    ['', '/btw fresh question'],
    ['/btw existing question', '/btw existing question'],
  ]) {
    await editor.fill(draft);
    await page.getByTestId('composer-add-menu-trigger').click();
    await page.getByTestId('composer-add-menu-btw').click();
    await expect(editor).toBeFocused();
    if (!draft) await editor.pressSequentially('fresh question');
    await expect(editor).toHaveText(expected);
  }
  expect(daemon.promptRequests()).toHaveLength(0);
  expect(
    daemon.requests.filter((r) => r.path.endsWith('/btw/stream')),
  ).toHaveLength(0);
});

test('disables the BTW entry with an explanation while a file is attached', async ({
  page,
}, testInfo) => {
  const daemon = await openSession(page, testInfo);
  const composer = page.locator('[data-web-shell-composer]');
  await page.locator(EDITOR).fill('Keep this draft and attachment');
  await composer
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Keep this attachment'),
    });
  await expect(
    page.locator('[data-web-shell-composer-attachments]'),
  ).toContainText('notes.txt');
  await page.getByTestId('composer-add-menu-trigger').click();
  const action = page.getByTestId('composer-add-menu-btw');
  await expect(action).toHaveAttribute('aria-disabled', 'true');
  await expect(action).toContainText('Remove attachments');
  await expect(page.locator(EDITOR)).toHaveText(
    'Keep this draft and attachment',
  );
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('shows a partial BTW answer and replaces it with the resumed snapshot', async ({
  page,
}, testInfo) => {
  const daemon = await openSession(page, testInfo);
  const requests: Array<{
    question: string;
    requestId: string;
    resume?: boolean;
  }> = [];
  let finish: (() => void) | undefined;
  const resumed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/btw/stream', async (route) => {
    const body = route.request().postDataJSON() as {
      question: string;
      requestId: string;
      resume?: boolean;
    };
    requests.push(body);
    if (requests.length > 1) await resumed;
    const events =
      requests.length === 1
        ? [{ type: 'answer', answer: 'Partial BTW answer' }]
        : [{ type: 'done', answer: 'Partial BTW answer, now complete.' }];
    await route.fulfill({
      contentType: 'text/event-stream',
      body: events
        .map(
          (event) =>
            `data: ${JSON.stringify({ v: 1, requestId: body.requestId, ...event })}\n\n`,
        )
        .join(''),
    });
  });
  await page.locator(EDITOR).fill('/btw Explain this');
  await page.locator(EDITOR).press('Enter');
  await expect(
    page.getByText('Partial BTW answer', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('btw-partial-answer.png'),
  });
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ ...requests[0], resume: true });
  finish?.();
  await expect(
    page.getByText('Partial BTW answer, now complete.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Partial BTW answer', { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-web-shell-message-list]')).not.toContainText(
    'Partial BTW answer',
  );
  expect(daemon.promptRequests()).toHaveLength(0);
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('btw-resumed-answer.png'),
  });
});

test('uses legacy JSON when streaming BTW is not advertised', async ({
  page,
}, testInfo) => {
  const daemon = await openSession(page, testInfo, false);
  await page.locator(EDITOR).fill('/btw Explain this');
  await page.locator(EDITOR).press('Enter');
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  const calls = daemon.requests.filter(
    (request) =>
      request.method === 'POST' && /\/btw(?:\/stream)?$/.test(request.path),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.path).toMatch(/\/btw$/);
});

test('does not retry legacy JSON after an advertised streaming failure', async ({
  page,
}, testInfo) => {
  await openSession(page, testInfo);
  const paths: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/btw(?:\/stream)?$/.test(path))
      paths.push(path);
  });
  await page.route('**/btw/stream', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unsupported stream' }),
    }),
  );
  await page.locator(EDITOR).fill('/btw Explain this');
  await page.locator(EDITOR).press('Enter');
  await expect(page.getByText(/Side question failed/).first()).toBeVisible();
  expect(paths).toHaveLength(1);
  expect(paths[0]).toMatch(/\/btw\/stream$/);
});

test('follows BTW output until scrolled up, resumes at bottom, and resets for a new question', async ({
  page,
}, testInfo) => {
  await openSession(page, testInfo);
  const answer = (rows: number) =>
    Array.from(
      { length: rows },
      (_, index) => `Scroll row ${index}: streamed answer content.`,
    ).join('\n\n');
  const release: Array<() => void> = [];
  const gates = [0, 1, 2].map(
    (index) =>
      new Promise<void>((resolve) => {
        release[index] = resolve;
      }),
  );
  const requests: Array<{
    requestId: string;
    question: string;
    resume?: boolean;
  }> = [];
  await page.route('**/btw/stream', async (route) => {
    const body = route.request().postDataJSON() as {
      requestId: string;
      question: string;
      resume?: boolean;
    };
    requests.push(body);
    const fresh = body.question === 'New long question';
    const attempt = requests.filter(
      (request) => request.question === body.question,
    ).length;
    if (!fresh && attempt > 1) await gates[attempt - 2];
    const rows = fresh ? 40 : 20 + attempt * 20;
    const event = {
      v: 1,
      type: fresh || attempt === 4 ? 'done' : 'answer',
      requestId: body.requestId,
      answer: answer(rows),
    };
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify(event)}\n\n`,
    });
  });
  await page.locator(EDITOR).fill('/btw Long question');
  await page.locator(EDITOR).press('Enter');
  const viewport = page.locator('[data-web-shell-btw-content]');
  const metrics = () =>
    viewport.evaluate((element) => ({
      top: element.scrollTop,
      gap: element.scrollHeight - element.clientHeight - element.scrollTop,
    }));
  await expect(
    page.getByText('Scroll row 39: streamed answer content.', { exact: true }),
  ).toBeAttached();
  await expect.poll(async () => (await metrics()).gap).toBeLessThan(3);
  await viewport.hover();
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => (await metrics()).gap).toBeGreaterThan(100);
  const paused = await metrics();
  release[0]?.();
  await expect(
    page.getByText('Scroll row 59: streamed answer content.', { exact: true }),
  ).toBeAttached();
  await page.screenshot({
    path: testInfo.outputPath('btw-scroll-paused.png'),
    animations: 'disabled',
  });
  expect(Math.abs((await metrics()).top - paused.top)).toBeLessThan(3);
  await viewport.hover();
  await page.mouse.wheel(0, 100_000);
  await expect.poll(async () => (await metrics()).gap).toBeLessThan(3);
  release[1]?.();
  await expect(
    page.getByText('Scroll row 79: streamed answer content.', { exact: true }),
  ).toBeAttached();
  await expect.poll(async () => (await metrics()).gap).toBeLessThan(3);
  release[2]?.();
  await expect(
    page.getByText('Scroll row 99: streamed answer content.', { exact: true }),
  ).toBeAttached();
  await expect.poll(async () => (await metrics()).gap).toBeLessThan(3);
  expect(
    requests
      .slice(1)
      .every(
        (request) =>
          request.requestId === requests[0]?.requestId &&
          request.resume === true,
      ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('btw-scroll-following.png'),
    animations: 'disabled',
  });
  await viewport.hover();
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => (await metrics()).gap).toBeGreaterThan(100);
  await page.locator(EDITOR).fill('/btw New long question');
  await page.locator(EDITOR).press('Enter');
  await expect.poll(() => requests.at(-1)?.question).toBe('New long question');
  await expect(viewport).toContainText('New long question');
  await expect(
    page.getByText('Scroll row 39: streamed answer content.', { exact: true }),
  ).toBeAttached();
  await expect.poll(async () => (await metrics()).gap).toBeLessThan(3);
  expect(requests.at(-1)?.requestId).not.toBe(requests[0]?.requestId);
});

test('keeps a partial BTW answer and shows the terminal stream error', async ({
  page,
}, testInfo) => {
  const daemon = await openSession(page, testInfo);
  let finish: (() => void) | undefined;
  const failure = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const requests: Array<{ requestId: string; resume?: boolean }> = [];
  await page.route('**/btw/stream', async (route) => {
    const body = route.request().postDataJSON() as {
      requestId: string;
      resume?: boolean;
    };
    requests.push(body);
    if (requests.length > 1) await failure;
    const event =
      requests.length === 1
        ? {
            v: 1,
            type: 'answer',
            requestId: body.requestId,
            answer: 'Received before the failure.',
          }
        : {
            v: 1,
            type: 'error',
            requestId: body.requestId,
            code: 'btw_timeout',
            message: 'Side question timed out',
          };
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify(event)}\n\n`,
    });
  });
  await page.locator(EDITOR).fill('/btw Partial failure');
  await page.locator(EDITOR).press('Enter');
  await expect(
    page.getByText('Received before the failure.', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ ...requests[0], resume: true });
  finish?.();
  await expect(page.getByText(/Side question timed out/).first()).toBeVisible();
  await expect(
    page.getByText('Received before the failure.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Press Space, Enter, or Escape to dismiss', { exact: true }),
  ).toBeVisible();
  expect(
    daemon.requests.filter(
      (request) => request.method === 'POST' && /\/btw$/.test(request.path),
    ),
  ).toHaveLength(0);
  await page.screenshot({
    path: testInfo.outputPath('btw-partial-error.png'),
    animations: 'disabled',
  });
});

test('cancels the pending BTW stream with Escape without cancelling the main task', async ({
  page,
}, testInfo) => {
  const daemon = await openSession(page, testInfo);
  await page.locator(EDITOR).fill('Continue the main task');
  await page.locator(EDITOR).press('Enter');
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  const mainCancel = page.getByRole('button', {
    name: 'esc to cancel',
    exact: true,
  });
  await expect(mainCancel).toBeVisible();
  let requestId: string | undefined;
  await page.route('**/btw/stream', async (route) => {
    const body = route.request().postDataJSON() as { requestId: string };
    requestId = body.requestId;
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ v: 1, type: 'answer', requestId, answer: 'Pending cancellable answer.' })}\n\n`,
    });
  });
  await page.locator(EDITOR).fill('/btw Cancel this question');
  await page.locator(EDITOR).press('Enter');
  await expect(
    page.getByText('Pending cancellable answer.', { exact: true }),
  ).toBeVisible();
  const cancelled = page.waitForRequest(
    (request) =>
      request.method() === 'DELETE' &&
      new URL(request.url()).pathname.endsWith(`/btw/stream/${requestId}`),
  );
  await page.keyboard.press('Escape');
  await cancelled;
  await expect(page.locator('[data-web-shell-btw-content]')).toHaveCount(0);
  await expect(mainCancel).toBeVisible();
  expect(daemon.promptRequests()).toHaveLength(1);
  expect(
    daemon.requests.filter(
      (request) =>
        request.method === 'POST' &&
        (/\/btw$/.test(request.path) || /\/cancel$/.test(request.path)),
    ),
  ).toHaveLength(0);
});
