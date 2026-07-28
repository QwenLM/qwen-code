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
