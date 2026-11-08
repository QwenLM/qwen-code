import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';
import { completeReplay, submitLocalCommand } from './visuals/harness';

const primary = '/tmp/archive-primary';
const secondary = '/tmp/archive-secondary';

for (const touch of [false, true]) {
  test.describe(
    touch ? 'touch archive actions' : 'desktop archive actions',
    () => {
      test.use({
        hasTouch: touch,
        viewport: { width: touch ? 390 : 1440, height: 900 },
      });

      test('exports and restores directly from an archived row @smoke', async ({
        page,
      }, testInfo) => {
        const scenario = createWebShellDaemonScenario({
          workspaceCwd: primary,
          capabilities: {
            features: [
              'session_events',
              'workspace_settings',
              'session_archive',
              'workspace_archived_session_export',
              'workspace_session_metadata',
              'workspace_qualified_rest_core',
            ],
            workspaces: [
              { id: 'primary', cwd: primary, primary: true, trusted: true },
              {
                id: 'secondary',
                cwd: secondary,
                primary: false,
                trusted: true,
              },
            ],
          },
        });
        await installMockDaemon(page, scenario, {
          baseURL: String(testInfo.project.use.baseURL),
        });
        const restored = new Set<string>();
        await page.route(
          /\/workspaces?\/[^/]+\/sessions(?:\?|$)/,
          async (route) => {
            const url = new URL(route.request().url());
            const cwd = decodeURIComponent(url.pathname.split('/')[2]!);
            await route.fulfill({
              json: {
                sessions:
                  url.searchParams.get('archiveState') === 'archived' &&
                  !restored.has(cwd)
                    ? [
                        {
                          sessionId:
                            cwd === primary
                              ? 'archived-primary'
                              : 'archived-secondary',
                          workspaceCwd: cwd,
                          displayName:
                            cwd === primary
                              ? 'Primary archived conversation'
                              : 'Secondary archived conversation',
                          sourceType: 'default',
                          isArchived: true,
                          updatedAt: '2026-10-25T00:00:00Z',
                        },
                      ]
                    : [],
              },
            });
          },
        );
        const exports: string[] = [];
        const restores: Array<{ path: string; body: unknown }> = [];
        await page.route(
          /\/session\/[^/]+\/archive\/export\?/,
          async (route) => {
            exports.push(new URL(route.request().url()).pathname);
            await route.fulfill({
              contentType: 'text/html',
              body: '<html><body>Archived conversation</body></html>',
              headers: {
                'content-disposition': 'attachment; filename="archive.html"',
              },
            });
          },
        );
        await page.route(/\/sessions\/unarchive$/, async (route) => {
          const path = new URL(route.request().url()).pathname;
          const body = route.request().postDataJSON() as {
            sessionIds: string[];
          };
          restores.push({ path, body });
          restored.add(
            body.sessionIds[0] === 'archived-primary' ? primary : secondary,
          );
          await route.fulfill({
            json: {
              unarchived: body.sessionIds,
              alreadyActive: [],
              errors: [],
            },
          });
        });
        await page.goto('/settings?language=en&theme=light');
        await page
          .getByRole('navigation', { name: 'Settings', exact: true })
          .getByRole('button', { name: 'Archived conversations', exact: true })
          .click();
        const archive = page.locator('[data-web-shell-archived-sessions]');
        for (const [cwd, name, id] of [
          [primary, 'Primary archived conversation', 'archived-primary'],
          [secondary, 'Secondary archived conversation', 'archived-secondary'],
        ]) {
          const row = archive
            .locator('[class*="archivedRow"]')
            .filter({ hasText: name });
          await expect(row).toBeVisible();
          await page.mouse.move(0, 0);
          const exportButton = row.getByRole('button', {
            name: 'Export conversation record',
            exact: true,
          });
          const restoreButton = row.getByRole('button', {
            name: 'Restore',
            exact: true,
          });
          await expect(exportButton).toHaveCount(1);
          const actions = exportButton.locator('..');
          if (touch) {
            expect(
              await page.evaluate(
                () => matchMedia('(hover: none) and (pointer: coarse)').matches,
              ),
            ).toBe(true);
            await expect(actions).toHaveCSS('opacity', '1');
          } else {
            await expect(actions).toHaveCSS('opacity', '0');
            await exportButton.focus();
            await expect(actions).toHaveCSS('opacity', '1');
            await page.keyboard.press('Tab');
            await expect(restoreButton).toBeFocused();
            await restoreButton.blur();
            await row.hover();
            await expect(actions).toHaveCSS('opacity', '1');
          }
          await expect(exportButton).toHaveAttribute(
            'title',
            'Export conversation record',
          );
          await expect(restoreButton).toHaveAttribute('title', 'Restore');
          const controls = [
            exportButton,
            restoreButton,
            row.getByRole('button', { name: 'More actions', exact: true }),
          ];
          const boxes = await Promise.all(
            controls.map((control) => control.boundingBox()),
          );
          expect(boxes.every(Boolean)).toBe(true);
          expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(
            boxes[1]!.x,
          );
          expect(boxes[1]!.x + boxes[1]!.width).toBeLessThanOrEqual(
            boxes[2]!.x,
          );
          const rowBox = await row.boundingBox();
          expect(boxes[2]!.x + boxes[2]!.width).toBeLessThanOrEqual(
            rowBox!.x + rowBox!.width,
          );
          await page.screenshot({
            path: testInfo.outputPath(`${id}-actions.png`),
          });
          await controls[2].click();
          const menu = page.getByRole('menu');
          await expect(
            menu.getByRole('menuitem', { name: 'Rename', exact: true }),
          ).toBeVisible();
          await expect(
            menu.getByRole('menuitem', { name: 'Delete', exact: true }),
          ).toBeVisible();
          await expect(
            menu.getByRole('menuitem', { name: /Export|Restore/ }),
          ).toHaveCount(0);
          await page.keyboard.press('Escape');
          const downloadPromise = page.waitForEvent('download');
          if (touch) await exportButton.tap();
          else await exportButton.click();
          expect((await downloadPromise).suggestedFilename()).toBe(
            'archive.html',
          );
          expect(exports.at(-1)).toBe(
            `/workspaces/${encodeURIComponent(cwd)}/session/${id}/archive/export`,
          );
          if (touch) await restoreButton.tap();
          else await restoreButton.click();
          await expect
            .poll(() => restores.length)
            .toBe(cwd === primary ? 1 : 2);
          expect(restores.at(-1)).toEqual({
            path:
              cwd === primary
                ? '/sessions/unarchive'
                : `/workspaces/${encodeURIComponent(cwd)}/sessions/unarchive`,
            body: { sessionIds: [id] },
          });
          await expect(row).toHaveCount(0);
        }
      });
    },
  );
}

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
