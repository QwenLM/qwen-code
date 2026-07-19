/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  queueMockDaemonFailure,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const TEST_TOKEN = 'web-shell-channel-e2e-token';

test('loads the deterministic channel catalog and workspace snapshot', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: [
        'session_events',
        'workspace_settings',
        'channel_management',
        'channel_auth',
      ],
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoChannels(page, scenario, daemon);

  await expect(page.getByText('Credential Adapter')).toBeVisible();
  await expect(page.getByText('QR Adapter')).toBeVisible();
});

test('preserves, replaces, and explicitly clears stored credentials without rendering them', async ({
  page,
}, testInfo) => {
  const scenario = managedScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoChannels(page, scenario, daemon);

  await page.getByRole('button', { name: 'Add channel' }).click();
  const createDialog = page.getByRole('dialog', { name: 'Add channel' });
  await createDialog.getByLabel('Name *').fill('created-credential');
  await createDialog
    .getByLabel('Endpoint')
    .fill('https://created.invalid/messages');
  await createDialog.getByRole('button', { name: 'Enter credential' }).click();
  await createDialog.getByLabel('Access token').fill('created-value');
  await createDialog.getByRole('button', { name: 'Add channel' }).click();
  expect(lastChannelUpsertFor(daemon, 'created-credential').body).toMatchObject(
    {
      config: {
        type: 'credential-adapter',
        endpoint: 'https://created.invalid/messages',
      },
      secrets: {
        token: { operation: 'replace', value: 'created-value' },
      },
    },
  );
  await expect(page.locator('body')).not.toContainText('created-value');

  await openCredentialEditor(page);
  await expect(page.getByRole('button', { name: 'Keep stored' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(TEST_TOKEN);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(lastChannelUpsert(daemon).body).toMatchObject({
    secrets: { token: { operation: 'preserve' } },
  });

  await openCredentialEditor(page);
  await page.getByRole('button', { name: 'Replace' }).click();
  await page.getByLabel('Access token').fill('replacement-value');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect(lastChannelUpsert(daemon).body).toMatchObject({
    secrets: {
      token: { operation: 'replace', value: 'replacement-value' },
    },
  });
  await expect(page.locator('body')).not.toContainText('replacement-value');

  await openCredentialEditor(page);
  await page.getByRole('button', { name: 'Clear stored credential' }).click();
  await page.getByText('Permanently remove the stored Access token.').click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect(lastChannelUpsert(daemon).body).toMatchObject({
    secrets: { token: { operation: 'clear' } },
  });
});

test('retries runtime errors, toggles startup, reloads conflicts, and preserves failed deletes', async ({
  page,
}, testInfo) => {
  const scenario = managedScenario();
  const workspace = scenario.channelWorkspaces[scenario.workspaceCwd];
  workspace.snapshot.instances['primary-credential']!.runtime = {
    state: 'error',
    lastError: 'Adapter unavailable',
  };
  workspace.snapshot.instances['primary-qr']!.runtime = {
    state: 'partial',
  };
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoChannels(page, scenario, daemon);

  await expect(page.getByText('Adapter unavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Retry primary-credential' }).click();
  await expect(page.getByText('Adapter unavailable')).toHaveCount(0);
  expect(
    daemon.requests.some(
      (request) =>
        request.method === 'POST' &&
        request.path.endsWith('/channels/primary-credential/restart'),
    ),
  ).toBe(true);

  workspace.snapshot.revision = 'revision-20';
  const startup = page.getByRole('switch', {
    name: 'Start primary-credential with serve',
  });
  await startup.click();
  await expect(page.getByText('Channel settings are out of date')).toHaveCount(
    0,
  );
  await startup.click();
  await expect(startup).toBeChecked();
  const startupRequests = daemon.requests.filter(
    (request) =>
      request.method === 'PUT' &&
      request.path.endsWith('/channels/primary-credential/startup'),
  );
  expect(startupRequests).toHaveLength(2);
  expect(startupRequests[1]!.body).toEqual({
    expectedRevision: 'revision-20',
    enabled: true,
  });

  await page.getByRole('button', { name: 'Stop primary-qr' }).click();
  await expect(
    page.getByRole('button', { name: 'Start primary-qr' }),
  ).toBeVisible();
  expect(
    daemon.requests.some(
      (request) =>
        request.method === 'POST' &&
        request.path.endsWith('/channels/primary-qr/stop'),
    ),
  ).toBe(true);

  const deletePath = `${channelWorkspacePath(scenario.workspaceCwd)}/channels/primary-credential`;
  queueMockDaemonFailure(scenario, 'DELETE', deletePath, {
    status: 500,
    body: {
      code: 'channel_stop_failed',
      error: 'The channel could not be stopped before deletion.',
    },
  });
  await page
    .getByRole('button', { name: 'More actions for primary-credential' })
    .click();
  await page
    .getByRole('menuitem', { name: 'Delete primary-credential' })
    .click();
  await page.getByRole('button', { name: 'Delete channel' }).click();
  await expect(
    page.getByRole('heading', { name: 'Delete channel?' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('alertdialog', { name: 'Delete channel?' })
      .getByText('The channel could not be stopped before deletion.'),
  ).toBeVisible();
  expect(workspace.snapshot.instances['primary-credential']).toBeDefined();
  expect(
    workspace.snapshot.instances['primary-credential']!.startsWithServe,
  ).toBe(true);
});

test('rotates a local QR image before explicit authentication commit', async ({
  page,
}, testInfo) => {
  const scenario = managedScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoChannels(page, scenario, daemon);

  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('Name *').fill('handoff-qr');
  await page.getByLabel('Type *').click();
  await page.getByRole('option', { name: 'QR Adapter' }).click();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  expect(lastChannelUpsertFor(daemon, 'handoff-qr').body).toMatchObject({
    config: { type: 'qr-adapter' },
  });
  const qr = page.getByRole('img', {
    name: 'QR code for QR Adapter channel handoff-qr',
  });
  await expect(qr).toBeVisible();
  const firstUrl = await qr.getAttribute('src');
  expect(firstUrl).toMatch(/^blob:/);
  await expect(
    page.getByText('Scan the QR code with your channel app.'),
  ).toBeVisible();
  await expect(
    page.getByText('QR code scanned. Confirm in your channel app.'),
  ).toBeVisible();
  await expect.poll(() => qr.getAttribute('src')).not.toBe(firstUrl);
  const oldUrlStillReadable = await page.evaluate(async (url) => {
    if (!url) return true;
    try {
      await fetch(url);
      return true;
    } catch {
      return false;
    }
  }, firstUrl);
  expect(oldUrlStillReadable).toBe(false);

  await expect(
    page.getByText('Authentication is ready to save.'),
  ).toBeVisible();
  expect(
    daemon.requests.filter((request) => request.path.endsWith('/commit')),
  ).toHaveLength(0);
  await page.getByRole('button', { name: 'Save authentication' }).click();
  await expect(page.getByText('Authentication saved.')).toBeVisible();
  expect(
    daemon.requests.filter((request) => request.path.endsWith('/commit')),
  ).toHaveLength(1);
  const qrResponses = daemon.requests.filter((request) =>
    request.path.endsWith('/qr'),
  );
  expect(qrResponses).toHaveLength(2);
});

test('keeps management read-only when the feature exists without a token', async ({
  page,
}, testInfo) => {
  const scenario = managedScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoChannels(page, scenario, daemon, null);

  await expect(page.getByText('Channel management is read-only')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add channel' }),
  ).toBeDisabled();
});

test('reports unsupported management when a token exists without the feature', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoChannels(page, scenario, daemon);

  await expect(
    page.getByText('Channel management is not supported'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add channel' }),
  ).toBeDisabled();
});

test('supports keyboard-only channel navigation and a 440px layout', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 860 });
  const scenario = managedScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.focus();
  await page.keyboard.type('/settings');
  await page.locator('[data-web-shell-composer-submit]').focus();
  await page.keyboard.press('Enter');
  const category = page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: /^Channels/ });
  await tabTo(page, category);
  await page.keyboard.press('Enter');
  const manage = page.getByRole('button', { name: 'Manage channels' });
  await tabTo(page, manage);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Channels' })).toBeFocused();

  const add = page.getByRole('button', { name: 'Add channel' });
  await tabTo(page, add);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Add channel' }),
  ).toBeVisible();
  await expect(page.getByLabel('Name *')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();

  const back = page.getByRole('button', { name: 'Back to settings' });
  await tabTo(page, back);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Settings' })).toBeVisible();
  await expect(manage).toBeFocused();

  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= 440),
    )
    .toBe(true);
  for (const label of [
    'More actions for primary-credential',
    'Start primary-credential',
    'Authenticate primary-qr',
  ]) {
    await expect(page.getByRole('button', { name: label })).toBeVisible();
  }
});

