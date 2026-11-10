import { expect, test } from '@playwright/test';
import type { DaemonSessionStatsStatus } from '@qwen-code/sdk/daemon';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

function statsFor(
  sessionId: string,
  workspaceCwd: string,
  prompt: number,
): DaemonSessionStatsStatus {
  return {
    v: 1,
    sessionId,
    workspaceCwd,
    sessionStartTimeMs: 1_000,
    durationMs: 600_000,
    promptCount: 2,
    models: {
      'qwen3.8-max': {
        api: { totalRequests: 35, totalErrors: 0, totalLatencyMs: 300_000 },
        tokens: {
          prompt,
          candidates: 120_000,
          total: prompt + 120_000,
          cached: Math.round(prompt * 0.92),
          thoughts: 40_000,
        },
        generation: {
          timedRequests: 35,
          totalTtftMs: 42_000,
          totalGenerationDurationMs: 4_000_000,
          totalThroughputOutputTokens: 120_000,
          totalTimedGenerationDurationMs: 4_000_000,
          totalOutputSpeedTokens: 120_000,
          totalOutputSpeedDurationMs: 4_615_000,
        },
      },
    },
    tools: {
      totalCalls: 0,
      totalSuccess: 0,
      totalFail: 0,
      totalDurationMs: 0,
      byName: {},
    },
    files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
  };
}

