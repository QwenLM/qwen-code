/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import type {
  DaemonEvent,
  HookExecutionEntry,
  HookLifecycleSummary,
} from '@qwen-code/sdk/daemon';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const sessionId = 'hook-statistics-session';
const admissionId = 'admission-turn-1';
const historyId = `${sessionId}########1`;
const startedAt = 1_795_000_000_000;

function execution(index: number): HookExecutionEntry {
  const base = {
    v: 1 as const,
    kind: 'hook' as const,
    executionId: `hook-${index}`,
    runtimeId: 'runtime-hooks',
    sessionId,
    promptId: historyId,
    agentId: null,
    eventName: 'MessageDisplay',
    hookType: 'command' as const,
    source: 'project' as const,
    name: `Named hook ${String(index + 1).padStart(2, '0')}`,
    startedAt: startedAt + index * 10,
  };
  if (index === 3) {
    return {
      event: {
        ...base,
        phase: 'dispatched',
        dispatchedAt: base.startedAt + 2,
        dispatchDurationMs: 2,
      },
      status: 'dispatched',
      conflicted: false,
    };
  }
  if (index === 4) {
    return {
      event: { ...base, phase: 'started' },
      status: 'unknown',
      conflicted: false,
    };
  }
  const outcome = index === 1 ? 'blocked' : index === 2 ? 'error' : 'success';
  return {
    event: {
      ...base,
      phase: 'ended',
      endedAt: base.startedAt + 10,
      durationMs: 10,
      outcome,
      exitCode: index === 2 ? 1 : 0,
    },
    status: outcome,
    conflicted: false,
  };
}

function summary(total: number): HookLifecycleSummary {
  return {
    totalExecutions: total,
    counts: {
      success: total - 4,
      blocked: 1,
      error: 1,
      timeout: 0,
      cancelled: 0,
      dispatched: 1,
      unknown: 1,
      running: 0,
    },
    durationMs: (total - 2) * 10,
    durationComplete: false,
  };
}

