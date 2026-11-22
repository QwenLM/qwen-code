/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { DaemonSessionScheduledTaskStatus } from '@qwen-code/sdk/daemon';
import type { DaemonScheduledTask } from '../daemon/workspace/types';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const SESSION_ID = 'session-scheduled-1';

function buildScenario(now: number) {
  const durableTasks: DaemonScheduledTask[] = [
    {
      id: 'durable-standup',
      name: 'Daily CI digest',
      cron: '0 9 * * *',
      prompt: 'Summarize overnight CI results and open regressions.',
      recurring: true,
      enabled: true,
      createdAt: now - 3_600_000,
      lastFiredAt: now - 600_000,
      nextRunAt: now + 45 * 60_000,
      sessionId: SESSION_ID,
      sessionMode: 'persistent',
      runs: [],
    },
  ];
  const sessionTasks: DaemonSessionScheduledTaskStatus[] = [
    {
      id: 'cron-build-watch',
      source: 'cron',
      cronExpr: '*/5 * * * *',
      prompt: 'Check the release pipeline status and report any failed jobs.',
      recurring: true,
      createdAt: now - 120_000,
      expiresAt: now + 3_600_000,
      lastFiredAt: null,
      nextRunAt: now + 3 * 60_000,
    },
    {
      id: 'wakeup-deploy-check',
      source: 'wakeup',
      cronExpr: '@wakeup',
      prompt: 'Verify canary rollout metrics after the soak window.',
      recurring: false,
      createdAt: now - 60_000,
      expiresAt: null,
      lastFiredAt: null,
      nextRunAt: now + 8 * 60_000,
    },
  ];

  const scenario = createWebShellDaemonScenario({
    sessionId: SESSION_ID,
    events: [
      userTextEvent(
        'Watch the release pipeline every 5 minutes and follow up on canary metrics.',
        { id: 1 },
      ),
      toolCallEvent(
        'tool-cron-1',
        'cron_create',
        {
          cron: '*/5 * * * *',
          prompt:
            'Check the release pipeline status and report any failed jobs.',
          recurring: true,
          durable: false,
        },
        {
          id: 2,
          rawOutput: {
            returnDisplay:
              'Scheduled job cron-build-watch (*/5 * * * *, recurring)',
            llmContent: 'Created scheduled task (id: cron-build-watch)',
          },
        },
      ),
      assistantTextEvent(
        'Scheduled the 5-minute pipeline check and armed a canary follow-up wakeup in this session.',
        { id: 3 },
      ),
      turnCompleteEvent('prompt-scheduled-1', { id: 4 }),
    ],
  });

  return { scenario, durableTasks, sessionTasks };
}

async function setupScheduledRoutes(
  page: Page,
  baseURL: string,
  state: {
    durableTasks: DaemonScheduledTask[];
    sessionTasks: DaemonSessionScheduledTaskStatus[];
    cancelledPayloads: Array<{ taskId: string; kind: unknown }>;
    patchedPayloads: Array<{ taskId: string; body: Record<string, unknown> }>;
  },
) {
  const origin = new URL(baseURL).origin;
  await page.route(
    (url) =>
      url.origin === origin &&
      (url.pathname === '/scheduled-tasks' ||
        url.pathname.startsWith('/scheduled-tasks/') ||
        url.pathname === `/session/${SESSION_ID}/tasks` ||
        url.pathname.startsWith(`/session/${SESSION_ID}/tasks/`)),
    async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();

      if (url.pathname === '/scheduled-tasks' && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ tasks: state.durableTasks }),
        });
        return;
      }

      const patchMatch = url.pathname.match(/^\/scheduled-tasks\/([^/]+)$/);
      if (patchMatch && method === 'PATCH') {
        const taskId = decodeURIComponent(patchMatch[1]!);
        const body = (route.request().postDataJSON() ?? {}) as Record<
          string,
          unknown
        >;
        state.patchedPayloads.push({ taskId, body });
        state.durableTasks = state.durableTasks.map((task) =>
          task.id === taskId && typeof body['enabled'] === 'boolean'
            ? { ...task, enabled: body['enabled'] }
            : task,
        );
        const updated = state.durableTasks.find((task) => task.id === taskId);
        await route.fulfill({
          status: updated ? 200 : 404,
          contentType: 'application/json',
          body: JSON.stringify(updated ?? { error: 'not found' }),
        });
        return;
      }

      if (url.pathname === `/session/${SESSION_ID}/tasks` && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            v: 1,
            sessionId: SESSION_ID,
            now: Date.now(),
            tasks: [],
            scheduledTasks: state.sessionTasks,
          }),
        });
        return;
      }

      const cancelMatch = url.pathname.match(
        new RegExp(`^/session/${SESSION_ID}/tasks/([^/]+)/cancel$`),
      );
      if (cancelMatch && method === 'POST') {
        const taskId = decodeURIComponent(cancelMatch[1]!);
        const body = (route.request().postDataJSON() ?? {}) as Record<
          string,
          unknown
        >;
        state.cancelledPayloads.push({ taskId, kind: body['kind'] });
        const before = state.sessionTasks.length;
        state.sessionTasks = state.sessionTasks.filter(
          (task) => task.id !== taskId,
        );
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            cancelled: state.sessionTasks.length < before,
          }),
        });
        return;
      }

      await route.fallback();
    },
  );
}

