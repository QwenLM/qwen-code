/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import type { ThreadDetailView } from '../../components/workspace-agents/ThreadView';
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
 * Agent collaboration: a conversation several agents work in, its team panel
 * and details, the @ picker in an ordinary chat, and the Agents page.
 *
 * One thread carries every run state the screens distinguish -- queued behind
 * others, quiet long enough to look stuck, working through tool steps, and
 * waiting on an approval -- so a change to any of them shows in one capture.
 * Statuses and reasons are the server's own sentences, so the translation of
 * them is what gets rendered.
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
    workingOn: {
      id: 'th_main',
      title: 'Speed up the test suite',
      state: 'working',
    },
    waiting: 0,
  },
  {
    id: 'ag_reviewer',
    name: 'reviewer',
    description: 'Reviews changes for correctness.',
    enabled: true,
    status: 'working',
    workingOn: {
      id: 'th_main',
      title: 'Speed up the test suite',
      state: 'working',
    },
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

function mainThread(): ThreadDetailView {
  return {
    id: 'th_main',
    title: 'Speed up the test suite',
    body: 'Context from the conversation this was sent from:\n\nUser: unit tests now take 14 minutes.',
    status: 'in_progress',
    reason: '3 Agents are running, 1 queued',
    assigneeName: 'lead',
    posts: [
      {
        id: 'p1',
        sequence: 1,
        authorKind: 'human',
        authorName: 'user',
        text: '@lead the unit tests take 14 minutes. Find the slowest suites and propose fixes.',
        at: NOW - 12 * MIN,
      },
      {
        id: 'p2',
        sequence: 2,
        authorKind: 'agent',
        authorName: 'lead',
        sourceRunId: 'run_lead_1',
        text: 'I split this into two parts. @reviewer please check whether the barrel imports in packages/cli slow collection down. I will profile the core suites myself.',
        at: NOW - 10 * MIN,
      },
    ],
    runs: [
      {
        id: 'run_lead_2',
        agentId: 'ag_lead',
        agentName: 'lead',
        status: 'running',
        closeAcknowledged: false,
        trigger: 'mentioned by you',
        startedAt: NOW - 3 * MIN,
        progress: {
          receivedAt: NOW,
          activityAt: NOW - 2_000,
          stage: 'tool',
          detail: 'Shell: npx vitest run --reporter=json packages/core',
          outputText: '',
          steps: [
            {
              id: 's1',
              title: 'Read packages/core/vitest.config.ts',
              status: 'done',
            },
            {
              id: 's2',
              title: 'Shell: npx vitest list packages/core',
              status: 'failed',
            },
            {
              id: 's3',
              title: 'Shell: npx vitest run --reporter=json packages/core',
              status: 'running',
            },
          ],
        },
      },
      {
        id: 'run_reviewer_1',
        agentId: 'ag_reviewer',
        agentName: 'reviewer',
        status: 'running',
        closeAcknowledged: false,
        trigger: 'mentioned by lead',
        startedAt: NOW - 9 * MIN,
        progress: {
          receivedAt: NOW,
          activityAt: NOW - 6 * MIN,
          stage: 'thinking',
          detail: '',
        },
      },
      {
        id: 'run_docs_1',
        agentId: 'ag_docs',
        agentName: 'docs',
        status: 'running',
        closeAcknowledged: false,
        trigger: 'mentioned by lead',
        sessionId: 'sess_docs',
        startedAt: NOW - MIN,
        progress: {
          receivedAt: NOW,
          activityAt: NOW - 5_000,
          stage: 'awaiting_approval',
          detail: 'WriteFile: docs/testing.md',
          permission: {
            requestId: 'perm_1',
            title: 'WriteFile: docs/testing.md',
            options: [
              {
                optionId: 'allow_once',
                name: 'Allow once',
                kind: 'allow_once',
              },
              { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
            ],
          },
        },
      },
      {
        id: 'run_tester_1',
        agentId: 'ag_tester',
        agentName: 'tester',
        status: 'queued',
        queueAhead: 2,
        closeAcknowledged: false,
        trigger: 'mentioned by lead',
      },
      {
        id: 'run_lead_1',
        agentId: 'ag_lead',
        agentName: 'lead',
        status: 'completed',
        closeAcknowledged: true,
        trigger: 'mentioned by you',
        startedAt: NOW - 12 * MIN,
        endedAt: NOW - 10 * MIN,
      },
    ],
    children: [
      {
        id: 'th_child_1',
        title: 'Check barrel imports in packages/cli',
        status: 'in_progress',
        reason: '1 Agent is running',
        assigneeName: 'reviewer',
      },
    ],
    budget: {
      turnsUsed: 3,
      turnLimit: 12,
      tokensUsed: 184_000,
      tokenLimit: 1_000_000,
    },
  };
}

async function setup(page: Page, baseURL: string): Promise<string> {
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: ['session_events', 'agent_collaboration_v1'] },
  });
  await installScenario(page, scenario, baseURL);
  const thread = mainThread();
  await page.route('**/workspaces/*/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    // Without the live stream the page falls back to reads, which is all a
    // still capture needs.
    if (path.endsWith('/events')) return route.abort();
    if (path.endsWith('/agents')) return route.fulfill({ json: { agents } });
    if (path.endsWith(`/threads/${thread.id}`) && method === 'PATCH') {
      const { assignee } = route.request().postDataJSON() as {
        assignee: string | null;
      };
      if (assignee) thread.assigneeName = assignee;
      else delete thread.assigneeName;
      return route.fulfill({ json: { id: thread.id, assignee } });
    }
    if (path.endsWith(`/threads/${thread.id}/done`) && method === 'POST') {
      thread.status = 'done';
      thread.reason = 'a person marked this thread done';
      return route.fulfill({ json: { id: thread.id, status: 'done' } });
    }
    if (path.endsWith(`/threads/${thread.id}`))
      return route.fulfill({ json: thread });
    if (path.endsWith('/threads'))
      return route.fulfill({
        json: {
          threads: [
            { ...thread, updatedAt: NOW, liveRunCount: 4 },
            {
              id: 'th_done',
              title: 'Rename the settings keys',
              status: 'done',
              reason: 'a person marked this thread done',
              updatedAt: NOW - 60 * MIN,
              liveRunCount: 0,
            },
          ],
        },
      });
    return route.fulfill({ status: 404, json: { error: 'not in fixture' } });
  });
  return scenario.workspaceCwd;
}

