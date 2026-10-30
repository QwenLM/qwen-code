import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const FEATURES = [
  'session_events',
  'permission_vote',
  'session_permission_vote',
  'session_scope_override',
  'session_source_metadata',
  'workspace_settings',
  'workspace_voice',
  'scheduled_task_gate',
  'autofix_pr_watches',
];

function watch(sessionId: string, over: Record<string, unknown> = {}) {
  return {
    pr: 12,
    repo: 'acme/widgets',
    host: 'github.com',
    url: 'https://github.com/acme/widgets/pull/12',
    headRefName: 'feat/cache',
    headSha: 'a'.repeat(40),
    pushes: 3,
    maxPushes: 10,
    session: sessionId,
    preparedAt: '2026-10-27T08:00:00.000Z',
    lastCheck: new Date(Date.now() - 60_000).toISOString(),
    checkedRecently: true,
    lastRound: new Date(Date.now() - 9 * 60_000).toISOString(),
    stopped: null,
    watch: { every: 2, reply: true, instructions: '', task: 'feedc0ffee12' },
    ended: null,
    needsHuman: [
      {
        sha: 'a'.repeat(40),
        at: '2026-10-27T08:30:00.000Z',
        text: 'Should the cache key include the locale? The reviewer and the issue disagree.',
      },
    ],
    worktreeExists: true,
    fix: {
      attempt: '0123456789ab',
      startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      fresh: true,
    },
    ...over,
  };
}

function task(sessionId: string) {
  return {
    id: 'watch-task',
    name: null,
    cron: '*/2 * * * *',
    prompt: 'Run /autofix-pr tick acme/widgets#12 --task feedc0ffee12',
    gate: '"${QWEN_CODE_CLI:-qwen}" autofix-pr snapshot 12 --gate --repo acme/widgets --host github.com --session web-shell-e2e-session --task feedc0ffee12',
    gateStatus: {
      lastAt: Date.now() - 60_000,
      lastOutcome: 'quiet',
      quietSinceDelivery: 4,
      lastDeliveredAt: Date.now() - 9 * 60_000,
      consecutiveFailures: 0,
    },
    recurring: true,
    enabled: true,
    createdAt: Date.now() - 3_600_000,
    lastFiredAt: Date.now() - 60_000,
    nextRunAt: Date.now() + 60_000,
    sessionId,
    sessionMode: 'persistent',
    modelServiceId: null,
    groupId: null,
    runs: [],
  };
}

async function setup(
  page: Page,
  testInfo: TestInfo,
): Promise<{
  scenario: WebShellDaemonScenario;
  daemon: MockDaemonController;
}> {
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: FEATURES },
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  // Registered after the mock daemon, so these answer first.
  await page.route(`${origin}/autofix-pr/watches`, (route) =>
    route.fulfill({
      json: {
        v: 1,
        available: true,
        root: scenario.capabilities.workspaceCwd,
        now: new Date().toISOString(),
        watches: [
          watch(scenario.sessionId),
          watch('a-terminal-session', {
            pr: 40,
            url: 'https://github.com/acme/widgets/pull/40',
            pushes: 0,
            needsHuman: [],
            fix: null,
            lastRound: null,
            watch: {
              every: 5,
              reply: true,
              instructions: '',
              task: 'abcdefabcdef',
            },
          }),
          watch('gone-session', {
            pr: 7,
            url: 'https://github.com/acme/widgets/pull/7',
            needsHuman: [],
            fix: null,
            stopped: 'merged',
            checkedRecently: false,
          }),
        ],
      },
    }),
  );
  await page.route(`${origin}/scheduled-tasks`, (route) =>
    route.fulfill({ json: { v: 1, tasks: [task(scenario.sessionId)] } }),
  );
  return { scenario, daemon };
}

async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

test('lists the PR watches and stops one in the session that owns it', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const { scenario, daemon } = await setup(page, testInfo);
  await gotoSession(page, scenario, daemon);

  await page.getByRole('button', { name: 'PR watches' }).first().click();
  const pageView = page.getByTestId('pr-watches-page');
  await expect(pageView).toBeVisible();
  const watches = pageView.getByTestId('autofix-pr-watch');
  await expect(watches).toHaveCount(3);
  await expect(watches.nth(0)).toContainText('acme/widgets#12');
  await expect(watches.nth(0)).toContainText(
    'Fixing in the background (6 min)',
  );
  await expect(watches.nth(0)).toContainText('Needs your decision (1)');
  await expect(watches.nth(1)).toContainText(
    'Owned by a session outside this Web Shell',
  );
  await expect(pageView).toContainText('PR merged');
  await watches.nth(0).getByText('Needs your decision (1)').click();
  await page.screenshot({
    path: testInfo.outputPath('01-pr-watches-page.png'),
    fullPage: true,
  });

  await watches.nth(0).getByRole('button', { name: 'Stop watch' }).click();
  await expect
    .poll(() =>
      daemon
        .promptRequests()
        .map((request) => JSON.stringify(request.body ?? null)),
    )
    .toEqual([expect.stringContaining('/autofix-pr stop 12')]);
  expect(daemon.promptRequests()[0]?.path).toContain(
    encodeURIComponent(scenario.sessionId),
  );
});

test("shows a watch's state on its scheduled task's card", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  const { scenario, daemon } = await setup(page, testInfo);
  await gotoSession(page, scenario, daemon);

  await page.getByRole('button', { name: 'Scheduled tasks' }).first().click();
  const card = page.getByTestId('autofix-pr-watch');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('acme/widgets#12');
  await expect(card).toContainText('Pushes 3/10');
  await expect(card.getByRole('button', { name: 'Stop watch' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('02-scheduled-task-card.png'),
    fullPage: true,
  });
});
