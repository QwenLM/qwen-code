/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
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
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);

  await expect(page.getByText('Web Shell task', { exact: true })).toBeVisible();
  await expect(page.getByText('DingTalk conversation')).toHaveCount(0);
  await expect(page.getByText('Legacy channel conversation')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Channels' }).click();
  await expect(
    page.getByText('DingTalk conversation', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Web Shell task')).toHaveCount(0);
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
            key: 'sessionScope',
            label: 'Session scope',
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
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);

  await page.getByRole('button', { name: 'Channels' }).click();
  await page.getByRole('button', { name: 'Configure DingTalk' }).click();
  await expect(
    page.getByRole('heading', { name: 'Configure DingTalk' }),
  ).toBeVisible();
  await page.getByLabel('Instance name').fill('release-bot');
  await page.getByLabel('Client ID (AppKey)').fill('ding-client-id');
  await page.getByLabel('Client Secret (AppSecret)').fill('ding-client-secret');
  await page.getByLabel('Session scope').click();
  await page.getByRole('option', { name: 'Per thread' }).click();
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
          request.path.endsWith('/channels/release-bot'),
      ),
    )
    .toEqual([
      expect.objectContaining({
        body: {
          expectedRevision: '1',
          config: {
            type: 'dingtalk',
            clientId: 'ding-client-id',
            sessionScope: 'thread',
            senderPolicy: 'pairing',
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
  await expect(page.getByLabel('Session scope')).toHaveText('Per thread');
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
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Delete release-bot' }).click();
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
        body: { expectedRevision: '2' },
      }),
    ]);
});
