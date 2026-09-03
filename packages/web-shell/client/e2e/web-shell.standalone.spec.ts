import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type DaemonRequestRecord,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const standaloneFeatures = [
  'session_events',
  'permission_vote',
  'session_permission_vote',
  'session_scope_override',
  'session_source_metadata',
  'standalone_sessions_v1',
];

const WORKSPACE_CWD = '/tmp/qwen-web-shell-e2e';

/** Standalone creation calls, ignoring the Recents list reads. */
function standaloneCreates(
  daemon: MockDaemonController,
): DaemonRequestRecord[] {
  return daemon.requests.filter(
    (request) =>
      request.method === 'POST' && request.path === '/standalone/sessions',
  );
}

test('the composer no-workspace target creates an exact standalone session @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: standaloneFeatures },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoNewStandaloneChat(page);
  await fillComposer(page, 'Start a standalone conversation');
  await page.locator('[data-web-shell-composer-submit]').click();

  const create = await waitForRequest(
    daemon,
    (request) =>
      request.method === 'POST' && request.path === '/standalone/sessions',
  );
  const body = requestBody(create);
  expect(Object.keys(body).sort()).toEqual(['approvalMode', 'sessionId']);
  expect(body['approvalMode']).toBe('default');
  expect(body['sessionId']).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(daemon.requests).not.toContainEqual(
    expect.objectContaining({ method: 'POST', path: '/session' }),
  );

  const sessionId = String(body['sessionId']);
  await expect(page).toHaveURL(
    new RegExp(
      `/session/${sessionId.replaceAll('-', '\\-')}\\?context=standalone$`,
    ),
  );
});

test('the sidebar New task keeps the primary workspace route on a capable daemon @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: standaloneFeatures },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoNewTask(page);
  await fillComposer(page, 'Start a workspace conversation');
  await page.locator('[data-web-shell-composer-submit]').click();

  const create = await waitForRequest(
    daemon,
    (request) => request.method === 'POST' && request.path === '/session',
  );
  expect(requestBody(create)['cwd']).toBe(scenario.workspaceCwd);
  expect(standaloneCreates(daemon)).toEqual([]);
});

test('keeps workspace navigation reachable inside a standalone chat @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: WORKSPACE_CWD,
    capabilities: {
      features: standaloneFeatures,
      workspaces: [
        { id: 'primary', cwd: WORKSPACE_CWD, primary: true, trusted: true },
      ],
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoNewStandaloneChat(page);

  // The workspace row survives the projectless context: without it there is no
  // route back to a workspace.
  const sidebar = page.getByRole('complementary');
  const workspaceRow = sidebar.getByRole('button', {
    name: /^qwen-web-shell-e2e/,
  });
  await expect(workspaceRow).toBeVisible();

  // Row actions are hidden until the row is hovered.
  await workspaceRow.hover();
  const newTaskButtons = sidebar.getByRole('button', {
    name: 'New task',
    exact: true,
  });
  await expect(newTaskButtons).toHaveCount(2);
  await newTaskButtons.last().click();

  await fillComposer(page, 'Back to the workspace');
  await page.locator('[data-web-shell-composer-submit]').click();

  const create = await waitForRequest(
    daemon,
    (request) => request.method === 'POST' && request.path === '/session',
  );
  expect(requestBody(create)['cwd']).toBe(WORKSPACE_CWD);
});

test('hides the standalone entry point without the capability @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await page.goto('/');
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  // A single workspace with no creation capabilities and no standalone
  // support hides the composer picker entirely.
  await expect(page.locator('button[aria-label="Workspace"]')).toHaveCount(0);

  await clickNewTask(page);
  await fillComposer(page, 'Start a legacy conversation');
  await page.locator('[data-web-shell-composer-submit]').click();

  await waitForRequest(
    daemon,
    (request) => request.method === 'POST' && request.path === '/session',
  );
  expect(standaloneCreates(daemon)).toEqual([]);
});

test('an uncertain standalone create stays recoverable and is never retried @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: standaloneFeatures },
    standaloneCreateError: {
      status: 500,
      code: 'standalone_creation_outcome_unknown',
      message: 'creation outcome is unknown',
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoNewStandaloneChat(page);
  await fillComposer(page, 'Do not duplicate this conversation');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect(page.getByText('Creation may have succeeded')).toBeVisible();
  expect(
    daemon.requests.filter(
      (request) =>
        request.method === 'POST' && request.path === '/standalone/sessions',
    ),
  ).toHaveLength(1);
  expect(daemon.requests).not.toContainEqual(
    expect.objectContaining({ method: 'POST', path: '/session' }),
  );

  await expect(page.locator('[data-web-shell-composer-submit]')).toBeDisabled();
  // The composer picker is not offered while the outcome is unknown, and a
  // plain new task is blocked by the recovery guard, so neither path may
  // start a second create.
  await expect(page.locator('button[aria-label="Workspace"]')).toHaveCount(0);
  await clickNewTask(page);
  expect(
    daemon.requests.filter(
      (request) =>
        request.method === 'POST' && request.path === '/standalone/sessions',
    ),
  ).toHaveLength(1);
});