test('cancels primary auth and routes channel reads to a switched secondary workspace', async ({
  page,
}, testInfo) => {
  const primaryCwd = '/tmp/qwen-web-shell-e2e';
  const secondaryCwd = '/tmp/qwen-secondary-workspace';
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: primaryCwd,
    capabilities: {
      features: [
        'session_events',
        'workspace_settings',
        'channel_management',
        'channel_auth',
      ],
      workspaces: [
        { id: 'primary', cwd: primaryCwd, primary: true, trusted: true },
        {
          id: 'secondary',
          cwd: secondaryCwd,
          primary: false,
          trusted: true,
        },
      ],
    },
    sessions: [
      {
        sessionId: 'primary-session',
        workspaceCwd: primaryCwd,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
        displayName: 'Primary channel session',
        clientCount: 1,
        hasActivePrompt: false,
      },
      {
        sessionId: 'secondary-session',
        workspaceCwd: secondaryCwd,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
        displayName: 'Secondary channel session',
        clientCount: 1,
        hasActivePrompt: false,
      },
    ],
    sessionId: 'primary-session',
  });
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoChannels(page, scenario, daemon);
  const secondaryWorkspace = page.getByRole('button', {
    name: 'qwen-secondary-workspace',
  });
  if ((await secondaryWorkspace.getAttribute('aria-expanded')) === 'false') {
    await secondaryWorkspace.click();
  }
  const secondarySession = page.getByRole('button', {
    name: /Secondary channel session/,
  });
  await expect(secondarySession).toBeVisible();
  const secondarySessionHandle = await secondarySession.elementHandle();
  if (!secondarySessionHandle) {
    throw new Error('Secondary workspace session control was not mounted.');
  }
  await page.getByRole('button', { name: 'Authenticate primary-qr' }).click();
  await expect(
    page.getByRole('img', {
      name: 'QR code for QR Adapter channel primary-qr',
    }),
  ).toBeVisible();

  await secondarySessionHandle.evaluate((element) =>
    (element as HTMLButtonElement).click(),
  );
  const connection = await daemon.sse.waitForConnection('secondary-session');
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
  await expect
    .poll(
      () =>
        daemon.requests.filter(
          (request) =>
            request.method === 'DELETE' &&
            request.path.includes(
              `${channelWorkspacePath(primaryCwd)}/channels/primary-qr/auth-sessions/`,
            ),
        ).length,
    )
    .toBe(1);

  const secondaryRequestStart = daemon.requests.length;
  await page.locator('[data-web-shell-composer-editor] .cm-content').click();
  await page.keyboard.type('/settings');
  await page.locator('[data-web-shell-composer-submit]').click();
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: /^Channels/ })
    .click();
  await page.getByRole('button', { name: 'Manage channels' }).click();
  await expect(page.getByText('secondary-credential')).toBeVisible();
  await expect(page.getByText('primary-credential')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Start secondary-credential' })
    .click();
  await page.getByRole('button', { name: 'Authenticate secondary-qr' }).click();
  await expect(
    page.getByRole('img', {
      name: 'QR code for QR Adapter channel secondary-qr',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    page.getByRole('heading', { name: 'Authenticate secondary-qr' }),
  ).toHaveCount(0);

  const secondaryChannelRequests = daemon.requests
    .slice(secondaryRequestStart)
    .filter((request) => request.path.includes('/channel'));
  expect(secondaryChannelRequests.length).toBeGreaterThan(4);
  expect(
    secondaryChannelRequests.every((request) =>
      request.path.startsWith(channelWorkspacePath(secondaryCwd)),
    ),
  ).toBe(true);
  expect(
    daemon.requests.some(
      (request) =>
        request.method === 'GET' &&
        request.path === `${channelWorkspacePath(secondaryCwd)}/channels`,
    ),
  ).toBe(true);
});

async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 80; index += 1) {
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard focus did not reach the requested control.');
}

