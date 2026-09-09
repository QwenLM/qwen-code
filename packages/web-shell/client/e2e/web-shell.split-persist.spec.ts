import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { DaemonPermissionRequestEvent } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const WORKSPACE_CWD = '/tmp/qwen-web-shell-e2e';
const MAIN_SESSION = 'split-main-session';
const SESSION_A = 'split-session-a';
const SESSION_B = 'split-session-b';
const STORAGE_KEY = 'qwen-webshell-split-sessions';

function createSplitScenario(): WebShellDaemonScenario {
  const at = '2026-07-03T00:00:00.000Z';
  return createWebShellDaemonScenario({
    workspaceCwd: WORKSPACE_CWD,
    sessionId: MAIN_SESSION,
    sessions: [
      {
        sessionId: MAIN_SESSION,
        workspaceCwd: WORKSPACE_CWD,
        createdAt: at,
        updatedAt: at,
        displayName: 'Main Session',
        clientCount: 1,
        hasActivePrompt: false,
      },
      {
        sessionId: SESSION_A,
        workspaceCwd: WORKSPACE_CWD,
        createdAt: at,
        updatedAt: at,
        displayName: 'Session A',
        clientCount: 0,
        hasActivePrompt: false,
      },
      {
        sessionId: SESSION_B,
        workspaceCwd: WORKSPACE_CWD,
        createdAt: at,
        updatedAt: at,
        displayName: 'Session B',
        clientCount: 0,
        hasActivePrompt: false,
      },
    ],
  });
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

test('restores the split across a reload and isolates it per tab @smoke', async ({
  page,
  context,
}, testInfo) => {
  // Wide viewport so the split stays unfolded (it folds below the large-screen
  // breakpoint).
  await page.setViewportSize({ width: 1440, height: 900 });

  const scenario = createSplitScenario();
  await installScenario(page, scenario, testInfo);

  // Open the split via the deep link — the exact URL "open in new tab" produces
  // (path reset to `/`, sessions in `?split=`).
  await page.goto(`/?split=${SESSION_A},${SESSION_B}`);

  const split = page.locator('[data-testid="split-view"]');
  await expect(split).toBeVisible();
  await expect(page.locator('[data-testid="chat-pane"]')).toHaveCount(2);

  // The session set lands in per-tab storage…
  await expect
    .poll(async () =>
      page.evaluate((key) => window.sessionStorage.getItem(key), STORAGE_KEY),
    )
    .toBe(JSON.stringify([SESSION_A, SESSION_B]));

  // …and the one-shot deep-link param is consumed so a bookmark isn't sticky.
  await expect.poll(async () => new URL(page.url()).search).toBe('');

  // Reload (URL is now bare `/`): the split comes back from storage.
  await page.reload();
  await expect(page.locator('[data-testid="split-view"]')).toBeVisible();
  await expect(page.locator('[data-testid="chat-pane"]')).toHaveCount(2);

  // A brand-new tab has its own sessionStorage, so it must NOT inherit tab 1's
  // split. (If persistence used localStorage, this tab would wrongly reopen it.)
  const page2 = await context.newPage();
  await page2.setViewportSize({ width: 1440, height: 900 });
  await installScenario(page2, scenario, testInfo);
  await page2.goto(`/session/${MAIN_SESSION}`);
  await expect(
    page2.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  await expect(page2.locator('[data-testid="split-view"]')).toHaveCount(0);
});

test('leaving the split clears storage so a refresh does not restore it', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const scenario = createSplitScenario();
  await installScenario(page, scenario, testInfo);

  await page.goto(`/?split=${SESSION_A},${SESSION_B}`);
  await expect(page.locator('[data-testid="split-view"]')).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate((key) => window.sessionStorage.getItem(key), STORAGE_KEY),
    )
    .toBe(JSON.stringify([SESSION_A, SESSION_B]));

  // Leave via the split's back button.
  await page
    .locator('[data-testid="split-view"] header button')
    .first()
    .click();
  await expect(page.locator('[data-testid="split-view"]')).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate((key) => window.sessionStorage.getItem(key), STORAGE_KEY),
    )
    .toBeNull();

  // A refresh now lands on the normal view, not the split.
  await page.reload();
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  await expect(page.locator('[data-testid="split-view"]')).toHaveCount(0);
});

