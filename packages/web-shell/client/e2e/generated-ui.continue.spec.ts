/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { startGeneratedUiSandbox } from './utils/generatedUiSandbox';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const resourceUri = 'ui://qwen-code-generated-ui/view-v1.html';
const input = {
  title: 'Parameter continuation fixture',
  summary: 'Initial result: 4. This summary must not enter the message.',
  html:
    '<label for="rate">Rate</label><input id="rate" type="number" value="2">' +
    '<input id="bounded" type="range" min="0" max="10" value="3">' +
    '<input id="empty" value=""><input id="unchecked" type="checkbox">' +
    '<input id="hidden" value="hidden parameter"><input id="disabled" disabled value="fixed parameter">' +
    '<select id="choice"><option value="first">First</option><option value="second">Second</option></select>' +
    '<output id="answer">Initial</output><button id="calculate">Calculate</button>',
  css: '#hidden { display: none; }',
  javascript:
    'function calculate() { ui.text("answer", String(Number(ui.input("rate").value) * 2)); }' +
    'ui.on("calculate", "click", calculate); ui.value("bounded", "99"); calculate();',
};

interface SnapshotMessage {
  kind: string;
  title: string;
  snapshot: {
    schemaVersion: number;
    documentId: string;
    activationId: string;
    appliedSequence: number;
    baseInputRevision: number;
    inputRevision: number;
    inputs: Record<string, { value: string; checked: boolean }>;
  };
  rejectedEvents: number;
}

let appHtml: string;
let toolResult: Record<string, unknown>;
let sandbox: Awaited<ReturnType<typeof startGeneratedUiSandbox>>;

test.beforeAll(async () => {
  sandbox = await startGeneratedUiSandbox();
  appHtml = sandbox.appHtml;
  toolResult = sandbox.createShowResult(input);
});

test.afterAll(async () => {
  await sandbox?.close();
});

