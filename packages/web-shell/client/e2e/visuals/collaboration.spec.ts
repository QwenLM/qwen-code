/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import type {
  DaemonEvent,
  QwenAgentMessageMeta,
  SessionAgentRunFrame,
  SessionSquadView,
} from '@qwen-code/sdk/daemon';
import { createWebShellDaemonScenario } from '../utils/mockDaemon';
import {
  captureScreenshot,
  clearFocus,
  FIXED_CAPTURE_TIME,
  gotoNewSession,
  gotoSession,
  installScenario,
  resolveBaseURL,
  VISUAL_VIEWPORT,
  type VisualTheme,
} from './harness';

/**
 * Agent collaboration: the @ picker in an ordinary chat, the Agents page
 * (roster, squads, runtimes, adding a runtime, a new agent on a runtime,
 * sharing), and a squad at work in a chat.
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
    expect(requested.filter((entry) => entry.includes('/threads'))).toEqual([]);
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
    // The terminal equivalent asks the running `qwen serve` to join.
    await expect(
      dialog.getByText(
        /qwen agents join 'https:\/\/coordinator\.example:4170\/join\/ws_team'/,
      ),
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

/** `GET …/agent/squads` entries, as `toSquadView` resolves them. */
const squads: SessionSquadView[] = [
  {
    id: 'sq_review',
    name: 'review-squad',
    description: 'Reviews a change and updates the docs.',
    instructions: 'Ask reviewer first; docs only after it passes.',
    leaderAgentId: 'ag_lead',
    leaderName: 'lead',
    members: [
      { agentId: 'ag_reviewer', role: 'checks correctness', name: 'reviewer' },
      { agentId: 'ag_docs', role: 'updates the changelog', name: 'docs' },
    ],
    createdAt: NOW - 3 * 24 * 60 * MIN,
    updatedAt: NOW - 60 * MIN,
  },
  {
    // No description and no roles: the card shows only the chips.
    id: 'sq_release',
    name: 'release-crew',
    leaderAgentId: 'ag_docs',
    leaderName: 'docs',
    members: [
      { agentId: 'ag_lead', name: 'lead' },
      { agentId: 'ag_reviewer', name: 'reviewer' },
    ],
    createdAt: NOW - 2 * 24 * 60 * MIN,
    updatedAt: NOW - 2 * 24 * 60 * MIN,
  },
];

async function setupSquads(
  page: Page,
  baseURL: string,
  /** Live run frames of the scenario's session, given its id. */
  framesFor: (sessionId: string) => SessionAgentRunFrame[] = () => [],
  /**
   * The session's history. It is what `load` replays (`compactedReplay`):
   * the chat renders from that. `transcriptPage` only answers the older-page
   * and trajectory reads, so events put there never reach the chat.
   */
  events: DaemonEvent[] = [],
) {
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: ['session_events', 'agent_collaboration_v1'] },
    events,
  });
  const daemon = await installScenario(page, scenario, baseURL);
  // A frame of another session is dropped by the client, so the frames are
  // stamped with this scenario's.
  const frames = framesFor(scenario.sessionId);
  await page.route('**/workspaces/*/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (isAgentStream(path)) return route.abort();
    if (path.endsWith('/agents')) return route.fulfill({ json: { agents } });
    if (path.endsWith('/squads')) return route.fulfill({ json: { squads } });
    if (/\/sessions\/[^/]+\/runs$/.test(path))
      return route.fulfill({ json: { frames } });
    return route.fulfill({ status: 404, json: { error: 'not in fixture' } });
  });
  return { scenario, daemon };
}

async function openSquads(page: Page, theme: VisualTheme): Promise<void> {
  await openAgents(page, theme);
  await page.getByRole('radio', { name: 'Squads', exact: true }).click();
  await expect(page.getByTestId('squad-card')).toHaveCount(2);
}

/** A transcript update in the shape `createAgentRecordTranscriptUpdate` emits. */
function agentRecord(
  id: number,
  recordId: string,
  role: 'user' | 'assistant',
  text: string,
  agentMessage: QwenAgentMessageMeta,
  offsetMin: number,
): DaemonEvent {
  const segmentId =
    agentMessage.kind === 'agent_mention'
      ? `mention:${recordId}`
      : `agent:${agentMessage.runId}`;
  return {
    id,
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate:
        role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
      content: { type: 'text', text },
      _meta: {
        source: agentMessage.kind,
        qwenAgentMessage: agentMessage,
        qwenDiscreteMessage: true,
        timestamp: NOW - offsetMin * MIN,
        qwenTranscript: { sourceRecordIds: [recordId], segmentId },
      },
    },
  } as unknown as DaemonEvent;
}

