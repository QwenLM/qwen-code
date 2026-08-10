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
            key: 'senderPolicy',
            label: 'Sender Policy',
            kind: 'enum',
            required: true,
            default: 'pairing',
            options: [
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
  await expect(page.getByLabel('Allowed user IDs')).toHaveCount(0);
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
            senderPolicy: 'pairing',
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
          senderPolicy: 'allowlist',
          allowedUsers: ['staff-a', 'staff-b'],
          groupPolicy: 'allowlist',
          sessionScope: 'chat_thread',
          groups: { 'group-a': {}, 'group-b': {} },
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      },
    }),
  );

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
        body: { expectedRevision: '3' },
      }),
    ]);
});
