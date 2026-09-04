/**
 * @license
 * Copyright 2025 Qwen
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
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'workspace_settings',
        'workspace_voice',
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
    gitStatus: { v: 2, workspaceCwd: PRIMARY_CWD, branch: 'main' },
    // The secondary workspace answers with its own counts so a row showing
    // another workspace's facets would be caught.
    workspaceOverviews: {
      [SECONDARY_CWD]: {
        skills: {
          skills: [
            {
              kind: 'skill',
              status: 'ok',
              name: 'a',
              description: '',
              level: 'project',
              modelInvocable: true,
            },
            {
              kind: 'skill',
              status: 'ok',
              name: 'b',
              description: '',
              level: 'project',
              modelInvocable: true,
            },
            {
              kind: 'skill',
              status: 'ok',
              name: 'c',
              description: '',
              level: 'project',
              modelInvocable: true,
            },
          ],
        },
        memory: { fileCount: 2, ruleCount: 7 },
        mcp: { servers: [] },
      },
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
        {
          kind: 'mcp_server',
          name: 'legacy',
          status: 'ok',
          transport: 'stdio',
          disabled: true,
          disabledReason: 'config',
        },
      ],
    },
    skills: {
      skills: [
        {
          kind: 'skill',
          status: 'ok',
          name: 'review',
          description: 'Review a PR',
          level: 'project',
          modelInvocable: true,
        },
        {
          kind: 'skill',
          status: 'ok',
          name: 'deploy',
          description: 'Deploy',
          level: 'user',
          modelInvocable: true,
          disabledReason: 'default',
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
}

/** Facet names requested for one workspace, in request order. */
function overviewRequests(
  daemon: MockDaemonController,
  workspaceCwd: string,
): string[] {
  const prefix = `/workspaces/${encodeURIComponent(workspaceCwd)}/`;
  return daemon.requests
    .filter(
      (request) =>
        request.method === 'GET' &&
        request.path.startsWith(prefix) &&
        /\/(mcp|skills|extensions|channels|memory|hooks)$/.test(request.path),
    )
    .map((request) => request.path.slice(prefix.length));
}

/**
 * Waits until `count()` reports the same value for a quiet window of real
 * time, then returns it. Startup fires several request bursts that the fake
 * clock cannot gate (the StrictMode double mount, the composer skill loader,
 * and one more facet round when the connection settles), so the polling
 * baseline must be taken after those bursts have landed.
 */
async function waitForStableOverviewCount(
  count: () => number,
  quietWindowMs = 2_000,
): Promise<number> {
  const deadline = Date.now() + 15_000;
  let last = count();
  let quietSince = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = Date.now();
    const current = count();
    if (current !== last) {
      last = current;
      quietSince = now;
    } else if (now - quietSince >= quietWindowMs) {
      return current;
    }
    if (now > deadline) {
      throw new Error(
        `overview request count never stabilised (last count: ${current})`,
      );
    }
  }
}

