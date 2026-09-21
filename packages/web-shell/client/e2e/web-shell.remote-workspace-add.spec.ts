import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  type DaemonRequestRecord,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

/**
 * The "connected computer" the Add workspace flow navigates the tab to. Any
 * origin works as long as it differs from the page origin; the mock daemon is
 * installed against this origin and the page controllers fall through to it.
 */
const REMOTE_ORIGIN = 'http://127.0.0.1:5199';

const REMOTE_CWD = '/srv/remote-project';
const LOCAL_CWD = '/srv/local-project';

/** Only these two exist in the mocked filesystem; each host lists one. */
const REMOTE_FOLDER = 'shared-checkout';
const LOCAL_FOLDER = 'local-checkout';

const workspaceFeatures = [
  'session_events',
  'permission_vote',
  'session_permission_vote',
  'session_scope_override',
  'session_source_metadata',
  'dynamic_workspace_registration',
  'persistent_workspace_registration',
  'workspace_display_name',
];

function hostScenario(
  cwd: string,
  pathSuggestions: Record<string, string[]>,
): WebShellDaemonScenario {
  return createWebShellDaemonScenario({
    workspaceCwd: cwd,
    capabilities: {
      features: workspaceFeatures,
      workspaces: [{ id: 'primary', cwd, primary: true, trusted: true }],
    },
    pathSuggestions,
  });
}

function installHost(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
  origin?: string,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: origin ?? String(testInfo.project.use.baseURL),
  });
}

/** Seed the connection catalog before the shell boots. */
async function seedConnectedComputer(page: Page): Promise<void> {
  await page.addInitScript(
    (seed: { key: string; origin: string }) => {
      try {
        window.localStorage.setItem(seed.key, JSON.stringify([seed.origin]));
      } catch {
        // Opaque origin (about:blank); this runs again per document.
      }
    },
    { key: 'qwen-remote-connections', origin: REMOTE_ORIGIN },
  );
}

async function gotoSourceShell(page: Page): Promise<string> {
  await page.goto('/');
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  return page.url();
}

function addWorkspaceDialog(page: Page) {
  return page.locator('[data-web-shell-dialog-title="Add Workspace"]');
}

async function openFolderBrowser(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'Add workspace', exact: true })
    .click();
  await expect(addWorkspaceDialog(page)).toBeVisible();
}

async function selectFolderSource(page: Page, source: string): Promise<void> {
  const dialog = addWorkspaceDialog(page);
  await dialog.getByRole('combobox', { name: 'Folder source' }).click();
  await page.getByRole('option', { name: source, exact: true }).click();
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
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(
      `Expected an object body for ${request.method} ${request.path}`,
    );
  }
  return body as Record<string, unknown>;
}

test('Settings adds a verified computer and returns to Connections @smoke', async ({
  page,
}, testInfo) => {
  await installHost(
    page,
    hostScenario(LOCAL_CWD, { '/srv': [LOCAL_FOLDER] }),
    testInfo,
  );
  await installHost(
    page,
    hostScenario(REMOTE_CWD, { '/srv': [REMOTE_FOLDER] }),
    testInfo,
    REMOTE_ORIGIN,
  );

  const sourceUrl = await gotoSourceShell(page);
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .first()
    .click();
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: /^Connections/ })
    .click();
  await page.getByLabel('Daemon address').fill(REMOTE_ORIGIN);
  await page.getByRole('button', { name: 'Add connection' }).click();

  await expect(page).toHaveURL(sourceUrl);
  await expect(
    page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('button', { name: /^Connections/ }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('127.0.0.1:5199', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(
          window.localStorage.getItem('qwen-remote-connections') || '[]',
        ),
      ),
    )
    .toEqual([REMOTE_ORIGIN]);

  await page.getByTestId('panel-back').click();
  await openFolderBrowser(page);
  await addWorkspaceDialog(page)
    .getByRole('combobox', { name: 'Folder source' })
    .click();
  await expect(
    page.getByRole('option', { name: '127.0.0.1:5199', exact: true }),
  ).toBeVisible();
});

