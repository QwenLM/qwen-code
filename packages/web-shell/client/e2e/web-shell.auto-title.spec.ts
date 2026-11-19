import { expect, test, type Page, type Request } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

const promptText = 'Send before title is saved';
const manualTitle = 'My session title';
const previousSessionId = 'previous-session';

function isMetadataPatch(request: Request, sessionId: string) {
  return (
    request.method() === 'PATCH' &&
    new URL(request.url()).pathname.endsWith(`/session/${sessionId}/metadata`)
  );
}

function isAutoTitlePatch(request: Request, sessionId: string) {
  if (!isMetadataPatch(request, sessionId)) return false;
  const body = request.postDataJSON() as {
    initialDisplayName?: string;
    displayName?: string;
  };
  return (body.initialDisplayName ?? body.displayName) === promptText;
}

async function holdAutoTitle(page: Page, sessionId: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/session/**/metadata', async (route) => {
    if (isAutoTitlePatch(route.request(), sessionId)) await held;
    await route.fallback();
  });
  return {
    release,
    requested: () =>
      page.waitForRequest((request) => isAutoTitlePatch(request, sessionId)),
    responded: () =>
      page.waitForResponse((response) =>
        isAutoTitlePatch(response.request(), sessionId),
      ),
  };
}

async function setup(page: Page, baseURL: string | undefined) {
  const scenario = createWebShellDaemonScenario();
  // The mock pre-seeds the row which POST /session will allocate.
  const newSession = scenario.sessions.find(
    ({ sessionId }) => sessionId === scenario.sessionId,
  )!;
  newSession.displayName = null;
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const autoTitle = await holdAutoTitle(page, scenario.sessionId);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/session/${previousSessionId}?language=en`);
  await daemon.sse.waitForConnection(previousSessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: previousSessionId, replayedCount: 0 }),
  );
  const sidebar = page.locator('[data-sidebar-shell]');
  await sidebar
    .getByRole('button', { name: 'New session', exact: true })
    .first()
    .click();
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await page
    .locator('[data-web-shell-composer-editor] .cm-content')
    .fill(promptText);
  return {
    autoTitle,
    daemon,
    sessionId: scenario.sessionId,
    savedTitle: () =>
      scenario.sessions.find(
        ({ sessionId }) => sessionId === scenario.sessionId,
      )?.displayName,
    sidebar,
  };
}

test('submits the first prompt while the automatic title is held', async ({
  page,
  baseURL,
}) => {
  const { autoTitle, sessionId, savedTitle } = await setup(page, baseURL);
  try {
    const [, promptResponse] = await Promise.all([
      autoTitle.requested(),
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/session/${sessionId}/prompt`,
        { timeout: 10_000 },
      ),
      page.locator('[data-web-shell-composer-submit]').click(),
    ]);
    expect(promptResponse.status()).toBe(202);
    expect(promptResponse.request().postData()).toContain(promptText);
    const titleResponse = autoTitle.responded();
    autoTitle.release();
    expect((await titleResponse).ok()).toBe(true);
    expect(savedTitle()).toBe(promptText);
  } finally {
    autoTitle.release();
  }
});

test('sends to the allocated session when switching away during creation', async ({
  page,
  baseURL,
}) => {
  const { autoTitle, daemon, sessionId, savedTitle, sidebar } = await setup(
    page,
    baseURL,
  );
  let releaseCreate!: () => void;
  const createHeld = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route('**/session', async (route) => {
    if (route.request().method() === 'POST') await createHeld;
    await route.fallback();
  });
  try {
    const createRequested = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/session',
    );
    await page.locator('[data-web-shell-composer-submit]').click();
    await createRequested;
    await sidebar.getByText('Previous Session', { exact: true }).click();
    await daemon.sse.waitForConnection(previousSessionId);
    await expect(page).toHaveURL(
      (url) => url.pathname === `/session/${previousSessionId}`,
    );
    const titleRequested = autoTitle.requested();
    releaseCreate();
    await titleRequested;
    await expect
      .poll(() => daemon.promptRequests(), { timeout: 10_000 })
      .toHaveLength(1);
    expect(daemon.promptRequests()[0].path).toBe(
      `/session/${sessionId}/prompt`,
    );
    expect(JSON.stringify(daemon.promptRequests()[0].body)).toContain(
      promptText,
    );
    const titleResponse = autoTitle.responded();
    autoTitle.release();
    expect((await titleResponse).ok()).toBe(true);
    expect(savedTitle()).toBe(promptText);
    await expect(page).toHaveURL(
      (url) => url.pathname === `/session/${previousSessionId}`,
    );
    await expect(
      sidebar.getByText('Previous Session', { exact: true }),
    ).toBeVisible();
    expect(daemon.promptRequests()).toHaveLength(1);
  } finally {
    releaseCreate();
    autoTitle.release();
  }
});

test('keeps a manual rename when the delayed automatic title reaches the daemon', async ({
  page,
  baseURL,
}) => {
  const { autoTitle, sessionId, savedTitle, sidebar } = await setup(
    page,
    baseURL,
  );
  try {
    const titleRequested = autoTitle.requested();
    await page.locator('[data-web-shell-composer-submit]').click();
    await titleRequested;
    const row = sidebar
      .locator('[data-web-shell-session-title]', { hasText: promptText })
      .locator('..');
    await row.hover();
    await row.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const editor = sidebar.getByRole('textbox', { name: /^Rename:/ });
    await editor.fill(manualTitle);
    const renamed = page.waitForResponse((response) => {
      const request = response.request();
      return (
        isMetadataPatch(request, sessionId) &&
        (request.postDataJSON() as { displayName?: string }).displayName ===
          manualTitle
      );
    });
    await editor.press('Enter');
    expect((await renamed).ok()).toBe(true);
    await expect(sidebar.getByText(manualTitle, { exact: true })).toBeVisible();
    const titleResponse = autoTitle.responded();
    autoTitle.release();
    expect((await titleResponse).ok()).toBe(true);
    expect(savedTitle()).toBe(manualTitle);
    await expect(sidebar.getByText(manualTitle, { exact: true })).toBeVisible();
  } finally {
    autoTitle.release();
  }
});
