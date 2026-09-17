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

/**
 * The Remote choice stays disabled until this browser has connected to the
 * origin at least once, so seed that memory before the shell boots.
 */
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

async function openHostChooser(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'Add workspace', exact: true })
    .click();
  await expect(addWorkspaceDialog(page)).toBeVisible();
}

async function chooseRemoteHost(page: Page): Promise<void> {
  const dialog = addWorkspaceDialog(page);
  // The input is sr-only, so the label is the click target.
  await dialog.getByText('Remote', { exact: true }).click();
  await expect(dialog.getByRole('radio', { name: 'Remote' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Next: choose folder' }).click();
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

  await gotoSourceShell(page);
  await openHostChooser(page);
  await chooseRemoteHost(page);

  // The tab really navigates to the chosen computer, marker and all.
  await expect
    .poll(() => new URL(page.url()).searchParams.get('daemon'))
    .toBe(REMOTE_ORIGIN);

  const dialog = addWorkspaceDialog(page);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('option', { name: REMOTE_FOLDER }),
  ).toBeVisible();
  // The source daemon was never asked: only the chosen computer has this folder.
  await expect(dialog.getByRole('option', { name: LOCAL_FOLDER })).toHaveCount(
    0,
  );
  expect(
    local.requests.filter(
      (request) => request.path === '/workspace-path-suggestions',
    ),
  ).toEqual([]);
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
  await openHostChooser(page);
  await chooseRemoteHost(page);
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

test('changing the computer reopens the chooser on the source tab @smoke', async ({
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
  await openHostChooser(page);
  await chooseRemoteHost(page);
  await expect(
    addWorkspaceDialog(page).getByRole('option', { name: REMOTE_FOLDER }),
  ).toBeVisible();

  await addWorkspaceDialog(page)
    .getByRole('button', { name: 'Change computer', exact: true })
    .click();

  // The chooser is back on the source tab, and the shell is not gated behind
  // a second "unfamiliar address" confirmation.
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  await expect(page).toHaveURL(sourceUrl);
  const dialog = addWorkspaceDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Local' })).toBeChecked();
  expect(new URL(page.url()).origin).toBe(sourceOrigin);
});

test('the local choice browses folders on the page origin @smoke', async ({
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
  const sourceUrl = page.url();
  await openHostChooser(page);
  const dialog = addWorkspaceDialog(page);
  await expect(dialog.getByRole('radio', { name: 'Local' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Next: choose folder' }).click();

  // The browse step is reached in place — one reload to carry the marker, and
  // no navigation onto another origin.
  await expect(
    dialog.getByRole('option', { name: LOCAL_FOLDER }),
  ).toBeVisible();
  expect(new URL(page.url()).origin).toBe(new URL(sourceUrl).origin);
  expect(new URL(page.url()).searchParams.has('addRemoteWorkspace')).toBe(
    false,
  );
  expect(loads).toHaveLength(2);
  await waitForRequest(
    local,
    (request) =>
      request.method === 'GET' &&
      request.path === '/workspace-path-suggestions',
  );
});