test('the resumed browser lists the chosen computer directories @smoke', async ({
  page,
}, testInfo) => {
  const local = await installHost(
    page,
    hostScenario(LOCAL_CWD, { '/srv': [LOCAL_FOLDER] }),
    testInfo,
  );
  const remote = await installHost(
    page,
    hostScenario(REMOTE_CWD, { '/srv': [REMOTE_FOLDER] }),
    testInfo,
    REMOTE_ORIGIN,
  );
  await seedConnectedComputer(page);

  const sourceUrl = await gotoSourceShell(page);
  await openFolderBrowser(page);
  const sourceSelector = addWorkspaceDialog(page).getByRole('combobox', {
    name: 'Folder source',
  });
  await expect(sourceSelector).toHaveText('This computer');
  await expect(addWorkspaceDialog(page).getByRole('radio')).toHaveCount(0);
  await expect(
    addWorkspaceDialog(page).getByRole('option', { name: LOCAL_FOLDER }),
  ).toBeVisible();
  await selectFolderSource(page, '127.0.0.1:5199');

  // Browsing the chosen computer no longer navigates the tab: the folder list
  // is fetched through the source daemon's proxy route and shown in place.
  await expect(page).toHaveURL(sourceUrl);
  expect(new URL(page.url()).searchParams.has('daemon')).toBe(false);

  const dialog = addWorkspaceDialog(page);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('option', { name: REMOTE_FOLDER }),
  ).toBeVisible();
  // The same browser now shows only the chosen computer's folders.
  await expect(dialog.getByRole('option', { name: LOCAL_FOLDER })).toHaveCount(
    0,
  );
  await waitForRequest(
    local,
    (request) =>
      request.method === 'GET' &&
      request.path === '/workspace-path-suggestions',
  );
  await waitForRequest(
    remote,
    (request) =>
      request.method === 'GET' &&
      request.path === '/workspace-path-suggestions',
  );

  // Choosing a folder registers it on the chosen computer, not on the source.
  await dialog.getByRole('option', { name: REMOTE_FOLDER }).click();
  await dialog.getByRole('button', { name: 'Add this folder' }).click();
  const added = await waitForRequest(
    remote,
    (request) => request.method === 'POST' && request.path === '/workspaces',
  );
  expect(requestBody(added)['cwd']).toBe(`/srv/${REMOTE_FOLDER}/`);
  expect(
    local.requests.filter(
      (request) => request.method === 'POST' && request.path === '/workspaces',
    ),
  ).toEqual([]);

  // Confirming the add is what hands the tab over to the chosen computer.
  await expect
    .poll(() => new URL(page.url()).searchParams.get('daemon'))
    .toBe(REMOTE_ORIGIN);
});