for (const { width, language, theme } of [
  { width: 1200, language: 'zh-CN', theme: 'dark' },
  { width: 1200, language: 'en', theme: 'light' },
  { width: 390, language: 'zh-CN', theme: 'light' },
]) {
  test(`composer usage reading ${width}px ${language} ${theme} @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(
      ({ language, theme }) => {
        localStorage.setItem('qwen-code-web-shell-language', language);
        localStorage.setItem('qwen-code-web-shell-theme', theme);
      },
      { language, theme },
    );
    const scenario = createWebShellDaemonScenario({
      events: [
        userTextEvent('Summarize the repository layout.', { id: 1 }),
        assistantTextEvent('The repository has core, cli and web-shell.', {
          id: 2,
        }),
        turnCompleteEvent('usage-1', { id: 3 }),
      ],
    });
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    let stats = statsFor(scenario.sessionId, scenario.workspaceCwd, 4_080_000);
    let reads = 0;
    await page.route('**/session/*/stats', (route) => {
      reads++;
      return route.fulfill({ json: stats });
    });
    await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
    const connection = await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({
        sessionId: connection.sessionId,
        replayedCount: 3,
      }),
    );

    const zh = language === 'zh-CN';
    const bar = page.locator('[data-web-shell-composer-usage]');
    // 120,000 tok over 4,615 s; 92% of 4.08M input tokens cached.
    await expect(bar).toHaveText(
      zh
        ? '2 轮·26 tok/s4.2M tok·缓存命中 92%'
        : '2 turns·26 tok/s4.2M tok·92% cache hit',
    );
    await page.screenshot({
      path: testInfo.outputPath(
        `composer-usage-${width}-${language}-${theme}.png`,
      ),
    });
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);

    // A usage update from a model response reads the stats again.
    stats = statsFor(scenario.sessionId, scenario.workspaceCwd, 8_000_000);
    const before = reads;
    await daemon.sendEvent({
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' Done.' },
          _meta: { usage: { inputTokens: 52_000, outputTokens: 900 } },
        },
      },
    });
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(bar).toContainText('8.12M tok');

    await bar.getByRole('button').click();
    await expect(page.getByTestId('token-usage-panel')).toBeVisible();
  });
}

test('composer usage reading stays hidden and silent when stats fail @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Hello', { id: 1 }),
      assistantTextEvent('Hi.', { id: 2 }),
      turnCompleteEvent('usage-fail', { id: 3 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  let reads = 0;
  await page.route('**/session/*/stats', (route) => {
    reads++;
    return route.fulfill({ status: 500, json: { error: 'boom' } });
  });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 3 }),
  );
  await expect(page.getByText('Hi.', { exact: true })).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(page.locator('[data-web-shell-composer-usage]')).toHaveCount(0);
  await expect(page.getByText(/Load stats failed/)).toHaveCount(0);
});

test('composer usage follows background work and refreshes when it settles @smoke', async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date('2026-11-10T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-10T01:00:00Z'));
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: [
        'session_events',
        'session_source_metadata',
        'workspace_session_live_state',
      ],
      sessionLiveStatePollIntervalMs: 1_000,
    },
    events: [
      userTextEvent('Continue investigating in the background.', { id: 1 }),
      assistantTextEvent('The background agent is still working.', { id: 2 }),
      turnCompleteEvent('usage-background', { id: 3 }),
    ],
  });
  let backgroundRunning = true;
  scenario.sessions[0] = {
    ...scenario.sessions[0],
    hasActivePrompt: false,
    hasRunningBackgroundTasks: true,
    activeWorkState: 'active',
  };
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.route(
    /\/workspaces\/.*\/sessions\/live-state(?:\?.*)?$/,
    (route) =>
      route.fulfill({
        json: {
          v: 1,
          catalogVersion: scenario.sessionCatalogVersion,
          sessions: [
            {
              sessionId: scenario.sessionId,
              clientCount: 1,
              hasActivePrompt: false,
              hasRunningBackgroundTasks: backgroundRunning,
              activeWorkState: backgroundRunning ? 'active' : 'idle',
              isWaitingForPermission: false,
              isWaitingForUserQuestion: false,
            },
          ],
        },
      }),
  );
  let stats = statsFor(scenario.sessionId, scenario.workspaceCwd, 4_080_000);
  let reads = 0;
  await page.route('**/session/*/stats', (route) => {
    reads++;
    return route.fulfill({ json: stats });
  });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 3 }),
  );
  const bar = page.locator('[data-web-shell-composer-usage]');
  const backgroundMarker = page.locator(
    '[data-web-shell-session-background-running]',
  );
  await expect(backgroundMarker).toBeVisible();
  await expect(bar).toContainText('4.2M tok');
  await page.clock.runFor(1_000);

  stats = statsFor(scenario.sessionId, scenario.workspaceCwd, 8_000_000);
  const beforeChildUsage = reads;
  await daemon.sendEvent({
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          parentToolCallId: 'background-agent',
          usage: { inputTokens: 52_000, outputTokens: 900 },
        },
      },
    },
  });
  await page.clock.runFor(1_000);
  expect(reads).toBe(beforeChildUsage);
  await expect(bar).toContainText('4.2M tok');
  await page.clock.runFor(5_000);
  await expect(bar).toContainText('8.12M tok');

  stats = statsFor(scenario.sessionId, scenario.workspaceCwd, 9_000_000);
  backgroundRunning = false;
  await page.clock.runFor(1_000);
  await expect(backgroundMarker).toHaveCount(0);
  await page.clock.runFor(1_000);
  await expect(bar).toContainText('9.12M tok');
  const settledReads = reads;
  await page.clock.runFor(6_000);
  expect(reads).toBe(settledReads);
});

test('composer usage waits for a historical session to finish loading @smoke', async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date('2026-11-10T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-10T01:00:00Z'));
  const replayFor = (label: string, id: number, sessionId?: string) => [
    userTextEvent(`${label} question`, { id, sessionId }),
    {
      ...assistantTextEvent(`${label} answer`, { id: id + 1, sessionId }),
      data: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${label} answer` },
          _meta: { usage: { inputTokens: 100, outputTokens: 20 } },
        },
      },
    },
    turnCompleteEvent(`${label}-turn`, { id: id + 2, sessionId }),
  ];
  const scenario = createWebShellDaemonScenario({ events: replayFor('A', 1) });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  let ready = false;
  let loadStarted = false;
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const reads: boolean[] = [];
  await page.route('**/session/*/stats', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    if (id === 'previous-session') {
      reads.push(ready);
      if (!ready) {
        return route.fulfill({
          status: 404,
          json: { code: 'session_not_found', sessionId: id },
        });
      }
    }
    return route.fulfill({
      json: statsFor(
        id,
        scenario.workspaceCwd,
        id === 'previous-session' ? 8_000_000 : 4_080_000,
      ),
    });
  });
  await page.route('**/session/previous-session/load', async (route) => {
    loadStarted = true;
    await loadGate;
    ready = true;
    await route.fulfill({
      json: {
        sessionId: 'previous-session',
        workspaceCwd: scenario.workspaceCwd,
        attached: true,
        clientId: scenario.clientId,
        createdAt: new Date().toISOString(),
        hasActivePrompt: false,
        state: { ...scenario.state, displayName: 'Previous Session' },
        compactedReplay: replayFor('B', 101, 'previous-session'),
        liveJournal: [],
        lastEventId: 103,
      },
    });
  });

  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId, replayedCount: 3 }),
  );
  const bar = page.locator('[data-web-shell-composer-usage]');
  await expect(bar).toContainText('4.2M tok');
  await page
    .locator('[data-sidebar-shell]')
    .getByText('Previous Session', { exact: true })
    .click();
  await expect.poll(() => loadStarted).toBe(true);
  await page.clock.runFor(1_500);
  const readsWhileLoading = [...reads];
  releaseLoad();
  await daemon.sse.waitForConnection('previous-session');
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: 'previous-session', replayedCount: 3 }),
  );
  await expect(page.getByText('B answer', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/session\/previous-session/);
  await page.clock.runFor(1_000);
  await expect(bar).toContainText('8.12M tok');
  expect(readsWhileLoading).toEqual([]);
  expect(reads.every(Boolean)).toBe(true);
});
