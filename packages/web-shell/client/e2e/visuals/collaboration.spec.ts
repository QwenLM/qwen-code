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
    reason: '3 个智能体执行中，1 个排队中',
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
        reason: '1 个智能体执行中',
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
    // Without the live stream the page falls back to reads, which is all a
    // still capture needs.
    if (path.endsWith('/events')) return route.abort();
    if (path.endsWith('/agents')) return route.fulfill({ json: { agents } });
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
  await expect(
    page.getByText('WriteFile: docs/testing.md').first(),
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
    await clearFocus(page);
    await captureScreenshot(page, `collab-conversation-${theme}`);

    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Team' })).toBeVisible();
    await clearFocus(page);
    await captureScreenshot(page, `collab-team-panel-${theme}`);
  });

  test(`collaboration details (${theme})`, async ({ page }, testInfo) => {
    const cwd = await setup(page, resolveBaseURL(testInfo));
    await openConversation(page, theme, cwd);
    await page
      .getByRole('button', { name: 'Task details', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await clearFocus(page);
    await captureScreenshot(page, `collab-details-${theme}`);
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
      .getByRole('button', { name: 'Conversations', exact: true })
      .click();
    await expect(page.getByText('3 working, 1 queued')).toBeVisible();
    await clearFocus(page);
    await captureScreenshot(page, `collab-conversations-${theme}`);
  });
}

/**
 * Runtimes: this computer plus two joined machines, one offering only Qwen
 * Code and one offering all three programs, so the program picker shows both
 * an available and an unavailable choice.
 */
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
    provider: 'Qwen Code ACP, Codex CLI, Claude Code ACP',
    programs: ['qwen', 'codex', 'claude'],
    status: 'offline',
    workspaceCwd: '/Users/dev/qwen-code',
    agentCount: 0,
    lastSeenAt: NOW - 3 * 60 * MIN,
  };
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
    if (path.endsWith('/agents') && method === 'GET')
      return route.fulfill({
        json: {
          agents: remoteAgents,
          runtimes: [local, buildBox, macMini],
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
              scope: 'analysis',
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
  test(`collaboration runtimes (${theme})`, async ({ page }, testInfo) => {
    await setupRuntimes(page, resolveBaseURL(testInfo));
    await gotoNewSession(page, theme);
    await page
      .getByRole('button', { name: 'Agents', exact: true })
      .first()
      .click();
    await page.getByRole('button', { name: 'Runtimes', exact: true }).click();
    await expect(page.getByText('mac-mini', { exact: true })).toBeVisible();
    await clearFocus(page);
    await captureScreenshot(page, `collab-runtimes-${theme}`);

    await page.getByRole('button', { name: 'Add a runtime' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Create join command' }).click();
    // The command carries the token; waiting for it is waiting for the link.
    await expect(dialog.getByText(/join_x+/).first()).toBeVisible();
    await captureScreenshot(page, `collab-add-runtime-${theme}`);
  });

  test(`collaboration share and new agent (${theme})`, async ({
    page,
  }, testInfo) => {
    await setupRuntimes(page, resolveBaseURL(testInfo));
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

    await page.getByRole('button', { name: 'New agent', exact: true }).click();
    // A machine with only Qwen Code: Codex and Claude Code are offered but
    // unavailable, which is the state the picker has to explain.
    await page
      .locator('label', { hasText: '/srv/checkout/qwen-code' })
      .first()
      .click();
    const claude = page.locator('label', { hasText: 'Claude Code' }).first();
    await claude.scrollIntoViewIfNeeded();
    await expect(claude).toBeVisible();
    await clearFocus(page);
    await captureScreenshot(page, `collab-new-agent-runtime-${theme}`);
  });
}
