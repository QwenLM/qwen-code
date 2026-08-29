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

test('shows facet chips and session counts for the expanded primary workspace', async ({
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

  // The primary workspace lists two sessions; nothing is running.
  await expect(primaryHeader.getByLabel('2 sessions')).toBeVisible();

  // Both workspaces start expanded; the primary section renders first.
  const chipLists = sidebar.getByRole('list', { name: 'Workspace overview' });
  const chips = chipLists.first();
  await expect(chips.getByLabel(/^MCP:/)).toHaveText('MCP1/2');
  await expect(chips.getByLabel(/^MCP:/)).toHaveAttribute(
    'title',
    'MCP: 1 of 3 connected, 1 failed, 1 disabled',
  );
  await expect(chips.getByLabel(/^Skills:/)).toHaveText('Skills1');
  await expect(chips.getByLabel(/^Extensions:/)).toHaveText('Extensions0');
  await expect(chips.getByLabel(/^Channels:/)).toHaveText('Channels0');
  await expect(chips.getByLabel(/^Context:/)).toHaveText('Context0');
  await expect(
    sidebar.locator('[data-web-shell-workspace-path]').first(),
  ).toHaveText(PRIMARY_CWD);

  // The secondary row shows its own facets, not the primary's.
  const secondaryChips = chipLists.nth(1);
  await expect(secondaryChips.getByLabel(/^Skills:/)).toHaveText('Skills3');
  await expect(secondaryChips.getByLabel(/^Context:/)).toHaveText('Context2');
  await expect(secondaryChips.getByLabel(/^MCP:/)).toHaveText('MCP0');
  await expect(chips.getByLabel(/^Skills:/)).toHaveText('Skills1');

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

  // Collapsing a row drops its chips; the next open refetches.
  const secondaryHeader = sidebar.getByRole('button', {
    name: /^qwen-api-service/,
  });
  const beforeCollapse = overviewRequests(daemon, SECONDARY_CWD).length;
  await secondaryHeader.click();
  await expect(secondaryHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(
    sidebar.getByRole('list', { name: 'Workspace overview' }),
  ).toHaveCount(1);
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

test('polls an expanded workspace once per 30 s tick and not faster', async ({
  page,
}, testInfo) => {
  const scenario = createScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  // A fake clock lets the spec observe the 30 s cadence without waiting.
  await page.clock.install();
  await gotoSession(page, scenario, daemon);
  const sidebar = page.getByRole('complementary');
  await expect(
    sidebar.getByRole('list', { name: 'Workspace overview' }).first(),
  ).toBeVisible();
  const facets = (cwd: string) =>
    [...new Set(overviewRequests(daemon, cwd))].sort();
  await expect
    .poll(() => facets(PRIMARY_CWD))
    .toEqual(['channels', 'extensions', 'mcp', 'memory', 'skills']);
  const settled = overviewRequests(daemon, PRIMARY_CWD).length;

  // Just short of a tick: no new facet requests.
  await page.clock.runFor(29_000);
  await page.waitForTimeout(200);
  expect(overviewRequests(daemon, PRIMARY_CWD)).toHaveLength(settled);

  // Past the tick: exactly one more round of the default facets.
  await page.clock.runFor(2_000);
  await expect
    .poll(() => overviewRequests(daemon, PRIMARY_CWD).length)
    .toBe(settled + 5);
});