test('surfaces durable and session-scoped scheduled tasks in header, composer chips, and environment panel', async ({
  page,
}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL ?? 'http://127.0.0.1:5174';
  const now = Date.now();
  const { scenario, durableTasks, sessionTasks } = buildScenario(now);
  const state = {
    durableTasks,
    sessionTasks,
    cancelledPayloads: [] as Array<{ taskId: string; kind: unknown }>,
    patchedPayloads: [] as Array<{
      taskId: string;
      body: Record<string, unknown>;
    }>,
  };

  await installMockDaemon(page, scenario, baseURL);
  await setupScheduledRoutes(page, baseURL, state);

  await page.addInitScript(() => {
    window.localStorage.setItem('qwen-code-web-shell-language', 'en');
    window.localStorage.setItem('qwen-code-web-shell-theme', 'dark');
  });
  await page.goto(`${baseURL}/session/${SESSION_ID}?theme=dark`);

  const headerEntry = page.locator('[data-web-shell-scheduled-tasks-entry]');
  await expect(headerEntry).toBeVisible();
  await expect(headerEntry).toHaveAttribute('data-active', 'true');
  await expect(headerEntry).toContainText('3');

  const composerChip = page.locator('[data-testid="composer-scheduled-chip"]');
  await expect(composerChip).toBeVisible();
  await expect(composerChip).toContainText('2 scheduled tasks');

  await headerEntry.click();
  const section = page.locator(
    '[data-testid="environment-scheduled-tasks-section"]',
  );
  await expect(section).toBeVisible();
  await expect(
    section.locator('[data-testid="environment-scheduled-task"]'),
  ).toHaveCount(3);
  await expect(section).toContainText('Daily CI digest');
  await expect(section).toContainText('Persistent');
  await expect(section).toContainText('Check the release pipeline status');
  await expect(section).toContainText('Session');
  await expect(section).toContainText('Verify canary rollout metrics');
  await expect(section).toContainText('Loop');

  const captureDir = process.env['CAPTURE_SESSION_SCHEDULED_DIR'];
  if (captureDir) {
    await mkdir(captureDir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await page.screenshot({
      path: join(captureDir, 'session-scheduled-tasks-dark.png'),
      animations: 'disabled',
    });

    await page.evaluate(() => {
      window.localStorage.setItem('qwen-code-web-shell-theme', 'light');
    });
    await page.goto(`${baseURL}/session/${SESSION_ID}?theme=light`);
    await expect(headerEntry).toBeVisible();
    await expect(section).toBeVisible();
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await page.screenshot({
      path: join(captureDir, 'session-scheduled-tasks-light.png'),
      animations: 'disabled',
    });
  }

  // Stop the session-scoped cron task inline.
  const cronRow = section
    .locator('[data-testid="environment-scheduled-task"]')
    .filter({ hasText: 'Check the release pipeline status' });
  await cronRow.locator('button[aria-label="Stop"]').click();

  await expect
    .poll(() => state.cancelledPayloads)
    .toEqual([{ taskId: 'cron-build-watch', kind: 'cron' }]);
  await expect(
    section.locator('[data-testid="environment-scheduled-task"]'),
  ).toHaveCount(2);
  await expect(composerChip).toContainText('1 scheduled task');
  await expect(headerEntry).toContainText('2');

  // Pause the durable task inline.
  const durableRow = section
    .locator('[data-testid="environment-scheduled-task"]')
    .filter({ hasText: 'Daily CI digest' });
  await durableRow.locator('button[aria-label="Disable"]').click();

  await expect
    .poll(() => state.patchedPayloads)
    .toEqual([{ taskId: 'durable-standup', body: { enabled: false } }]);
  await expect(durableRow).toHaveAttribute('data-enabled', 'false');
});
