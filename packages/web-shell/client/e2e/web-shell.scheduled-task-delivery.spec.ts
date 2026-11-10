/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import type { DaemonScheduledTask } from '../daemon/workspace/types';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

const primaryCwd = '/tmp/qwen-delivery-primary';
const secondaryCwd = '/tmp/qwen-delivery-secondary';
const target = {
  channelName: 'release-bot',
  type: 'chat' as const,
  id: 'chat-1',
};
const delivery = { kind: 'channel' as const, target };

function task(
  overrides: Partial<DaemonScheduledTask> = {},
): DaemonScheduledTask {
  return {
    id: 'task-1',
    name: 'Daily summary',
    cron: '0 9 * * *',
    prompt: 'Summarize the project',
    recurring: true,
    enabled: true,
    createdAt: 1,
    lastFiredAt: null,
    nextRunAt: null,
    sessionId: null,
    sessionMode: 'persistent',
    runs: [],
    ...overrides,
  };
}

async function install(
  page: Page,
  baseURL: string,
  options: {
    tasks?: DaemonScheduledTask[];
    capable?: boolean;
    multiWorkspace?: boolean;
    omitWorkspaces?: boolean;
    channelsFail?: boolean;
    contactsFail?: boolean;
    deferPrimaryContacts?: boolean;
    configuredWebhook?: boolean;
  } = {},
) {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: primaryCwd,
    capabilities: {
      features: [
        'session_events',
        'session_source_metadata',
        'channel_management',
        'workspace_qualified_rest_core',
        'workspace_channel_observed_contacts',
        ...(options.capable === false ? [] : ['channel_delivery']),
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: primaryCwd,
          displayName: 'Main workspace',
          primary: true,
          trusted: true,
        },
        ...(options.multiWorkspace
          ? [
              {
                id: 'secondary',
                cwd: secondaryCwd,
                displayName: 'Release workspace',
                primary: false,
                trusted: true,
              },
            ]
          : []),
      ],
    },
    channelTypes: [
      {
        type: 'dingtalk',
        displayName: 'DingTalk',
        manageable: true,
        fields: [],
      },
      ...(options.configuredWebhook
        ? [
            {
              type: 'dingtalk-webhook',
              displayName: 'DingTalk webhook',
              manageable: true,
              fields: [],
              outboundOnly: true,
              defaultDeliveryTarget: {
                type: 'chat' as const,
                id: 'default',
                label: 'Configured DingTalk group',
              },
            },
          ]
        : []),
    ],
  });
  if (options.omitWorkspaces) delete scenario.capabilities.workspaces;
  await installMockDaemon(page, scenario, { baseURL });
  const tasks = new Map<string, DaemonScheduledTask[]>([
    ['primary', options.tasks ?? []],
    ['secondary', []],
  ]);
  const writes: Array<{
    method: string;
    path: string;
    body: Record<string, unknown>;
  }> = [];
  const reads: string[] = [];
  const pendingContacts: Array<() => Promise<void>> = [];
  let contactsVisible = true;
  await page.route('**/*', async (route) => {
    if (route.request().isNavigationRequest()) return route.continue();
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const secondary =
      path.includes('secondary') ||
      path.includes(encodeURIComponent(secondaryCwd));
    const workspace = secondary ? 'secondary' : 'primary';
    const channelName = secondary ? 'secondary-bot' : 'release-bot';
    if (path.endsWith('/channels')) {
      reads.push(path);
      if (options.channelsFail)
        return route.fulfill({
          status: 500,
          json: { error: 'Channels temporarily unavailable' },
        });
      return route.fulfill({
        json: {
          revision: '1',
          instances: Object.fromEntries(
            (secondary ? [channelName] : [channelName, 'ops-bot']).map(
              (name) => [
                name,
                {
                  name,
                  config: {
                    type:
                      options.configuredWebhook && name === 'ops-bot'
                        ? 'dingtalk-webhook'
                        : 'dingtalk',
                  },
                  secrets: {},
                  startsWithServe: false,
                  runtime: { state: 'connected' },
                },
              ],
            ),
          ),
        },
      });
    }
    if (path.endsWith('/channel/observed-contacts')) {
      reads.push(path);
      if (options.contactsFail)
        return route.fulfill({
          status: 500,
          json: { error: 'Contacts temporarily unavailable' },
        });
      const respond = () =>
        route.fulfill({
          json: {
            users: [],
            groups: contactsVisible
              ? [
                  ...['chat-1', 'chat-2'].map((id) => ({
                    channelName,
                    id: secondary ? `secondary-${id}` : id,
                    label: 'Release team',
                    lastObservedAt: '2026-11-07T00:00:00Z',
                    users: [],
                    topics: [],
                  })),
                  ...(!secondary && !options.configuredWebhook
                    ? [
                        {
                          channelName: 'ops-bot',
                          id: 'ops-chat',
                          label: 'Operations team',
                          lastObservedAt: '2026-11-07T00:00:00Z',
                          users: [],
                          topics: [],
                        },
                      ]
                    : []),
                ]
              : [],
          },
        });
      if (options.deferPrimaryContacts && !secondary) {
        pendingContacts.push(respond);
        return;
      }
      return respond();
    }
    const match = path.match(/\/scheduled-tasks(?:\/([^/]+))?$/);
    if (!match) return route.fallback();
    if (method === 'GET')
      return route.fulfill({ json: { tasks: tasks.get(workspace) } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    writes.push({ method, path, body });
    const current = tasks.get(workspace)!;
    const next =
      method === 'POST'
        ? task(body as Partial<DaemonScheduledTask>)
        : { ...current.find((item) => item.id === match[1])!, ...body };
    tasks.set(
      workspace,
      method === 'POST'
        ? [...current, next]
        : current.map((item) => (item.id === match[1] ? next : item)),
    );
    return route.fulfill({ json: next });
  });
  await page.goto('/scheduled-tasks?language=en-US');
  await expect(
    page.getByRole('button', { name: 'New scheduled task', exact: true }),
  ).toBeVisible();
  return {
    writes,
    reads,
    releaseContacts: () =>
      Promise.all(pendingContacts.splice(0).map((respond) => respond())),
    hideContacts: () => {
      contactsVisible = false;
    },
  };
}

async function createForm(page: Page) {
  await page
    .getByRole('button', { name: 'New scheduled task', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('Summarize the project');
  await page
    .getByRole('combobox', { name: /^Run in/ })
    .selectOption('dedicated');
}

async function selectDelivery(page: Page) {
  await page
    .getByRole('combobox', { name: 'Delivery Channel', exact: true })
    .selectOption('release-bot');
  await page
    .getByRole('combobox', { name: 'Suggested destination', exact: true })
    .selectOption(JSON.stringify(target));
}

test('uses a configured destination without contacts and switches back to manual delivery @smoke', async ({
  page,
  baseURL,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await install(page, baseURL!, { configuredWebhook: true });
  await createForm(page);
  const channels = page.getByRole('combobox', {
    name: 'Delivery Channel',
    exact: true,
  });
  const id = page.getByRole('textbox', { name: 'Destination ID', exact: true });
  const suggestions = page.getByRole('combobox', {
    name: 'Suggested destination',
    exact: true,
  });
  await channels.selectOption('ops-bot');
  await expect(
    page.getByText(
      'Messages are sent to the group configured for this Channel.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(id).toHaveCount(0);
  await expect(suggestions).toHaveCount(0);
  expect(
    state.reads.filter((path) => path.endsWith('/channel/observed-contacts')),
  ).toEqual([]);
  await page
    .getByText('Messages are sent to the group configured for this Channel.', {
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('configured-delivery-desktop.png'),
  });

  await channels.selectOption('release-bot');
  await expect(id).toHaveValue('');
  await expect(suggestions).toContainText('chat-1');
  await id.fill('manual-target');
  await channels.selectOption('ops-bot');
  await expect(id).toHaveCount(0);
  await expect(suggestions).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByText('Messages are sent to the group configured for this Channel.', {
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  const width = await page.getByRole('dialog').evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
  await page.screenshot({
    path: info.outputPath('configured-delivery-mobile.png'),
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]!.body).toMatchObject({
    sessionMode: 'persistent',
    delivery: {
      kind: 'channel',
      target: { channelName: 'ops-bot', type: 'chat', id: 'default' },
    },
  });
  await expect(page.getByTestId('scheduled-task-delivery')).toContainText(
    'ops-bot · Chat · default',
  );
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(id).toHaveCount(0);
  await channels.selectOption('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]!.body.delivery).toBeNull();
  expect(errors).toEqual([]);
});

test('preserves an unsupported saved configured target until explicit repair @smoke', async ({
  page,
  baseURL,
}, info) => {
  const saved = {
    kind: 'channel' as const,
    target: { channelName: 'ops-bot', type: 'user' as const, id: ' old-id ' },
  };
  const state = await install(page, baseURL!, {
    configuredWebhook: true,
    tasks: [task({ delivery: saved })],
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const id = page.getByRole('textbox', { name: 'Destination ID', exact: true });
  await expect(id).toHaveValue(' old-id ');
  await expect(
    page.getByRole('combobox', { name: 'Destination type', exact: true }),
  ).toHaveValue('user');
  await expect(
    page.getByRole('button', {
      name: 'Use configured destination',
      exact: true,
    }),
  ).toBeVisible();
  expect(
    state.reads.filter((path) => path.endsWith('/channel/observed-contacts')),
  ).toEqual([]);
  await page
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Renamed task');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]!.body).not.toHaveProperty('delivery');

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(id).toHaveValue(' old-id ');
  const repair = page.getByRole('button', {
    name: 'Use configured destination',
    exact: true,
  });
  await repair.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('configured-delivery-preserved-id.png'),
  });
  await repair.click();
  await expect(id).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]!.body.delivery).toEqual({
    kind: 'channel',
    target: { channelName: 'ops-bot', type: 'chat', id: 'default' },
  });
});

test('creates, preserves, changes and explicitly clears scheduled delivery @smoke', async ({
  page,
  baseURL,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await install(page, baseURL!);
  await createForm(page);
  await expect(
    page.getByRole('combobox', { name: 'Delivery Channel', exact: true }),
  ).toHaveValue('');
  await selectDelivery(page);
  await expect(
    page.getByRole('combobox', { name: 'Suggested destination', exact: true }),
  ).toContainText('chat-1');
  await expect(
    page.getByRole('combobox', { name: 'Suggested destination', exact: true }),
  ).toContainText('chat-2');
  await expect(
    page.getByRole('combobox', { name: 'Suggested destination', exact: true }),
  ).not.toContainText('ops-bot');
  await page.screenshot({ path: info.outputPath('delivery-create.png') });
  await page
    .getByRole('button', { name: 'Create', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('delivery-create-details.png'),
  });
  await page
    .getByRole('combobox', { name: 'Destination type', exact: true })
    .selectOption('user');
  await page
    .getByRole('textbox', { name: 'Destination ID', exact: true })
    .fill('previous-user');
  await page
    .getByRole('combobox', { name: 'Delivery Channel', exact: true })
    .selectOption('ops-bot');
  await expect(
    page.getByRole('textbox', { name: 'Destination ID', exact: true }),
  ).toHaveValue('');
  await expect(
    page.getByRole('combobox', { name: 'Destination type', exact: true }),
  ).toHaveValue('chat');
  await expect(
    page.getByRole('combobox', { name: 'Suggested destination', exact: true }),
  ).toContainText('ops-chat');
  await expect(
    page.getByRole('combobox', { name: 'Suggested destination', exact: true }),
  ).not.toContainText('release-bot');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Choose a Channel and enter a destination ID.',
  );
  expect(state.writes).toHaveLength(0);
  await selectDelivery(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    method: 'POST',
    path: '/scheduled-tasks',
    body: { delivery, sessionMode: 'persistent' },
  });
  await expect(page.getByTestId('scheduled-task-delivery')).toContainText(
    'chat-1',
  );
  await page.screenshot({ path: info.outputPath('delivery-saved-card.png') });
  state.hideContacts();
  const refreshedContacts = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      '/workspace/channel/observed-contacts',
  );
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const contactsResponse = await refreshedContacts;
  await contactsResponse.finished();
  expect(await contactsResponse.json()).toEqual({ users: [], groups: [] });
  const suggestions = page.getByRole('combobox', {
    name: 'Suggested destination',
    exact: true,
  });
  await expect(suggestions).toBeEnabled();
  await expect(suggestions).not.toContainText('chat-1');
  await expect(
    page.getByText(
      'This destination is not in the recent suggestions. Its ID is preserved; contact discovery is not required for delivery.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Destination ID', exact: true }),
  ).toHaveValue('chat-1');
  await page
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Renamed summary');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]!.body).not.toHaveProperty('delivery');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Destination type', exact: true })
    .selectOption('user');
  await page
    .getByRole('textbox', { name: 'Destination ID', exact: true })
    .fill(' api-only-user ');
  await expect(
    page.getByText(
      'This ID has leading or trailing whitespace, which will be sent as part of the destination.',
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Remove surrounding whitespace', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('delivery-whitespace.png') });
  await page
    .getByRole('button', { name: 'Remove surrounding whitespace', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Destination ID', exact: true }),
  ).toHaveValue('api-only-user');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(3);
  expect(state.writes[2]!.body.delivery).toEqual({
    kind: 'channel',
    target: { channelName: 'release-bot', type: 'user', id: 'api-only-user' },
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Destination ID', exact: true }),
  ).toHaveValue('api-only-user');
  await page
    .getByRole('combobox', { name: 'Delivery Channel', exact: true })
    .selectOption('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(4);
  expect(state.writes[3]!.body.delivery).toBeNull();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByTestId('scheduled-task-delivery')).toHaveCount(0);
  await expect(page.getByTestId('scheduled-tasks-page')).not.toContainText(
    'Delivery off',
  );
  await page.screenshot({ path: info.outputPath('delivery-cleared-card.png') });
  expect(errors).toEqual([]);
});

test('uses the primary cwd when bootstrap capabilities omit workspaces @smoke', async ({
  page,
  baseURL,
}, info) => {
  const state = await install(page, baseURL!, { omitWorkspaces: true });
  await createForm(page);
  await selectDelivery(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    method: 'POST',
    path: '/scheduled-tasks',
    body: { delivery, sessionMode: 'persistent' },
  });
  expect(state.reads).toContain(
    `/workspaces/${encodeURIComponent(primaryCwd)}/channels`,
  );
  expect(state.reads).toContain('/workspace/channel/observed-contacts');
  await expect(page.getByTestId('scheduled-task-delivery')).toContainText(
    'release-bot · Chat · chat-1',
  );
  await page.screenshot({
    path: info.outputPath('delivery-bootstrap-primary.png'),
  });
});

test('requires explicit per-run delivery resolution in a narrow Chromium viewport @smoke', async ({
  page,
  baseURL,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await install(page, baseURL!);
  await page
    .getByRole('button', { name: 'New scheduled task', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: /^Run in/ })).toHaveValue(
    'per_run',
  );
  const conflictHint = page.getByText(
    'A new session every run does not support Channel delivery. Choose a persistent session or turn delivery off before saving.',
    { exact: true },
  );
  await expect(conflictHint).not.toBeVisible();
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('Summarize the project');
  await selectDelivery(page);
  await expect(conflictHint).toBeVisible();
  await page
    .getByRole('combobox', { name: /^Run in/ })
    .selectOption('dedicated');
  await expect(conflictHint).not.toBeVisible();
  await page.getByRole('combobox', { name: /^Run in/ }).selectOption('per_run');
  await expect(conflictHint).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Destination ID', exact: true }),
  ).toHaveValue('chat-1');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  expect(state.writes).toHaveLength(0);
  await expect(page.getByRole('combobox', { name: /^Run in/ })).toHaveValue(
    'per_run',
  );
  await page
    .getByRole('textbox', { name: 'Destination ID', exact: true })
    .fill('x'.repeat(200));
  const dialogWidth = await page.getByRole('dialog').evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(dialogWidth.scroll).toBeLessThanOrEqual(dialogWidth.client);
  const identity = page.getByText(`release-bot · Chat · ${'x'.repeat(200)}`, {
    exact: true,
  });
  await identity.scrollIntoViewIfNeeded();
  const identityWidth = await identity.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(identityWidth.scroll).toBeLessThanOrEqual(identityWidth.client);

  await page.screenshot({
    path: info.outputPath('delivery-per-run-mobile.png'),
  });
  await page
    .getByRole('combobox', { name: 'Delivery Channel', exact: true })
    .selectOption('');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]!.body).toMatchObject({ sessionMode: 'per_run' });
  expect(state.writes[0]!.body).not.toHaveProperty('delivery');
});

test('preserves saved targets without delivery capability @smoke', async ({
  page,
  baseURL,
}) => {
  const state = await install(page, baseURL!, {
    capable: false,
    tasks: [task({ delivery })],
  });
  await expect(page.getByTestId('scheduled-tasks-page')).toContainText(
    'chat-1',
  );
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Destination ID', exact: true }),
  ).toBeDisabled();
  const runIn = page.getByRole('combobox', { name: /^Run in/ });
  await expect(runIn).toBeEnabled();
  await expect(runIn).toHaveValue('dedicated');
  await expect(
    runIn.getByRole('option', {
      name: 'A new session every run',
      exact: true,
    }),
  ).toHaveJSProperty('disabled', true);
  await page
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Renamed without capability');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]!.body).not.toHaveProperty('delivery');
  expect(state.reads).toEqual([]);
});

test('ignores late contacts and scopes discovery and creation when workspace changes @smoke', async ({
  page,
  baseURL,
}) => {
  const state = await install(page, baseURL!, {
    multiWorkspace: true,
    deferPrimaryContacts: true,
  });
  await createForm(page);
  await page
    .getByRole('combobox', { name: 'Delivery Channel', exact: true })
    .selectOption('release-bot');
  await expect
    .poll(
      () =>
        state.reads.filter((path) =>
          path.endsWith('/channel/observed-contacts'),
        ).length,
    )
    .toBe(1);
  await expect(
    page.getByText('Loading suggested destinations…', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Destination ID', exact: true })
    .fill('primary-manual');
  await page
    .getByRole('combobox', { name: 'Workspace', exact: true })
    .selectOption('secondary');
  await expect(
    page.getByRole('combobox', { name: 'Delivery Channel', exact: true }),
  ).toHaveValue('');
  await expect(
    page.getByRole('combobox', { name: 'Delivery Channel', exact: true }),
  ).not.toContainText('release-bot');
  await page
    .getByRole('combobox', { name: 'Delivery Channel', exact: true })
    .selectOption('secondary-bot');
  const secondaryTarget = {
    channelName: 'secondary-bot',
    type: 'chat',
    id: 'secondary-chat-2',
  };
  await expect(
    page.getByRole('combobox', { name: 'Suggested destination', exact: true }),
  ).toContainText('secondary-chat-2');
  const lateResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      '/workspace/channel/observed-contacts',
  );
  await state.releaseContacts();
  await (await lateResponse).finished();
  await page
    .getByRole('combobox', { name: 'Suggested destination', exact: true })
    .selectOption(JSON.stringify(secondaryTarget));
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    path: '/workspaces/secondary/scheduled-tasks',
    body: { delivery: { kind: 'channel', target: secondaryTarget } },
  });
  expect(state.reads).toContain(
    '/workspaces/secondary/channel/observed-contacts',
  );
  expect(state.reads).toContain(
    `/workspaces/${encodeURIComponent(secondaryCwd)}/channels`,
  );
});

