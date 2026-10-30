/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { startGeneratedUiSandbox } from './utils/generatedUiSandbox';
import {
  expect,
  test,
  type Frame,
  type FrameLocator,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const resourceUri = 'ui://qwen-code-generated-ui/view-v1.html';
const frameSelector = 'iframe[title="Interactive view"]';
const input = {
  title: 'Retained parameter fixture',
  summary: 'Original summary. Reopening starts from the original values.',
  html:
    '<label for="rate">Rate</label><input id="rate" value="2">' +
    '<output id="answer"></output><button id="apply">Apply</button>' +
    '<button id="insert">Insert controls</button>' +
    '<button id="fail">Fail runtime</button><div id="dynamic"></div>',
  css: 'button { margin: 4px; }',
  javascript:
    'let rounds = 0;' +
    'ui.text("answer", "0:" + ui.input("rate").value);' +
    'ui.on("apply", "click", () => {' +
    'rounds += 1; ui.text("answer", String(rounds) + ":" + ui.input("rate").value); });' +
    'ui.on("insert", "click", () => ui.html("dynamic", ' +
    JSON.stringify(
      '<input id="one" type="radio" name="plan" checked>' +
        '<input id="two" type="radio" name="plan">' +
        '<select id="choice"><option value="a">A</option><option value="b">B</option></select>',
    ) +
    '));' +
    'ui.on("fail", "click", () => { throw new Error("retention fixture failure"); });',
};

interface RealmProbe {
  id: string;
  inits: number;
}

interface LifecycleEvent {
  kind: 'init' | 'pagehide';
  realm: string;
}

type ProbeWindow = Window & {
  __pr03Realm: RealmProbe;
  __pr03Record(event: LifecycleEvent): Promise<void>;
  __pr03QueueParking?: Promise<{
    waiting: number;
    expired: boolean;
    status: string | null | undefined;
    notice: string | null | undefined;
  }>;
  __pr03ReplyGate: {
    hold: boolean;
    waiting: number;
    expired: boolean;
    holdFor(): void;
    release(): void;
  };
};

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

async function observeRuntime(page: Page, holdInit = false) {
  const lifecycle: LifecycleEvent[] = [];
  const workers: Array<{ nonce: Promise<string>; closed: boolean }> = [];
  await page.exposeFunction('__pr03Record', (event: LifecycleEvent) => {
    lifecycle.push(event);
  });
  await page.addInitScript(
    ({ holdInit }) => {
      const target = window as ProbeWindow;
      target.__pr03Realm = {
        id: Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'),
        inits: 0,
      };
      const held: Array<() => void> = [];
      let holdMilliseconds = holdInit ? 3_500 : 750;
      let timer: ReturnType<typeof setTimeout> | undefined;
      target.__pr03ReplyGate = {
        hold: holdInit,
        waiting: 0,
        expired: false,
        holdFor() {
          this.release();
          this.expired = false;
          this.hold = true;
          holdMilliseconds = 750;
        },
        release() {
          clearTimeout(timer);
          timer = undefined;
          this.hold = false;
          this.waiting = 0;
          for (const deliver of held.splice(0)) deliver();
        },
      };
      window.addEventListener('pagehide', () => {
        void target
          .__pr03Record({ kind: 'pagehide', realm: target.__pr03Realm.id })
          .catch(() => {});
      });
      if (typeof Worker === 'undefined') return;
      const onmessage = Object.getOwnPropertyDescriptor(
        Worker.prototype,
        'onmessage',
      )!;
      Object.defineProperty(Worker.prototype, 'onmessage', {
        configurable: true,
        get: onmessage.get,
        set(this: Worker, listener: Worker['onmessage']) {
          onmessage.set!.call(
            this,
            listener &&
              ((event: MessageEvent) => {
                if (target.__pr03ReplyGate.hold) {
                  if (!held.length)
                    timer = setTimeout(() => {
                      target.__pr03ReplyGate.expired = true;
                      target.__pr03ReplyGate.release();
                    }, holdMilliseconds);
                  held.push(() => listener.call(this, event));
                  target.__pr03ReplyGate.waiting = held.length;
                } else listener.call(this, event);
              }),
          );
        },
      });
      const postMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (
        this: Worker,
        ...args: Parameters<Worker['postMessage']>
      ) {
        const message = args[0] as { type?: unknown } | null;
        if (message && typeof message === 'object' && message.type === 'init') {
          target.__pr03Realm.inits += 1;
          void target
            .__pr03Record({ kind: 'init', realm: target.__pr03Realm.id })
            .catch(() => {});
        }
        return Reflect.apply(postMessage, this, args);
      };
    },
    { holdInit },
  );
  page.on('worker', (worker) => {
    const record = {
      nonce: worker
        .evaluate(() => {
          const target = globalThis as typeof globalThis & {
            __pr03Worker?: string;
          };
          target.__pr03Worker ??= Array.from(
            crypto.getRandomValues(new Uint32Array(4)),
          ).join('-');
          return target.__pr03Worker;
        })
        .catch(() => {
          record.closed = true;
          return '';
        }),
      closed: false,
    };
    worker.on('close', () => {
      record.closed = true;
    });
    workers.push(record);
  });
  const liveWorkerNonces = async () => {
    const values = await Promise.all(
      workers.map(async (record) => ({ record, nonce: await record.nonce })),
    );
    return values
      .filter(({ record, nonce }) => !record.closed && nonce !== '')
      .map(({ nonce }) => nonce);
  };
  return {
    lifecycle,
    workers,
    liveWorkerNonces,
    async snapshot(app: FrameLocator | Frame) {
      const realm = await app.locator('body').evaluate(() => {
        const target = window as ProbeWindow;
        return target.__pr03Realm;
      });
      return {
        realm,
        workerNonces: await liveWorkerNonces(),
        workersCreated: workers.length,
        workersClosed: workers.filter((worker) => worker.closed).length,
        pagehides: lifecycle.filter((event) => event.kind === 'pagehide'),
      };
    },
  };
}

async function openCards(
  page: Page,
  testInfo: TestInfo,
  {
    count = 1,
    virtualized = false,
    moveBefore = true,
    dataMode = false,
    holdInit = false,
    history = false,
  } = {},
) {
  await page.setViewportSize({ width: history ? 1600 : 1280, height: 900 });
  await page.route('**/workspace/models', (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  const probe = await observeRuntime(page, holdInit);
  if (!moveBefore) {
    await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, 'moveBefore', {
        value: undefined,
        configurable: true,
      });
    });
  }
  const earlier = virtualized
    ? Array.from({ length: 120 }, (_, index) => [
        userTextEvent(`Earlier question ${index}`, { id: index * 2 + 1 }),
        assistantTextEvent(`Earlier answer ${index}`, { id: index * 2 + 2 }),
      ]).flat()
    : [];
  const firstId = earlier.length + 1;
  const scenario = createWebShellDaemonScenario({
    sessionId: 'generated-ui-retention',
    state: { _meta: { generatedUi: { version: 1, enabled: true } } },
    events: [
      ...earlier,
      history
        ? {
            v: 1,
            id: firstId,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: {
                  type: 'text',
                  text: 'Show a retained parameter view.',
                },
                _meta: {
                  'qwen.session.recordId': 'retention-live-record',
                  qwenTranscript: {
                    sourceRecordIds: ['retention-live-record'],
                  },
                },
              },
            },
          }
        : userTextEvent('Show a retained parameter view.', { id: firstId }),
      ...Array.from({ length: count }, (_, index) =>
        toolCallEvent(
          `generated-retention-${index}`,
          'mcp__generated-ui__generated_ui_show',
          input,
          {
            id: firstId + index + 1,
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
      turnCompleteEvent('retained', { id: firstId + count + 1 }),
    ],
  });
  if (history)
    scenario.capabilities.features.push(
      'session_turn_navigation',
      'session_transcript_pagination',
    );
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  let eventEpoch = 'generated-ui-retention-epoch-1';
  let loadCount = 0;
  // HTTP/SSE data are fixtures. React, transcript projection, the cross-origin
  // sandbox, fixed App, bridge, and QuickJS Worker are production components.
  await page.route('**/session/*/load', (route) => {
    loadCount += 1;
    return route.fulfill({
      json: {
        sessionId: scenario.sessionId,
        clientId: scenario.clientId,
        workspaceCwd: scenario.workspaceCwd,
        eventEpoch,
        attached: true,
        createdAt: '2026-10-26T00:00:00.000Z',
        hasActivePrompt: false,
        generatedUi: scenario.state._meta?.['generatedUi'],
        state: scenario.state,
        compactedReplay: scenario.events,
        liveJournal: [],
        lastEventId: firstId + count + 1,
        ...(history
          ? {
              historyHasMore: true,
              historyAnchorRecordId: 'retention-live-record',
            }
          : {}),
      },
    });
  });
  if (history) {
    await page.route('**/session/*/turn-index*', (route) =>
      route.fulfill({
        json: {
          v: 1,
          sessionId: scenario.sessionId,
          snapshot: 'retention-history',
          totalTurns: 4,
          start: 0,
          turns: Array.from({ length: 4 }, (_, ordinal) => ({
            ordinal,
            turnId:
              ordinal === 3
                ? 'retention-live-record'
                : `retention-old-${ordinal}`,
            kind: 'prompt',
            label: `Retained history ${ordinal}`,
          })),
        },
      }),
    );
    await page.route('**/session/*/transcript*', (route) => {
      const at = new URL(route.request().url()).searchParams.get('atRecordId');
      // The initial underfill request must not prepend the navigation target
      // into the live list; the anchored request below rebuilds MessageList.
      if (!at)
        return route.fulfill({
          json: {
            v: 1,
            sessionId: scenario.sessionId,
            events: [],
            hasMore: false,
          },
        });
      return route.fulfill({
        json: {
          v: 1,
          sessionId: scenario.sessionId,
          hasMore: false,
          hasOlder: false,
          targetRecordId: at,
          events: [
            {
              v: 1,
              id: 1,
              type: 'session_update',
              data: {
                update: {
                  sessionUpdate: 'user_message_chunk',
                  content: {
                    type: 'text',
                    text: 'An earlier retained-history question.',
                  },
                  _meta: {
                    'qwen.session.recordId': at,
                    qwenTranscript: { sourceRecordIds: [at] },
                  },
                },
              },
            },
            {
              v: 1,
              id: 2,
              type: 'session_update',
              data: {
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: {
                    type: 'text',
                    text: 'An earlier retained-history answer.',
                  },
                  _meta: {
                    'qwen.session.recordId': `${at}-answer`,
                    qwenTranscript: { sourceRecordIds: [`${at}-answer`] },
                  },
                },
              },
            },
          ],
        },
      });
    });
  }
  await page.route('**/mcp-app-sandbox?*', async (route) => {
    const requested = new URL(route.request().url());
    if (dataMode) requested.searchParams.set('mode', 'data');
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
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  const cards = page.locator(frameSelector);
  const scroll = page.locator('[data-web-shell-message-list]');
  const visibleCards = scroll.locator(frameSelector);
  const app = (index = 0) =>
    cards.nth(index).contentFrame().frameLocator('iframe');
  await expect(cards).toHaveCount(count);
  for (let index = 0; index < count; index++) {
    await expect(app(index).locator('#status')).toHaveAttribute(
      'data-state',
      holdInit ? 'starting' : 'ready',
    );
  }
  await expect.poll(() => probe.workers.length).toBe(count);
  return {
    daemon,
    scenario,
    probe,
    cards,
    visibleCards,
    scroll,
    app,
    loadCount: () => loadCount,
    changeEpoch: () => {
      eventEpoch = 'generated-ui-retention-epoch-2';
    },
    async park() {
      await scroll.hover({ position: { x: 10, y: 10 } });
      await page.mouse.wheel(0, -100_000);
      await expect(visibleCards).toHaveCount(0);
    },
    async returnToCard() {
      await scroll.hover({ position: { x: 10, y: 10 } });
      await page.mouse.wheel(0, 100_000);
      await expect(visibleCards).toHaveCount(count);
      await visibleCards.last().scrollIntoViewIfNeeded();
    },
  };
}

// Reads the parameters the continue action would send, without sending:
// the prompt is refused at the daemon boundary, so the card reports that
// nothing was sent and stays available.
async function reviewSnapshot(page: Page, app: FrameLocator) {
  let text: string | undefined;
  const capture = async (route: Route) => {
    const body = route.request().postDataJSON() as {
      prompt: Array<{ text: string }>;
    };
    text = body.prompt[0].text;
    await route.fulfill({ status: 409, json: { error: 'captured by test' } });
  };
  await page.route('**/session/*/prompt', capture);
  try {
    await app.locator('#continue-analysis').click();
    await expect.poll(() => text).toBeDefined();
    await expect(app.locator('#continuation-status')).toContainText(
      'Not sent.',
    );
  } finally {
    await page.unroute('**/session/*/prompt', capture);
  }
  const payload = JSON.parse(
    text!.slice(text!.indexOf('{'), text!.lastIndexOf('}') + 1),
  ) as {
    snapshot: { documentId: string; activationId: string };
    rejectedEvents: number;
  };
  await expect(app.locator('#continue-analysis')).toBeEnabled();
  return { ...payload.snapshot, rejectedEvents: payload.rejectedEvents };
}

interface HostRpcReply {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  error?: { code: number; message: string };
  timedOut?: boolean;
}

async function appRpc(
  app: FrameLocator | Frame,
  method: 'ui/message' | 'tools/call',
  params: Record<string, unknown>,
): Promise<HostRpcReply> {
  // This adversarial request tests the real host lease. It is sent from the
  // actual fixed App through its sandbox proxy, not used to click hidden UI.
  return app.locator('body').evaluate(
    (_body, { method, params }) =>
      new Promise<HostRpcReply>((resolve) => {
        const id = `pr03-visibility-${Array.from(
          crypto.getRandomValues(new Uint32Array(4)),
        ).join('-')}`;
        const listener = (event: MessageEvent) => {
          if (event.source !== window.parent || event.data?.id !== id) return;
          window.removeEventListener('message', listener);
          clearTimeout(timer);
          resolve(event.data as HostRpcReply);
        };
        const timer = setTimeout(() => {
          window.removeEventListener('message', listener);
          resolve({ timedOut: true });
        }, 3000);
        window.addEventListener('message', listener);
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      }),
    { method, params },
  );
}

async function openNavigationPage(page: Page, name: string) {
  await page
    .locator('[data-web-shell-navigation-rail]')
    .getByRole('button', { name: 'More', exact: true })
    .click();
  await page
    .locator('[data-web-shell-sidebar-more]')
    .getByRole('button', { name, exact: true })
    .click();
}

const hiddenMessage = {
  role: 'user',
  content: [
    {
      type: 'text',
      text: 'Hidden Generated UI must not obtain host review or dispatch authority.',
    },
  ],
};

test('retains the actual App and Worker across virtual row unmounts @smoke', async ({
  page,
}, testInfo) => {
  const fixture = await openCards(page, testInfo, { virtualized: true });
  const { app, cards, probe, daemon } = fixture;
  const view = app().frameLocator('#view');
  await cards.first().scrollIntoViewIfNeeded();
  expect(
    await app()
      .locator('body')
      .evaluate(() => {
        try {
          return !!window.top?.document;
        } catch {
          return false;
        }
      }),
  ).toBe(false);
  await view.locator('#rate').fill('7');
  await view.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(view.locator('#answer')).toHaveText('1:7');
  await view.getByRole('button', { name: 'Insert controls' }).click();
  await view.locator('#two').check();
  await view.locator('#choice').selectOption('b');
  await view.locator('#rate').fill('9');
  await expect(app().locator('#status')).toHaveAttribute('data-state', 'dirty');
  const before = await probe.snapshot(app());
  expect(before.realm.inits).toBe(1);
  expect(before.workerNonces).toHaveLength(1);
  await fixture.park();
  await expect(cards).toHaveCount(1);
  await expect(cards).toBeHidden();
  expect(daemon.promptRequests()).toHaveLength(0);
  await fixture.returnToCard();
  expect(await probe.snapshot(app())).toEqual(before);
  await expect(view.locator('#rate')).toHaveValue('9');
  await expect(view.locator('#two')).toBeChecked();
  await expect(view.locator('#one')).not.toBeChecked();
  await expect(view.locator('#choice')).toHaveValue('b');
  await expect(app().locator('#continue-analysis')).toBeDisabled();
  await view.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(view.locator('#answer')).toHaveText('2:9');
  await expect(app().locator('#continue-analysis')).toBeEnabled();
  await testInfo.attach('retained-runtime-identities', {
    body: JSON.stringify(
      { before, after: await probe.snapshot(app()) },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  expect(daemon.promptRequests()).toHaveLength(0);
});

for (const { status, stopped } of [
  { status: 404, stopped: false },
  { status: 401, stopped: false },
  { status: 401, stopped: true },
  { status: 503, stopped: false },
]) {
  test(`handles retained ${stopped ? 'stopped ' : ''}App and Worker lifetime after load returns ${status} @smoke`, async ({
    page,
  }, testInfo) => {
    const { app, cards, probe, daemon, scenario } = await openCards(
      page,
      testInfo,
    );
    const view = app().frameLocator('#view');
    await view.locator('#rate').fill('7');
    await view.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(view.locator('#answer')).toHaveText('1:7');
    await view.locator('#rate').fill('9');
    await expect(app().locator('#status')).toHaveAttribute(
      'data-state',
      'dirty',
    );
    if (stopped) {
      await app().locator('#stop').click();
      await expect(app().locator('#status')).toHaveAttribute(
        'data-state',
        'stopped',
      );
      await expect
        .poll(() => probe.workers.filter(({ closed }) => closed).length)
        .toBe(1);
    }
    const before = await probe.snapshot(app());
    const mainRealm = await page.evaluate(
      () => (window as ProbeWindow).__pr03Realm.id,
    );

    await page.route('**/session/previous-session/load', (route) =>
      route.fulfill({
        json: {
          sessionId: 'previous-session',
          clientId: scenario.clientId,
          workspaceCwd: scenario.workspaceCwd,
          eventEpoch: 'generated-ui-retention-epoch-1',
          attached: true,
          hasActivePrompt: false,
          state: scenario.state,
          generatedUi: scenario.state._meta?.['generatedUi'],
          compactedReplay: [],
          liveJournal: [],
          lastEventId: 0,
        },
      }),
    );
    const sidebar = page.locator('[data-sidebar-shell]');
    await sidebar.getByText('Previous Session', { exact: true }).click();
    await daemon.sse.waitForConnection('previous-session');
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId: 'previous-session' }),
    );
    await expect(page).toHaveURL(/\/session\/previous-session/);
    await expect(cards).toHaveCount(1);
    await expect(cards).toBeHidden();
    expect(await probe.snapshot(app())).toEqual(before);

    const failurePath = `/session/${scenario.sessionId}/load`;
    const errorMessage = `Retention load failure ${status}`;
    await page.route(`**${failurePath}`, (route) =>
      route.fulfill({ status, json: { error: errorMessage } }),
    );
    const failedLoad = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === failurePath &&
        response.request().method() === 'POST',
    );
    await sidebar.getByText(scenario.displayName, { exact: true }).click();
    expect((await failedLoad).status()).toBe(status);
    await expect(page.getByText(errorMessage).first()).toBeVisible();
    if (status === 503) {
      await expect(cards).toHaveCount(1);
      await expect(cards).toBeHidden();
      expect(await probe.snapshot(app())).toEqual(before);
      await expect(view.locator('#rate')).toHaveValue('9');
      await expect(view.locator('#answer')).toHaveText('1:7');
    } else {
      await expect(cards).toHaveCount(0);
      await expect
        .poll(() => probe.workers.every(({ closed }) => closed))
        .toBe(true);
    }
    await page.unroute(`**${failurePath}`);
    await sidebar.getByText('Previous Session', { exact: true }).click();
    await daemon.sse.waitForConnection('previous-session');
    const priorConnections = await daemon.sse.connections();
    await sidebar.getByText(scenario.displayName, { exact: true }).click();
    await expect
      .poll(async () =>
        (await daemon.sse.connections()).some(
          (connection) =>
            connection.sessionId === scenario.sessionId &&
            !priorConnections.some(
              (prior) =>
                prior.url === connection.url &&
                prior.connectedAt === connection.connectedAt,
            ),
        ),
      )
      .toBe(true);
    await daemon.sendEvent(
      replayCompleteEvent({
        sessionId: scenario.sessionId,
        replayedCount: scenario.events.length,
      }),
    );
    await expect(
      page.locator('[data-web-shell-composer-surface] .cm-content'),
    ).toBeEditable();
    if (status === 503) {
      await expect(cards).toBeVisible();
      expect(await probe.snapshot(app())).toEqual(before);
      await expect(view.locator('#rate')).toHaveValue('9');
      await expect(view.locator('#answer')).toHaveText('1:7');
    } else {
      const reopen = page.getByRole('button', {
        name: 'Reopen interactive view',
        exact: true,
      });
      await expect(reopen).toBeVisible();
      await expect(cards).toHaveCount(0);
      await reopen.click();
      await expect(app().locator('#status')).toHaveAttribute(
        'data-state',
        'ready',
      );
      await expect(app().frameLocator('#view').locator('#rate')).toHaveValue(
        '2',
      );
      await expect(
        page.getByText(/Reopening starts from the original content/).first(),
      ).toBeVisible();
      expect((await probe.snapshot(app())).realm.id).not.toBe(before.realm.id);
    }
    expect(
      await page.evaluate(() => (window as ProbeWindow).__pr03Realm.id),
    ).toBe(mainRealm);
    expect(daemon.promptRequests()).toHaveLength(0);
  });
}

test('folding preserves state and returns keyboard focus at narrow width @smoke', async ({
  page,
}, testInfo) => {
  const { app, cards, probe, scroll, daemon } = await openCards(page, testInfo);
  await page.setViewportSize({ width: 375, height: 900 });
  await cards.first().scrollIntoViewIfNeeded();
  await app().frameLocator('#view').locator('#rate').fill('6');
  const before = await probe.snapshot(app());
  const collapse = scroll.getByTitle('Collapse', { exact: true }).first();
  await collapse.click();
  await expect(cards).toBeHidden();
  await expect(cards).toHaveCount(1);
  expect(
    await cards.evaluate((frame) => frame.closest('[inert]') !== null),
  ).toBe(true);
  const expand = scroll.getByTitle('Expand', { exact: true }).first();
  await expect(expand).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cards).toBeVisible();
  await expect(collapse).toBeFocused();
  expect(await probe.snapshot(app())).toEqual(before);
  await expect(app().frameLocator('#view').locator('#rate')).toHaveValue('6');
  await expect(app().locator('#continue-analysis')).toBeDisabled();
  const bounds = await cards.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  const screenshot = testInfo.outputPath('retained-card-narrow.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Retained card at 375px', {
    path: screenshot,
    contentType: 'image/png',
  });
  expect(daemon.promptRequests()).toHaveLength(0);
  await page.close();
  await expect
    .poll(() => probe.workers.every(({ closed }) => closed))
    .toBe(true);
});