/** Opens the collaboration conversation the way the sidebar does. */
async function openConversation(
  page: Page,
  theme: VisualTheme,
  cwd: string,
): Promise<void> {
  await page.addInitScript(
    ({ id, cwd }) => {
      sessionStorage.setItem(
        'qwen:team-conversation',
        JSON.stringify({ id, cwd, server: location.origin }),
      );
    },
    { id: 'th_main', cwd },
  );
  await gotoNewSession(page, theme);
  // The approval is the one card only this fixture's docs run produces.
  await expect(
    page.locator('[data-web-shell-permission-panel]').filter({
      hasText: 'docs/testing.md',
    }),
  ).toBeVisible();
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
  test(`collaboration conversation (${theme})`, async ({ page }, testInfo) => {
    const cwd = await setup(page, resolveBaseURL(testInfo));
    await openConversation(page, theme, cwd);
    await expect(
      page.getByRole('button', { name: 'Accept and mark done' }),
    ).toBeVisible();
    await clearFocus(page);
    await captureScreenshot(page, `collab-conversation-${theme}`);

    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Team' })).toBeVisible();
    await page.getByRole('button', { name: 'Assignee' }).click();
    await expect(page.getByRole('menuitem', { name: 'No lead' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'docs' })).toBeVisible();
    await page.keyboard.press('Escape');
    await clearFocus(page);
    await captureScreenshot(page, `collab-team-panel-${theme}`);

    await page.getByRole('button', { name: 'Assignee' }).click();
    const assignDocs = page.waitForRequest(
      (request) =>
        request.method() === 'PATCH' &&
        request.url().endsWith('/threads/th_main'),
    );
    await page.getByRole('menuitem', { name: 'docs' }).click();
    expect((await assignDocs).postDataJSON()).toEqual({ assignee: 'docs' });
    await expect(page.getByRole('button', { name: 'Assignee' })).toHaveText(
      'docs',
    );

    await page.getByRole('button', { name: 'Assignee' }).click();
    const clearLead = page.waitForRequest(
      (request) =>
        request.method() === 'PATCH' &&
        request.url().endsWith('/threads/th_main'),
    );
    await page.getByRole('menuitem', { name: 'No lead' }).click();
    expect((await clearLead).postDataJSON()).toEqual({ assignee: null });
    await expect(page.getByRole('button', { name: 'Assignee' })).toHaveText(
      'No lead',
    );

    const markDone = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        request.url().endsWith('/threads/th_main/done'),
    );
    await page.getByRole('button', { name: 'Accept and mark done' }).click();
    await markDone;
    await expect(
      page.getByRole('button', { name: 'Accept and mark done' }),
    ).toHaveCount(0);
  });

  test(`collaboration mention picker (${theme})`, async ({
    page,
  }, testInfo) => {
    await setup(page, resolveBaseURL(testInfo));
    await gotoNewSession(page, theme);
    await page
      .locator('[data-web-shell-composer-editor]:visible .cm-content')
      .click();
    await page.keyboard.type('@');
    await page.keyboard.press('Enter');
    // The picker lists the agents; an empty one is the regression to catch.
    await expect(page.getByText('reviewer', { exact: true })).toBeVisible();
    await captureScreenshot(page, `collab-mention-picker-${theme}`);
  });

  test(`collaboration agents page (${theme})`, async ({ page }, testInfo) => {
    await setup(page, resolveBaseURL(testInfo));
    await openAgents(page, theme);
    await clearFocus(page);
    await captureScreenshot(page, `collab-agents-${theme}`);

    await page
      .getByRole('radio', { name: 'Conversations', exact: true })
      .click();
    await expect(page.getByText('3 working, 1 queued')).toBeVisible();
    await clearFocus(page);
    await captureScreenshot(page, `collab-conversations-${theme}`);
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
    provider: 'Qwen Code ACP',
    programs: ['qwen'],
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
  ];
  await page.route('**/workspaces/*/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.endsWith('/events')) return route.abort();
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
      return route.fulfill({ json: { agentsMadeLocal: [], runsEnded: 0 } });
    }
    if (path.endsWith('/agents') && method === 'GET')
      return route.fulfill({
        json: {
          agents: remoteAgents,
          runtimes,
        },
      });
    if (path.endsWith('/threads'))
      return route.fulfill({ json: { threads: [] } });
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
    // The first Host increment offers Qwen Code only.
    await page
      .locator('label', { hasText: '/srv/checkout/qwen-code' })
      .first()
      .click();
    const qwen = page.locator('input[name="agent-execution-provider"]');
    await qwen.scrollIntoViewIfNeeded();
    await expect(qwen).toBeChecked();
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
    if (path.endsWith('/events')) return route.abort();
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
    if (path.endsWith('/threads'))
      return route.fulfill({ json: { threads: [] } });
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