test('standalone Recents keeps lifecycle actions on exact standalone routes @smoke', async ({
  page,
}, testInfo) => {
  const currentSessionId = '11111111-1111-4111-8111-111111111111';
  const otherSessionId = '22222222-2222-4222-8222-222222222222';
  const scenario = createWebShellDaemonScenario({
    sessionId: currentSessionId,
    capabilities: { features: standaloneFeatures },
    standaloneSessions: [
      standaloneSummary(currentSessionId, 'Current conversation'),
      standaloneSummary(otherSessionId, 'Other conversation'),
    ],
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await page.goto(
    `/session/${encodeURIComponent(currentSessionId)}?context=standalone`,
  );
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  const connection = await daemon.sse.waitForConnection(currentSessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  await expect(
    page.getByText('Other conversation', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(`/tmp/standalone/${otherSessionId}`)).toHaveCount(
    0,
  );

  await openSessionAction(page, 'Other conversation', 'Rename');
  const renameDialog = page.getByRole('dialog', { name: 'Rename' });
  await renameDialog.getByRole('textbox').fill('Renamed conversation');
  await renameDialog.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByText('Renamed conversation', { exact: true }),
  ).toBeVisible();

  const download = page.waitForEvent('download');
  await openSessionAction(
    page,
    'Renamed conversation',
    'Export conversation record',
  );
  await expect((await download).suggestedFilename()).toBe(
    `${otherSessionId}.html`,
  );

  await openSessionAction(page, 'Renamed conversation', 'Archive');
  await expect(
    page.getByText('Renamed conversation', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(
    page.getByText('Renamed conversation', { exact: true }),
  ).toBeVisible();

  await openSessionAction(page, 'Renamed conversation', 'Restore');
  await expect(
    page.getByText('Renamed conversation', { exact: true }),
  ).toBeVisible();
  await openSessionAction(page, 'Renamed conversation', 'Delete');
  const deleteDialog = page.getByRole('dialog', { name: 'Delete' });
  await deleteDialog.getByRole('button', { name: 'Delete' }).click();
  await expect(
    page.getByText('Renamed conversation', { exact: true }),
  ).toHaveCount(0);

  expect(
    daemon.requests.map((request) => `${request.method} ${request.path}`),
  ).toEqual(
    expect.arrayContaining([
      `PATCH /standalone/sessions/${otherSessionId}/metadata`,
      `GET /standalone/sessions/${otherSessionId}/export`,
      'POST /standalone/sessions/archive',
      'POST /standalone/sessions/unarchive',
      'POST /standalone/sessions/delete',
    ]),
  );
});

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

async function clickNewTask(page: Page): Promise<void> {
  const newTask = page
    .getByRole('button', { name: 'New task', exact: true })
    .first();
  await expect(newTask).toBeEnabled();
  await newTask.click();
}

async function gotoNewTask(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await clickNewTask(page);
}

async function selectNoWorkspaceTarget(page: Page): Promise<void> {
  await page.locator('button[aria-label="Workspace"]').click();
  await page
    .getByRole('menuitemradio', {
      name: 'No workspace (standalone)',
      exact: true,
    })
    .click();
}

async function gotoNewStandaloneChat(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await selectNoWorkspaceTarget(page);
}

async function fillComposer(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.type(text);
}

async function openSessionAction(
  page: Page,
  sessionName: string,
  actionName: string,
): Promise<void> {
  const row = page
    .getByRole('button', { name: sessionName, exact: true })
    .locator('..');
  await row.getByRole('button', { name: 'Conversation actions' }).click();
  await page.getByRole('menuitem', { name: actionName, exact: true }).click();
}

function standaloneSummary(sessionId: string, displayName: string) {
  return {
    sessionId,
    workspaceCwd: `/tmp/standalone/${sessionId}`,
    sourceType: 'standalone' as const,
    context: { kind: 'standalone' as const },
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    displayName,
    clientCount: 0,
    hasActivePrompt: false,
    isArchived: false,
  };
}

async function waitForRequest(
  daemon: MockDaemonController,
  predicate: (request: DaemonRequestRecord) => boolean,
): Promise<DaemonRequestRecord> {
  await expect.poll(() => daemon.requests.some(predicate)).toBe(true);
  const request = daemon.requests.find(predicate);
  if (!request) throw new Error('Expected daemon request was not recorded.');
  return request;
}

function requestBody(request: DaemonRequestRecord): Record<string, unknown> {
  if (
    typeof request.body !== 'object' ||
    request.body === null ||
    Array.isArray(request.body)
  ) {
    throw new Error(
      `Expected an object body for ${request.method} ${request.path}`,
    );
  }
  return request.body as Record<string, unknown>;
}