test('New task parks the same App and Worker and revokes host authority @smoke', async ({
  page,
}, testInfo) => {
  const { app, cards, probe, daemon, scenario } = await openCards(
    page,
    testInfo,
  );
  const view = app().frameLocator('#view');
  await view.locator('#rate').fill('7');
  await view.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(view.locator('#answer')).toHaveText('1:7');
  await view.locator('#rate').fill('9');
  const before = await probe.snapshot(app());
  await page
    .getByRole('button', { name: 'New session', exact: true })
    .first()
    .click();
  await expect(cards).toBeHidden();
  expect(
    (await appRpc(app(), 'ui/message', hiddenMessage)).result?.isError,
  ).toBe(true);
  expect(await probe.snapshot(app())).toEqual(before);
  await page
    .locator('[data-sidebar-shell]')
    .getByText(scenario.displayName, { exact: true })
    .click();
  await daemon.sse.waitForConnection(scenario.sessionId);
  await expect(cards).toBeVisible();
  expect(await probe.snapshot(app())).toEqual(before);
  await expect(view.locator('#rate')).toHaveValue('9');
  await expect(view.locator('#answer')).toHaveText('1:7');
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('a missing session leaves the previous App parked without host authority @smoke', async ({
  page,
}, testInfo) => {
  const { app, cards, probe, daemon } = await openCards(page, testInfo);
  await app().frameLocator('#view').locator('#rate').fill('9');
  const before = await probe.snapshot(app());
  const calls: string[] = [];
  await page.route('**/session/*/mcp-app/tools/call', (route) => {
    calls.push(route.request().url());
    return route.fulfill({ json: { content: [] } });
  });
  await page.route('**/session/previous-session/load', (route) =>
    route.fulfill({ status: 404, json: { error: 'Session not found' } }),
  );
  await page
    .locator('[data-sidebar-shell]')
    .getByText('Previous Session', { exact: true })
    .click();
  await expect(page.locator('[class*="missingSessionState"]')).toBeVisible();
  await expect(cards).toBeHidden();
  expect(
    (
      await appRpc(app(), 'tools/call', {
        name: 'generated_ui_show',
        arguments: input,
      })
    ).error,
  ).toBeDefined();
  expect(
    (await appRpc(app(), 'ui/message', hiddenMessage)).result?.isError,
  ).toBe(true);
  expect(calls).toEqual([]);
  expect(daemon.promptRequests()).toHaveLength(0);
  expect(await probe.snapshot(app())).toEqual(before);
});

test('a fullscreen artifact panel revokes split-card authority without rebuilding it @smoke', async ({
  page,
}, testInfo) => {
  const { app, cards, probe, daemon, scenario } = await openCards(
    page,
    testInfo,
  );
  const calls: string[] = [];
  await page.route('**/session/*/mcp-app/tools/call', (route) => {
    calls.push(route.request().url());
    return route.fulfill({
      json: { content: [{ type: 'text', text: 'visible tool' }] },
    });
  });
  await page
    .getByRole('button', { name: 'Toggle right panel', exact: true })
    .click();
  await openNavigationPage(page, 'Split View');
  const pane = page
    .getByTestId('split-view')
    .locator(`[data-pane-session-id="${scenario.sessionId}"]`);
  await expect(pane.locator(frameSelector)).toBeVisible();
  await app().frameLocator('#view').locator('#rate').fill('9');
  const before = await probe.snapshot(app());
  const tool = { name: 'generated_ui_show', arguments: input };
  expect(
    (await appRpc(app(), 'tools/call', tool)).result?.content?.[0]?.text,
  ).toBe('visible tool');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Exit fullscreen', exact: true }),
  ).toBeVisible();
  await expect(cards).toBeHidden();
  expect((await appRpc(app(), 'tools/call', tool)).error).toBeDefined();
  expect(
    (await appRpc(app(), 'ui/message', hiddenMessage)).result?.isError,
  ).toBe(true);
  expect(calls).toHaveLength(1);
  expect(daemon.promptRequests()).toHaveLength(0);
  expect(await probe.snapshot(app())).toEqual(before);
  await page
    .getByRole('button', { name: 'Exit fullscreen', exact: true })
    .click();
  await expect(pane.locator(frameSelector)).toBeVisible();
  expect(await probe.snapshot(app())).toEqual(before);
  await expect(app().frameLocator('#view').locator('#rate')).toHaveValue('9');
});

test('the reply gate automatically releases before the event watchdog', async ({
  page,
}, testInfo) => {
  const { app, probe } = await openCards(page, testInfo);
  const before = await probe.snapshot(app());
  await app()
    .locator('body')
    .evaluate(() => (window as ProbeWindow).__pr03ReplyGate.holdFor());
  await app()
    .frameLocator('#view')
    .getByRole('button', { name: 'Apply', exact: true })
    .click();
  await expect
    .poll(() =>
      app()
        .locator('body')
        .evaluate(() => {
          const gate = (window as ProbeWindow).__pr03ReplyGate;
          return {
            hold: gate.hold,
            waiting: gate.waiting,
            expired: gate.expired,
          };
        }),
    )
    .toEqual({ hold: false, waiting: 0, expired: true });
  await expect(app().locator('#status')).toHaveAttribute('data-state', 'ready');
  expect(
    await app()
      .locator('body')
      .evaluate(() => (window as ProbeWindow).__pr03ReplyGate.expired),
  ).toBe(true);
  expect(await probe.snapshot(app())).toEqual(before);
});

test('history navigation rebuilds MessageList without rebuilding the live card @smoke', async ({
  page,
}, testInfo) => {
  const fixture = await openCards(page, testInfo, { history: true });
  const { app, cards, probe, daemon } = fixture;
  await cards.first().scrollIntoViewIfNeeded();
  await app().frameLocator('#view').locator('#rate').fill('23');
  const before = await probe.snapshot(app());
  const navigation = page.locator('[data-global-turn-navigation]');
  await expect(navigation).toBeVisible();
  await navigation.locator('[data-turn-ordinal="0"]').click();
  await expect(
    page.locator('[data-history-viewport="historical"]'),
  ).toContainText('An earlier retained-history answer.');
  await expect(
    page.locator('[data-history-viewport="historical"]').locator(frameSelector),
  ).toHaveCount(0);
  await expect(cards).toHaveCount(1);
  await expect(cards).toBeHidden();
  await page
    .getByRole('button', { name: 'Scroll to bottom', exact: true })
    .click();
  await expect(
    page.locator('[data-history-viewport="live"]').locator(frameSelector),
  ).toHaveCount(1);
  await cards.first().scrollIntoViewIfNeeded();
  expect(await probe.snapshot(app())).toEqual(before);
  await expect(app().frameLocator('#view').locator('#rate')).toHaveValue('23');
  await expect(app().locator('#continue-analysis')).toBeDisabled();
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('a real initialization reply can finish while its frame is parked', async ({
  page,
}, testInfo) => {
  const fixture = await openCards(page, testInfo, {
    virtualized: true,
    holdInit: true,
  });
  const { app, cards, probe, daemon } = fixture;
  await expect
    .poll(() =>
      app()
        .locator('body')
        .evaluate(() => (window as ProbeWindow).__pr03ReplyGate.waiting),
    )
    .toBe(1);
  const before = await probe.snapshot(app());
  expect(before.realm.inits).toBe(1);
  await fixture.park();
  await expect(cards).toHaveCount(1);
  const heldAtParking = await app()
    .locator('body')
    .evaluate(() => {
      const gate = (window as ProbeWindow).__pr03ReplyGate;
      const result = { waiting: gate.waiting, expired: gate.expired };
      gate.release();
      return result;
    });
  expect(
    heldAtParking.expired,
    'Initialization gate expired before parking',
  ).toBe(false);
  expect(heldAtParking.waiting).toBe(1);
  await expect(app().locator('#status')).toHaveAttribute('data-state', 'ready');
  await fixture.returnToCard();
  expect(await probe.snapshot(app())).toEqual(before);
  await app()
    .frameLocator('#view')
    .getByRole('button', { name: 'Apply', exact: true })
    .click();
  await expect(app().frameLocator('#view').locator('#answer')).toHaveText(
    '1:2',
  );
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('parking with a full queue preserves admitted work and rejected-event count', async ({
  page,
}, testInfo) => {
  const fixture = await openCards(page, testInfo, { virtualized: true });
  const { app, cards, probe, daemon, visibleCards } = fixture;
  await cards.first().scrollIntoViewIfNeeded();
  const before = await probe.snapshot(app());
  await app()
    .locator('body')
    .evaluate(() => {
      const target = window as Window & { __pr03ApplyClicks: number };
      target.__pr03ApplyClicks = 0;
      // Register from the fixed App: #view deliberately disallows scripts.
      const body =
        document.querySelector<HTMLIFrameElement>('#view')!.contentDocument!
          .body;
      body.addEventListener('click', (event) => {
        if (
          event.isTrusted &&
          (event.target as Element | null)?.closest('#apply')
        ) {
          target.__pr03ApplyClicks++;
          if (target.__pr03ApplyClicks === 18)
            window.top!.postMessage({ type: 'pr03-park-queue' }, '*');
        }
      });
    });
  // Keep cross-origin parking and reply delivery within the browser's budget.
  await page.evaluate((selector) => {
    const frame = document.querySelector(selector)!;
    const park = (event: MessageEvent) => {
      if (event.data?.type !== 'pr03-park-queue') return;
      window.removeEventListener('message', park);
      const observer = new MutationObserver(() => {
        if (frame.closest('[data-generated-ui-parking]')) {
          observer.disconnect();
          (event.source as Window).postMessage(
            { type: 'pr03-queue-parked' },
            '*',
          );
        }
      });
      observer.observe(document, { childList: true, subtree: true });
      document.querySelector<HTMLElement>(
        '[data-web-shell-message-list]',
      )!.scrollTop = 0;
    };
    window.addEventListener('message', park);
  }, frameSelector);
  await app()
    .locator('body')
    .evaluate(() => {
      const target = window as ProbeWindow;
      target.__pr03QueueParking = new Promise((resolve) => {
        const parked = (event: MessageEvent) => {
          if (
            event.source !== window.top ||
            event.data?.type !== 'pr03-queue-parked'
          )
            return;
          window.removeEventListener('message', parked);
          const gate = target.__pr03ReplyGate;
          const result = {
            waiting: gate.waiting,
            expired: gate.expired,
            status: document
              .querySelector('#status')
              ?.getAttribute('data-state'),
            notice: document.querySelector('#notice')?.textContent,
          };
          gate.release();
          resolve(result);
        };
        window.addEventListener('message', parked);
      });
      target.__pr03ReplyGate.holdFor();
    });
  // Delay delivery only: the real Worker computes its unchanged response.
  // Native clicks fill the existing one-in-flight + 16 waiting queue.
  await app()
    .frameLocator('#view')
    .getByRole('button', { name: 'Apply', exact: true })
    .click({ clickCount: 20 });
  const heldAtParking = await app()
    .locator('body')
    .evaluate(() => (window as ProbeWindow).__pr03QueueParking!);
  expect(heldAtParking.status).toBe('running');
  expect(heldAtParking.notice).toContain('queue was full');
  expect(
    heldAtParking.expired,
    'Reply gate expired before parking completed',
  ).toBe(false);
  expect(heldAtParking.waiting).toBeGreaterThan(0);
  await expect(visibleCards).toHaveCount(0);
  const deliveredClicks = await app()
    .locator('body')
    .evaluate(() => {
      return (window as Window & { __pr03ApplyClicks: number })
        .__pr03ApplyClicks;
    });
  await testInfo.attach('native-click-admission', {
    body: JSON.stringify({ requestedClicks: 20, deliveredClicks }),
    contentType: 'application/json',
  });
  // The queue notice changes the frame's layout mid-burst. Count actual
  // trusted clicks reaching Apply instead of assuming every mouse-up hits it.
  expect(deliveredClicks).toBeGreaterThan(17);
  await expect(app().locator('#status')).toHaveAttribute('data-state', 'ready');
  await fixture.returnToCard();
  expect(await probe.snapshot(app())).toEqual(before);
  await expect(app().frameLocator('#view').locator('#answer')).toHaveText(
    '17:2',
  );
  await expect(app().locator('#notice')).toContainText('queue was full');
  const capture = await reviewSnapshot(page, app());
  expect(capture.rejectedEvents).toBe(deliveredClicks - 17);
  await fixture.park();
  await fixture.returnToCard();
  expect(await probe.snapshot(app())).toEqual(before);
  await expect(app().frameLocator('#view').locator('#answer')).toHaveText(
    '17:2',
  );
  const returnedCapture = await reviewSnapshot(page, app());
  expect(returnedCapture).toEqual(capture);
  await testInfo.attach('retained-queue-captures', {
    body: JSON.stringify({ deliveredClicks, capture, returnedCapture }),
    contentType: 'application/json',
  });
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('retains the opaque data-mode App and its Worker across parking', async ({
  page,
}, testInfo) => {
  const fixture = await openCards(page, testInfo, {
    virtualized: true,
    dataMode: true,
  });
  const { app, cards, probe, daemon } = fixture;
  await cards.first().scrollIntoViewIfNeeded();
  expect(
    await app()
      .locator('body')
      .evaluate(() => window.origin),
  ).toBe('null');
  await app().frameLocator('#view').locator('#rate').fill('17');
  const before = await probe.snapshot(app());
  expect(before.realm.inits).toBe(1);
  await fixture.park();
  await fixture.returnToCard();
  expect(await probe.snapshot(app())).toEqual(before);
  await expect(app().frameLocator('#view').locator('#rate')).toHaveValue('17');
  await expect(app().locator('#continue-analysis')).toBeDisabled();
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('parking a fifth card evicts only the oldest runtime and requires reopening', async ({
  page,
}, testInfo) => {
  const fixture = await openCards(page, testInfo, {
    count: 5,
    virtualized: true,
  });
  const { app, cards, probe, daemon, scroll, visibleCards } = fixture;
  const siblingRealms: RealmProbe[] = [];
  for (let index = 0; index < 5; index++) {
    await cards.nth(index).scrollIntoViewIfNeeded();
    await app(index)
      .frameLocator('#view')
      .locator('#rate')
      .fill(String(index + 3));
    if (index > 0) siblingRealms.push((await probe.snapshot(app(index))).realm);
  }
  await fixture.park();
  await expect(cards).toHaveCount(4);
  await expect
    .poll(() => probe.workers.filter(({ closed }) => closed).length)
    .toBe(1);
  expect(probe.workers).toHaveLength(5);
  await scroll.hover({ position: { x: 10, y: 10 } });
  await page.mouse.wheel(0, 100_000);
  await expect(visibleCards).toHaveCount(4);
  const reopen = page.getByRole('button', { name: /Reopen interactive view/i });
  await expect(reopen).toHaveCount(1);
  for (let index = 0; index < 4; index++) {
    await expect(app(index).frameLocator('#view').locator('#rate')).toHaveValue(
      String(index + 4),
    );
  }
  await reopen.scrollIntoViewIfNeeded();
  await reopen.click();
  await expect(cards).toHaveCount(5);
  await expect(app().locator('#status')).toHaveAttribute('data-state', 'ready');
  await expect(app().frameLocator('#view').locator('#rate')).toHaveValue('2');
  await expect.poll(() => probe.workers.length).toBe(6);
  for (let index = 0; index < 4; index++) {
    expect((await probe.snapshot(app(index + 1))).realm).toEqual(
      siblingRealms[index],
    );
    await expect(
      app(index + 1)
        .frameLocator('#view')
        .locator('#rate'),
    ).toHaveValue(String(index + 4));
  }
  expect(probe.workers).toHaveLength(6);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('parking never repeats an accepted request', async ({
  page,
}, testInfo) => {
  const fixture = await openCards(page, testInfo, { virtualized: true });
  const { app, cards, daemon, scenario, probe } = fixture;
  await cards.first().scrollIntoViewIfNeeded();
  const before = await probe.snapshot(app());
  await app().frameLocator('#view').locator('#rate').fill('12');
  await app()
    .frameLocator('#view')
    .getByRole('button', {
      name: 'Apply',
      exact: true,
    })
    .click();
  await app().locator('#continue-analysis').click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  const request = daemon.promptRequests()[0];
  expect(request.path).toBe(`/session/${scenario.sessionId}/prompt`);
  expect(JSON.stringify(request.body)).toContain('\\"12\\"');
  await expect(app().locator('#continuation-status')).toHaveAttribute(
    'data-state',
    'accepted',
  );
  await fixture.park();
  expect(daemon.promptRequests()).toHaveLength(1);
  await fixture.returnToCard();
  await expect(app().locator('#continuation-status')).toHaveAttribute(
    'data-state',
    'accepted',
  );
  expect((await probe.snapshot(app())).realm).toEqual(before.realm);
  expect(daemon.promptRequests()).toHaveLength(1);
});

test('identical content from different tool calls has separate activations and state @smoke', async ({
  page,
}, testInfo) => {
  const { app, cards, probe, daemon } = await openCards(page, testInfo, {
    count: 2,
  });
  await cards.nth(0).scrollIntoViewIfNeeded();
  const first = await reviewSnapshot(page, app(0));
  const firstRealm = (await probe.snapshot(app(0))).realm;
  await app(0).frameLocator('#view').locator('#rate').fill('11');
  await cards.nth(1).scrollIntoViewIfNeeded();
  const second = await reviewSnapshot(page, app(1));
  const secondRealm = (await probe.snapshot(app(1))).realm;
  expect(first.documentId).toBe(second.documentId);
  expect(first.activationId).not.toBe(second.activationId);
  expect(firstRealm.id).not.toBe(secondRealm.id);
  expect(new Set(await probe.liveWorkerNonces()).size).toBe(2);
  await expect(app(1).frameLocator('#view').locator('#rate')).toHaveValue('2');
  await cards.nth(0).scrollIntoViewIfNeeded();
  await expect(app(0).frameLocator('#view').locator('#rate')).toHaveValue('11');
  expect(daemon.promptRequests()).toHaveLength(0);
});

for (const terminal of ['stopped', 'error'] as const) {
  test(`${terminal} stays terminal across parking until an explicit host reset @smoke`, async ({
    page,
  }, testInfo) => {
    const fixture = await openCards(page, testInfo, { virtualized: true });
    const { app, cards, probe, daemon } = fixture;
    await cards.first().scrollIntoViewIfNeeded();
    const oldSnapshot = await reviewSnapshot(page, app());
    const before = await probe.snapshot(app());
    if (terminal === 'stopped') await app().locator('#stop').click();
    else
      await app()
        .frameLocator('#view')
        .getByRole('button', {
          name: 'Fail runtime',
        })
        .click();
    await expect(app().locator('#status')).toHaveAttribute(
      'data-state',
      terminal,
    );
    await expect
      .poll(() => probe.workers.filter(({ closed }) => closed).length)
      .toBe(1);
    await fixture.park();
    await fixture.returnToCard();
    await expect(app().locator('#status')).toHaveAttribute(
      'data-state',
      terminal,
    );
    expect((await probe.snapshot(app())).realm).toEqual(before.realm);
    expect(probe.workers).toHaveLength(1);
    await page
      .getByRole('button', { name: 'Reopen and reset', exact: true })
      .click();
    await expect(app().locator('#status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await expect.poll(() => probe.workers.length).toBe(2);
    await cards.first().scrollIntoViewIfNeeded();
    const reopened = await reviewSnapshot(page, app());
    expect(reopened.activationId).not.toBe(oldSnapshot.activationId);
    expect((await probe.snapshot(app())).realm.id).not.toBe(before.realm.id);
    await expect(app().frameLocator('#view').locator('#answer')).toHaveText(
      '0:2',
    );
    expect(daemon.promptRequests()).toHaveLength(0);
  });
}

test('missing moveBefore offers an explicit cold start after a row unmount', async ({
  page,
}, testInfo) => {
  const fixture = await openCards(page, testInfo, {
    virtualized: true,
    moveBefore: false,
  });
  const { app, cards, probe, daemon, scroll } = fixture;
  await cards.first().scrollIntoViewIfNeeded();
  const before = await probe.snapshot(app());
  await app().frameLocator('#view').locator('#rate').fill('15');
  await fixture.park();
  await expect(cards).toHaveCount(0);
  await expect
    .poll(() => probe.workers.filter(({ closed }) => closed).length)
    .toBe(1);
  await scroll.hover({ position: { x: 10, y: 10 } });
  await page.mouse.wheel(0, 100_000);
  const reopen = page.getByRole('button', { name: /Reopen interactive view/i });
  await expect(reopen).toBeVisible();
  expect(probe.workers).toHaveLength(1);
  await reopen.click();
  await expect(app().locator('#status')).toHaveAttribute('data-state', 'ready');
  expect((await probe.snapshot(app())).realm.id).not.toBe(before.realm.id);
  await expect(app().frameLocator('#view').locator('#rate')).toHaveValue('2');
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('observed policy revocation releases a parked runtime without dispatch', async ({
  page,
}, testInfo) => {
  const fixture = await openCards(page, testInfo, { virtualized: true });
  const { daemon, scenario, cards, probe, scroll } = fixture;
  await fixture.park();
  await expect(cards).toHaveCount(1);
  scenario.state._meta = { generatedUi: { version: 1, enabled: false } };
  await daemon.sendEvent({
    v: 1,
    type: 'settings_changed',
    data: { key: 'mcp.allowed', scope: 'workspace', value: [] },
  });
  await expect(cards).toHaveCount(0);
  await expect
    .poll(() => probe.workers.filter(({ closed }) => closed).length)
    .toBe(1);
  await scroll.hover({ position: { x: 10, y: 10 } });
  await page.mouse.wheel(0, 100_000);
  await expect(page.getByText(input.summary, { exact: true })).toBeVisible();
  expect(probe.workers).toHaveLength(1);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('epoch reset never reattaches the previous runtime', async ({
  page,
}, testInfo) => {
  const fixture = await openCards(page, testInfo, { virtualized: true });
  const { daemon, cards, probe, scroll } = fixture;
  await cards.first().scrollIntoViewIfNeeded();
  await fixture.app().frameLocator('#view').locator('#rate').fill('19');
  const before = await probe.snapshot(fixture.app());
  await fixture.park();
  fixture.changeEpoch();
  const loads = fixture.loadCount();
  await daemon.sendEvent({
    v: 1,
    type: 'state_resync_required',
    data: { reason: 'epoch_reset' },
  });
  await expect.poll(fixture.loadCount).toBeGreaterThan(loads);
  await expect
    .poll(() => probe.workers.filter(({ closed }) => closed).length)
    .toBe(1);
  await scroll.hover({ position: { x: 10, y: 10 } });
  await page.mouse.wheel(0, 100_000);
  const reopen = page.getByRole('button', { name: /Reopen interactive view/i });
  await expect(reopen).toBeVisible();
  expect(probe.workers).toHaveLength(1);
  await reopen.click();
  await expect(fixture.app().locator('#status')).toHaveAttribute(
    'data-state',
    'ready',
  );
  expect((await probe.snapshot(fixture.app())).realm.id).not.toBe(
    before.realm.id,
  );
  await expect(
    fixture.app().frameLocator('#view').locator('#rate'),
  ).toHaveValue('2');
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('a main card hidden by Settings loses host authority and keeps its runtime @smoke', async ({
  page,
}, testInfo) => {
  const { app, cards, probe, daemon } = await openCards(page, testInfo);
  await cards.first().scrollIntoViewIfNeeded();
  await app().frameLocator('#view').locator('#rate').fill('29');
  const before = await probe.snapshot(app());
  await openNavigationPage(page, 'Settings');
  await expect(page.getByTestId('inline-panel')).toHaveAttribute(
    'aria-label',
    'Settings',
  );
  await expect(cards).toHaveCount(1);
  await expect(cards).toBeHidden();
  const response = await appRpc(app(), 'ui/message', hiddenMessage);
  await testInfo.attach('hidden-main-card-rpc', {
    body: JSON.stringify({ destination: 'Settings', response }),
    contentType: 'application/json',
  });
  expect(response.result?.isError).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(daemon.promptRequests()).toHaveLength(0);
  expect(await probe.snapshot(app())).toEqual(before);
  await page
    .locator('[data-web-shell-navigation-rail]')
    .getByRole('button', { name: 'Home', exact: true })
    .click();
  await cards.first().scrollIntoViewIfNeeded();
  expect(await probe.snapshot(app())).toEqual(before);
  await expect(app().frameLocator('#view').locator('#rate')).toHaveValue('29');
  await expect(app().locator('#continue-analysis')).toBeDisabled();
  await app()
    .frameLocator('#view')
    .getByRole('button', { name: 'Apply', exact: true })
    .click();
  await expect(app().frameLocator('#view').locator('#answer')).toHaveText(
    '1:29',
  );
  await reviewSnapshot(page, app());
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('entering and leaving Split View hands the same card to the visible surface @smoke', async ({
  page,
}, testInfo) => {
  const { app, cards, probe, daemon, scenario } = await openCards(
    page,
    testInfo,
  );
  await cards.first().scrollIntoViewIfNeeded();
  await app().frameLocator('#view').locator('#rate').fill('29');
  const before = await probe.snapshot(app());
  await openNavigationPage(page, 'Split View');
  const split = page.getByTestId('split-view');
  await expect(split).toBeVisible();
  const pane = split.locator(`[data-pane-session-id="${scenario.sessionId}"]`);
  await expect(pane.locator(frameSelector)).toBeVisible();
  await expect(cards).toHaveCount(1);
  expect(await probe.snapshot(app())).toEqual(before);
  await expect(app().frameLocator('#view').locator('#rate')).toHaveValue('29');
  await expect(app().locator('#continue-analysis')).toBeDisabled();
  await cards.first().scrollIntoViewIfNeeded();
  await app()
    .frameLocator('#view')
    .getByRole('button', { name: 'Apply', exact: true })
    .click();
  await expect(app().frameLocator('#view').locator('#answer')).toHaveText(
    '1:29',
  );
  await reviewSnapshot(page, app());
  await page
    .locator('[data-web-shell-navigation-rail]')
    .getByRole('button', { name: 'Home', exact: true })
    .click();
  await expect(split).toHaveCount(0);
  await expect(cards).toHaveCount(1);
  await cards.first().scrollIntoViewIfNeeded();
  expect(await probe.snapshot(app())).toEqual(before);
  await expect(app().frameLocator('#view').locator('#rate')).toHaveValue('29');
  await expect(app().frameLocator('#view').locator('#answer')).toHaveText(
    '1:29',
  );
  await reviewSnapshot(page, app());
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('maximizing another split pane revokes hidden tool RPCs without recreating the App', async ({
  page,
}, testInfo) => {
  const { scenario, daemon, probe, cards } = await openCards(page, testInfo);
  await page.setViewportSize({ width: 1600, height: 1000 });
  // Only the HTTP daemon is a fixture. Each real split provider receives its
  // requested session/client and epoch, so its attached owner can be verified.
  await page.route('**/session/*/load', (route) => {
    const sessionId = new URL(route.request().url()).pathname.split('/')[2];
    return route.fulfill({
      json: {
        sessionId,
        clientId:
          route.request().headers()['x-qwen-client-id'] ?? scenario.clientId,
        workspaceCwd: scenario.workspaceCwd,
        eventEpoch: 'generated-ui-retention-epoch-1',
        attached: true,
        createdAt: '2026-10-26T00:00:00.000Z',
        hasActivePrompt: false,
        generatedUi: scenario.state._meta?.['generatedUi'],
        state: scenario.state,
        compactedReplay: scenario.events,
        liveJournal: [],
        lastEventId: scenario.events.length,
      },
    });
  });
  const calls: string[] = [];
  await page.route('**/session/*/mcp-app/tools/call', (route) => {
    calls.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      json: {
        content: [{ type: 'text', text: 'visible tool reached daemon' }],
      },
    });
  });
  await openNavigationPage(page, 'Split View');
  const split = page.getByTestId('split-view');
  await expect(split).toBeVisible();
  await split.getByRole('button', { name: 'Add session' }).click();
  await split
    .getByRole('button', { name: 'Previous Session', exact: true })
    .click();
  await daemon.sse.waitForConnection('previous-session');
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: 'previous-session',
      replayedCount: scenario.events.length,
    }),
  );
  const mainPane = split.locator(
    `[data-pane-session-id="${scenario.sessionId}"]`,
  );
  const otherPane = split.locator('[data-pane-session-id="previous-session"]');
  const card = otherPane.locator(frameSelector);
  await expect(cards).toHaveCount(2);
  await expect(mainPane.locator(frameSelector)).toBeVisible();
  await expect(card).toBeVisible();
  await expect(
    card.contentFrame().frameLocator('iframe').locator('#status'),
  ).toHaveAttribute('data-state', 'ready');
  // Keep the actual Frame handle while its slot disappears into parking.
  const appElement = await card
    .contentFrame()
    .locator('iframe')
    .elementHandle();
  const app = (await appElement!.contentFrame())!;
  await card.scrollIntoViewIfNeeded();
  await app.frameLocator('#view').locator('#rate').fill('31');
  const before = await probe.snapshot(app);
  const tool = { name: 'generated_ui_show', arguments: input };
  const visibleReply = await appRpc(app, 'tools/call', tool);
  await testInfo.attach('visible-split-pane-rpc', {
    body: JSON.stringify({ visibleReply, calls }),
    contentType: 'application/json',
  });
  expect(visibleReply.result?.content?.[0]?.text).toBe(
    'visible tool reached daemon',
  );
  expect(calls).toEqual(['/session/previous-session/mcp-app/tools/call']);
  await mainPane
    .getByRole('button', { name: 'Maximize pane', exact: true })
    .click();
  await expect(otherPane).toBeHidden();
  await expect(
    page.locator('[data-generated-ui-parking]').locator(frameSelector),
  ).toHaveCount(1);
  const hiddenReply = await appRpc(app, 'tools/call', tool);
  expect(hiddenReply.timedOut).not.toBe(true);
  expect(hiddenReply.error).toBeDefined();
  expect(calls).toHaveLength(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(daemon.promptRequests()).toHaveLength(0);
  expect(await probe.snapshot(app)).toEqual(before);
  await mainPane
    .getByRole('button', { name: 'Restore pane', exact: true })
    .click();
  await expect(card).toBeVisible();
  await expect(mainPane.locator(frameSelector)).toBeVisible();
  await expect(cards).toHaveCount(2);
  expect(await probe.snapshot(app)).toEqual(before);
  await expect(app.frameLocator('#view').locator('#rate')).toHaveValue('31');
  const restoredReply = await appRpc(app, 'tools/call', tool);
  expect(restoredReply.result?.content?.[0]?.text).toBe(
    'visible tool reached daemon',
  );
  expect(calls).toEqual([
    '/session/previous-session/mcp-app/tools/call',
    '/session/previous-session/mcp-app/tools/call',
  ]);
  await testInfo.attach('hidden-split-pane-rpc', {
    body: JSON.stringify({
      visibleReply,
      hiddenReply,
      restoredReply,
      calls,
    }),
    contentType: 'application/json',
  });
});

for (const shadowPortals of [false, true]) {
  test(`retains the subagent App and Worker after panel close with shadow portals ${shadowPortals} @smoke`, async ({
    page,
  }, testInfo) => {
    let injected = 0;
    await page.route('**/main.tsx', async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const marker = /webShellProps:\s*\{/g;
      expect(body.match(marker)).toHaveLength(1);
      injected++;
      await route.fulfill({
        response,
        body: body.replace(
          marker,
          `webShellProps: { shadowDom: { portals: ${shadowPortals} },`,
        ),
      });
    });
    const fixture = await openCards(page, testInfo);
    expect(injected).toBe(1);
    await page.setViewportSize({ width: 900, height: 900 });
    const childId = 'retained-child';
    let childLoads = 0;
    const childReplay = [
      userTextEvent('Render the child view', { id: 1, sessionId: childId }),
      toolCallEvent(
        'child-card',
        'mcp__generated-ui__generated_ui_show',
        input,
        {
          id: 2,
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
      turnCompleteEvent('child-turn', { id: 3, sessionId: childId }),
    ];
    await page.route('**/session/**/subagents/retained-agent', (route) =>
      route.fulfill({ json: { sessionId: childId, status: 'completed' } }),
    );
    await page.route(`**/session/${childId}/load`, (route) => {
      childLoads++;
      return route.fulfill({
        json: {
          sessionId: childId,
          clientId:
            route.request().headers()['x-qwen-client-id'] ?? 'child-client',
          workspaceCwd: fixture.scenario.workspaceCwd,
          eventEpoch: 'child-epoch-1',
          attached: true,
          createdAt: '2026-10-27T00:00:00.000Z',
          hasActivePrompt: false,
          state: fixture.scenario.state,
          generatedUi: fixture.scenario.state._meta?.['generatedUi'],
          compactedReplay: childReplay,
          liveJournal: [],
          lastEventId: 3,
        },
      });
    });
    await fixture.daemon.sendEvent(
      userTextEvent('Open child details', { id: 100 }),
    );
    await fixture.daemon.sendEvent(
      toolCallEvent(
        'retained-agent',
        'agent',
        {
          description: 'Retained child',
          prompt: 'Render the child view',
          subagent_type: 'general-purpose',
        },
        {
          id: 101,
          rawOutput: {
            task_id: 'retained-task',
            subagentName: 'Retained child',
            status: 'completed',
          },
        },
      ),
    );
    await fixture.daemon.sendEvent(
      turnCompleteEvent('parent-agent-turn', { id: 102 }),
    );
    const trigger = page
      .getByRole('button', { name: /Retained child/ })
      .first();
    await trigger.click();
    const panel = page.locator('aside[aria-label="Right panel"]');
    await expect(panel).toBeVisible();
    await fixture.daemon.sse.waitForConnection(childId);
    await fixture.daemon.sendEvent(
      replayCompleteEvent({
        sessionId: childId,
        replayedCount: childReplay.length,
      }),
    );
    const card = panel.locator(frameSelector);
    await expect(card).toHaveCount(1);
    expect(
      await card.evaluate(
        (element) => element.getRootNode() instanceof ShadowRoot,
      ),
    ).toBe(shadowPortals);
    const app = card.contentFrame().frameLocator('iframe');
    await expect(app.locator('#status')).toHaveAttribute('data-state', 'ready');
    const view = app.frameLocator('#view');
    await view.locator('#rate').fill('7');
    await view.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(view.locator('#answer')).toHaveText('1:7');
    await view.locator('#rate').fill('9');
    await expect(app.locator('#status')).toHaveAttribute('data-state', 'dirty');
    const before = await fixture.probe.snapshot(app);
    const frame = await card.elementHandle();
    const mainRealm = await page.evaluate(
      () => (window as ProbeWindow).__pr03Realm.id,
    );
    await panel
      .getByRole('button', { name: 'Toggle right panel', exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    expect(await frame!.evaluate((element) => element.isConnected)).toBe(true);
    expect(
      await frame!.evaluate((element) =>
        element.closest('[data-generated-ui-parking]')?.hasAttribute('inert'),
      ),
    ).toBe(true);
    expect(await fixture.probe.liveWorkerNonces()).toEqual(before.workerNonces);
    const previousLoads = childLoads;
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect.poll(() => childLoads).toBeGreaterThan(previousLoads);
    await fixture.daemon.sse.waitForConnection(childId);
    await fixture.daemon.sendEvent(
      replayCompleteEvent({
        sessionId: childId,
        replayedCount: childReplay.length,
      }),
    );
    await expect(card).toHaveCount(1);
    expect(await fixture.probe.snapshot(app)).toEqual(before);
    await expect(view.locator('#rate')).toHaveValue('9');
    await expect(view.locator('#answer')).toHaveText('1:7');
    expect(
      await page.evaluate(() => (window as ProbeWindow).__pr03Realm.id),
    ).toBe(mainRealm);
    expect(fixture.daemon.promptRequests()).toHaveLength(0);
    await testInfo.attach('subagent-portal-retention', {
      body: JSON.stringify({
        shadowPortals,
        before,
        after: await fixture.probe.snapshot(app),
      }),
      contentType: 'application/json',
    });
  });
}