test('shows session details without moving focus and preserves drafts across pane controls @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installScenario(page, createSplitScenario(), testInfo);
  await page.goto(`/?split=${SESSION_A},${SESSION_B}`);

  const split = page.getByTestId('split-view');
  const paneA = page.locator(`[data-pane-session-id="${SESSION_A}"]`);
  const paneB = page.locator(`[data-pane-session-id="${SESSION_B}"]`);
  const editorA = paneA.locator('.cm-content');
  const editorB = paneB.locator('.cm-content');
  const titleB = paneB.locator('[data-slot="popover-anchor"]');
  const details = page.getByRole('dialog', { name: 'Session B', exact: true });
  await expect(editorA).toBeEditable();
  await expect(editorB).toBeEditable();
  await editorA.fill('Draft kept in session A');
  await expect(paneA.getByTestId('chat-pane')).toHaveAttribute(
    'data-pane-active',
  );
  await expect(paneA.locator('header')).not.toHaveCSS('box-shadow', 'none');
  await expect(paneB.locator('header')).toHaveCSS('box-shadow', 'none');
  const headerHeight = await paneB
    .locator('header')
    .evaluate((header) => header.getBoundingClientRect().height);

  await expect(editorA).toBeFocused();
  await titleB.hover();
  await expect(details).toBeVisible();
  await expect(details).toHaveAttribute('data-side', 'bottom');
  await expect(details.getByText(SESSION_B, { exact: true })).toBeVisible();
  await expect(
    details.getByText('qwen-web-shell-e2e', { exact: true }),
  ).toBeVisible();
  await expect(editorA).toBeFocused();
  await expect(paneB.getByTestId('chat-pane')).not.toHaveAttribute(
    'data-pane-active',
  );
  const rootBounds = await page.locator('[data-web-shell-root]').boundingBox();
  const detailsBounds = await details.boundingBox();
  expect(rootBounds).not.toBeNull();
  expect(detailsBounds).not.toBeNull();
  expect(detailsBounds!.x).toBeGreaterThanOrEqual(rootBounds!.x);
  expect(detailsBounds!.x + detailsBounds!.width).toBeLessThanOrEqual(
    rootBounds!.x + rootBounds!.width,
  );
  expect(
    await paneB
      .locator('header')
      .evaluate((header) => header.getBoundingClientRect().height),
  ).toBe(headerHeight);
  await page.screenshot({ path: testInfo.outputPath('split-details.png') });

  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await paneB
    .getByRole('button', { name: 'Maximize pane', exact: true })
    .hover();
  await page.waitForTimeout(350);
  await expect(details).toHaveCount(0);
  await paneB.locator('header').click({ position: { x: 5, y: 5 } });
  await expect(paneB.getByTestId('chat-pane')).toHaveAttribute(
    'data-pane-active',
  );
  await paneA.getByRole('button', { name: 'Close pane', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(editorA).toBeFocused();
  await expect(paneA.getByTestId('chat-pane')).toHaveAttribute(
    'data-pane-active',
  );
  await editorB.fill('Draft kept in session B');
  await paneB
    .getByRole('button', { name: 'Maximize pane', exact: true })
    .click();
  await expect(paneA).toBeHidden();
  await paneB
    .getByRole('button', { name: 'Restore pane', exact: true })
    .click();
  await expect(editorA).toHaveText('Draft kept in session A');
  await expect(editorB).toHaveText('Draft kept in session B');
  const paneWidths = await split
    .locator('[data-pane-session-id]')
    .evaluateAll((panes) =>
      panes.map((pane) => pane.getBoundingClientRect().width),
    );
  expect(Math.abs(paneWidths[0] - paneWidths[1])).toBeLessThan(1);

  await split.getByRole('button', { name: 'Add session' }).click();
  await split
    .getByRole('button', { name: 'Main Session', exact: true })
    .click();
  const mainPane = page.locator(`[data-pane-session-id="${MAIN_SESSION}"]`);
  await expect(mainPane.getByTestId('chat-pane')).toHaveAttribute(
    'data-pane-active',
  );
  await mainPane
    .getByRole('button', { name: 'Close pane', exact: true })
    .click();
  await expect(mainPane).toHaveCount(0);
  await expect(split.locator('[data-pane-active]')).toHaveCount(1);
  await expect(editorA).toHaveText('Draft kept in session A');
  await expect(editorB).toHaveText('Draft kept in session B');
});

test('navigates hidden tool and question approvals without answering them @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const scenario = createSplitScenario();
  const toolEvent: DaemonPermissionRequestEvent = {
    v: 1,
    id: 1,
    type: 'permission_request',
    data: {
      requestId: 'split-tool-permission',
      sessionId: SESSION_A,
      toolCall: { name: 'Bash', input: { command: 'printf web-shell-e2e' } },
      options: [
        { optionId: 'cancel', label: 'Reject', kind: 'reject_once' },
        {
          optionId: 'proceed_always_user',
          label: 'Always allow for user',
          kind: 'allow_always',
        },
        {
          optionId: 'proceed_always_project',
          label: 'Always allow for project',
          kind: 'allow_always',
        },
        { optionId: 'allow_once', label: 'Allow once', kind: 'allow_once' },
      ],
    },
  };
  scenario.events = [toolEvent];
  scenario.branch = {
    sessionId: SESSION_B,
    displayName: 'Session B',
    events: [
      {
        v: 1,
        id: 1,
        type: 'permission_request',
        data: {
          requestId: 'split-question-permission',
          sessionId: SESSION_B,
          toolCall: {
            name: 'ask_user_question',
            input: {
              questions: [
                {
                  question: 'Which behavior should be checked?',
                  header: 'Check',
                  options: [
                    { label: 'Focus', description: 'Check focus retention' },
                    { label: 'Drafts', description: 'Check draft retention' },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
          options: [
            { optionId: 'allow_once', label: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', label: 'Reject', kind: 'reject_once' },
          ],
        },
      },
    ],
  };
  const daemon = await installScenario(page, scenario, testInfo);
  await page.goto(`/?split=${SESSION_A},${SESSION_B}`);
  const split = page.getByTestId('split-view');
  const paneA = page.locator(`[data-pane-session-id="${SESSION_A}"]`);
  const paneB = page.locator(`[data-pane-session-id="${SESSION_B}"]`);
  const pending = split.getByRole('button', {
    name: '2 awaiting input — Go to the next session awaiting input',
    exact: true,
  });
  await expect(
    paneA.locator('[data-web-shell-permission-panel]'),
  ).toBeVisible();
  await expect(paneB.locator('[data-web-shell-ask-panel]')).toBeVisible();
  await expect(pending).toHaveText('2 awaiting input');
  const toolbarHeight = await split
    .locator(':scope > header')
    .evaluate((header) => header.getBoundingClientRect().height);
  await paneA
    .getByRole('button', { name: 'Maximize pane', exact: true })
    .click();
  await expect(paneB).toBeHidden();
  await expect(pending).toBeVisible();
  await pending.click();
  await expect(paneA).toBeHidden();
  await expect(paneB).toBeVisible();
  await expect(paneB).toBeFocused();
  for (const key of [
    'Enter',
    'Control+Enter',
    'Meta+Enter',
    '2',
    '3',
    'Escape',
  ]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(50);
    expect(daemon.permissionRequests()).toHaveLength(0);
  }
  await expect(paneA).toBeVisible();
  await paneB.getByRole('button', { name: 'Collapse', exact: true }).click();
  await pending.click();
  await pending.click();
  await expect(paneB).toBeFocused();
  await expect(paneB.locator('[data-web-shell-ask-option]')).toHaveCount(0);
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(50);
  expect(daemon.permissionRequests()).toHaveLength(0);
  await paneB
    .getByRole('button', { name: 'Maximize pane', exact: true })
    .click();
  await expect(paneB.getByTestId('chat-pane')).toHaveAttribute(
    'data-pane-active',
  );
  expect(daemon.permissionRequests()).toHaveLength(0);
  await pending.click();
  await expect(paneB).toBeHidden();
  await expect(paneA).toBeVisible();
  await expect(paneA).toBeFocused();
  for (const key of ['Enter', '2', '3', 'Escape']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(50);
    expect(daemon.permissionRequests()).toHaveLength(0);
  }
  await expect(paneB).toBeVisible();
  await paneA
    .getByRole('button', { name: 'Maximize pane', exact: true })
    .click();
  await page.mouse.move(0, 0);
  expect(daemon.permissionRequests()).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('split-pending.png') });

  const reject = paneA.locator(
    '[data-web-shell-permission-option][tabindex="0"]',
  );
  await reject.focus();
  await page.keyboard.press('ArrowDown');
  await expect(
    paneA.locator('[data-web-shell-permission-option]').nth(1),
  ).toBeFocused();
  expect(daemon.permissionRequests()).toHaveLength(0);

  await daemon.sse.waitForConnection(SESSION_A);
  await daemon.sendEvent({
    v: 1,
    id: 2,
    type: 'permission_resolved',
    data: {
      requestId: 'split-tool-permission',
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    },
  });
  const onePending = split.getByRole('button', {
    name: '1 awaiting input — Go to the next session awaiting input',
    exact: true,
  });
  await expect(onePending).toHaveText('1 awaiting input');
  await expect(paneB).toBeHidden();
  await onePending.focus();
  await daemon.sendEvent({
    v: 1,
    id: 3,
    type: 'permission_resolved',
    data: {
      requestId: 'split-question-permission',
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    },
  });
  await expect(onePending).toHaveCount(0);
  await expect(split.locator(':scope > header [role="status"]')).toBeEmpty();
  await expect(
    split.getByRole('button', { name: 'back', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(paneB).toBeVisible();
  await paneB.getByRole('button', { name: 'Close pane', exact: true }).click();
  await expect(
    split.getByRole('button', {
      name: 'Go to the next session awaiting input',
    }),
  ).toHaveCount(0);
  await expect(paneA).toBeVisible();
  await expect(paneA.getByTestId('chat-pane')).toHaveAttribute(
    'data-pane-active',
  );
  expect(daemon.permissionRequests()).toHaveLength(0);
  expect(
    await split
      .locator(':scope > header')
      .evaluate((header) => header.getBoundingClientRect().height),
  ).toBe(toolbarHeight);
});

test('keeps title details inside narrow panes in an embedded shell @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installScenario(page, createSplitScenario(), testInfo);
  await page.goto(`/?split=${SESSION_A},${SESSION_B},${MAIN_SESSION}`);
  const root = page.locator('[data-web-shell-root]');
  await expect(page.getByTestId('split-view')).toBeVisible();
  await root.evaluate((element) => {
    element.style.width = '1100px';
    element.style.marginLeft = '40px';
  });
  for (const [id, name] of [
    [SESSION_B, 'Session B'],
    [MAIN_SESSION, 'Main Session'],
  ]) {
    const pane = page.locator(`[data-pane-session-id="${id}"]`);
    await pane.locator('[data-slot="popover-anchor"]').hover();
    const details = page.getByRole('dialog', { name, exact: true });
    await expect(details).toBeVisible();
    await expect
      .poll(async () => {
        const bounds = await details.boundingBox();
        const paneBounds = await pane.boundingBox();
        const rootBounds = await root.boundingBox();
        return (
          bounds &&
          paneBounds &&
          rootBounds &&
          [paneBounds, rootBounds].every(
            (host) =>
              bounds.x >= host.x &&
              bounds.x + bounds.width <= host.x + host.width,
          )
        );
      })
      .toBe(true);
    await page.keyboard.press('Escape');
  }
});