const lead = { agentId: 'ag_lead', name: 'lead', program: 'qwen' as const };
const reviewer = {
  agentId: 'ag_reviewer',
  name: 'reviewer',
  program: 'qwen' as const,
};

/**
 * A squad in a chat: an earlier ask the leader had nothing to do for (its
 * no_action line), then an ask it hands to two members; reviewer has replied
 * under the squad's name, docs is still working.
 */
function squadChatEvents(): DaemonEvent[] {
  return [
    agentRecord(
      1,
      'rec-mention-1',
      'user',
      '@review-squad anything waiting for review?',
      {
        kind: 'agent_mention',
        mentionedAgentIds: [],
        mentionedSquadIds: ['sq_review'],
      },
      30,
    ),
    agentRecord(
      2,
      'rec-lead-1',
      'assistant',
      // What replay shows for a leader's empty reply.
      'No action needed.',
      {
        kind: 'agent_message',
        author: { ...lead, runtimeId: 'local', squadName: 'review-squad' },
        runId: 'run-lead-1',
        status: 'completed',
        totalTokens: 3_210,
        squadOutcome: 'no_action',
      },
      29,
    ),
    agentRecord(
      3,
      'rec-mention-2',
      'user',
      '@review-squad check the login fix and note it in the changelog',
      {
        kind: 'agent_mention',
        mentionedAgentIds: [],
        mentionedSquadIds: ['sq_review'],
      },
      12,
    ),
    agentRecord(
      4,
      'rec-lead-2',
      'assistant',
      '@reviewer please review the token check in `auth.ts`.\n\n@docs once it passes, add a changelog line.',
      {
        kind: 'agent_message',
        author: { ...lead, runtimeId: 'local', squadName: 'review-squad' },
        runId: 'run-lead-2',
        status: 'completed',
        totalTokens: 4_820,
      },
      11,
    ),
    agentRecord(
      5,
      'rec-reviewer-1',
      'assistant',
      'Looks good: the expired-token branch now returns 401 and has a test.',
      {
        kind: 'agent_message',
        author: {
          ...reviewer,
          runtimeId: 'local',
          memberSquadName: 'review-squad',
        },
        runId: 'run-reviewer-1',
        status: 'completed',
        steps: [
          { id: 's1', title: 'ReadFile: src/auth.ts', status: 'completed' },
          { id: 's2', title: 'Shell: npm test -- auth', status: 'completed' },
        ],
        totalTokens: 58_466,
      },
      4,
    ),
  ];
}

/** docs, delegated by the leader, still working: the engagement is open. */
const docsRun = (sessionId: string): SessionAgentRunFrame => ({
  type: 'run',
  sessionId,
  runId: 'run-docs-1',
  author: {
    agentId: 'ag_docs',
    name: 'docs',
    program: 'qwen',
    runtimeId: 'local',
  },
  status: 'running',
  outputText: 'Adding the entry under **Fixes**…',
  steps: [
    { id: 's1', title: 'ReadFile: CHANGELOG.md', status: 'completed' },
    { id: 's2', title: 'Edit: CHANGELOG.md', status: 'running' },
  ],
  totalTokens: 12_480,
  activityAt: NOW - 20_000,
  squadId: 'sq_review',
  squadName: 'review-squad',
});

