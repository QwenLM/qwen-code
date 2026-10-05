/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import { createWebShellDaemonScenario } from '../utils/mockDaemon';
import {
  captureScreenshot,
  clearFocus,
  FIXED_CAPTURE_TIME,
  gotoNewSession,
  installScenario,
  resolveBaseURL,
  VISUAL_VIEWPORT,
  type VisualTheme,
} from './harness';

/**
 * Agent collaboration: the @ picker in an ordinary chat, and the Agents page
 * (roster, runtimes, adding a runtime, a new agent on a runtime, sharing).
 *
 * Agents answer inside the chat session they were mentioned in, so there is
 * no separate conversation surface to capture here.
 */

const THEMES: readonly VisualTheme[] = ['dark', 'light'];
const NOW = FIXED_CAPTURE_TIME.getTime();
const MIN = 60_000;

test.use({ viewport: { ...VISUAL_VIEWPORT } });

const agents = [
  {
    id: 'ag_lead',
    name: 'lead',
    description: 'Plans the work and brings in the right people.',
    enabled: true,
    status: 'working',
    waiting: 0,
  },
  {
    id: 'ag_reviewer',
    name: 'reviewer',
    description: 'Reviews changes for correctness.',
    enabled: true,
    status: 'working',
    waiting: 1,
  },
  {
    id: 'ag_docs',
    name: 'docs',
    description: 'Writes user-facing docs.',
    enabled: true,
    status: 'idle',
    waiting: 0,
  },
  {
    id: 'ag_archivist',
    name: 'archivist',
    description: 'Paused while the archive moves.',
    enabled: false,
    status: 'offline',
    waiting: 0,
  },
];

/** The live run stream is aborted: without it the page falls back to reads. */
function isAgentStream(path: string): boolean {
  return path.endsWith('/session-events');
}

async function setup(page: Page, baseURL: string): Promise<string[]> {
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: ['session_events', 'agent_collaboration_v1'] },
  });
  await installScenario(page, scenario, baseURL);
  const requested: string[] = [];
  await page.route('**/workspaces/*/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    requested.push(`${route.request().method()} ${path}`);
    if (isAgentStream(path)) return route.abort();
    if (path.endsWith('/agents')) return route.fulfill({ json: { agents } });
    if (/\/sessions\/[^/]+\/runs$/.test(path))
      return route.fulfill({ json: { frames: [] } });
    return route.fulfill({ status: 404, json: { error: 'not in fixture' } });
  });
  return requested;
}

async function openAgents(page: Page, theme: VisualTheme): Promise<void> {
  await gotoNewSession(page, theme);
  await page
    .getByRole('button', { name: 'Agents', exact: true })
    .first()
    .click();
  await expect(page.getByText('archivist', { exact: true })).toBeVisible();
}

for (const theme of THEMES) {
  test(`collaboration mention picker (${theme})`, async ({
    page,
  }, testInfo) => {
    const requested = await setup(page, resolveBaseURL(testInfo));
    await gotoNewSession(page, theme);
    await page
      .locator('[data-web-shell-composer-editor]:visible .cm-content')
      .click();
    await page.keyboard.type('@');
    await page.keyboard.press('Enter');
    // The picker lists the agents; an empty one is the regression to catch.
    await expect(page.getByText('reviewer', { exact: true })).toBeVisible();
    await captureScreenshot(page, `collab-mention-picker-${theme}`);
    // Picking an agent only writes the mention; the reply comes back in this
    // session, so nothing opens a separate conversation.
    // TODO(multi-agent): this pick-and-insert step has not been run yet.
    await page.getByText('reviewer', { exact: true }).click();
    await expect(
      page.locator('[data-web-shell-composer-editor]:visible .cm-content'),
    ).toContainText('@reviewer');
    expect(requested.filter((entry) => entry.includes('/threads'))).toEqual(
      [],
    );
  });

  test(`collaboration agents page (${theme})`, async ({ page }, testInfo) => {
    await setup(page, resolveBaseURL(testInfo));
    await openAgents(page, theme);
    // Roster and runtimes only: conversations live in chat sessions now.
    await expect(
      page.getByRole('radio', { name: 'Conversations', exact: true }),
    ).toHaveCount(0);
    await clearFocus(page);
    await captureScreenshot(page, `collab-agents-${theme}`);
  });
}