function channelWorkspacePath(workspaceCwd: string): string {
  return `/workspaces/${encodeURIComponent(workspaceCwd)}`;
}

function managedScenario(): WebShellDaemonScenario {
  return createWebShellDaemonScenario({
    capabilities: {
      features: [
        'session_events',
        'workspace_settings',
        'channel_management',
        'channel_auth',
      ],
    },
  });
}

async function openCredentialEditor(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'More actions for primary-credential' })
    .click();
  await page.getByRole('menuitem', { name: 'Edit primary-credential' }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit primary-credential' }),
  ).toBeVisible();
}

function lastChannelUpsert(daemon: MockDaemonController) {
  return lastChannelUpsertFor(daemon, 'primary-credential');
}

function lastChannelUpsertFor(daemon: MockDaemonController, name: string) {
  const requests = daemon.requests.filter(
    (request) =>
      request.method === 'PUT' && request.path.endsWith(`/channels/${name}`),
  );
  const request = requests.at(-1);
  if (!request) throw new Error('Expected a channel upsert request.');
  return request;
}

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

async function gotoChannels(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
  token: string | null = TEST_TOKEN,
): Promise<void> {
  await gotoSession(page, scenario, daemon, token);
  await page.locator('[data-web-shell-composer-editor] .cm-content').click();
  await page.keyboard.type('/settings');
  await page.locator('[data-web-shell-composer-submit]').click();
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: /^Channels/ })
    .click();
  await page.getByRole('button', { name: 'Manage channels' }).click();
  await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible();
}

async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
  token: string | null = TEST_TOKEN,
): Promise<void> {
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}${query}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}