test('shows workspace details on hover and no counts in the header', async ({
  page,
}, testInfo) => {
  const scenario = createScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  const sidebar = page.getByRole('complementary');
  const primaryHeader = sidebar.getByRole('button', {
    name: /^qwen-web-shell-e2e/,
  });
  await expect(primaryHeader).toHaveAttribute('aria-expanded', 'true');

  // The header itself carries no counts; they moved into the popover.
  await expect(primaryHeader.getByLabel('2 sessions')).toHaveCount(0);

  // Hovering the workspace header opens the details popover: full path,
  // branch, session counts, and every known facet, zeros included.
  await primaryHeader.hover();
  const primaryDetails = page.getByRole('dialog', {
    name: 'qwen-web-shell-e2e',
  });
  await expect(primaryDetails).toBeVisible();
  // The primary workspace lists two sessions; nothing is running.
  const primarySessions = primaryDetails.locator(
    '[data-web-shell-workspace-sessions]',
  );
  await expect(primarySessions).toHaveText('Sessions2');
  await expect(primarySessions).toHaveAttribute('title', '2 sessions');
  await expect(
    primaryDetails.locator('[data-web-shell-workspace-path]'),
  ).toHaveText(PRIMARY_CWD);
  const primaryMcp = primaryDetails.locator(
    '[data-web-shell-workspace-overview="mcp"]',
  );
  await expect(primaryMcp).toHaveText('MCP1/2');
  await expect(primaryMcp).toHaveAttribute(
    'title',
    'MCP: 1 of 3 connected, 1 failed, 1 disabled',
  );
  await expect(
    primaryDetails.locator('[data-web-shell-workspace-overview="skills"]'),
  ).toHaveText('Skills1');
  // The popover takes no persistent space, so known zeros show too.
  await expect(
    primaryDetails.locator('[data-web-shell-workspace-overview="extensions"]'),
  ).toHaveText('Extensions0');
  await expect(
    primaryDetails.locator('[data-web-shell-workspace-overview="channels"]'),
  ).toHaveText('Channels0');
  await expect(
    primaryDetails.locator('[data-web-shell-workspace-overview="context"]'),
  ).toHaveText('Context0');
  await page.mouse.move(0, 0);
  await expect(primaryDetails).toBeHidden();

  // The secondary row shows its own facets, not the primary's.
  const secondaryHeader = sidebar.getByRole('button', {
    name: /^qwen-api-service/,
  });
  await secondaryHeader.hover();
  const secondaryDetails = page.getByRole('dialog', {
    name: 'qwen-api-service',
  });
  await expect(secondaryDetails).toBeVisible();
  await expect(
    secondaryDetails.locator('[data-web-shell-workspace-overview="skills"]'),
  ).toHaveText('Skills3');
  await expect(
    secondaryDetails.locator('[data-web-shell-workspace-overview="context"]'),
  ).toHaveText('Context2');
  await expect(
    secondaryDetails.locator('[data-web-shell-workspace-overview="mcp"]'),
  ).toHaveText('MCP0');
  await page.mouse.move(0, 0);
  await expect(secondaryDetails).toBeHidden();

  // Every expanded workspace is asked for exactly the default facet set
  // (hooks stay opt-in). The dev build runs effects twice under StrictMode,
  // so count distinct facets rather than requests.
  const facets = (cwd: string) =>
    [...new Set(overviewRequests(daemon, cwd))].sort();
  await expect
    .poll(() => facets(PRIMARY_CWD))
    .toEqual(['channels', 'extensions', 'mcp', 'memory', 'skills']);
  await expect
    .poll(() => facets(SECONDARY_CWD))
    .toEqual(['channels', 'extensions', 'mcp', 'memory', 'skills']);
  // Once settled, nothing bursts within the settle window; the 30 s poll
  // itself is pinned by the clock-driven spec below.
  const settled = overviewRequests(daemon, PRIMARY_CWD).length;
  await page.waitForTimeout(1_500);
  expect(overviewRequests(daemon, PRIMARY_CWD)).toHaveLength(settled);

  // Collapsing a row stops its facet fetch; the next open refetches.
  const beforeCollapse = overviewRequests(daemon, SECONDARY_CWD).length;
  await secondaryHeader.click();
  await expect(secondaryHeader).toHaveAttribute('aria-expanded', 'false');
  await secondaryHeader.click();
  await expect(secondaryHeader).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() => overviewRequests(daemon, SECONDARY_CWD).length)
    .toBeGreaterThan(beforeCollapse);
  expect(overviewRequests(daemon, PRIMARY_CWD)).toHaveLength(settled);
});

test('opens the workspace menu with management entries on the primary workspace only', async ({
  page,
}, testInfo) => {
  const scenario = createScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  const sidebar = page.getByRole('complementary');

  // A secondary workspace has no management entries yet, but can be removed.
  const secondaryRow = sidebar
    .getByRole('button', { name: /^qwen-api-service/ })
    .locator('..');
  await secondaryRow.hover();
  await secondaryRow.getByRole('button', { name: 'Workspace actions' }).click();
  const secondaryMenu = page.getByRole('menu');
  await expect(secondaryMenu.getByRole('menuitem')).toHaveText([
    'Copy path',
    'New task',
    'New worktree task',
    'Reload runtime',
    'Remove workspace',
  ]);
  // "New worktree task" opens a draft in that workspace with the composer's
  // git mode armed for a worktree.
  await secondaryMenu
    .getByRole('menuitem', { name: 'New worktree task' })
    .click();
  await expect(secondaryMenu).toBeHidden();
  await expect(page.getByRole('button', { name: 'Worktree' })).toBeVisible();

  const primaryRow = sidebar
    .getByRole('button', { name: /^qwen-web-shell-e2e/ })
    .locator('..');
  await primaryRow.hover();
  await primaryRow.getByRole('button', { name: 'Workspace actions' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Copy path',
    'New task',
    'New worktree task',
    'MCP1/2',
    'Skills1',
    'Extensions0',
    'Channels0',
    'Settings',
    'Reload runtime',
  ]);
  await menu.getByRole('menuitem', { name: /^MCP/ }).click();
  await expect(page.getByRole('region', { name: 'MCP Servers' })).toBeVisible();
});

