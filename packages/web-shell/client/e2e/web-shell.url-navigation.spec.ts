import { expect, test, type Page } from '@playwright/test';
import { completeReplay } from './visuals/harness';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

const pages = [
  ['plugins', 'Plugins'],
  ['channels', 'Channels'],
  ['scheduled-tasks', 'Scheduled Tasks'],
  ['goals', 'Goals'],
  ['settings', 'Settings'],
] as const;
async function expectPage(page: Page, path: string) {
  if (path === 'goals' || path === 'scheduled-tasks') {
    await expect(
      page.getByTestId(
        path === 'goals' ? 'goals-page' : 'scheduled-tasks-page',
      ),
    ).toBeVisible();
  } else {
    await expect(page.getByTestId('inline-panel')).toBeVisible();
    await expect(page.getByTestId('inline-panel')).toHaveAttribute(
      'aria-label',
      new RegExp(path, 'i'),
    );
  }
}
async function install(page: Page, baseURL: string) {
  const daemon = await installMockDaemon(page, createWebShellDaemonScenario(), {
    baseURL,
  });
  await page.route('**/*', async (route) => {
    if (route.request().isNavigationRequest()) await route.continue();
    else if (new URL(route.request().url()).pathname === '/scheduled-tasks') {
      await route.fulfill({ json: { tasks: [] } });
    } else await route.fallback();
  });
  return daemon;
}
for (const [path, label] of pages) {
  test(`${path} click, reload, fresh tab, and return without allocation @smoke`, async ({
    page,
    context,
    baseURL,
  }, info) => {
    const daemon = await install(page, baseURL!);
    await page.goto('/?language=en-US&instanceId=host&instanceType=dsw');
    await page
      .locator('[data-sidebar-shell]')
      .getByRole('button', { name: label, exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/${path}\\?instanceId=host&instanceType=dsw$`),
    );
    await expectPage(page, path);
    const historyLength = await page.evaluate(() => history.length);
    await page
      .locator('[data-sidebar-shell]')
      .getByRole('button', { name: label, exact: true })
      .click();
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await page.reload();
    await expectPage(page, path);
    await page.screenshot({ path: info.outputPath(`${path}.png`) });
    const fresh = await context.newPage();
    const freshDaemon = await install(fresh, baseURL!);
    await fresh.goto(page.url());
    await expectPage(fresh, path);
    if (path === 'plugins') await fresh.keyboard.press('Escape');
    else
      await fresh
        .getByRole('button', { name: /^back$/i })
        .first()
        .click();
    await expect(fresh).toHaveURL(/\/\?instanceId=host&instanceType=dsw$/);
    expect(
      freshDaemon.requests.filter(
        (r) => r.method === 'POST' && r.path === '/session',
      ),
    ).toHaveLength(0);
    await fresh.close();
    await page.goBack();
    await expect(page).toHaveURL(/\/\?instanceId=host&instanceType=dsw$/);
    await expect(page.getByTestId('inline-panel')).toHaveCount(0);
    await page.goForward();
    await expectPage(page, path);
    expect(
      daemon.requests.filter(
        (r) => r.method === 'POST' && r.path === '/session',
      ),
    ).toHaveLength(0);
  });
}

test('embedded base restores a page, retains host parameters and keeps split hidden @smoke', async ({
  page,
  baseURL,
}) => {
  const daemon = await install(page, baseURL!);
  // The host owns its SPA fallback. Serve its actual library entry at deep URLs.
  await page.route('**/agentic-code**', async (route) => {
    if (!route.request().isNavigationRequest()) return route.fallback();
    const response = await route.fetch({
      url: `${baseURL}/e2e/url-navigation-harness.html`,
    });
    await route.fulfill({ response });
  });
  await page.goto('/agentic-code/plugins?instanceId=abc&instanceType=dsw');
  await expectPage(page, 'plugins');
  await expect(
    page.getByRole('button', { name: 'Split View', exact: true }),
  ).toHaveCount(0);
  await page
    .locator('[data-sidebar-shell]')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await expect(page).toHaveURL(
    /\/agentic-code\/settings\?instanceId=abc&instanceType=dsw$/,
  );
  await page.reload();
  await expectPage(page, 'settings');
  await page.getByTestId('panel-back').click();
  await expect(page).toHaveURL(
    /\/agentic-code\?instanceId=abc&instanceType=dsw$/,
  );
  expect(
    daemon.requests.filter((r) => r.method === 'POST' && r.path === '/session'),
  ).toHaveLength(0);
});

test('session survives page navigation and browser history restores sessions @smoke', async ({
  page,
  baseURL,
}) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.goto(`/session/${scenario.sessionId}?instanceId=kept`);
  await completeReplay(
    page,
    daemon,
    scenario.sessionId,
    scenario.events.length,
  );
  await page
    .locator('[data-sidebar-shell]')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await expectPage(page, 'settings');
  await page.getByTestId('panel-back').click();
  await expect(page).toHaveURL(
    new RegExp(`/session/${scenario.sessionId}\\?instanceId=kept$`),
  );
  await page.goBack();
  await expectPage(page, 'settings');
  await page.goForward();
  await expect(page.getByTestId('inline-panel')).toHaveCount(0);
  expect(
    daemon.requests.filter((r) => r.method === 'POST' && r.path === '/session'),
  ).toHaveLength(0);
});

test('explicit page path wins over cockpit and slow capabilities do not erase it @smoke', async ({
  page,
  baseURL,
}) => {
  const daemon = await install(page, baseURL!);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/capabilities', async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto('/goals?view=cockpit&instanceId=kept');
  expect(new URL(page.url()).pathname).toBe('/goals');
  release();
  await expectPage(page, 'goals');
  await expect(page).toHaveURL(/\/goals\?instanceId=kept$/);
  expect(
    daemon.requests.filter((r) => r.method === 'POST' && r.path === '/session'),
  ).toHaveLength(0);
});

test('new task leaves a directly opened page without creating a session @smoke', async ({
  page,
  baseURL,
}) => {
  const daemon = await install(page, baseURL!);
  await page.goto('/plugins?instanceId=kept');
  await expectPage(page, 'plugins');
  await page
    .locator('[data-sidebar-shell]')
    .getByRole('button', { name: 'New task', exact: true })
    .click();
  await expect(page).toHaveURL(/\/\?instanceId=kept$/);
  await expect(page.getByTestId('inline-panel')).toHaveCount(0);
  expect(
    daemon.requests.filter((r) => r.method === 'POST' && r.path === '/session'),
  ).toHaveLength(0);
});

test('browser Back restores the legacy cockpit after a page @smoke', async ({
  page,
  baseURL,
}) => {
  const scenario = createWebShellDaemonScenario({
    settings: {
      settings: [
        {
          key: 'experimental.sessionWorkflow',
          type: 'boolean',
          label: 'Session Workflow',
          category: 'Experimental',
          requiresRestart: false,
          default: false,
          values: { effective: true },
        },
      ],
    },
  });
  await installMockDaemon(page, scenario, { baseURL });
  await page.goto('/?view=cockpit&language=en-US');
  await expect(page.getByTestId('cockpit-empty')).toBeVisible();
  await page
    .locator('[data-sidebar-shell]')
    .getByRole('button', { name: 'Plugins', exact: true })
    .click();
  await expectPage(page, 'plugins');
  await page.goBack();
  await expect(page).toHaveURL(/\/\?view=cockpit$/);
  await expect(page.getByTestId('cockpit-empty')).toBeVisible();
});