async function openFixture(
  page: Page,
  baseURL: string,
  failNextPage = false,
  promptOnly = false,
) {
  const hook = execution(0).event;
  const lifecycle = (phase: 'started' | 'ended', id: number): DaemonEvent => ({
    id,
    v: 1,
    type: 'session_update',
    promptId: admissionId,
    data: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: { hookLifecycle: { ...hook, phase } },
      },
    },
  });
  const user = {
    ...userTextEvent('Inspect these hook executions.', { id: 1 }),
    promptId: admissionId,
  };
  const answer = {
    ...assistantTextEvent('The reply is complete.', { id: 4 }),
    promptId: admissionId,
  };
  const scenario = createWebShellDaemonScenario({
    sessionId,
    events: [
      user,
      lifecycle('started', 2),
      lifecycle('ended', 3),
      ...(promptOnly ? [] : [answer]),
      turnCompleteEvent(admissionId, { id: 5, sessionId }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  let total = 55;
  let failed = false;
  const reads: URL[] = [];
  await page.route('**/session/*/turns/*/hooks*', async (route) => {
    const url = new URL(route.request().url());
    reads.push(url);
    expect(decodeURIComponent(url.pathname)).toContain(
      `/turns/${historyId}/hooks`,
    );
    const start = Number(url.searchParams.get('start') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const snapshot = url.searchParams.get('snapshot') ?? `snapshot-${total}`;
    const frozenTotal = Number(snapshot.split('-')[1]);
    if (failNextPage && start === 50 && limit === 50 && !failed) {
      failed = true;
      await route.fulfill({
        status: 503,
        json: { error: 'Temporary read failure' },
      });
      return;
    }
    await route.fulfill({
      json: {
        sessionId,
        promptId: historyId,
        snapshot,
        start,
        totalExecutions: frozenTotal,
        executions: Array.from(
          { length: Math.min(limit, frozenTotal - start) },
          (_, index) => execution(start + index),
        ),
        summary: summary(frozenTotal),
        coverage: 'recorded',
        ...(start + limit < frozenTotal ? { nextStart: start + limit } : {}),
      },
    });
  });
  await page.goto(`/session/${sessionId}?language=en`);
  await daemon.sse.waitForConnection(sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId, replayedCount: promptOnly ? 4 : 5 }),
  );
  await expect(
    page.getByText('Inspect these hook executions.', { exact: true }),
  ).toBeVisible();
  if (!promptOnly) {
    await expect(
      page.getByText('The reply is complete.', { exact: true }),
    ).toBeVisible();
  }
  return {
    reads,
    append: () => {
      total++;
    },
  };
}

for (const theme of ['light', 'dark']) {
  test(`hook statistics compact hover, focus, frozen pages and retry (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem('qwen-code-web-shell-theme', value),
      theme,
    );
    const fixture = await openFixture(
      page,
      String(testInfo.project.use.baseURL),
      true,
    );
    const trigger = page.getByRole('button', {
      name: 'Hook statistics',
      exact: true,
    });
    await expect(trigger).toBeVisible();
    await trigger.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toContainText('Hook statistics');
    await expect(tooltip).toContainText(
      '55 runs · 1 blocked · 1 failed · 530 ms',
    );
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator('dl')).toHaveCount(0);
    await expect(
      tooltip.getByText('Named hook 55', { exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath(`hooks-hover-${theme}.png`),
    });
    await page.mouse.move(0, 0);
    await trigger.focus();
    await expect(tooltip).toBeVisible();
    await trigger.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Hook statistics' });
    await expect(dialog).toBeVisible();
    const total = dialog.locator('dt', { hasText: /^Runs$/ }).locator('+ dd');
    await expect(total).toHaveText('55');
    const desktopBox = await dialog.boundingBox();
    expect(desktopBox).not.toBeNull();
    expect(desktopBox!.width).toBeLessThanOrEqual(560);
    const recordsList = dialog
      .locator('[data-slot="collapsible"]')
      .first()
      .locator('..');
    expect(
      await recordsList.evaluate(
        (element) =>
          parseFloat(getComputedStyle(element).maxHeight) / window.innerHeight,
      ),
    ).toBeCloseTo(0.7);
    await expect(dialog).not.toContainText('Succeeded:');
    await expect(dialog).not.toContainText('Parallel durations overlap');
    await expect(dialog).not.toContainText(
      'Some execution durations are unavailable.',
    );
    await expect(
      dialog.getByRole('button', { name: 'Refresh', exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByText('Named hook 50', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText('Named hook 51', { exact: true }),
    ).toHaveCount(0);
    await dialog.getByRole('button', { name: /Named hook 01/ }).click();
    await expect(dialog).toContainText('Hook type: command');
    await expect(dialog).toContainText('Started:');
    await expect(dialog).toContainText('Ended:');
    await expect(dialog).toContainText('Exit code: 0');
    await dialog.getByRole('button', { name: /Named hook 04/ }).click();
    await expect(dialog).toContainText('Final result is not collected.');
    await dialog.getByRole('button', { name: /Named hook 05/ }).click();
    await expect(dialog).toContainText('The terminal result was not recorded');
    await expect(
      dialog.getByRole('button', { name: /Named hook 04/ }),
    ).toBeVisible();
    await expect(
      dialog.getByText('Final result is not collected.'),
    ).toBeVisible();
    await expect(
      dialog.getByText(/The terminal result was not recorded/),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`hooks-dialog-${theme}.png`),
    });
    fixture.append();
    await dialog.getByRole('button', { name: 'Load 50 more' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(
      dialog.getByText('Named hook 55', { exact: true }),
    ).toBeVisible();
    await expect(total).toHaveText('55');
    await expect(
      dialog.getByText('Named hook 56', { exact: true }),
    ).toHaveCount(0);
    const nextPages = fixture.reads.filter(
      (url) =>
        url.searchParams.get('start') === '50' &&
        url.searchParams.get('limit') === '50',
    );
    expect(nextPages).toHaveLength(2);
    expect(
      nextPages.every(
        (url) => url.searchParams.get('snapshot') === 'snapshot-55',
      ),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.hover();
    await expect(tooltip).toContainText('Hook statistics');
    await expect(tooltip).toContainText(
      '56 runs · 1 blocked · 1 failed · 540 ms',
    );
    await expect(tooltip.locator('dl')).toHaveCount(0);
    await trigger.click();
    await expect(total).toHaveText('56');
    await expect(
      dialog.getByText('Named hook 51', { exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(total).toHaveText('56');
  });
}

test('prompt hook statistics stays clickable above message actions', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFixture(page, String(testInfo.project.use.baseURL), false, true);
  await page
    .getByText('Inspect these hook executions.', { exact: true })
    .hover();
  const trigger = page.getByRole('button', {
    name: 'Hook statistics',
    exact: true,
  });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Hook statistics' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('Named hook 01', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('hooks-prompt-dialog.png'),
  });
});

test('hook statistics fits 320px and restores focus to reply menu', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await openFixture(page, String(testInfo.project.use.baseURL));
  await expect(
    page.getByRole('button', { name: 'Hook statistics', exact: true }),
  ).toBeHidden();
  const more = page.getByRole('button', { name: 'More reply actions' });
  await more.click();
  await page.getByRole('menuitem', { name: 'Hook statistics' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hook statistics' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('Named hook 01', { exact: true }),
  ).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(740);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('hooks-dialog-320.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();
});

test('historical viewport keeps canonical hook identity and returns to live', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const record = (number: number, text: string): DaemonEvent => ({
    v: 1,
    id: number + 10,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate:
          number % 2 ? 'agent_message_chunk' : 'user_message_chunk',
        content: { type: 'text', text },
        _meta: {
          'qwen.session.recordId': `record-${number}`,
          qwenTranscript: { sourceRecordIds: [`record-${number}`] },
        },
      },
    },
  });
  const live = [record(6, 'Live prompt'), record(7, 'Live reply')];
  const historical = [
    record(0, 'Historical prompt'),
    record(1, 'Historical reply'),
  ];
  const scenario = createWebShellDaemonScenario({ sessionId, events: live });
  scenario.capabilities.features.push(
    'session_turn_navigation',
    'session_transcript_pagination',
  );
  const baseURL = String(testInfo.project.use.baseURL);
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const hookPromptIds: string[] = [];
  await page.route(`${baseURL}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (/\/session\/[^/]+\/(load|resume)$/.test(url.pathname)) {
      await route.fulfill({
        json: {
          sessionId,
          workspaceCwd: scenario.workspaceCwd,
          attached: true,
          createdAt: new Date().toISOString(),
          hasActivePrompt: false,
          clientId: scenario.clientId,
          state: scenario.state,
          compactedReplay: live,
          liveJournal: [],
          lastEventId: 17,
          historyHasMore: true,
          historyAnchorRecordId: 'record-6',
        },
      });
    } else if (url.pathname.endsWith('/turn-index')) {
      await route.fulfill({
        json: {
          v: 1,
          sessionId,
          snapshot: 'history-index',
          totalTurns: 4,
          start: 0,
          turns: [0, 1, 2, 3].map((ordinal) => ({
            ordinal,
            turnId: `record-${ordinal * 2}`,
            kind: 'prompt',
            promptId: `admission-${ordinal + 1}`,
            historyPromptId: `${sessionId}########${ordinal + 1}`,
            label: ordinal ? 'Live prompt' : 'Historical prompt',
          })),
        },
      });
    } else if (url.pathname.endsWith('/transcript')) {
      const anchored = url.searchParams.get('atRecordId') === 'record-0';
      await route.fulfill({
        json: {
          v: 1,
          sessionId,
          events: anchored ? historical : [],
          hasMore: anchored,
          hasOlder: false,
          ...(anchored
            ? { nextCursor: 'after:1', targetRecordId: 'record-0' }
            : {}),
        },
      });
    } else if (/\/turns\/.*\/hooks$/.test(url.pathname)) {
      const promptId = decodeURIComponent(url.pathname.split('/').at(-2)!);
      hookPromptIds.push(promptId);
      expect([historyId, `${sessionId}########4`]).toContain(promptId);
      const entry = execution(0);
      await route.fulfill({
        json: {
          sessionId,
          promptId,
          snapshot: `hook-snapshot-${promptId}`,
          start: 0,
          totalExecutions: 1,
          executions: [
            {
              ...entry,
              event: {
                ...entry.event,
                promptId,
                name: promptId === historyId ? 'Historical hook' : 'Live hook',
              },
            },
          ],
          summary: {
            totalExecutions: 1,
            counts: {
              success: 1,
              blocked: 0,
              error: 0,
              timeout: 0,
              cancelled: 0,
              dispatched: 0,
              unknown: 0,
              running: 0,
            },
            durationMs: 10,
            durationComplete: true,
          },
          coverage: 'recorded',
        },
      });
    } else await route.fallback();
  });
  await page.goto(`/session/${sessionId}?language=en`);
  await daemon.sse.waitForConnection(sessionId);
  await daemon.sendEvent(replayCompleteEvent({ sessionId, replayedCount: 2 }));
  const liveViewport = page.locator('[data-history-viewport="live"]');
  await expect(
    liveViewport.getByText('Live reply', { exact: true }),
  ).toBeVisible();
  const rail = page.locator('[data-global-turn-navigation]');
  await expect(rail).toBeVisible();
  await rail.locator('[data-turn-ordinal="0"]').click();
  const historyViewport = page.locator('[data-history-viewport="historical"]');
  await expect(
    historyViewport.getByText('Historical reply', { exact: true }),
  ).toBeVisible();
  await historyViewport
    .getByRole('button', { name: 'Hook statistics', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Hook statistics' });
  await expect(
    dialog.getByText('Historical hook', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText('Live hook', { exact: true })).toHaveCount(0);
  expect(hookPromptIds).toContain(historyId);
  await page.screenshot({
    path: testInfo.outputPath('hooks-historical-dialog.png'),
  });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Scroll to bottom' }).click();
  await expect(
    liveViewport.getByText('Live reply', { exact: true }),
  ).toBeVisible();
  await liveViewport
    .getByRole('button', { name: 'Hook statistics', exact: true })
    .click();
  await expect(dialog.getByText('Live hook', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText('Historical hook', { exact: true }),
  ).toHaveCount(0);
  expect(hookPromptIds.at(-1)).toBe(`${sessionId}########4`);
});