test('polls an expanded workspace once per 30 s tick and not faster @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  // A fake clock lets the spec observe the 30 s cadence without waiting.
  // Pausing it keeps startup (StrictMode double mount, the composer skill
  // loader, any connection-settle re-fetch) from eating into the interval
  // the assertions measure: every startup timer is pinned to one fake
  // instant, and nothing fires until runFor below.
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await gotoSession(page, scenario, daemon);
  const facets = (cwd: string) =>
    [...new Set(overviewRequests(daemon, cwd))].sort();
  await expect
    .poll(() => facets(PRIMARY_CWD))
    .toEqual(['channels', 'extensions', 'mcp', 'memory', 'skills']);
  // Let the real-time startup bursts land before counting.
  await waitForStableOverviewCount(
    () => overviewRequests(daemon, PRIMARY_CWD).length,
  );
  // Flush everything the paused startup scheduled below one cadence,
  // including the first poll tick itself, so the baseline sits on a known
  // interval phase.
  await page.clock.runFor(30_500);
  const settled = await waitForStableOverviewCount(
    () => overviewRequests(daemon, PRIMARY_CWD).length,
  );

  // Just short of the next tick: no new facet requests.
  await page.clock.runFor(29_000);
  await page.waitForTimeout(200);
  expect(overviewRequests(daemon, PRIMARY_CWD)).toHaveLength(settled);

  // Past the tick: exactly one more round of the default facets.
  await page.clock.runFor(2_000);
  await expect
    .poll(() => overviewRequests(daemon, PRIMARY_CWD).length)
    .toBe(settled + 5);
});

test('opens the workspace folder and terminal locally when the daemon is loopback', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: PRIMARY_CWD,
    displayName: 'Run auth migration',
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'workspace_settings',
        'workspace_voice',
        'workspace_local_open',
        'workspace_local_terminal',
      ],
      workspaces: [
        { id: 'ws-primary', cwd: PRIMARY_CWD, primary: true, trusted: true },
      ],
    },
    gitStatus: { v: 2, workspaceCwd: PRIMARY_CWD, branch: 'main' },
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
    }),
  );

  const sidebar = page.getByRole('complementary');
  const header = sidebar.getByRole('button', { name: /^qwen-web-shell-e2e/ });
  await expect(header).toBeVisible();

  // The hover popover's path row carries the open-locally buttons.
  await header.hover();
  const details = page.getByRole('dialog', { name: 'qwen-web-shell-e2e' });
  await expect(details).toBeVisible();
  const openRequests = () =>
    daemon.requests.filter(
      (request) =>
        request.method === 'POST' &&
        /\/workspaces\/.+\/open\/?$/.test(request.path),
    );
  const openButton = details.locator('[data-web-shell-open-workspace-folder]');
  await expect(openButton).toBeVisible();
  await openButton.click();
  await expect.poll(() => openRequests()).toHaveLength(1);

  const terminalButton = details.locator(
    '[data-web-shell-open-workspace-terminal]',
  );
  await expect(terminalButton).toBeVisible();
  await terminalButton.click();
  await expect.poll(() => openRequests()).toHaveLength(2);
  expect(openRequests()[1]?.body).toEqual({ target: 'terminal' });

  // The workspace menu offers the same actions. The button clicks focused
  // the popover content, which now holds the popover open (keyboard parity),
  // so dismiss it explicitly.
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await header.hover();
  await header
    .locator('..')
    .getByRole('button', { name: 'Workspace actions' })
    .click();
  const menu = page.getByRole('menu');
  await expect(
    menu.getByRole('menuitem', { name: 'Open folder' }),
  ).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: 'Open terminal' }),
  ).toBeVisible();
});
