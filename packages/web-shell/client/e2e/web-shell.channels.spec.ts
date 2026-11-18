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
} from './utils/mockDaemon';

test('shows channel sessions in the sidebar channel catalog', async ({
  page,
}, testInfo) => {
  const workspaceCwd = '/tmp/qwen-web-shell-e2e';
  // DaemonSessionSummary requires workspaceCwd; keep a shared base so every
  // fixture matches the shape the real daemon returns.
  const baseSession = { workspaceCwd };
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'channel_management',
      ],
    },
    channelTypes: [
      {
        type: 'dingtalk',
        displayName: 'DingTalk',
        manageable: true,
        fields: [],
      },
      {
        type: 'feishu',
        displayName: 'Feishu',
        manageable: true,
        fields: [],
      },
    ],
    channels: {
      revision: '1',
      instances: {
        'release-bot': {
          name: 'release-bot',
          config: { type: 'dingtalk' },
          secrets: {},
          startsWithServe: false,
          runtime: { state: 'connected' },
        },
        'ops-bot': {
          name: 'ops-bot',
          config: { type: 'dingtalk' },
          secrets: {},
          startsWithServe: false,
          runtime: { state: 'connected' },
        },
        'feishu-main': {
          name: 'feishu-main',
          config: { type: 'feishu' },
          secrets: {},
          startsWithServe: false,
          runtime: { state: 'connected' },
        },
      },
    },
    sessions: [
      {
        ...baseSession,
        sessionId: 'task-session',
        displayName: 'Web Shell task',
        sourceType: 'default',
      },
      {
        ...baseSession,
        sessionId: 'dingtalk-session',
        displayName: 'DingTalk conversation',
        sourceType: 'channel',
        sourceId: 'release-bot',
      },
      {
        ...baseSession,
        sessionId: 'dingtalk-ops-session',
        displayName: 'DingTalk ops conversation',
        sourceType: 'channel',
        sourceId: 'ops-bot',
        isPinned: true,
      },
      {
        ...baseSession,
        sessionId: 'feishu-session',
        displayName: 'Feishu conversation',
        sourceType: 'channel',
        sourceId: 'feishu-main',
      },
      {
        ...baseSession,
        sessionId: 'legacy-channel-session',
        displayName: 'Legacy channel conversation',
        sourceType: 'channel',
      },
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);

  await expect(page.getByText('Web Shell task', { exact: true })).toBeVisible();
  await expect(page.getByText('DingTalk conversation')).toHaveCount(0);
  await expect(page.getByText('Legacy channel conversation')).toHaveCount(0);
  await page.getByRole('button', { name: 'Channels', exact: true }).click();
  await expect(
    page.getByText('DingTalk conversation', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Web Shell task')).toHaveCount(0);
  await expect(page.getByTestId('inline-panel')).toBeVisible();
  const sidebar = page.locator('[data-web-shell-sidebar-section="channels"]');
  await expect(sidebar.getByTestId('manage-workspaces')).toHaveCount(0);
  await expect(
    sidebar.getByRole('button', { name: 'Add workspace', exact: true }),
  ).toHaveCount(0);
  await expect(sidebar.locator('[aria-label="Workspace actions"]')).toHaveCount(
    0,
  );

  const dingTalkGroup = page.getByRole('region', { name: 'DingTalk' });
  await expect(dingTalkGroup).toContainText('DingTalk conversation');
  await expect(dingTalkGroup).toContainText('DingTalk ops conversation');
  await expect(dingTalkGroup).not.toContainText('Feishu conversation');
  await expect(page.getByRole('region', { name: 'Feishu' })).toContainText(
    'Feishu conversation',
  );
  await expect(
    page.getByRole('region', { name: 'Other channels' }),
  ).toContainText('Legacy channel conversation');

  const dingTalkToggle = dingTalkGroup.getByRole('button').first();
  await expect(dingTalkToggle).toHaveAttribute('aria-expanded', 'true');
  await dingTalkToggle.click();
  await expect(dingTalkToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByText('DingTalk conversation', { exact: true }),
  ).toHaveCount(0);
  await dingTalkToggle.click();
  await expect(dingTalkToggle).toHaveAttribute('aria-expanded', 'true');

  scenario.sessions.push({
    ...baseSession,
    sessionId: 'new-dingtalk-session',
    displayName: 'New DingTalk conversation',
    sourceType: 'channel',
    sourceId: 'release-bot',
  });
  await expect(
    page.getByText('New DingTalk conversation', { exact: true }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(dingTalkGroup).toContainText('New DingTalk conversation');

  const column = page.locator('[data-web-shell-sidebar-section="channels"]');
  const channelNav = page
    .locator('[data-web-shell-navigation-rail]')
    .getByRole('button', { name: 'Channels', exact: true });
  await expect(column).toBeVisible();
  await expect(column).toHaveCSS('width', '300px');
  await expect(page.getByRole('tab', { name: 'Channels' })).toHaveCount(0);
  await expect(column.getByRole('button', { name: 'Settings' })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await channelNav.click();
  await expect(page.getByTestId('inline-panel')).toBeVisible();
  await expect(column).toBeVisible();
  await expect(channelNav).toHaveAttribute('aria-current', 'page');
  await column.getByText('DingTalk conversation', { exact: true }).click();
  const channelConnection =
    await daemon.sse.waitForConnection('dingtalk-session');
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: channelConnection.sessionId }),
  );
  await expect(page.getByTestId('inline-panel')).toHaveCount(0);
  await expect(channelNav).toHaveAttribute('aria-current', 'page');
  await expect(column).toBeVisible();
  await page.keyboard.press('Control+b');
  await expect(column).toBeHidden();
  await channelNav.click();
  await expect(column).toBeVisible();
  await expect(page.getByTestId('inline-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByText('Web Shell task', { exact: true })).toBeVisible();
  await expect(page.getByTestId('manage-workspaces')).toBeAttached();
  await expect(page.locator('[aria-label="Workspace actions"]')).toBeAttached();
  await expect(
    page.getByText('DingTalk conversation', { exact: true }),
  ).toHaveCount(0);
});

test('creates and deletes a typed Channel configuration', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'workspace_settings',
        'workspace_voice',
        'channel_management',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/qwen-web-shell-e2e',
          displayName: 'Main workspace',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/tmp/qwen-channel-secondary',
          displayName: 'Release workspace',
          primary: false,
          trusted: true,
        },
      ],
    },
    channelTypes: [
      {
        type: 'dingtalk',
        displayName: 'DingTalk',
        manageable: true,
        fields: [
          {
            key: 'clientId',
            label: 'Client ID',
            kind: 'string',
            required: true,
            envResolvable: true,
          },
          {
            key: 'clientSecret',
            label: 'Client Secret',
            kind: 'secret',
            required: true,
            envResolvable: true,
          },
          {
            key: 'privatePolicy',
            label: 'Private Policy',
            kind: 'enum',
            required: true,
            default: 'pairing',
            options: [
              { value: 'disabled', label: 'Disabled' },
              { value: 'pairing', label: 'Pairing' },
              { value: 'allowlist', label: 'Allowlist' },
              { value: 'open', label: 'Open' },
            ],
          },
          {
            key: 'allowedUsers',
            label: 'Allowed Users',
            kind: 'string-list',
          },
          {
            key: 'groupPolicy',
            label: 'Group Policy',
            kind: 'enum',
            required: true,
            default: 'disabled',
            options: [
              { value: 'disabled', label: 'Disabled' },
              { value: 'pairing', label: 'Pairing' },
              { value: 'allowlist', label: 'Allowlist' },
              { value: 'open', label: 'Open' },
            ],
          },
          {
            key: 'sessionScope',
            label: 'Session Scope',
            kind: 'enum',
            required: true,
            default: 'user',
            options: [
              { value: 'user', label: 'Per user and chat' },
              { value: 'thread', label: 'Per thread' },
              { value: 'chat_thread', label: 'Per chat and thread' },
              { value: 'single', label: 'One shared session' },
            ],
          },
        ],
      },
      {
        type: 'wecom',
        displayName: 'WeCom',
        manageable: true,
        fields: [],
      },
      {
        type: 'feishu',
        displayName: 'Feishu',
        manageable: true,
        fields: [],
      },
    ],
    pairingRequests: {
      'release-bot': [
        {
          senderId: 'user-42',
          senderName: 'Ada',
          code: 'ABCD1234',
          createdAt: Date.parse('2026-07-28T00:00:00.000Z'),
        },
        {
          senderId: 'user-77',
          senderName: 'Grace',
          subject: { type: 'group', id: 'group-9', name: 'Release Team' },
          code: 'QW3N5678',
          createdAt: Date.parse('2026-07-28T00:02:00.000Z'),
        },
      ],
    },
  });
  await page.addInitScript(() => {
    window.sessionStorage.setItem('qwen-daemon-token', 'e2e-token');
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);

  await page.getByRole('button', { name: 'Channels', exact: true }).click();
  await page.getByRole('button', { name: 'Configure DingTalk' }).click();
  await expect(
    page.getByRole('heading', { name: 'Configure DingTalk' }),
  ).toBeVisible();
  const editor = page.getByRole('dialog');
  await expect(editor.getByLabel('Workspace')).toContainText('Main workspace');
  await editor.getByLabel('Workspace').click();
  await page.getByRole('option', { name: 'Release workspace' }).click();
  await expect(editor.getByLabel('Workspace')).toContainText(
    'Release workspace',
  );
  await page.getByLabel('Instance name').fill('release-bot');
  await page.getByLabel('Client ID (AppKey)').fill('ding-client-id');
  await page.getByLabel('Client Secret (AppSecret)').fill('ding-client-secret');
  await expect(page.getByLabel('Direct message policy')).toContainText(
    'Pairing',
  );
  await expect(page.getByLabel('Allowed user IDs')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Conversation management' }),
  ).toBeVisible();
  await expect(page.getByText('By user', { exact: true })).toBeVisible();
  await expect(
    page.getByText('By chat or thread', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Share all', { exact: true })).toBeVisible();
  await page.getByLabel('By chat or thread').click();
  await expect(
    page.getByText(
      'Messages in the same group or topic share one conversation; best for collaboration.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(
    page.getByRole('heading', { name: 'Configure DingTalk' }),
  ).toHaveCount(0);
  await expect(page.getByText('release-bot', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      daemon.requests.filter(
        (request) =>
          request.method === 'PUT' &&
          request.path ===
            '/workspaces/%2Ftmp%2Fqwen-channel-secondary/channels/release-bot',
      ),
    )
    .toEqual([
      expect.objectContaining({
        body: {
          expectedRevision: '1',
          config: {
            type: 'dingtalk',
            clientId: 'ding-client-id',
            privatePolicy: 'pairing',
            groupPolicy: 'disabled',
            sessionScope: 'chat_thread',
          },
          secrets: {
            clientSecret: {
              operation: 'replace',
              value: 'ding-client-secret',
            },
          },
        },
      }),
    ]);

  await page.getByRole('button', { name: 'Edit release-bot' }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit DingTalk' }),
  ).toBeVisible();
  await expect(page.getByLabel('By chat or thread')).toBeChecked();
  await expect(page.getByText('Ada', { exact: true })).toBeVisible();
  await expect(page.getByText('ABCD1234', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Approve Ada, code ABCD1234' })
    .click();
  await page
    .getByRole('button', {
      name: 'Approve Group: Release Team, code QW3N5678',
    })
    .click();
  await expect(page.getByText('No pending requests')).toBeVisible();
  await expect
    .poll(() =>
      daemon.requests.filter(
        (request) =>
          request.method === 'POST' &&
          request.path.endsWith(
            '/channels/release-bot/pairing-requests/approve',
          ),
      ),
    )
    .toEqual([
      expect.objectContaining({
        body: { code: 'ABCD1234' },
      }),
      expect.objectContaining({
        body: { code: 'QW3N5678' },
      }),
    ]);
  await expect(
    page.getByRole('button', { name: 'Revoke Group: group-9' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Revoke Group: group-9' }).click();
  const groupRevokeConfirmation = page.getByRole('alertdialog');
  await expect(groupRevokeConfirmation).toContainText(
    'Only the approval created through pairing will be removed.',
  );
  await groupRevokeConfirmation
    .getByRole('button', { name: 'Revoke approval' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Revoke user-42' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Revoke user-42' }).click();
  const revokeConfirmation = page.getByRole('alertdialog');
  await expect(revokeConfirmation).toContainText(
    'Only the approval created through pairing will be removed.',
  );
  await revokeConfirmation
    .getByRole('button', { name: 'Revoke approval' })
    .click();
  await expect(page.getByText('No pairing approvals')).toBeVisible();
  await expect
    .poll(() =>
      daemon.requests.filter(
        (request) =>
          request.method === 'DELETE' &&
          request.path.endsWith('/channels/release-bot/pairing-approvals'),
      ),
    )
    .toEqual([
      expect.objectContaining({
        body: { groupId: 'group-9' },
      }),
      expect.objectContaining({
        body: { senderId: 'user-42' },
      }),
    ]);

  await page.getByLabel('Direct message policy').click();
  await page.getByRole('option', { name: 'Allowlist' }).click();
  await page.getByLabel('Allowed user IDs').fill('staff-a, staff-b');
  await page.getByLabel('Group policy').click();
  await page.getByRole('option', { name: 'Allowlist' }).click();
  await page.getByLabel('Allowed group IDs').fill('group-a, group-b');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit DingTalk' }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      daemon.requests.filter(
        (request) =>
          request.method === 'PUT' &&
          request.path.endsWith('/channels/release-bot'),
      ),
    )
    .toHaveLength(2);
  expect(
    daemon.requests.filter(
      (request) =>
        request.method === 'PUT' &&
        request.path.endsWith('/channels/release-bot'),
    )[1],
  ).toEqual(
    expect.objectContaining({
      body: {
        expectedRevision: '2',
        config: {
          type: 'dingtalk',
          clientId: 'ding-client-id',
          privatePolicy: 'allowlist',
          allowedUsers: ['staff-a', 'staff-b'],
          groupPolicy: 'allowlist',
          sessionScope: 'chat_thread',
          groups: { 'group-a': {}, 'group-b': {} },
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      },
    }),
  );

  await page
    .getByRole('button', { name: 'More actions for release-bot' })
    .click();
  await page.getByRole('menuitem', { name: 'Delete release-bot' }).click();
  const confirmation = page.getByRole('alertdialog');
  await confirmation.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('release-bot', { exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      daemon.requests.filter(
        (request) =>
          request.method === 'DELETE' &&
          request.path.endsWith('/channels/release-bot'),
      ),
    )
    .toEqual([
      expect.objectContaining({
        body: { expectedRevision: '3' },
      }),
    ]);
});

test('shows Qwen Live sessions in Tasks and excludes them from Channels @smoke', async ({
  page,
}, testInfo) => {
  const workspaceCwd = '/tmp/qwen-web-shell-e2e';
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    sessions: [
      {
        workspaceCwd,
        sessionId: 'qwen-live-task',
        clientCount: 1,
        hasActivePrompt: false,
        displayName: 'Qwen Live task fixture',
        sourceType: 'qwen-live',
      },
      {
        workspaceCwd,
        sessionId: 'ordinary-task',
        displayName: 'Ordinary task fixture',
        sourceType: 'default',
      },
      {
        workspaceCwd,
        sessionId: 'channel-task',
        displayName: 'Channel task fixture',
        sourceType: 'channel',
      },
    ],
  });
  scenario.capabilities.features.push(
    'session_archive',
    'workspace_session_metadata',
  );
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Home', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByText('Qwen Live task fixture', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Channel task fixture', { exact: true }),
  ).toHaveCount(0);

  const liveRow = page
    .locator('[data-web-shell-session-title]', {
      hasText: 'Qwen Live task fixture',
    })
    .locator('..');
  await liveRow.hover();
  await expect(
    liveRow.getByRole('button', { name: 'Delete', exact: true }),
  ).toHaveCount(0);
  await liveRow.getByRole('button', { name: 'More actions' }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Delete', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('menuitem', { name: 'Archive', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');

  const ordinaryRow = page
    .locator('[data-web-shell-session-title]', {
      hasText: 'Ordinary task fixture',
    })
    .locator('..');
  await ordinaryRow.hover();
  await ordinaryRow.getByRole('button', { name: 'More actions' }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Delete', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Archive', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Channels', exact: true }).click();
  await expect(
    page.getByText('Channel task fixture', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Qwen Live task fixture', { exact: true }),
  ).toHaveCount(0);

  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(
    page.getByText('Qwen Live task fixture', { exact: true }),
  ).toBeVisible();
});

test('edits GitHub bound-session action templates on demand and toggles fullscreen @smoke', async ({
  page,
}, testInfo) => {
  const workspaceCwd = '/tmp/qwen-web-shell-e2e';
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'channel_management',
      ],
    },
    channelTypes: [
      {
        type: 'github',
        displayName: 'GitHub',
        manageable: true,
        fields: [
          {
            key: 'useLocalGh',
            label: 'Use Local GitHub CLI Authentication',
            kind: 'boolean',
          },
          {
            key: 'groupPolicy',
            label: 'Group Policy',
            kind: 'enum',
            required: true,
            default: 'open',
            options: [
              { value: 'open', label: 'Open' },
              { value: 'allowlist', label: 'Allowlist' },
              { value: 'pairing', label: 'Pairing' },
              { value: 'disabled', label: 'Disabled' },
            ],
          },
          {
            key: 'deliverToBoundSessions',
            label: 'Deliver To PR-Bound Sessions',
            kind: 'boolean',
            default: 'false',
          },
          {
            key: 'boundSessionActions',
            label: 'Bound Session Actions',
            kind: 'record',
            options: [
              {
                value: 'default',
                label: 'default',
                description: 'Fallback for any unmatched event',
                group: 'any',
              },
              {
                value: 'watch:ci_failure',
                label: 'watch:ci_failure',
                description: 'CI checks turn red on a head commit',
                group: 'any',
              },
              {
                value: 'comment',
                label: 'comment',
                description: 'A new comment notification',
                group: 'any',
              },
              {
                value: 'review:watch:ci_failure',
                label: 'review:watch:ci_failure',
                description: 'CI checks turn red on a head commit',
                group: 'review',
              },
              {
                value: 'fix:comment',
                label: 'fix:comment',
                description: 'A new comment notification',
                group: 'fix',
              },
            ],
          },
        ],
      },
    ],
  });
  await page.addInitScript(() => {
    window.sessionStorage.setItem('qwen-daemon-token', 'e2e-token');
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);

  await page.getByRole('button', { name: 'Channels', exact: true }).click();
  await page.getByRole('button', { name: 'Configure GitHub' }).click();
  const editor = page.getByRole('dialog');
  await expect(
    editor.getByRole('heading', { name: 'Configure GitHub' }),
  ).toBeVisible();

  // On-demand rows: a fresh draft shows the add picker, not one input per
  // descriptor option.
  const addPicker = editor.getByLabel('Bound Session Actions');
  await expect(addPicker).toBeVisible();
  await expect(editor.locator('textarea')).toHaveCount(0);

  // Fullscreen toggle enlarges the dialog and back. Locate by aria-pressed:
  // the accessible name flips between Fullscreen and Exit fullscreen.
  const fullscreenButton = editor.locator('button[aria-pressed]');
  await expect(fullscreenButton).toHaveAttribute('aria-label', 'Fullscreen');
  await fullscreenButton.click();
  await expect(fullscreenButton).toHaveAttribute('aria-pressed', 'true');
  const viewport = page.viewportSize();
  // The dialog size transitions over 100ms; poll the settled width.
  await expect
    .poll(async () => (await editor.boundingBox())?.width ?? 0)
    .toBeGreaterThan((viewport?.width ?? 1280) - 64);
  await fullscreenButton.click();
  await expect(fullscreenButton).toHaveAttribute('aria-pressed', 'false');

  await editor.getByLabel('Instance name').fill('gh-bot');
  await editor
    .getByRole('switch', { name: 'Use Local GitHub CLI Authentication' })
    .click();
  await editor
    .getByRole('switch', { name: 'Deliver To PR-Bound Sessions' })
    .click();

  // Add two keys; leave one empty — the save must filter it out.
  await addPicker.click();
  await page.getByRole('option', { name: /review:watch:ci_failure/ }).click();
  const template = 'Review CI failure on %repo%#%pr%\nRun /verify-pr';
  await editor
    .getByRole('textbox', { name: 'review:watch:ci_failure' })
    .fill(template);
  await addPicker.click();
  await page.getByRole('option', { name: /fix:comment/ }).click();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(
    editor.getByRole('heading', { name: 'Configure GitHub' }),
  ).toHaveCount(0);

  const upserts = () =>
    daemon.requests.filter(
      (request) =>
        request.method === 'PUT' && request.path.endsWith('/channels/gh-bot'),
    );
  await expect.poll(() => upserts().length).toBe(1);
  expect(upserts()[0]?.body).toEqual(
    expect.objectContaining({
      config: expect.objectContaining({
        type: 'github',
        useLocalGh: true,
        deliverToBoundSessions: true,
        boundSessionActions: { 'review:watch:ci_failure': template },
      }),
    }),
  );

  // Reopen: the stored row round-trips; deleting it drops the key on save.
  await page.getByRole('button', { name: 'Edit gh-bot' }).click();
  await expect(
    editor.getByRole('textbox', { name: 'review:watch:ci_failure' }),
  ).toHaveValue(template);
  await editor
    .getByRole('button', { name: 'Remove review:watch:ci_failure' })
    .click();
  await expect(editor.locator('textarea')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => upserts().length).toBe(2);
  const secondBody = upserts()[1]?.body as {
    config: Record<string, unknown>;
  };
  expect(secondBody.config['boundSessionActions']).toBeUndefined();
});

test('configures a WeChat channel with in-browser QR login', async ({
  page,
}, testInfo) => {
  const workspaceCwd = '/tmp/qwen-web-shell-e2e';
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'channel_management',
      ],
    },
    channelTypes: [
      {
        type: 'weixin',
        displayName: 'WeChat',
        manageable: true,
        fields: [
          {
            key: 'groupPolicy',
            label: 'Group Policy',
            kind: 'enum',
            required: true,
            default: 'disabled',
            options: [{ value: 'disabled', label: 'Disabled' }],
          },
          {
            key: 'privatePolicy',
            label: 'Private Policy',
            kind: 'enum',
            required: true,
            default: 'pairing',
            options: [
              { value: 'disabled', label: 'Disabled' },
              { value: 'pairing', label: 'Pairing' },
              { value: 'allowlist', label: 'Allowlist' },
              { value: 'open', label: 'Open' },
            ],
          },
          {
            key: 'sessionScope',
            label: 'Session Scope',
            kind: 'enum',
            required: true,
            default: 'user',
            options: [
              { value: 'user', label: 'Per user and chat' },
              { value: 'single', label: 'One shared session' },
            ],
          },
        ],
      },
    ],
    channels: { revision: '1', instances: {} },
    sessions: [
      {
        workspaceCwd,
        sessionId: 'task-session',
        displayName: 'Web Shell task',
        sourceType: 'default',
      },
    ],
  });
  await page.addInitScript(() => {
    window.sessionStorage.setItem('qwen-daemon-token', 'e2e-token');
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  // The WeChat login routes are process-global, so the workspace mock daemon
  // does not serve them. Registered after installMockDaemon so this handler
  // takes precedence; anything else falls through to the shared mock.
  let configured = false;
  let flowStatus: 'waiting' | 'scanned' | 'ready' = 'waiting';
  let revokes = 0;
  let cancels = 0;
  await page.route('**/auth/weixin**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/auth/weixin' && method === 'GET') {
      await route.fulfill({
        json: {
          enabled: true,
          configured,
          ...(configured ? { userId: 'wx-user-1' } : {}),
        },
      });
      return;
    }
    if (path === '/auth/weixin/flows' && method === 'POST') {
      flowStatus = 'waiting';
      await route.fulfill({
        status: 201,
        json: {
          id: 'flow-1',
          status: 'waiting',
          qrText: '▄▀▄▀',
          qrcodeUrl: 'https://scan.example/qr-1',
        },
      });
      return;
    }
    if (path === '/auth/weixin/flows/flow-1' && method === 'DELETE') {
      // The panel drops a live flow when the editor closes; the daemon would
      // keep polling the upstream otherwise. Answer it like the real route.
      cancels += 1;
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === '/auth/weixin/flows/flow-1' && method === 'GET') {
      const status = flowStatus;
      if (flowStatus === 'waiting') flowStatus = 'scanned';
      else if (flowStatus === 'scanned') {
        flowStatus = 'ready';
        configured = true;
      }
      await route.fulfill({
        json: {
          id: 'flow-1',
          status,
          ...(status === 'ready' ? {} : { qrText: '▄▀▄▀' }),
        },
      });
      return;
    }
    if (path === '/auth/weixin/revoke' && method === 'POST') {
      revokes += 1;
      configured = false;
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fallback();
  });

  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);

  await page.getByRole('button', { name: 'Channels', exact: true }).click();
  // The platform must be offered at all — before this feature weixin was
  // filtered out of the Web Shell allowlist.
  await page.getByRole('button', { name: 'Configure WeChat' }).click();
  const editor = page.getByRole('dialog');
  await expect(
    editor.getByRole('heading', { name: 'Configure WeChat' }),
  ).toBeVisible();

  const panel = editor.getByTestId('weixin-login-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Not logged in');
  // No credential input: the token comes from the QR login, not the form.
  await expect(editor.locator('input[type="password"]')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Log in with QR code' }).click();
  await expect(panel.locator('pre')).toHaveText('▄▀▄▀');
  await expect(panel).toContainText('Scan the QR code with WeChat.');
  await expect(panel).toContainText('Scanned. Confirm on your phone.');
  await expect(panel).toContainText('WeChat connected.');
  await expect(panel).toContainText('Logged in');
  await expect(panel).toContainText('User ID: wx-user-1');
  // The QR is gone once the flow is terminal.
  await expect(panel.locator('pre')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Log out' }).click();
  await expect.poll(() => revokes).toBe(1);
  await expect(panel).toContainText('Not logged in');

  // Saving must not require being logged in.
  await editor.getByLabel('Instance name').fill('my-weixin');
  await editor.getByRole('button', { name: 'Save' }).click();
  const upserts = () =>
    daemon.requests.filter(
      (request) =>
        request.method === 'PUT' &&
        request.path.endsWith('/channels/my-weixin'),
    );
  await expect.poll(() => upserts().length).toBe(1);
  expect(upserts()[0]?.body).toEqual(
    expect.objectContaining({
      config: expect.objectContaining({
        type: 'weixin',
        groupPolicy: 'disabled',
      }),
    }),
  );
  // Closing the editor drops a *live* flow, never a finished one — cancelling
  // here would delete the retained terminal view for no reason.
  expect(cancels).toBe(0);
});

test('lists a configured Email channel and hides its inert group controls @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'channel_management',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/qwen-web-shell-e2e',
          displayName: 'Main workspace',
          primary: true,
          trusted: true,
        },
      ],
    },
    channelTypes: [
      {
        type: 'email',
        displayName: 'Email',
        manageable: true,
        fields: [
          {
            key: 'address',
            label: 'address',
            kind: 'string',
            required: true,
            envResolvable: true,
          },
          {
            key: 'imapHost',
            label: 'imapHost',
            kind: 'string',
            required: true,
            envResolvable: true,
          },
          {
            key: 'imapPassword',
            label: 'imapPassword',
            kind: 'secret',
            required: true,
            envResolvable: true,
          },
          {
            key: 'smtpPassword',
            label: 'smtpPassword',
            kind: 'secret',
            required: true,
            envResolvable: true,
          },
          {
            key: 'privatePolicy',
            label: 'Private Policy',
            kind: 'enum',
            required: true,
            default: 'allowlist',
            options: [
              { value: 'disabled', label: 'Disabled' },
              { value: 'allowlist', label: 'Allowlist' },
              { value: 'open', label: 'Open' },
            ],
          },
          {
            key: 'allowedUsers',
            label: 'Allowed Users',
            kind: 'string-list',
          },
          // Injected by the registry because the plugin does not declare it.
          // Email builds every envelope with isGroup:false, so it is inert.
          {
            key: 'groupPolicy',
            label: 'Group Policy',
            kind: 'enum',
            required: true,
            default: 'disabled',
            options: [
              { value: 'disabled', label: 'Disabled' },
              { value: 'pairing', label: 'Pairing' },
              { value: 'allowlist', label: 'Allowlist' },
              { value: 'open', label: 'Open' },
            ],
          },
        ],
      },
    ],
    channels: {
      revision: '1',
      instances: {
        'agent-mail': {
          name: 'agent-mail',
          config: {
            type: 'email',
            address: 'agent@example.com',
            imapHost: 'imap.example.com',
            privatePolicy: 'allowlist',
          },
          secrets: {
            imapPassword: { present: true, source: 'environment' },
            smtpPassword: { present: true, source: 'environment' },
          },
          startsWithServe: false,
          runtime: { state: 'connected' },
        },
      },
    },
  });
  await page.addInitScript(() => {
    window.sessionStorage.setItem('qwen-daemon-token', 'e2e-token');
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);

  await page.getByRole('button', { name: 'Channels', exact: true }).click();

  // The instance list filtered on the same allowlist as the picker, so a
  // running Email channel used to be absent from the page entirely.
  await expect(
    page.getByRole('button', { name: 'Edit agent-mail' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Configure Email' }).click();
  const editor = page.getByRole('dialog');
  await expect(
    editor.getByRole('heading', { name: 'Configure Email' }),
  ).toBeVisible();
  // Locate by role and accessible name, not by label text: FieldShell appends
  // an aria-hidden "*" to every required label, so the label's text is
  // "IMAP Host*" and an exact getByLabel matches nothing. The accessible name
  // skips aria-hidden content, so an exact role name matches the control.
  await expect(
    editor.getByRole('textbox', { name: 'IMAP Host', exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole('textbox', { name: 'Mailbox Address', exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole('combobox', {
      name: 'Direct message policy',
      exact: true,
    }),
  ).toBeVisible();
  // Substring name matchers on purpose: an exact matcher would also miss a
  // rendered "Group policy*", letting this guard pass while the control it
  // forbids is on screen. Cover the whole group axis, not just the policy.
  await expect(
    editor.getByRole('combobox', { name: /Group policy/ }),
  ).toHaveCount(0);
  await expect(
    editor.getByRole('textbox', { name: /Allowed group IDs/ }),
  ).toHaveCount(0);
  await expect(
    editor.getByRole('combobox', { name: /Who can talk in groups/ }),
  ).toHaveCount(0);
});

async function configureWebhook(
  page: Page,
  testInfo: TestInfo,
  platform: { type: 'dingtalk' | 'feishu' | 'wecom'; displayName: string },
) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const webhookType = `${platform.type}-webhook`;
  const webhookUrl = `$${platform.type.toUpperCase()}_WEBHOOK_URL`;
  const signingSecret = `$${platform.type.toUpperCase()}_SIGNING_SECRET`;
  const signed = platform.type !== 'wecom';
  const primaryWorkspaceCwd = '/tmp/qwen-web-shell-e2e';
  const workspaceCwd = '/tmp/qwen-outbound-webhook-secondary';
  const scenario = createWebShellDaemonScenario({
    channels: { revision: '7', instances: {} },
    capabilities: {
      features: [
        'session_events',
        'session_source_metadata',
        'channel_management',
        'channel_delivery',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: primaryWorkspaceCwd,
          displayName: 'Main workspace',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: workspaceCwd,
          displayName: 'Notification workspace',
          primary: false,
          trusted: true,
        },
      ],
    },
    channelTypes: [
      {
        type: platform.type,
        displayName: platform.displayName,
        manageable: true,
        fields: [],
      },
      {
        type: webhookType,
        displayName: `${platform.displayName} Webhook`,
        manageable: true,
        outboundOnly: true,
        defaultDeliveryTarget: {
          type: 'chat',
          id: 'default',
          label: 'Configured group',
        },
        fields: [
          {
            key: 'webhookUrl',
            label: 'Webhook URL',
            kind: 'secret',
            required: true,
            envResolvable: true,
          },
          ...(signed
            ? [
                {
                  key: 'signingSecret',
                  label: 'Signing secret',
                  kind: 'secret' as const,
                  envResolvable: true,
                },
              ]
            : []),
        ],
      },
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.route('**/workspace/models', (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.addInitScript(() => {
    window.sessionStorage.setItem('qwen-daemon-token', 'e2e-token');
  });
  let primarySnapshotRequests = 0;
  await page.route(
    (url) =>
      url.pathname ===
      `/workspaces/${encodeURIComponent(primaryWorkspaceCwd)}/channels`,
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      primarySnapshotRequests += 1;
      await route.fulfill({ json: { revision: '1', instances: {} } });
    },
  );
  await page.route(
    /\/workspaces\/[^/]+\/channels\/notices\/(start|stop)$/,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      expect(path).toMatch(
        new RegExp(
          `^/workspaces/${encodeURIComponent(workspaceCwd)}/channels/notices/(start|stop)$`,
        ),
      );
      const instance = scenario.channels.instances['notices'];
      instance.runtime = {
        state: path.endsWith('/start') ? 'connected' : 'stopped',
      };
      await route.fulfill({ json: { snapshot: scenario.channels, instance } });
    },
  );

  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(page).toHaveTitle('Qwen Code Web chat');
  await expect(page).toHaveURL(new RegExp(`/session/${scenario.sessionId}$`));
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
  await page.getByRole('button', { name: 'Channels', exact: true }).click();
  await expect(
    page.getByTestId(`channel-platform-${platform.type}`),
  ).toBeVisible();
  await expect.poll(() => primarySnapshotRequests).toBeGreaterThan(0);
  await expect(page.getByTestId(`channel-platform-${webhookType}`)).toHaveCount(
    0,
  );
  await page
    .getByRole('button', {
      name: `Configure ${platform.displayName}`,
      exact: true,
    })
    .click();
  const methodDialog = page.getByRole('dialog');
  const methodTitle = `Choose a ${platform.displayName} connection`;
  await expect(methodDialog).toHaveAccessibleName(methodTitle);
  await expect(methodDialog.getByRole('heading')).toHaveText(methodTitle);
  await expect(methodDialog).toHaveAccessibleDescription(
    `Choose how this Channel connects to ${platform.displayName}.`,
  );
  await expect(
    methodDialog.getByRole('button', {
      name: platform.type === 'wecom' ? /^Intelligent bot/ : /^Application bot/,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('outbound-channel-methods.png'),
    animations: 'disabled',
  });
  await methodDialog
    .getByRole('button', { name: /^Webhook \(send only\)/ })
    .click();
  const editor = page.getByRole('dialog');
  await expect(
    editor.getByRole('heading', {
      name: `Configure ${platform.displayName} Webhook`,
    }),
  ).toBeVisible();
  await expect(editor.getByText('Access control', { exact: true })).toHaveCount(
    0,
  );
  await expect(
    editor.getByText('Conversation management', { exact: true }),
  ).toHaveCount(0);
  await expect(editor.getByText('Pairing', { exact: true })).toHaveCount(0);
  await editor.getByLabel('Workspace').click();
  await page.getByRole('option', { name: 'Notification workspace' }).click();
  await expect(editor.getByLabel('Workspace')).toContainText(
    'Notification workspace',
  );
  await editor.getByLabel('Instance name').fill('notices');
  await editor.getByLabel('Webhook URL', { exact: false }).fill(webhookUrl);
  if (signed) {
    await editor
      .getByLabel('Signing secret', { exact: false })
      .fill(signingSecret);
  } else {
    await expect(
      editor.getByLabel('Signing secret', { exact: false }),
    ).toHaveCount(0);
    await expect(editor.getByLabel('Bot ID', { exact: false })).toHaveCount(0);
    await expect(editor.getByLabel('Bot Secret', { exact: false })).toHaveCount(
      0,
    );
  }
  await page.screenshot({
    path: testInfo.outputPath('outbound-channel-editor.png'),
  });
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const upsert = daemon.requests.find(
    (request) =>
      request.method === 'PUT' && request.path.endsWith('/channels/notices'),
  );
  expect(upsert?.path).toBe(
    `/workspaces/${encodeURIComponent(workspaceCwd)}/channels/notices`,
  );
  expect(upsert?.body).toEqual({
    expectedRevision: '7',
    config: { type: webhookType },
    secrets: {
      webhookUrl: { operation: 'replace', value: webhookUrl },
      ...(signed
        ? { signingSecret: { operation: 'replace', value: signingSecret } }
        : {}),
    },
  });
  const card = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText('notices', { exact: true }) });
  await card.getByRole('button', { name: 'Edit notices', exact: true }).click();
  await expect(editor.getByLabel('Webhook URL', { exact: false })).toHaveCount(
    0,
  );
  await expect(
    editor.getByLabel('Signing secret', { exact: false }),
  ).toHaveCount(0);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const updates = () =>
    daemon.requests.filter(
      (request) =>
        request.method === 'PUT' && request.path.endsWith('/channels/notices'),
    );
  expect(updates().at(-1)?.body).toEqual({
    expectedRevision: expect.any(String),
    config: { type: webhookType },
    secrets: {
      webhookUrl: { operation: 'preserve' },
      ...(signed ? { signingSecret: { operation: 'preserve' } } : {}),
    },
  });
  await card.getByRole('button', { name: 'Edit notices', exact: true }).click();
  await editor
    .getByRole('button', { name: 'Replace', exact: true })
    .first()
    .click();
  await editor
    .getByLabel('Webhook URL', { exact: false })
    .fill(`${webhookUrl}_V2`);
  if (signed) {
    await editor.getByRole('button', { name: 'Clear', exact: true }).click();
  } else {
    await expect(
      editor.getByRole('button', { name: 'Clear', exact: true }),
    ).toHaveCount(0);
  }
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(updates().at(-1)?.body).toEqual({
    expectedRevision: expect.any(String),
    config: { type: webhookType },
    secrets: {
      webhookUrl: { operation: 'replace', value: `${webhookUrl}_V2` },
      ...(signed ? { signingSecret: { operation: 'clear' } } : {}),
    },
  });
  await card.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(card.getByText('Ready to send', { exact: true })).toBeVisible();
  expect(
    daemon.requests.filter(
      (request) =>
        request.method === 'POST' &&
        /\/session$|\/standalone\/sessions$|\/prompt$/.test(request.path),
    ),
  ).toHaveLength(0);
  await page.screenshot({
    path: testInfo.outputPath('outbound-channel-ready.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('outbound-channel-mobile.png'),
  });
  await card.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(
    card.getByText('Not ready to send notifications.', { exact: true }),
  ).toBeVisible();
  await expect(card.getByText('Ready to send', { exact: true })).toHaveCount(0);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
}

for (const platform of [
  { type: 'dingtalk', displayName: 'DingTalk' },
  { type: 'feishu', displayName: 'Feishu' },
  { type: 'wecom', displayName: 'WeCom' },
] as const) {
  test(`configures and starts a ${platform.displayName} webhook method in the selected workspace`, async ({
    page,
  }, testInfo) => {
    await configureWebhook(page, testInfo, platform);
  });
}
