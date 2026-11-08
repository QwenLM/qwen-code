/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

// Real browser surface for the trust-withheld hooks state: the Daemon Status
// panel reads the workspace hooks section, which now carries the listing's
// disabledReason for trust-withheld project hooks.
test('daemon status shows trust-withheld project hooks @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      workspaces: [
        {
          id: 'project',
          cwd: '/tmp/qwen-hooks-status-e2e',
          primary: true,
          trusted: true,
        },
      ],
    },
  });
  scenario.workspaceOverviews['/tmp/qwen-hooks-status-e2e'] = {
    hooks: {
      hooks: [
        {
          kind: 'hook',
          eventName: 'SessionStart',
          config: { type: 'command', command: 'node marker.mjs' },
          source: 'project',
          enabled: false,
          disabledReason: 'untrusted',
        },
      ],
    } as never,
  };
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  // The mock daemon has no /daemon/status route; serve a minimal report whose
  // workspace hooks section carries the trust-withheld entry, the same shape
  // the real daemon's buildWorkspaceHooksStatus produces.
  await page.route('**/daemon/status*', async (route) => {
    await route.fulfill({
      json: {
        v: 1,
        detail: 'full',
        generatedAt: new Date().toISOString(),
        status: 'ok',
        issues: [],
        daemon: {
          pid: 1,
          uptimeMs: 1000,
          mode: 'http-bridge',
          workspaceCwd: '/tmp/qwen-hooks-status-e2e',
          qwenCodeVersion: '0.0.0-e2e',
        },
        security: {
          tokenConfigured: false,
          requireAuth: false,
          loopbackBind: true,
          allowOriginConfigured: false,
          allowOriginMode: 'loopback',
          sessionShellCommandEnabled: true,
        },
        limits: {
          maxSessions: null,
          maxTotalSessions: null,
          maxPendingPromptsPerSession: null,
          listenerMaxConnections: null,
          eventRingSize: 1000,
          promptDeadlineMs: null,
          writerIdleTimeoutMs: null,
          channelIdleTimeoutMs: 60000,
          sessionIdleTimeoutMs: 60000,
          acpConnectionCap: null,
          compactedReplayMaxBytes: 1000000,
          maxJournalEvents: 1000,
          maxJournalBytes: 1000000,
        },
        capabilities: {
          features: [],
          workspaces: [
            {
              id: 'project',
              cwd: '/tmp/qwen-hooks-status-e2e',
              primary: true,
              trusted: true,
            },
          ],
        },
        runtime: {
          process: { rss: 1000000, heapTotal: 500000, heapUsed: 300000 },
          sessions: { active: 0 },
          permissions: { pending: 0, policy: 'default' },
          channel: { live: false },
          channelWorker: { state: 'idle', enabled: false },
          transport: {
            restSseActive: 0,
            acp: {
              enabled: true,
              connections: 0,
              connectionStreams: 0,
              sessionStreams: 0,
              sseStreams: 0,
              wsStreams: 0,
              pendingClientRequests: 0,
            },
          },
          rateLimit: { enabled: false, rejectedSinceStart: {} },
        },
        full: {
          sessions: [],
          acpConnections: [],
          auth: {
            supportedDeviceFlowProviders: [],
            pendingDeviceFlowCount: 0,
          },
          workspace: {
            'workspace.hooks': {
              status: 'ok',
              durationMs: 1,
              summary: { initialized: true, hooksCount: 1 },
              data: {
                v: 1,
                workspaceCwd: '/tmp/qwen-hooks-status-e2e',
                initialized: true,
                disabled: false,
                hooks: [
                  {
                    kind: 'hook',
                    eventName: 'SessionStart',
                    config: { type: 'command', command: 'node marker.mjs' },
                    source: 'project',
                    enabled: false,
                    disabledReason: 'untrusted',
                  },
                ],
                events: {},
              },
            },
          },
        },
      },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?language=en');
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();

  // In the rail layout the footer (incl. Daemon Status) lives in the
  // More popover.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const statusButton = page.getByRole('button', { name: 'Daemon Status' });
  await expect(statusButton).toBeVisible({ timeout: 15_000 });
  await statusButton.click();
  // The status panel is a page region, not a role=dialog.
  const panel = page.getByRole('region', { name: 'Daemon Status' });
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await panel.getByRole('tab', { name: 'Diagnostics' }).click();
  await expect(panel.getByText('workspace.hooks')).toBeVisible({
    timeout: 20_000,
  });
  await expect(panel.getByText('hooksCount: 1')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('daemon-status-hooks.png'),
    fullPage: false,
  });
});
