import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  thoughtTextEvent,
  turnCompleteEvent,
  userTextEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

interface BrowserPerformanceMetrics {
  inputEvents: number[];
  longTasks: number[];
  frameGaps: number[];
}

declare global {
  interface Window {
    __webShellPerformanceMetrics?: BrowserPerformanceMetrics;
  }
}

const historyTurns = Number(process.env['WEB_SHELL_PERF_TURNS'] ?? 5_000);
const streamChunks = Number(process.env['WEB_SHELL_PERF_CHUNKS'] ?? 400);
const streamIntervalMs = Number(
  process.env['WEB_SHELL_PERF_INTERVAL_MS'] ?? 10,
);
const streamKind =
  process.env['WEB_SHELL_PERF_STREAM_KIND'] === 'thought'
    ? 'thought'
    : 'assistant';

test.skip(
  process.env['WEB_SHELL_PERF'] !== '1',
  'Set WEB_SHELL_PERF=1 to run the deterministic performance scenario.',
);

test('keeps the composer responsive during deterministic streaming @perf', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);

  await installPerformanceObservers(page);
  const history = createHistory(historyTurns);
  const scenario = createWebShellDaemonScenario({ events: history });
  const daemon = await installScenario(page, scenario, testInfo);

  const replayStartedAt = Date.now();
  await gotoSession(page, scenario, daemon);
  const replayMs = Date.now() - replayStartedAt;

  await fillComposer(page, 'Start deterministic performance stream');
  const submit = page.locator('[data-web-shell-composer-submit]');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);

  await resetPerformanceMetrics(page);
  const expectedInput = 'input remains responsive while output is streaming';
  const streamStartedAt = Date.now();
  let nextEventId = history.length + 1;
  let typingMs = 0;
  const streamTextEvent =
    streamKind === 'thought' ? thoughtTextEvent : assistantTextEvent;
  const streamEvents = Array.from({ length: streamChunks }, (_, index) => {
    const text = `${index}: ${'deterministic streaming text '.repeat(8)}\n`;
    return streamTextEvent(text, { id: nextEventId++ });
  });
  streamEvents.push(
    assistantTextEvent('STREAM_COMPLETE_SENTINEL', { id: nextEventId++ }),
    turnCompleteEvent('prompt-e2e', { id: nextEventId++ }),
  );

  const type = async () => {
    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    await editor.click();
    const typingStartedAt = Date.now();
    await page.keyboard.type(expectedInput, { delay: 20 });
    typingMs = Date.now() - typingStartedAt;
    await expect(editor).toHaveText(expectedInput);
  };

  await Promise.all([
    streamInBrowser(page, streamEvents, streamIntervalMs),
    type(),
  ]);
  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'STREAM_COMPLETE_SENTINEL',
  );
  await expect(
    page.locator('[data-markdown-streaming-plain-text="true"]'),
  ).toHaveCount(0);
  await page.waitForTimeout(100);

  const metrics = await readPerformanceMetrics(page);
  const result = {
    historyTurns,
    streamKind,
    streamChunks,
    streamIntervalMs,
    replayMs,
    streamMs: Date.now() - streamStartedAt,
    typingMs,
    typingOverheadMs: typingMs - expectedInput.length * 20,
    longTaskCount: metrics.longTasks.length,
    longTaskTotalMs: sum(metrics.longTasks),
    longTaskMaxMs: max(metrics.longTasks),
    frameGapP95Ms: percentile(metrics.frameGaps, 0.95),
    frameGapMaxMs: max(metrics.frameGaps),
    frameGapOver34MsCount: metrics.frameGaps.filter((gap) => gap > 34).length,
    slowInputEventCount: metrics.inputEvents.length,
    slowInputEventP95Ms: percentile(metrics.inputEvents, 0.95),
    slowInputEventMaxMs: max(metrics.inputEvents),
  };

  console.log(`WEB_SHELL_STREAM_PERF ${JSON.stringify(result)}`);
  await testInfo.attach('web-shell-stream-performance.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
});

function createHistory(turns: number): DaemonEvent[] {
  const events: DaemonEvent[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    events.push(
      userTextEvent(`historical user message ${turn}`, {
        id: events.length + 1,
      }),
      assistantTextEvent(
        `historical assistant message ${turn} ${'content '.repeat(12)}`,
        { id: events.length + 2 },
      ),
      turnCompleteEvent(`historical-prompt-${turn}`, {
        id: events.length + 3,
      }),
    );
  }
  return events;
}

async function installPerformanceObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const metrics: BrowserPerformanceMetrics = {
      inputEvents: [],
      longTasks: [],
      frameGaps: [],
    };
    window.__webShellPerformanceMetrics = metrics;
    let previousFrame: number | undefined;
    const sampleFrame = (timestamp: number) => {
      if (previousFrame !== undefined) {
        metrics.frameGaps.push(timestamp - previousFrame);
      }
      previousFrame = timestamp;
      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);

    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          metrics.longTasks.push(entry.duration);
        }
      }).observe({ type: 'longtask', buffered: true });
    }

    if (PerformanceObserver.supportedEntryTypes.includes('event')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (
            entry.name === 'keydown' ||
            entry.name === 'beforeinput' ||
            entry.name === 'input'
          ) {
            metrics.inputEvents.push(entry.duration);
          }
        }
      }).observe({
        type: 'event',
        buffered: true,
        durationThreshold: 16,
      } as PerformanceObserverInit);
    }
  });
}

async function resetPerformanceMetrics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const metrics = window.__webShellPerformanceMetrics;
    if (metrics) {
      metrics.inputEvents.length = 0;
      metrics.longTasks.length = 0;
      metrics.frameGaps.length = 0;
    }
  });
}

async function streamInBrowser(
  page: Page,
  events: readonly DaemonEvent[],
  intervalMs: number,
): Promise<void> {
  await page.evaluate(
    async ({ events, intervalMs }) => {
      const harness = window.__webShellSseHarness;
      if (!harness) {
        throw new Error('SSE harness is not installed.');
      }
      for (const event of events) {
        harness.writeFrame(`data: ${JSON.stringify(event)}\n\n`);
        await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
      }
    },
    { events, intervalMs },
  );
}

async function readPerformanceMetrics(
  page: Page,
): Promise<BrowserPerformanceMetrics> {
  return page.evaluate(() =>
    structuredClone(
      window.__webShellPerformanceMetrics ?? {
        inputEvents: [],
        longTasks: [],
        frameGaps: [],
      },
    ),
  );
}

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

async function fillComposer(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.type(text);
}

function sum(values: readonly number[]): number {
  return Math.round(values.reduce((total, value) => total + value, 0));
}

function max(values: readonly number[]): number {
  return Math.round(Math.max(0, ...values));
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * fraction) - 1;
  return Math.round(sorted[index] ?? 0);
}