for (const theme of THEMES) {
  test(`collaboration squads (${theme})`, async ({ page }, testInfo) => {
    await setupSquads(page, resolveBaseURL(testInfo));
    await openSquads(page, theme);
    // Squads have their own view: the agent roster is not under it.
    await expect(
      page.getByText('Paused while the archive moves.'),
    ).toBeHidden();
    const review = page
      .getByTestId('squad-card')
      .filter({ hasText: 'review-squad' });
    // The roster as a chain of command: the leader "leads", each member hangs
    // off it with its role in the same column.
    await expect(review.locator('[data-squad-role="leader"]')).toHaveCount(1);
    await expect(review.locator('[data-squad-role="leader"]')).toContainText(
      /lead.*leads/,
    );
    await expect(review.locator('[data-squad-role="member"]')).toHaveText([
      /reviewer.*checks correctness/,
      /docs.*updates the changelog/,
    ]);
    // Edit and Retire live in the card's ⋯ menu, as on agent cards.
    await expect(
      review.getByRole('button', { name: 'More actions for review-squad' }),
    ).toBeVisible();
    await expect(review.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    // A member without a role shows only its name: no role column.
    const crew = page
      .getByTestId('squad-card')
      .filter({ hasText: 'release-crew' });
    await expect(crew.locator('[data-squad-role="member"]')).toHaveCount(2);
    await expect(
      crew.locator('[data-squad-role="member"] > :nth-child(2)'),
    ).toHaveCount(0);
    // An empty description leaves no placeholder line.
    await expect(
      page.getByTestId('squad-card').filter({ hasText: 'release-crew' }),
    ).not.toContainText('—');
    await clearFocus(page);
    await captureScreenshot(page, `collab-squads-${theme}`);
  });

  test(`collaboration new squad (${theme})`, async ({ page }, testInfo) => {
    await setupSquads(page, resolveBaseURL(testInfo));
    await openSquads(page, theme);
    await page.getByRole('button', { name: 'New squad', exact: true }).click();
    const form = page.getByTestId('squad-form');
    await expect(form).toBeVisible();
    await expect(form.getByText('Called as @name in chats')).toBeVisible();
    await form.getByLabel('Name', { exact: true }).fill('triage');
    // The hint follows the name as it is typed.
    await expect(form.getByText('Called as @triage in chats')).toBeVisible();
    await form.locator('select').selectOption('ag_lead');
    // The leader is not offered as its own member; a role field appears only
    // once its member is checked.
    await expect(form.getByRole('checkbox')).toHaveCount(3);
    await expect(form.getByLabel('lead', { exact: true })).toHaveCount(0);
    await expect(form.getByLabel('docs Role (optional)')).toHaveCount(0);
    await form.getByLabel('reviewer', { exact: true }).check();
    await expect(form.getByLabel('reviewer Role (optional)')).toBeVisible();
    await expect(form.getByLabel('docs Role (optional)')).toHaveCount(0);
    await clearFocus(page);
    await captureScreenshot(page, `collab-new-squad-${theme}`);
  });

  test(`collaboration squad in chat (${theme})`, async ({ page }, testInfo) => {
    const { scenario, daemon } = await setupSquads(
      page,
      resolveBaseURL(testInfo),
      (sessionId) => [docsRun(sessionId)],
      squadChatEvents(),
    );
    await gotoSession(page, scenario, daemon, theme);
    // Capture what rendered before the detailed checks, so a failing run
    // still uploads the screen it failed on.
    await expect(page.getByText('anything waiting for review?')).toBeVisible();
    await clearFocus(page);
    await captureScreenshot(page, `collab-squad-chat-${theme}`);

    // The earlier ask: the squad's tag, then a plain sentence.
    const noAction = page.locator('[data-squad-outcome="no_action"]');
    await expect(noAction).toHaveCount(1);
    await expect(
      noAction.locator('[data-squad-tag="review-squad"]'),
    ).toBeVisible();
    await expect(noAction).toContainText('lead had nothing to do');
    await expect(noAction).not.toContainText('·');
    // A member's reply carries the squad it answered for.
    await expect(
      page.getByText('Looks good: the expired-token branch'),
    ).toBeVisible();
    // One tag vocabulary: the no-action line, the leader's dispatch, the
    // member's reply and the live engagement bar.
    await expect(page.locator('[data-squad-tag="review-squad"]')).toHaveCount(
      4,
    );
    const bar = page.getByTestId('squad-engagements');
    await expect(bar.getByRole('status')).toHaveAttribute(
      'aria-label',
      'Squad review-squad',
    );
    await expect(bar.locator('[data-squad-tag="review-squad"]')).toBeVisible();
    const docs = bar.locator('[data-state="working"]');
    await expect(docs).toContainText('docs');
    await expect(docs.getByRole('img', { name: 'working' })).toBeVisible();
    await expect(
      page.locator('[data-run-id="run-docs-1"]').getByText('12,480 tokens'),
    ).toBeVisible();

    // The earlier ask sits above the fold; capture its no-action line too.
    await noAction.scrollIntoViewIfNeeded();
    await clearFocus(page);
    await captureScreenshot(page, `collab-squad-no-action-${theme}`);
  });
}
