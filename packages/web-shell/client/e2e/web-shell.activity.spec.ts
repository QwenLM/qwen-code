import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  thoughtTextEvent,
  type DaemonRequestRecord,
} from './utils/mockDaemon';
import { completeReplay } from './visuals/harness';

const primary = '/tmp/activity-primary';
const secondary = '/tmp/activity-secondary';
type ActivitySession = DaemonSessionSummary;

function row(page: Page, sessionId: string, cwd = primary) {
  return page
    .locator('[data-web-shell-activity]')
    .locator(
      `[data-activity-key=${JSON.stringify(JSON.stringify([cwd, sessionId]))}]`,
    );
}

async function activityFixture(
  page: Page,
  testInfo: TestInfo,
  options: {
    language?: 'en' | 'zh-CN';
    theme?: 'light' | 'dark';
    unavailableCwd?: string;
    extraRows?: number;
    noPreview?: boolean;
  } = {},
) {
  const now = Date.now();
  const stamp = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();
  const make = (
    sessionId: string,
    minutes: number,
    extra: Partial<ActivitySession> = {},
  ): ActivitySession => ({
    sessionId,
    workspaceCwd: primary,
    displayName: sessionId,
    createdAt: stamp(minutes + 10),
    updatedAt: stamp(minutes),
    sourceType: 'default',
    hasActivePrompt: false,
    clientCount: 1,
    ...extra,
  });
  const sessions: ActivitySession[] = [
    make('current-chat', 1),
    make('approval-needed', 60, { isWaitingForPermission: true }),
    make('input-needed', 30, { isWaitingForUserQuestion: true }),
    make('failed-task', 45, { hasTurnError: true }),
    make('unread-result', 5),
    make('running-task', 3, {
      hasActivePrompt: true,
    }),
    make('pinned-result', 10, { isPinned: true, pinnedAt: stamp(10) }),
    make('scheduled-result', 2, {
      sourceId: 'scheduled_task_run:activity-test',
    }),
    make('child-result', 1, { parentSessionId: 'unread-result' }),
    make('archived-result', 1, { isArchived: true }),
    make('old-read-result', 12 * 24 * 60),
    make('old-unread-result', 12 * 24 * 60),
    make('unread-result', 15, { workspaceCwd: secondary }),
    ...Array.from({ length: options.extraRows ?? 0 }, (_, index) =>
      make(`extra-result-${index}`, 20 + index),
    ),
  ];
  const completed = sessions.filter(
    (session) =>
      ['unread-result', 'pinned-result', 'old-unread-result'].includes(
        session.sessionId,
      ) || session.sessionId.startsWith('extra-result-'),
  );
  for (const session of completed) session.hasActivePrompt = true;
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: primary,
    sessionId: 'current-chat',
    displayName: 'current-chat',
    sessions,
    capabilities: {
      sessionLiveStatePollIntervalMs: 250,
      features: [
        'session_events',
        'session_source_metadata',
        'session_organization',
        'workspace_qualified_rest_core',
        'workspace_session_live_state',
        'session_archive',
        'session_archive_idle_guard',
      ],
      workspaces: [
        { id: 'primary', cwd: primary, primary: true, trusted: true },
        { id: 'secondary', cwd: secondary, primary: false, trusted: true },
      ],
    },
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  const organizationWrites: DaemonRequestRecord[] = [];
  const archives: DaemonRequestRecord[] = [];
  const restores: DaemonRequestRecord[] = [];
  const previews: string[] = [];
  const catalogReads: Array<{ cwd: string; failed: boolean }> = [];
  const archiveFailures = new Set<string>();
  const unavailable = new Set<string>(
    options.unavailableCwd ? [options.unavailableCwd] : [],
  );
  let revision = 1;
  await page.route(/\/workspaces?\/[^/]+\/sessions(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const cwd = decodeURIComponent(url.pathname.split('/')[2]!);
    catalogReads.push({ cwd, failed: unavailable.has(cwd) });
    if (unavailable.has(cwd)) {
      await route.fulfill({
        status: 503,
        json: { error: 'Fixture unavailable' },
      });
      return;
    }
    const archived = url.searchParams.get('archiveState') === 'archived';
    const pinned = url.searchParams.get('group') === 'pinned';
    await route.fulfill({
      json: {
        sessions: sessions.filter(
          (session) =>
            session.workspaceCwd === cwd &&
            Boolean(session.isArchived) === archived &&
            (!pinned || session.isPinned),
        ),
      },
    });
  });
  await page.route(
    /\/workspaces\/[^/]+\/sessions\/live-state(?:\?|$)/,
    async (route) => {
      const cwd = decodeURIComponent(
        new URL(route.request().url()).pathname.split('/')[2]!,
      );
      await route.fulfill({
        json: {
          v: 1,
          catalogVersion: { generation: 'activity-fixture', revision },
          sessions: sessions.filter(
            (session) => session.workspaceCwd === cwd && !session.isArchived,
          ),
        },
      });
    },
  );
  await page.route(/\/workspace\/models$/, (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.route(
    /\/(?:workspaces\/[^/]+\/)?session\/[^/]+\/organization$/,
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.postDataJSON() as { isPinned?: boolean };
      organizationWrites.push({
        method: request.method(),
        path,
        body,
        headers: request.headers(),
      });
      const qualified = path.startsWith('/workspaces/');
      const parts = path.split('/');
      const cwd = qualified ? decodeURIComponent(parts[2]!) : primary;
      const id = decodeURIComponent(parts[qualified ? 4 : 2]!);
      const session = sessions.find(
        (item) => item.workspaceCwd === cwd && item.sessionId === id,
      );
      if (
        session &&
        typeof body.isPinned === 'boolean' &&
        Object.keys(body).length === 1
      ) {
        session.isPinned = body.isPinned;
        session.pinnedAt = body.isPinned ? new Date().toISOString() : undefined;
        revision++;
        await route.fulfill({
          json: {
            sessionId: id,
            isPinned: session.isPinned,
            pinnedAt: session.pinnedAt,
            groupId: null,
            color: null,
          },
        });
      } else {
        await route.fulfill({
          status: 500,
          json: { error: 'Unexpected organization write' },
        });
      }
    },
  );
  await page.route(
    /\/workspaces\/[^/]+\/session\/[^/]+\/transcript(?:\?|$)/,
    async (route) => {
      const url = new URL(route.request().url());
      const sessionId = decodeURIComponent(url.pathname.split('/')[4]!);
      previews.push(url.pathname + url.search);
      await route.fulfill({
        json: {
          v: 1,
          sessionId,
          hasMore: false,
          events: options.noPreview
            ? []
            : [
                thoughtTextEvent('Private analysis must not appear in preview'),
                assistantTextEvent(`Assistant preview for ${sessionId}`),
              ],
        },
      });
    },
  );
  await page.route(
    /\/workspaces\/[^/]+\/sessions\/(archive|unarchive)$/,
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const cwd = decodeURIComponent(path.split('/')[2]!);
      const body = request.postDataJSON() as { sessionIds: string[] };
      const restoring = path.endsWith('/unarchive');
      (restoring ? restores : archives).push({
        method: request.method(),
        path,
        body,
        headers: request.headers(),
      });
      const succeeded: string[] = [];
      const errors: Array<{ sessionId: string; error: string }> = [];
      for (const sessionId of body.sessionIds) {
        const session = sessions.find(
          (item) => item.workspaceCwd === cwd && item.sessionId === sessionId,
        );
        if (!session || (!restoring && archiveFailures.has(sessionId))) {
          errors.push({ sessionId, error: 'Fixture archive failure' });
        } else {
          session.isArchived = !restoring;
          session.hasActivePrompt = false;
          succeeded.push(sessionId);
        }
      }
      revision++;
      await route.fulfill({
        json: restoring
          ? { unarchived: succeeded, alreadyActive: [], notFound: [], errors }
          : { archived: succeeded, alreadyArchived: [], notFound: [], errors },
      });
    },
  );
  await page.goto(
    `/session/current-chat?language=${options.language ?? 'en'}&theme=${options.theme ?? 'light'}`,
  );
  await completeReplay(page, daemon, 'current-chat');
  await expect(
    page.getByRole('button', {
      name: options.language === 'zh-CN' ? '查看活动' : 'View activity',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: options.language === 'zh-CN' ? '查看活动' : 'View activity',
      exact: true,
    })
    .click();
  await expect(
    row(page, 'unread-result').locator('[data-web-shell-session-running]'),
  ).toBeVisible();
  for (const session of completed) session.hasActivePrompt = false;
  revision++;
  if (!options.unavailableCwd)
    await expect(
      row(page, 'unread-result').locator(
        '[data-web-shell-session-completed-unread]',
      ),
    ).toBeVisible();
  else
    await expect(
      row(page, 'unread-result').locator('[data-web-shell-session-running]'),
    ).toHaveCount(0);
  await page.keyboard.press('Escape');
  previews.length = 0;
  return {
    sessions,
    organizationWrites,
    archives,
    restores,
    previews,
    archiveFailures,
    unavailable,
    catalogReads,
  };
}

async function openActivity(page: Page) {
  await page
    .getByRole('button', { name: 'View activity', exact: true })
    .click();
  await expect(page.locator('[data-web-shell-activity]')).toBeVisible();
  await expect(row(page, 'input-needed')).toBeVisible();
}

async function openOptions(page: Page) {
  await page
    .getByRole('button', { name: 'Activity options', exact: true })
    .click();
}

for (const height of [1200, 720, 420]) {
  test(`activity reuses normal session row geometry, selection and idle status at ${height}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height });
    await activityFixture(page, testInfo, { noPreview: true });
    const normalCurrent = page
      .locator('[data-web-shell-session-title]')
      .filter({ hasText: /^current-chat$/ })
      .locator('xpath=ancestor::*[@role="button"][1]')
      .first();
    await expect(normalCurrent).toBeVisible();
    await expect(normalCurrent).toHaveAttribute('aria-current', 'page');
    const { scroll: beforeScroll, ...before } = await normalCurrent.evaluate(
      (element) => {
        const box = element.getBoundingClientRect();
        const sidebar = element.closest('aside')!.getBoundingClientRect();
        let scrollPort = element.parentElement!;
        while (
          !['auto', 'scroll'].includes(getComputedStyle(scrollPort).overflowY)
        )
          scrollPort = scrollPort.parentElement!;
        const style = getComputedStyle(scrollPort);
        return {
          className: element.className,
          height: box.height,
          x: box.x,
          width: box.width,
          right: box.right,
          sidebarRight: sidebar.right,
          rightGap: sidebar.right - box.right,
          background: getComputedStyle(element).backgroundColor,
          selectionMarker: getComputedStyle(element, '::before')
            .backgroundColor,
          scroll: {
            overflowing: scrollPort.scrollHeight > scrollPort.clientHeight,
            clientHeight: scrollPort.clientHeight,
            scrollHeight: scrollPort.scrollHeight,
            clientWidth: scrollPort.clientWidth,
            gutter: style.scrollbarGutter,
            paddingRight: style.paddingRight,
          },
        };
      },
    );
    const normalHeader = await page
      .getByRole('button', { name: 'Pinned', exact: true })
      .boundingBox();
    const newSession = await page
      .getByRole('button', { name: 'New session', exact: true })
      .filter({ hasText: 'New session' })
      .boundingBox();
    await page.screenshot({
      path: testInfo.outputPath(`activity-normal-row-baseline-${height}.png`),
      animations: 'disabled',
    });
    await openActivity(page);
    const current = row(page, 'current-chat')
      .locator('[role="button"]')
      .first();
    await expect(current).toHaveAttribute('aria-current', 'page');
    const { scroll: afterScroll, ...after } = await current.evaluate(
      (element) => {
        const box = element.getBoundingClientRect();
        const sidebar = element.closest('aside')!.getBoundingClientRect();
        let scrollPort = element.parentElement!;
        while (
          !['auto', 'scroll'].includes(getComputedStyle(scrollPort).overflowY)
        )
          scrollPort = scrollPort.parentElement!;
        const style = getComputedStyle(scrollPort);
        return {
          className: element.className,
          height: box.height,
          x: box.x,
          width: box.width,
          right: box.right,
          sidebarRight: sidebar.right,
          rightGap: sidebar.right - box.right,
          background: getComputedStyle(element).backgroundColor,
          selectionMarker: getComputedStyle(element, '::before')
            .backgroundColor,
          scroll: {
            overflowing: scrollPort.scrollHeight > scrollPort.clientHeight,
            clientHeight: scrollPort.clientHeight,
            scrollHeight: scrollPort.scrollHeight,
            clientWidth: scrollPort.clientWidth,
            gutter: style.scrollbarGutter,
            paddingRight: style.paddingRight,
          },
        };
      },
    );
    expect(after).toEqual(before);
    expect(beforeScroll.gutter).toBe('stable');
    expect(afterScroll.gutter).toBe('stable');
    if (height === 1200) {
      expect(beforeScroll.overflowing).toBe(false);
      expect(afterScroll.overflowing).toBe(false);
    }
    if (height === 420) {
      expect(beforeScroll.overflowing).toBe(true);
      expect(afterScroll.overflowing).toBe(true);
    }
    await expect(current.locator('[class*="sessionStatusDot"]')).toHaveCount(0);
    await expect(current.locator('[data-state="idle"]')).toHaveCount(0);
    await expect(current).not.toContainText('activity-primary');
    const activityHeader = await page
      .getByRole('button', { name: 'Priority', exact: true })
      .boundingBox();
    await testInfo.attach('shared-row-metrics', {
      body: JSON.stringify(
        {
          before,
          after,
          beforeScroll,
          afterScroll,
          normalHeader,
          activityHeader,
          newSession,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    expect(activityHeader!.x).toBe(normalHeader!.x);
    expect(
      (await page
        .getByRole('button', { name: 'New session', exact: true })
        .filter({ hasText: 'New session' })
        .boundingBox())!.x,
    ).toBe(newSession!.x);
    await page.screenshot({
      path: testInfo.outputPath(`activity-shared-row-parity-${height}.png`),
      animations: 'disabled',
    });
  });
}

test('activity rows share hover details, scoped pin actions and the normal session menu', async ({
  page,
}, testInfo) => {
  const fixture = await activityFixture(page, testInfo);
  await openActivity(page);
  const primaryRow = row(page, 'unread-result');
  const secondaryRow = row(page, 'unread-result', secondary);
  await expect(
    primaryRow.locator('[class*="sessionSearchSnippet"]'),
  ).toContainText('Assistant preview for unread-result');
  await expect(primaryRow).not.toContainText('activity-primary');
  await primaryRow.locator('[data-web-shell-session-title]').hover();
  const details = page.locator('[data-web-shell-session-details-content]');
  await expect(details).toContainText(primary);
  await expect(details.locator('[data-web-shell-session-id]')).toHaveText(
    'unread-result',
  );
  await page.screenshot({
    path: testInfo.outputPath('activity-shared-hover-details.png'),
    animations: 'disabled',
  });
  await secondaryRow.locator('[data-web-shell-session-title]').hover();
  await expect(details).toContainText(secondary);
  await expect(details).not.toContainText(primary);
  await secondaryRow.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect.poll(() => fixture.organizationWrites.length).toBe(1);
  expect(decodeURIComponent(fixture.organizationWrites[0]!.path)).toContain(
    secondary,
  );
  expect(fixture.organizationWrites[0]!.body).toEqual({ isPinned: true });
  await expect(
    secondaryRow.getByRole('button', { name: 'Unpin', exact: true }),
  ).toBeVisible();
  await expect(
    primaryRow.getByRole('button', { name: 'Pin', exact: true }),
  ).toBeAttached();
  await secondaryRow
    .getByRole('button', { name: 'More actions', exact: true })
    .click();
  await expect(
    page.getByRole('menuitem', { name: 'Archive', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Close activity view', exact: true })
    .click();
  await expect(page.locator('[data-web-shell-activity]')).toHaveCount(0);
  const ordinaryPinned = page
    .locator('[data-web-shell-session-title]')
    .filter({ hasText: /^unread-result$/ })
    .locator('xpath=ancestor::*[@role="button"][1]')
    .filter({ has: page.getByRole('button', { name: 'Unpin', exact: true }) })
    .first();
  await ordinaryPinned.hover();
  await expect(
    ordinaryPinned.getByRole('button', { name: 'Unpin', exact: true }),
  ).toBeVisible();
});

test('activity ranks attention, previews assistants and keeps source identities @smoke', async ({
  page,
}, testInfo) => {
  const fixture = await activityFixture(page, testInfo);
  await expect(
    page.locator('[data-web-shell-session-completed-unread]').first(),
  ).toBeVisible();
  await openActivity(page);
  const activity = page.locator('[data-web-shell-activity]');
  const priority = activity.locator('[data-activity-section="priority"]');
  await expect(priority.locator('[data-activity-key]')).toHaveCount(8);
  expect(
    await priority
      .locator('[data-activity-key]')
      .evaluateAll((rows) =>
        rows.map(
          (element) =>
            JSON.parse(element.getAttribute('data-activity-key')!)[1],
        ),
      ),
  ).toEqual([
    'input-needed',
    'failed-task',
    'approval-needed',
    'unread-result',
    'pinned-result',
    'unread-result',
    'old-unread-result',
    'running-task',
  ]);
  await expect(row(page, 'unread-result', secondary)).toBeVisible();
  await expect(row(page, 'old-read-result')).toHaveCount(0);
  await expect(row(page, 'scheduled-result')).toHaveCount(0);
  await expect(row(page, 'child-result')).toHaveCount(0);
  await expect(row(page, 'archived-result')).toHaveCount(0);
  await expect(row(page, 'input-needed')).toContainText(
    'Assistant preview for input-needed',
  );
  await expect(activity).not.toContainText('Private analysis');
  expect(fixture.organizationWrites).toHaveLength(0);
  expect(
    fixture.previews.every(
      (url) => new URL(url, 'http://fixture').searchParams.get('limit') === '5',
    ),
  ).toBe(true);
  await openOptions(page);
  await expect(
    page.getByRole('menuitemcheckbox', {
      name: 'Priority section',
      exact: true,
    }),
  ).toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath('activity-light-options.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
});

test('activity clears shared in-memory unread state without writes and keeps the open snapshot', async ({
  page,
}, testInfo) => {
  const fixture = await activityFixture(page, testInfo);
  await openActivity(page);
  const priorityRows = page.locator(
    '[data-activity-section="priority"] [data-activity-key]',
  );
  const before = await priorityRows.evaluateAll((rows) =>
    rows.map((element) => element.getAttribute('data-activity-key')),
  );
  await openOptions(page);
  await page
    .getByRole('menuitem', { name: 'Mark all as read', exact: true })
    .click();
  await expect(
    row(page, 'unread-result').locator(
      '[data-web-shell-session-completed-unread]',
    ),
  ).toHaveCount(0);
  expect(fixture.organizationWrites).toHaveLength(0);
  expect(
    await priorityRows.evaluateAll((rows) =>
      rows.map((element) => element.getAttribute('data-activity-key')),
    ),
  ).toEqual(before);
  await openOptions(page);
  await page
    .getByRole('menuitem', { name: 'Clear read chats', exact: true })
    .click();
  await expect(priorityRows).toHaveCount(4);
  await expect(
    page.locator('[data-activity-section="priority"]'),
  ).not.toContainText('old-unread-result');
  await page
    .getByRole('button', { name: 'Close activity view', exact: true })
    .click();
  await expect(
    page.locator('[data-web-shell-session-completed-unread]'),
  ).toHaveCount(0);
  await page.reload();
  await openActivity(page);
  await expect(priorityRows).toHaveCount(4);
});

test('activity forgets unread completions after reload instead of treating history as unread', async ({
  page,
}, testInfo) => {
  const fixture = await activityFixture(page, testInfo);
  await openActivity(page);
  await expect(
    row(page, 'unread-result').locator(
      '[data-web-shell-session-completed-unread]',
    ),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await openActivity(page);
  await expect(
    page.locator('[data-activity-section="priority"] [data-activity-key]'),
  ).toHaveCount(4);
  await expect(
    row(page, 'unread-result').locator(
      '[data-web-shell-session-completed-unread]',
    ),
  ).toHaveCount(0);
  await expect(row(page, 'old-unread-result')).toHaveCount(0);
  expect(fixture.organizationWrites).toHaveLength(0);
});

test('activity filters pinned and scheduled rows and toggles with keyboard', async ({
  page,
}, testInfo) => {
  await activityFixture(page, testInfo);
  await page.keyboard.press('Control+Alt+u');
  await expect(page.locator('[data-web-shell-activity]')).toBeVisible();
  await openOptions(page);
  await page
    .getByRole('menuitemcheckbox', { name: 'Pinned', exact: true })
    .click();
  await expect(page.locator('[data-activity-section="pinned"]')).toContainText(
    'pinned-result',
  );
  await expect(
    page.locator('[data-activity-section="priority"]'),
  ).not.toContainText('pinned-result');
  await openOptions(page);
  await page
    .getByRole('menuitemcheckbox', { name: 'Scheduled tasks', exact: true })
    .click();
  await expect(row(page, 'scheduled-result')).toBeVisible();
  await expect(row(page, 'pinned-result')).toHaveCount(1);
  await page.screenshot({
    path: testInfo.outputPath('activity-pinned-scheduled.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-web-shell-activity]')).toHaveCount(0);
  await page.keyboard.press('Control+Alt+u');
  await expect(row(page, 'scheduled-result')).toBeVisible();
});

test('activity shares the normal pinned fold state and keeps options on a folded section', async ({
  page,
}, testInfo) => {
  await activityFixture(page, testInfo);
  const normalPinned = page.getByRole('button', {
    name: 'Pinned',
    exact: true,
  });
  await expect(normalPinned).toHaveAttribute('aria-expanded', 'true');
  await normalPinned.click();
  await openActivity(page);
  const activity = page.locator('[data-web-shell-activity]');
  await expect(
    activity.getByRole('heading', { name: 'Activity', exact: true }),
  ).toHaveCount(0);
  await openOptions(page);
  await page
    .getByRole('menuitemcheckbox', { name: 'Pinned', exact: true })
    .click();
  const pinned = activity.locator('[data-activity-section="pinned"]');
  await expect(
    pinned.getByRole('button', { name: 'Pinned', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'pinned-result')).toHaveCount(0);
  await pinned.getByRole('button', { name: 'Pinned', exact: true }).click();
  await expect(row(page, 'pinned-result')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(normalPinned).toHaveAttribute('aria-expanded', 'true');
  await normalPinned.click();
  await openActivity(page);
  await expect(
    pinned.getByRole('button', { name: 'Pinned', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  const priority = activity.locator('[data-activity-section="priority"]');
  await priority.getByRole('button', { name: 'Priority', exact: true }).click();
  await expect(
    priority.getByRole('button', { name: 'Priority', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(priority.locator('[data-activity-key]')).toHaveCount(0);
  await expect(
    priority.getByRole('button', { name: 'Activity options', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('activity-folded-priority-pinned.png'),
    animations: 'disabled',
  });
});

test('activity moves options between section headers and resets with the header icon keyboard action', async ({
  page,
}, testInfo) => {
  await activityFixture(page, testInfo);
  await openActivity(page);
  const activity = page.locator('[data-web-shell-activity]');
  const options = { name: 'Activity options', exact: true };
  await expect(
    activity
      .locator('[data-activity-section="priority"]')
      .getByRole('button', options),
  ).toBeVisible();
  await openOptions(page);
  await expect(
    page.getByRole('menuitem', { name: 'Reset display options', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('menuitemcheckbox', { name: 'Pinned', exact: true })
    .click();
  await openOptions(page);
  await page
    .getByRole('menuitemcheckbox', { name: 'Priority section', exact: true })
    .click();
  await expect(
    activity
      .locator('[data-activity-section="pinned"]')
      .getByRole('button', options),
  ).toBeVisible();
  await openOptions(page);
  await page
    .getByRole('menuitemcheckbox', { name: 'Pinned', exact: true })
    .click();
  await expect(
    activity
      .locator('[data-activity-section="recent"]')
      .first()
      .getByRole('button', options),
  ).toBeVisible();
  await openOptions(page);
  const reset = page.getByRole('menuitem', {
    name: 'Reset display options',
    exact: true,
  });
  await expect(reset).toHaveText('');
  await expect(reset.locator('..')).toContainText('Display');
  await page.screenshot({
    path: testInfo.outputPath('activity-reset-display-icon.png'),
    animations: 'disabled',
  });
  await reset.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(reset).toHaveCount(0);
  await expect(
    page.getByRole('menuitemcheckbox', {
      name: 'Priority section',
      exact: true,
    }),
  ).toBeFocused();
  await expect(
    page.getByRole('menuitemcheckbox', {
      name: 'Priority section',
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole('menuitemcheckbox', { name: 'Pinned', exact: true }),
  ).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(
    activity
      .locator('[data-activity-section="priority"]')
      .getByRole('button', options),
  ).toBeVisible();
});

test('activity archives only priority, retains failures and supports undo', async ({
  page,
}, testInfo) => {
  const fixture = await activityFixture(page, testInfo);
  fixture.archiveFailures.add('failed-task');
  await openActivity(page);
  await openOptions(page);
  await page
    .getByRole('menuitemcheckbox', { name: 'Pinned', exact: true })
    .click();
  await openOptions(page);
  await page
    .getByRole('menuitem', { name: 'Archive chats', exact: true })
    .click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation).toContainText('Recent');
  await confirmation
    .getByRole('button', { name: 'Stop and archive', exact: true })
    .click();
  await expect.poll(() => fixture.archives.length).toBeGreaterThan(0);
  await expect(row(page, 'running-task')).toHaveCount(0);
  await expect(row(page, 'failed-task')).toBeVisible();
  await expect(row(page, 'pinned-result')).toBeVisible();
  expect(
    fixture.archives.flatMap(
      (request) => (request.body as { sessionIds: string[] }).sessionIds,
    ),
  ).not.toContain('current-chat');
  expect(
    fixture.archives.flatMap(
      (request) => (request.body as { sessionIds: string[] }).sessionIds,
    ),
  ).not.toContain('pinned-result');
  expect(
    fixture.archives.some((request) =>
      decodeURIComponent(request.path).includes(secondary),
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row(page, 'running-task')).toBeVisible();
  expect(
    fixture.sessions.find((session) => session.sessionId === 'running-task')
      ?.hasActivePrompt,
  ).toBe(false);
  expect(fixture.restores.length).toBeGreaterThan(0);
});

test('activity shows partial source failure and retries without losing healthy rows', async ({
  page,
}, testInfo) => {
  const fixture = await activityFixture(page, testInfo, {
    unavailableCwd: secondary,
  });
  await openActivity(page);
  const activity = page.locator('[data-web-shell-activity]');
  await expect(activity.getByRole('alert')).toContainText(
    'Some conversations are unavailable.',
  );
  await expect(row(page, 'input-needed')).toBeVisible();
  await expect(row(page, 'unread-result', secondary)).toHaveCount(0);
  fixture.unavailable.clear();
  await activity.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect
    .poll(
      () =>
        fixture.catalogReads.filter(
          (read) => read.cwd === secondary && !read.failed,
        ).length,
    )
    .toBeGreaterThan(0);
  await expect(row(page, 'unread-result', secondary)).toBeVisible();
  await expect(activity.getByRole('alert')).toHaveCount(0);
});

test('activity uses one ten-row budget and previews only displayed rows', async ({
  page,
}, testInfo) => {
  const fixture = await activityFixture(page, testInfo, { extraRows: 15 });
  await openActivity(page);
  const activity = page.locator('[data-web-shell-activity]');
  await expect(activity.locator('[data-activity-key]')).toHaveCount(10);
  expect(new Set(fixture.previews).size).toBeLessThanOrEqual(10);
  await activity
    .getByRole('button', { name: 'Show more', exact: true })
    .click();
  await expect(activity.locator('[data-activity-key]')).toHaveCount(20);
  await activity
    .getByRole('button', { name: 'Show more', exact: true })
    .click();
  await expect(activity.locator('[data-activity-key]')).toHaveCount(24);
  await expect(
    activity.getByRole('button', { name: 'Show more', exact: true }),
  ).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`activity Chinese ${theme} sidebar and menu remain usable`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await activityFixture(page, testInfo, { language: 'zh-CN', theme });
    await page.getByRole('button', { name: '查看活动', exact: true }).click();
    const activity = page.locator('[data-web-shell-activity]');
    await expect(row(page, 'input-needed')).toContainText(
      'Assistant preview for input-needed',
    );
    await page.screenshot({
      path: testInfo.outputPath(`activity-${theme}-zh-CN-list.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '活动选项', exact: true }).click();
    await expect(
      page.getByRole('menuitemcheckbox', { name: '优先处理分区', exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole('menuitem', { name: '归档优先处理聊天', exact: true }),
    ).toBeVisible();
    const activityBox = await activity
      .locator('[role="button"]')
      .first()
      .boundingBox();
    const menuBox = await page.getByRole('menu').boundingBox();
    expect(activityBox).not.toBeNull();
    expect(activityBox!.x).toBeGreaterThanOrEqual(0);
    expect(activityBox!.x + activityBox!.width).toBeLessThanOrEqual(1280);
    expect(menuBox).not.toBeNull();
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(1280);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(1000);
    await page.screenshot({
      path: testInfo.outputPath(`activity-${theme}-zh-CN.png`),
      animations: 'disabled',
    });
    await page
      .getByRole('menuitemcheckbox', { name: '置顶', exact: true })
      .click();
    await page.getByRole('button', { name: '活动选项', exact: true }).click();
    const reset = page.getByRole('menuitem', {
      name: '恢复默认显示选项',
      exact: true,
    });
    await expect(reset).toBeVisible();
    await expect(reset.locator('..')).toContainText('显示');
    await page.screenshot({
      path: testInfo.outputPath(`activity-${theme}-zh-CN-reset.png`),
      animations: 'disabled',
    });
  });
}