test('cancelling returns to the exact source tab @smoke', async ({
  page,
}, testInfo) => {
  await installHost(
    page,
    hostScenario(LOCAL_CWD, { '/srv': [LOCAL_FOLDER] }),
    testInfo,
  );
  const remote = await installHost(
    page,
    hostScenario(REMOTE_CWD, { '/srv': [REMOTE_FOLDER] }),
    testInfo,
    REMOTE_ORIGIN,
  );
  await seedConnectedComputer(page);

  await gotoSourceShell(page);
  const sourceUrl = page.url();
  await openFolderBrowser(page);
  await selectFolderSource(page, '127.0.0.1:5199');
  await expect(
    addWorkspaceDialog(page).getByRole('option', { name: REMOTE_FOLDER }),
  ).toBeVisible();

  await addWorkspaceDialog(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();

  // Back on the source tab, with the resume marker and any credential gone.
  await expect(page).toHaveURL(sourceUrl);
  await expect(addWorkspaceDialog(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Add workspace', exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  expect(
    remote.requests.filter(
      (request) => request.method === 'POST' && request.path === '/workspaces',
    ),
  ).toEqual([]);
});

test('the folder source selector can return to this computer @smoke', async ({
  page,
}, testInfo) => {
  await installHost(
    page,
    hostScenario(LOCAL_CWD, { '/srv': [LOCAL_FOLDER] }),
    testInfo,
  );
  await installHost(
    page,
    hostScenario(REMOTE_CWD, { '/srv': [REMOTE_FOLDER] }),
    testInfo,
    REMOTE_ORIGIN,
  );
  await seedConnectedComputer(page);

  const sourceUrl = await gotoSourceShell(page);
  const sourceOrigin = new URL(sourceUrl).origin;
  await openFolderBrowser(page);
  await selectFolderSource(page, '127.0.0.1:5199');
  await expect(
    addWorkspaceDialog(page).getByRole('option', { name: REMOTE_FOLDER }),
  ).toBeVisible();

  await selectFolderSource(page, 'This computer');

  // The browser stays open on the source tab, without a separate host chooser
  // or a second "unfamiliar address" confirmation.
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  await expect(page).toHaveURL(sourceUrl);
  const dialog = addWorkspaceDialog(page);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('combobox', { name: 'Folder source' }),
  ).toHaveText('This computer');
  await expect(
    dialog.getByRole('option', { name: LOCAL_FOLDER }),
  ).toBeVisible();
  expect(new URL(page.url()).origin).toBe(sourceOrigin);
});

test('the default source browses local folders without reloading the shell @smoke', async ({
  page,
}, testInfo) => {
  const local = await installHost(
    page,
    hostScenario(LOCAL_CWD, { '/srv': [LOCAL_FOLDER] }),
    testInfo,
  );
  await installHost(
    page,
    hostScenario(REMOTE_CWD, { '/srv': [REMOTE_FOLDER] }),
    testInfo,
    REMOTE_ORIGIN,
  );
  await seedConnectedComputer(page);
  const loads: string[] = [];
  page.on('load', () => loads.push(page.url()));

  await gotoSourceShell(page);
  const sourceUrl = page.url();
  await openFolderBrowser(page);
  const dialog = addWorkspaceDialog(page);
  await expect(
    dialog.getByRole('combobox', { name: 'Folder source' }),
  ).toHaveText('This computer');
  await expect(dialog.getByRole('radio')).toHaveCount(0);

  // The daemon this tab already talks to needs no handover, so the shell is
  // never reloaded — the open session and its socket survive the add.
  await expect(
    dialog.getByRole('option', { name: LOCAL_FOLDER }),
  ).toBeVisible();
  expect(new URL(page.url()).origin).toBe(new URL(sourceUrl).origin);
  expect(new URL(page.url()).searchParams.has('addRemoteWorkspace')).toBe(
    false,
  );
  expect(loads).toHaveLength(1);
  await waitForRequest(
    local,
    (request) =>
      request.method === 'GET' &&
      request.path === '/workspace-path-suggestions',
  );
});

test('with no connected computer the folder browser opens directly @smoke', async ({
  page,
}, testInfo) => {
  const local = await installHost(
    page,
    hostScenario(LOCAL_CWD, { '/srv': [LOCAL_FOLDER] }),
    testInfo,
  );
  const loads: string[] = [];
  page.on('load', () => loads.push(page.url()));

  await gotoSourceShell(page);
  await page
    .getByRole('button', { name: 'Add workspace', exact: true })
    .click();

  // There is still no intermediate location step. The selector has only the
  // current computer until a remote is configured in Settings > Connections.
  const dialog = addWorkspaceDialog(page);
  await expect(
    dialog.getByRole('option', { name: LOCAL_FOLDER }),
  ).toBeVisible();
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await expect(
    dialog.getByRole('combobox', { name: 'Folder source' }),
  ).toHaveText('This computer');
  await dialog.getByRole('combobox', { name: 'Folder source' }).click();
  await expect(page.getByRole('option')).toHaveCount(1);
  expect(loads).toHaveLength(1);
  await waitForRequest(
    local,
    (request) =>
      request.method === 'GET' &&
      request.path === '/workspace-path-suggestions',
  );
});