async function openCards(page: Page, testInfo: TestInfo, count = 1) {
  const scenario = createWebShellDaemonScenario({
    state: { _meta: { generatedUi: { version: 1, enabled: true } } },
    events: [
      userTextEvent('Show a parameter simulation.', { id: 1 }),
      ...Array.from({ length: count }, (_, index) =>
        toolCallEvent(
          `generated-${index}`,
          'mcp__generated-ui__generated_ui_show',
          input,
          {
            id: index + 2,
            rawOutput: {
              type: 'mcp_app',
              requiredFeature: 'generated-ui',
              serverName: 'generated-ui',
              resourceUri,
              html: appHtml,
              toolResult,
              toolArguments: input,
              fallbackText: input.summary,
            },
          },
        ),
      ),
      turnCompleteEvent('generated', { id: count + 2 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  // Only daemon HTTP/SSE is mocked. The sandbox, App/Worker, host bridge,
  // review dialog and ordinary prompt admission use their production code.
  await page.route(`**/session/${scenario.sessionId}/load`, (route) =>
    route.fulfill({
      json: {
        sessionId: scenario.sessionId,
        clientId: scenario.clientId,
        workspaceCwd: scenario.workspaceCwd,
        attached: true,
        createdAt: '2026-10-23T00:00:00.000Z',
        hasActivePrompt: false,
        generatedUi: { version: 1, enabled: true },
        state: scenario.state,
        compactedReplay: scenario.events,
        liveJournal: [],
        lastEventId: count + 2,
      },
    }),
  );
  await page.route('**/mcp-app-sandbox?*', async (route) => {
    const requested = new URL(route.request().url());
    const response = await fetch(
      `${sandbox.url}${requested.pathname}${requested.search}`,
      { redirect: 'manual' },
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  const cards = page.locator('iframe[title="Interactive view"]');
  await expect(cards).toHaveCount(count);
  const app = (index = 0) =>
    cards.nth(index).contentFrame().frameLocator('iframe');
  for (let index = 0; index < count; index++) {
    await expect(app(index).locator('#status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await expect(app(index).locator('#continue-analysis')).toBeEnabled();
  }
  expect(workers).toHaveLength(count);
  return { daemon, scenario, app, cards };
}

function parameters(text: string): SnapshotMessage {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  expect(start).toBeGreaterThan(-1);
  return JSON.parse(text.slice(start, end + 1)) as SnapshotMessage;
}

const contextTag = 'Interactive view values: Parameter continuation fixture';

test('sends applied parameters directly and offers them to the next message @smoke', async ({
  page,
}, testInfo) => {
  const { app, daemon, scenario } = await openCards(page, testInfo);
  await page.setViewportSize({ width: 375, height: 900 });
  // The card refits after the resize, so measure once the layout settles.
  await expect
    .poll(async () => {
      const continueBounds = await app()
        .locator('#continue-analysis')
        .boundingBox();
      const stopBounds = await app().locator('#stop').boundingBox();
      if (!continueBounds || !stopBounds) return false;
      return (
        continueBounds.y >= stopBounds.y + stopBounds.height &&
        continueBounds.x + continueBounds.width <= 375
      );
    })
    .toBe(true);
  await app().locator('#continue-analysis').scrollIntoViewIfNeeded();
  await expect(app().locator('#continue-analysis')).toBeVisible();
  const screenshot = testInfo.outputPath('continuation-narrow.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Generated UI fixture at 375px', {
    path: screenshot,
    contentType: 'image/png',
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const composerTag = page.locator('[data-web-shell-composer-tag]', {
    hasText: contextTag,
  });
  await expect(composerTag).toHaveCount(0);
  const view = app().frameLocator('#view');
  await expect(view.locator('#bounded')).toHaveValue('10');
  await view.locator('#rate').fill('7');
  await expect(app().locator('#continue-analysis')).toBeDisabled();
  await view.getByRole('button', { name: 'Calculate' }).click();
  await expect(view.locator('#answer')).toHaveText('14');
  // Applied values settle into one removable composer tag for the next message.
  await expect(composerTag).toHaveCount(1);
  expect(daemon.promptRequests()).toHaveLength(0);
  await expect(app().locator('#continue-analysis')).toBeEnabled();
  await app().locator('#continue-analysis').focus();
  await page.keyboard.press('Enter');

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const request = daemon.promptRequests()[0];
  expect(request.path).toBe(`/session/${scenario.sessionId}/prompt`);
  const prompt = (request.body as { prompt: Array<{ text: string }> }).prompt[0]
    .text;
  expect(parameters(prompt)).toMatchObject({
    kind: 'qwen.generated-ui.parameters',
    title: input.title,
    snapshot: {
      schemaVersion: 1,
      inputs: {
        rate: { value: '7', checked: false },
        bounded: { value: '10', checked: false },
        empty: { value: '', checked: false },
        unchecked: { value: 'on', checked: false },
        hidden: { value: 'hidden parameter', checked: false },
        disabled: { value: 'fixed parameter', checked: false },
        choice: { value: 'first', checked: false },
      },
    },
    rejectedEvents: 0,
  });
  expect(prompt).toContain('Continue the analysis');
  expect(prompt).not.toContain(input.summary);
  expect(prompt).not.toContain(input.html);
  expect(prompt).not.toContain(input.javascript);
  await expect(app().locator('#continuation-status')).toHaveAttribute(
    'data-state',
    'accepted',
  );
  // The sent values leave the composer and show as a labelled reference.
  await expect(composerTag).toHaveCount(0);
  await expect(page.getByText(contextTag).first()).toBeVisible();
  await expect(
    page.getByText('"kind": "qwen.generated-ui.parameters"'),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 900 });
  await app()
    .locator('#continuation-help')
    .evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(app().locator('#continuation-help')).toBeInViewport({
    ratio: 1,
  });
  await expect(app().locator('#continuation-status')).toBeInViewport({
    ratio: 1,
  });
  const feedbackScreenshot = testInfo.outputPath(
    'continuation-feedback-narrow.png',
  );
  await page.screenshot({ path: feedbackScreenshot, fullPage: true });
  await testInfo.attach('Generated UI fixture feedback at 375px', {
    path: feedbackScreenshot,
    contentType: 'image/png',
  });
});

test('keeps identical cards independent and explains a busy session @smoke', async ({
  page,
}, testInfo) => {
  const { app, daemon, cards } = await openCards(page, testInfo, 2);
  await cards.nth(0).scrollIntoViewIfNeeded();
  await app(0).locator('#continue-analysis').click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await expect(app(0).locator('#continuation-status')).toHaveAttribute(
    'data-state',
    'accepted',
  );

  // The first request's turn is still running, so nothing is sent.
  await cards.nth(1).scrollIntoViewIfNeeded();
  await app(1).locator('#continue-analysis').click();
  await expect(app(1).locator('#continuation-status')).toHaveText(
    'Not sent. The session is busy. Wait for it to finish, then send the message again.',
  );
  await expect(app(1).locator('#continue-analysis')).toBeEnabled();
  expect(daemon.promptRequests()).toHaveLength(1);
  // The first card keeps its own outcome.
  await expect(app(0).locator('#continuation-status')).toHaveAttribute(
    'data-state',
    'accepted',
  );
  const sent = parameters(
    (daemon.promptRequests()[0].body as { prompt: Array<{ text: string }> })
      .prompt[0].text,
  );
  expect(sent.title).toBe(input.title);
});

test('rechecks the DOM at capture before sending @smoke', async ({
  page,
}, testInfo) => {
  const { app, daemon } = await openCards(page, testInfo);
  const view = app().frameLocator('#view');
  await view.locator('#rate').evaluate((element) => {
    (element as HTMLInputElement).value = '8';
  });
  await expect(app().locator('#continue-analysis')).toBeEnabled();
  await app().locator('#continue-analysis').click();
  await expect(app().locator('#status')).toHaveAttribute('data-state', 'dirty');
  await expect(app().locator('#continuation-status')).toContainText(
    'Parameters are not ready',
  );
  expect(daemon.promptRequests()).toHaveLength(0);
  await view.getByRole('button', { name: 'Calculate' }).click();
  await expect(view.locator('#answer')).toHaveText('16');
  await app().locator('#continue-analysis').click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expect(
    parameters(
      (daemon.promptRequests()[0].body as { prompt: Array<{ text: string }> })
        .prompt[0].text,
    ).snapshot.inputs['rate'],
  ).toEqual({ value: '8', checked: false });
});

test('keeps the real App RPC pending across the admission window', async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date('2026-10-23T00:00:00.000Z') });
  await page.clock.pauseAt(new Date('2026-10-23T01:00:00.000Z'));
  const { app, daemon, scenario } = await openCards(page, testInfo);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let dispatched = false;
  await page.route(`**/session/${scenario.sessionId}/prompt`, async (route) => {
    dispatched = true;
    await held;
    await route.fallback();
  });
  try {
    await app().locator('#continue-analysis').click();
    await expect.poll(() => dispatched).toBe(true);
    await page.clock.fastForward(61_000);
    await expect(app().locator('#continuation-status')).toHaveAttribute(
      'data-state',
      'pending',
    );
    release();
    await expect(app().locator('#continuation-status')).toHaveAttribute(
      'data-state',
      'accepted',
    );
    expect(daemon.promptRequests()).toHaveLength(1);
  } finally {
    release();
  }
});

test('times out an unanswered App RPC at 210 seconds without resending an unknown request', async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date('2026-10-23T00:00:00.000Z') });
  await page.clock.pauseAt(new Date('2026-10-23T01:00:00.000Z'));
  // Observe actual RPC requests without replacing either SDK or host.
  await page.addInitScript(() => {
    if (location.pathname !== '/mcp-app-sandbox') return;
    let requests = 0;
    window.addEventListener(
      'message',
      (event) => {
        if (!event.data || typeof event.data !== 'object') return;
        const message = event.data as Record<string, unknown>;
        if (
          event.source !== window.parent &&
          message['method'] === 'ui/message'
        ) {
          document.body.dataset['continuationRequests'] = String(++requests);
        }
      },
      { capture: true },
    );
  });
  const { app, scenario } = await openCards(page, testInfo);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route(`**/session/${scenario.sessionId}/prompt`, async (route) => {
    attempts++;
    await held;
    await route.abort().catch(() => {});
  });
  try {
    await app().locator('#continue-analysis').click();
    await expect.poll(() => attempts).toBe(1);
    const proxy = page
      .locator('iframe[title="Interactive view"]')
      .contentFrame();
    await page.clock.fastForward(209_999);
    await expect(app().locator('#continuation-status')).toHaveAttribute(
      'data-state',
      'pending',
    );
    await page.clock.fastForward(1);
    await expect(app().locator('#continuation-status')).toHaveAttribute(
      'data-state',
      'unconfirmed',
    );
    await page.clock.fastForward(60_000);
    expect(attempts).toBe(1);
    await expect(proxy.locator('body')).toHaveAttribute(
      'data-continuation-requests',
      '1',
    );
    await expect(app().locator('#continuation-status')).toContainText(
      'Nothing is retried automatically.',
    );
  } finally {
    release();
  }
});
