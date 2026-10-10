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

function createScenario(advertiseGrant: boolean): WebShellDaemonScenario {
  return createWebShellDaemonScenario({
    workspaceCwd: PRIMARY_CWD,
    displayName: 'Run auth migration',
    capabilities: {
      features: [
        'session_events',
        'session_source_metadata',
        'workspace_settings',
        ...(advertiseGrant ? ['workspace_trust_grant'] : []),
      ],
      workspaces: [
        { id: 'ws-primary', cwd: PRIMARY_CWD, primary: true, trusted: true },
        {
          id: 'ws-api',
          cwd: SECONDARY_CWD,
          primary: false,
          trusted: false,
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
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
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

test('trusts an untrusted workspace from the Projects panel', async ({
  page,
}, testInfo) => {
  const scenario = createScenario(true);
  const daemon = await installScenario(page, scenario, testInfo);

  // Registered after the mock daemon, so this handler wins the route.
  const grants: string[] = [];
  await page.route('**/trust/grant', async (route) => {
    grants.push(route.request().url());
    // Stands in for the daemon's trust-file write, which the runtime
    // reconcile only reports on a later capabilities fetch.
    scenario.capabilities.workspaces = (
      scenario.capabilities.workspaces ?? []
    ).map((workspace) =>
      workspace.cwd === SECONDARY_CWD
        ? { ...workspace, trusted: true }
        : workspace,
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        v: 1,
        workspaceCwd: SECONDARY_CWD,
        folderTrustEnabled: true,
        effective: { state: 'trusted', source: 'file' },
        explicitTrustLevel: 'TRUST_FOLDER',
        requiresDaemonRestartForChanges: false,
      }),
    });
  });

  await openPanel(page, scenario, daemon);
  const panel = page.getByTestId('workspaces-overview-panel');
  const row = panel.locator('tbody tr', { hasText: SECONDARY_CWD });
  await expect(row.getByText('untrusted')).toBeVisible();
  const trust = row.getByRole('button', { name: 'Trust', exact: true });
  await expect(trust).toBeVisible();
  await expect(row.getByRole('button', { name: 'New task' })).toHaveCount(0);

  await trust.click();
  await expect
    .poll(() => grants.length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  expect(grants[0]).toBe(
    `${origin}/workspaces/${encodeURIComponent(SECONDARY_CWD)}/trust/grant`,
  );

  // The daemon agrees on the next fetch, so the row leaves its dead end.
  const newTask = row.getByRole('button', { name: 'New task' });
  await expect(newTask).toBeEnabled({ timeout: 15_000 });
  await expect(trust).toHaveCount(0);
});

test('keeps an untrusted workspace read-only on a daemon without the grant', async ({
  page,
}, testInfo) => {
  const scenario = createScenario(false);
  const daemon = await installScenario(page, scenario, testInfo);
  await openPanel(page, scenario, daemon);

  const panel = page.getByTestId('workspaces-overview-panel');
  const row = panel.locator('tbody tr', { hasText: SECONDARY_CWD });
  await expect(row.getByText('untrusted')).toBeVisible();
  await expect(
    row.getByRole('button', { name: 'Trust', exact: true }),
  ).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'New task' })).toBeDisabled();
});