test('loads contacts only for delivery and accepts manual IDs when discovery fails @smoke', async ({
  page,
  baseURL,
}) => {
  const state = await install(page, baseURL!, { contactsFail: true });
  await createForm(page);
  const channels = page.getByRole('combobox', {
    name: 'Delivery Channel',
    exact: true,
  });
  await expect(channels).toContainText('release-bot');
  expect(
    state.reads.filter((path) => path.endsWith('/channel/observed-contacts')),
  ).toEqual([]);
  await channels.selectOption('release-bot');
  await expect(
    page.getByText(
      'Could not load suggestions. You can still enter a destination ID; existing delivery is preserved.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText('Loading suggested destinations…', { exact: true }),
  ).not.toBeVisible();
  const id = page.getByRole('textbox', { name: 'Destination ID', exact: true });
  await expect(id).toBeEnabled();
  await id.fill('manual-chat');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]!.body.delivery).toEqual({
    kind: 'channel',
    target: { ...target, id: 'manual-chat' },
  });
});

test('preserves saved delivery when Channels and contact discovery fail @smoke', async ({
  page,
  baseURL,
}) => {
  const state = await install(page, baseURL!, {
    tasks: [task({ delivery })],
    channelsFail: true,
    contactsFail: true,
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(
    page.getByText(
      'Could not load Channels. Close and reopen the form to retry; existing delivery is preserved.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText('This Channel is unavailable in this workspace.', {
      exact: false,
    }),
  ).not.toBeVisible();
  const id = page.getByRole('textbox', { name: 'Destination ID', exact: true });
  await expect(id).toBeEnabled();
  await expect(id).toHaveValue('chat-1');
  await page
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Renamed after discovery failed');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]!.body).not.toHaveProperty('delivery');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Destination ID', exact: true }),
  ).toHaveValue('chat-1');
});