/** Runtimes: this computer plus two joined Qwen Code machines. */
async function setupRuntimes(page: Page, baseURL: string): Promise<void> {
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: ['session_events', 'agent_collaboration_v1'] },
  });
  await installScenario(page, scenario, baseURL);
  const local = {
    id: 'local',
    kind: 'local',
    label: 'This computer',
    provider: 'Qwen Code ACP',
    status: 'online',
    workspaceCwd: scenario.workspaceCwd,
  };
  const buildBox = {
    id: 'host_build',
    kind: 'external',
    label: 'build-box',
    provider: 'Qwen Code ACP, Claude Code ACP',
    programs: ['qwen', 'claude'],
    status: 'online',
    workspaceCwd: '/srv/checkout/qwen-code',
    agentCount: 1,
    runningTaskCount: 1,
    queuedTaskCount: 2,
    lastSeenAt: NOW - 5_000,
  };
  const macMini = {
    id: 'host_mac',
    kind: 'external',
    label: 'mac-mini',
    provider: 'Qwen Code ACP',
    programs: ['qwen'],
    status: 'offline',
    workspaceCwd: '/Users/dev/qwen-code',
    agentCount: 0,
    lastSeenAt: NOW - 3 * 60 * MIN,
  };
  let runtimes = [local, buildBox, macMini];
  const remoteAgents = [
    {
      id: 'ag_lead',
      name: 'lead',
      description: 'Plans the work and brings in the right people.',
      enabled: true,
      status: 'idle',
      waiting: 0,
      runtime: local,
    },
    {
      id: 'ag_builder',
      name: 'builder',
      description: 'Runs the long builds on the build machine.',
      enabled: true,
      status: 'working',
      waiting: 2,
      runtime: buildBox,
      execution: {
        mode: 'managed-host',
        hostIds: ['host_build'],
        provider: 'qwen',
      },
    },
    {
      // What a runtime creates for each program it offers.
      id: 'ag_claude_build',
      name: 'claude-build-box',
      enabled: true,
      status: 'idle',
      waiting: 0,
      runtime: buildBox,
      execution: {
        mode: 'managed-host',
        hostIds: ['host_build'],
        provider: 'claude',
      },
    },
  ];
  await page.route('**/workspaces/*/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (isAgentStream(path)) return route.abort();
    if (path.endsWith('/hosts/enrollment') && method === 'POST')
      return route.fulfill({
        json: {
          token: `join_${'x'.repeat(40)}`,
          workspaceId: 'ws_demo',
          expiresAt: NOW + 15 * MIN,
        },
      });
    const removedHost = /\/hosts\/([^/]+)$/.exec(path)?.[1];
    if (removedHost && method === 'DELETE') {
      runtimes = runtimes.filter((runtime) => runtime.id !== removedHost);
      return route.fulfill({ json: { agentsMadeLocal: [] } });
    }
    if (path.endsWith('/agents') && method === 'GET')
      return route.fulfill({
        json: {
          agents: remoteAgents,
          runtimes,
        },
      });
    return route.fulfill({ status: 404, json: { error: 'not in fixture' } });
  });
}

