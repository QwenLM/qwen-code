import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';
import { completeReplay, submitLocalCommand } from './visuals/harness';

const primary = '/tmp/archive-primary';
const secondary = '/tmp/archive-secondary';

for (const variant of [
  { theme: 'dark', language: 'en', width: 1440 },
  { theme: 'light', language: 'zh-CN', width: 1440 },
  { theme: 'dark', language: 'zh-CN', width: 390 },
  { theme: 'light', language: 'en', width: 390 },
]) {
  test(`archive management lives in Settings ${variant.theme} ${variant.language} ${variant.width} @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: variant.width, height: 900 });
    const scenario = createWebShellDaemonScenario({
      workspaceCwd: primary,
      capabilities: {
        features: [
          'session_events',
          'workspace_settings',
          'session_archive',
          ...(variant.language === 'en' ? ['session_source_metadata'] : []),
          'workspace_qualified_rest_core',
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
    const archiveReads: string[] = [];
    const activeSourceReads: Array<string | null> = [];
    let fail = false;
    await page.route(
      /\/workspaces?\/[^/]+\/sessions(?:\?|$)/,
      async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('archiveState') !== 'archived') {
          activeSourceReads.push(url.searchParams.get('sourceType'));
          await route.fulfill({ json: { sessions: [] } });
          return;
        }
        const cwd = decodeURIComponent(url.pathname.split('/')[2]!);
        archiveReads.push(cwd);
        if (fail) {
          await route.fulfill({
            status: 503,
            json: { error: 'Archive temporarily unavailable' },
          });
          return;
        }
        await route.fulfill({
          json: {
            sessions: [
              {
                sessionId: `archived-${cwd === primary ? 'primary' : 'secondary'}`,
                workspaceCwd: cwd,
                sourceType: url.searchParams.get('sourceType') ?? 'default',
                displayName:
                  url.searchParams.get('sourceType') === 'channel'
                    ? `Channel archive ${cwd === primary ? 'primary' : 'secondary'}`
                    : cwd === primary
                      ? 'Primary archived conversation'
                      : 'Secondary archived conversation',
                isArchived: true,
                updatedAt: '2026-10-25T00:00:00Z',
              },
            ],
          },
        });
      },
    );
    await page.goto(
      `/session/${scenario.sessionId}?theme=${variant.theme}&language=${variant.language}`,
    );
    await completeReplay(page, daemon, scenario.sessionId);
    expect(archiveReads).toHaveLength(0);
    await expect(page.locator('[data-sidebar-shell]')).not.toContainText(
      variant.language === 'en' ? 'Archived' : '已归档',
    );
    await submitLocalCommand(page, '/settings');
    const nav = page.getByRole('navigation', {
      name: variant.language === 'en' ? 'Settings' : '设置',
      exact: true,
    });
    const category = nav.getByRole('button', {
      name: variant.language === 'en' ? 'Archived conversations' : '归档会话',
      exact: true,
    });
    await expect(category).toBeVisible();
    expect(archiveReads).toHaveLength(0);
    await category.click();
    const archive = page.locator('[data-web-shell-archived-sessions]');
    await expect(
      archive.getByText('Primary archived conversation', { exact: true }),
    ).toBeVisible();
    await expect(
      archive.getByText('Secondary archived conversation', { exact: true }),
    ).toBeVisible();
    await expect(archive.getByRole('region')).toHaveCount(2);
    await expect(
      page.getByRole('tab', { name: /^(Workspace|User|工作区|用户)$/ }),
    ).toHaveCount(0);
    const bounds = await archive.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(variant.width);
    await page.screenshot({
      path: `/tmp/qwen-15549-${variant.theme}-${variant.language}-${variant.width}.png`,
    });
    expect(archiveReads.filter((cwd) => cwd === primary)).toHaveLength(1);
    expect(archiveReads.filter((cwd) => cwd === secondary)).toHaveLength(1);
    const count = archiveReads.length;
    await nav.getByRole('button', { name: /^(UI|界面)/ }).click();
    await expect(archive).toHaveCount(0);
    await category.click();
    await expect.poll(() => archiveReads.length).toBe(count + 2);
    await expect(
      archive.getByText('Secondary archived conversation', { exact: true }),
    ).toBeVisible();
    expect(archiveReads).toHaveLength(count + 2);
    if (variant.width === 1440 && variant.language === 'en') {
      fail = true;
      await nav.getByRole('button', { name: /^UI/ }).click();
      await category.click();
      const retry = archive.getByRole('button', { name: /Failed to load/ });
      await expect(retry).toBeVisible();
      fail = false;
      await retry.click();
      await expect(retry).toHaveCount(0);
      await expect(
        archive.getByText('Secondary archived conversation', { exact: true }),
      ).toBeVisible();
    }
    if (variant.language === 'en') {
      await expect(
        archive.getByRole('tablist', {
          name: 'Archived session source',
          exact: true,
        }),
      ).toBeVisible();
      await archive.getByRole('tab', { name: 'Channels', exact: true }).click();
      await expect(
        archive.getByText('Channel archive primary', { exact: true }),
      ).toBeVisible();
      await expect(
        archive.getByText('Channel archive secondary', { exact: true }),
      ).toBeVisible();
      await expect(
        archive.getByText('Primary archived conversation', { exact: true }),
      ).toHaveCount(0);
      expect(activeSourceReads).not.toContain('channel');
    }
  });
}

test('archive management remains reachable without a local workspace @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: ['session_events', 'standalone_sessions_v1'],
      workspaces: [],
    },
    standaloneSessions: [
      {
        sessionId: '33333333-3333-4333-8333-333333333333',
        workspaceCwd: '/tmp/standalone/33333333-3333-4333-8333-333333333333',
        displayName: 'Archived without a project',
        sourceType: 'standalone',
        context: { kind: 'standalone' },
        createdAt: '2026-10-25T00:00:00Z',
        updatedAt: '2026-10-25T00:00:00Z',
        isArchived: true,
      },
    ],
  });
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto('/?language=en');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Settings', exact: true });
  await expect(nav.getByRole('button', { name: /^Model/ })).toHaveCount(0);
  await nav
    .getByRole('button', { name: 'Archived conversations', exact: true })
    .click();
  await expect(
    page.locator('[data-web-shell-archived-sessions]'),
  ).toContainText('Archived without a project');
  await expect(page).toHaveURL(/\/settings/);
  await nav.getByRole('button', { name: /^UI/ }).click();
  await nav
    .getByRole('button', { name: 'Archived conversations', exact: true })
    .click();
  await expect(
    page.locator('[data-web-shell-archived-sessions]'),
  ).toContainText('Archived without a project');
});

test('hides archive management when the daemon has no archive capability @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: ['session_events', 'workspace_qualified_rest_core'],
    },
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await completeReplay(page, daemon, scenario.sessionId);
  await submitLocalCommand(page, '/settings');
  await expect(
    page.getByRole('navigation', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Settings', exact: true })
      .getByRole('button', { name: /^UI/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Archived conversations', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-web-shell-archived-sessions]')).toHaveCount(
    0,
  );
});
