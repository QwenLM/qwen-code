import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const PRS_FEATURE = 'workspace_github_prs';

const OPEN_PRS = [
  {
    number: 42,
    title: 'Fix the flaky integration test',
    url: 'https://github.com/o/r/pull/42',
    author: 'octocat',
    headRefName: 'fix/flaky-test',
    state: 'open' as const,
    reviewDecision: 'approved' as const,
    checks: 'passing' as const,
    updatedAt: 1_800_000_000,
  },
  {
    number: 7,
    title: 'WIP: rewrite the parser',
    url: 'https://github.com/o/r/pull/7',
    author: 'hubot',
    headRefName: 'wip/parser',
    state: 'draft' as const,
    reviewDecision: 'changes_requested' as const,
    checks: 'failing' as const,
    updatedAt: 1_800_000_100,
  },
];

function prsScenario(
  overrides: Parameters<typeof createWebShellDaemonScenario>[0] = {},
) {
  return createWebShellDaemonScenario({
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'workspace_settings',
        PRS_FEATURE,
      ],
    },
    gitHubPrs: {
      v: 1,
      workspaceCwd: '/workspace',
      available: true,
      pullRequests: OPEN_PRS,
    },
    ...overrides,
  });
}

test('opens the Pull requests tab via /prs and renders the list @smoke', async ({
  page,
}, testInfo) => {
  const scenario = prsScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  await submitLocalCommand(page, '/prs');

  const dialog = page.locator('[data-web-shell-dialog]');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#git-dialog-tab-prs')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(dialog).toContainText('Fix the flaky integration test');
  await expect(dialog).toContainText('#42');
  await expect(dialog).toContainText('WIP: rewrite the parser');
  await expect(dialog).toContainText('Approved');
  await expect(dialog).toContainText('Changes requested');
});

test('switches between the Changes, History, and Pull requests tabs @smoke', async ({
  page,
}, testInfo) => {
  const scenario = prsScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  await submitLocalCommand(page, '/prs');
  await expect(page.locator('#git-dialog-tab-prs')).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await page.locator('#git-dialog-tab-diff').click();
  await expect(page.locator('#git-dialog-tab-diff')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#git-dialog-tab-prs')).toHaveAttribute(
    'aria-selected',
    'false',
  );

  await page.locator('#git-dialog-tab-prs').click();
  await expect(page.locator('#git-dialog-tab-prs')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('[data-web-shell-dialog]')).toContainText(
    'Fix the flaky integration test',
  );
});

test('shows the not-a-repository state when the daemon reports unavailable @smoke', async ({
  page,
}, testInfo) => {
  const scenario = prsScenario({
    gitHubPrs: {
      v: 1,
      workspaceCwd: '/workspace',
      available: false,
      pullRequests: [],
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  await submitLocalCommand(page, '/prs');

  await expect(page.locator('[data-web-shell-dialog]')).toContainText(
    'This workspace is not a git repository',
  );
});

test('hides the Pull requests tab when the daemon lacks the capability @smoke', async ({
  page,
}, testInfo) => {
  const scenario = prsScenario({
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'workspace_settings',
      ],
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  // /diff still opens the dialog, but the PR tab must not be offered.
  await submitLocalCommand(page, '/diff');
  await expect(page.locator('[data-web-shell-dialog]')).toBeVisible();
  await expect(page.locator('#git-dialog-tab-prs')).toHaveCount(0);
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

async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

async function submitLocalCommand(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
  );
  await page.keyboard.type(text);
  await page.locator('[data-web-shell-composer-submit]').click();
}