for (const theme of THEMES) {
  test(`collaboration runtimes (${theme})`, async ({ page }, testInfo) => {
    await setupRuntimes(page, resolveBaseURL(testInfo));
    await gotoNewSession(page, theme);
    await page
      .getByRole('button', { name: 'Agents', exact: true })
      .first()
      .click();
    await page.getByRole('radio', { name: 'Runtimes', exact: true }).click();
    await expect(page.getByText('mac-mini', { exact: true })).toBeVisible();
    // Each runtime lists the programs it reported.
    await expect(page.getByText('Qwen Code, Claude Code')).toBeVisible();
    await clearFocus(page);
    await captureScreenshot(page, `collab-runtimes-${theme}`);

    page.once('dialog', (dialog) => dialog.accept());
    const removed = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        request.url().endsWith('/hosts/host_mac'),
    );
    await page
      .locator('section', {
        has: page.getByRole('heading', { name: 'mac-mini' }),
      })
      .last()
      .getByRole('button', { name: 'Remove' })
      .click();
    await removed;
    await expect(page.getByText('mac-mini', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Add a runtime' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Create join command' }).click();
    // The command carries the token; waiting for it is waiting for the link.
    await expect(dialog.getByText(/join_x+/).first()).toBeVisible();
    await captureScreenshot(page, `collab-add-runtime-${theme}`);

    // The reverse direction: this computer joins another coordinator.
    await dialog.getByRole('tab', { name: 'Join a coordinator' }).click();
    await dialog
      .getByLabel('Join link')
      .fill('https://coordinator.example:4170/join/ws_team');
    await expect(
      dialog.getByText(/qwen serve --no-web --port 0 --join/),
    ).toBeVisible();
  });

  test(`collaboration new agent on runtime (${theme})`, async ({
    page,
  }, testInfo) => {
    await setupRuntimes(page, resolveBaseURL(testInfo));
    await gotoNewSession(page, theme);
    await page
      .getByRole('button', { name: 'Agents', exact: true })
      .first()
      .click();
    await page.getByRole('button', { name: 'New agent', exact: true }).click();
    // A runtime offers the programs it reported: here Qwen Code and Claude
    // Code, not Codex.
    await page
      .locator('label', { hasText: '/srv/checkout/qwen-code' })
      .first()
      .click();
    const programs = page.locator('input[name="agent-execution-provider"]');
    await expect(programs).toHaveCount(3);
    await programs.first().scrollIntoViewIfNeeded();
    await expect(programs.nth(0)).toBeChecked();
    await expect(programs.nth(1)).toBeEnabled();
    await expect(programs.nth(2)).toBeDisabled();
    await clearFocus(page);
    await captureScreenshot(page, `collab-new-agent-runtime-${theme}`);
  });
}

async function setupSharing(page: Page, baseURL: string): Promise<void> {
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: ['session_events', 'agent_collaboration_v1'] },
  });
  await installScenario(page, scenario, baseURL);
  await page.route('**/workspaces/*/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (isAgentStream(path)) return route.abort();
    if (path.endsWith('/agents') && method === 'GET')
      return route.fulfill({
        json: {
          agents: [
            {
              id: 'ag_lead',
              name: 'lead',
              enabled: true,
              status: 'idle',
              waiting: 0,
            },
          ],
        },
      });
    if (/\/agents\/[^/]+\/shares$/.test(path))
      return method === 'POST'
        ? route.fulfill({
            status: 201,
            json: {
              endpoint: 'http://192.168.1.20:4170/a2a/v1',
              workspaceId: 'ws_demo',
              callerId: 'share_3f9a1c',
              agentId: 'ag_lead',
              secret: `a2a_${'s'.repeat(40)}`,
              expiresAt: NOW + 7 * 24 * 60 * MIN,
            },
          })
        : route.fulfill({ json: { shares: [] } });
    return route.fulfill({ status: 404, json: { error: 'not in fixture' } });
  });
}

for (const theme of THEMES) {
  test(`collaboration share (${theme})`, async ({ page }, testInfo) => {
    await setupSharing(page, resolveBaseURL(testInfo));
    await gotoNewSession(page, theme);
    await page
      .getByRole('button', { name: 'Agents', exact: true })
      .first()
      .click();
    await page.getByRole('button', { name: 'More actions for lead' }).click();
    await page.getByRole('menuitem', { name: 'Share' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Create link' }).click();
    await expect(dialog.getByText(/a2a_s+/).first()).toBeVisible();
    await captureScreenshot(page, `collab-share-${theme}`);
    await page.keyboard.press('Escape');
  });
}
