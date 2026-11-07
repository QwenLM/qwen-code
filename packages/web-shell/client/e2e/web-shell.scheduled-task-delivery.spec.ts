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
    ],
  });
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
      return route.fulfill({
        json: {
          revision: '1',
          instances: {
            [channelName]: {
              name: channelName,
              config: { type: 'dingtalk' },
              secrets: {},
              startsWithServe: false,
              runtime: { state: 'connected' },
            },
          },
        },
      });
    }
    if (path.endsWith('/channel/observed-contacts')) {
      reads.push(path);
      return route.fulfill({
        json: {
          users: [],
          groups: contactsVisible
            ? ['chat-1', 'chat-2'].map((id) => ({
                channelName,
                id: secondary ? `secondary-${id}` : id,
                label: 'Release team',
                lastObservedAt: '2026-11-07T00:00:00Z',
                users: [],
                topics: [],
              }))
            : [],
        },
      });
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

test('creates, preserves, changes and explicitly clears scheduled delivery', async ({
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
  await page.screenshot({ path: info.outputPath('delivery-create.png') });
  await page
    .getByRole('button', { name: 'Create', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('delivery-create-details.png'),
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    method: 'POST',
    path: '/scheduled-tasks',
    body: { delivery, sessionMode: 'persistent' },
  });
  await expect(page.getByTestId('scheduled-tasks-page')).toContainText(
    'chat-1',
  );
  await page.screenshot({ path: info.outputPath('delivery-saved-card.png') });
  state.hideContacts();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
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
    .fill('api-only-user');
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
  expect(errors).toEqual([]);
});

test('requires an explicit resolution of per-run delivery and supports mobile layout', async ({
  page,
  baseURL,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await install(page, baseURL!);
  await createForm(page);
  await selectDelivery(page);
  await page.getByRole('combobox', { name: /^Run in/ }).selectOption('per_run');
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

test('preserves saved targets without delivery capability', async ({
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
  await page
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Renamed without capability');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]!.body).not.toHaveProperty('delivery');
  expect(state.reads).toEqual([]);
});

test('resets selection and scopes discovery and creation when workspace changes', async ({
  page,
  baseURL,
}) => {
  const state = await install(page, baseURL!, { multiWorkspace: true });
  await createForm(page);
  await selectDelivery(page);
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
