/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const PRIMARY_CWD = '/tmp/qwen-web-shell-e2e';
const SECONDARY_CWD = '/tmp/qwen-api-service';

function createScenario(): WebShellDaemonScenario {
  return createWebShellDaemonScenario({
    workspaceCwd: PRIMARY_CWD,
    displayName: 'Run auth migration',
    capabilities: {
      features: [
        'session_events',
        // Per-row session counts query by source type; without this feature
        // the SDK refuses the filter and the cells stay unknown, matching
        // the sidebar's own degradation on older daemons.
        'session_source_metadata',
        'workspace_settings',
        'workspace_runtime_removal',
      ],
      workspaces: [
        { id: 'ws-primary', cwd: PRIMARY_CWD, primary: true, trusted: true },
        {
          id: 'ws-api',
          cwd: SECONDARY_CWD,
          primary: false,
          trusted: true,
          removable: true,
        },
      ],
    },
    gitStatus: {
      v: 2,
      workspaceCwd: PRIMARY_CWD,
      branch: 'main',
      staged: 1,
      unstaged: 1,
      untracked: 0,
      conflicted: 0,
    },
    mcp: {
      servers: [
        {
          kind: 'mcp_server',
          name: 'github',
          status: 'ok',
          transport: 'stdio',
          disabled: false,
          mcpStatus: 'connected',
        },
        {
          kind: 'mcp_server',
          name: 'jira',
          status: 'error',
          error: 'spawn failed',
          transport: 'stdio',
          disabled: false,
          mcpStatus: 'disconnected',
        },
      ],
    },
  });
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

async function openPanel(
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
  await page.getByTestId('manage-workspaces').click();
  await expect(page.getByTestId('workspaces-overview-panel')).toBeVisible();
}

test('lists every workspace with its health from the Projects entry', async ({
  page,
}, testInfo) => {
  const scenario = createScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await openPanel(page, scenario, daemon);

  const panel = page.getByTestId('workspaces-overview-panel');
  await expect(panel.getByText('2 workspaces')).toBeVisible();

  const primaryRow = panel.locator('tbody tr', { hasText: PRIMARY_CWD });
  await expect(primaryRow.getByText('primary')).toBeVisible();
  // Both mock sessions live in the primary workspace.
  await expect(primaryRow.getByText('2', { exact: true })).toBeVisible();
  // MCP: one connected of two enabled, one failed.
  await expect(primaryRow.getByText('1/2')).toBeVisible();
  await expect(primaryRow.getByText('1 failed')).toBeVisible();
  // Branch plus the dirty counter from the enriched status.
  await expect(primaryRow.getByText('main')).toBeVisible();
  await expect(primaryRow.getByText('2 changed')).toBeVisible();

  const secondaryRow = panel.locator('tbody tr', { hasText: SECONDARY_CWD });
  await expect(secondaryRow).toBeVisible();
  await expect(
    secondaryRow.getByRole('button', { name: 'New task' }),
  ).toBeEnabled();

  // The back arrow returns to the chat view.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('workspaces-overview-panel')).toBeHidden();
});

test('offers the shared removal dialog on removable rows only', async ({
  page,
}, testInfo) => {
  const scenario = createScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await openPanel(page, scenario, daemon);

  const panel = page.getByTestId('workspaces-overview-panel');
  const primaryRow = panel.locator('tbody tr', { hasText: PRIMARY_CWD });
  const secondaryRow = panel.locator('tbody tr', { hasText: SECONDARY_CWD });
  await expect(
    primaryRow.getByRole('button', { name: 'Remove workspace' }),
  ).toHaveCount(0);

  await secondaryRow.getByRole('button', { name: 'Remove workspace' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(SECONDARY_CWD)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});
