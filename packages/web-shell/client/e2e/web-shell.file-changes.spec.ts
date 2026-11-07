import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

// A simulated daemon verifies UI behavior; real Git is covered by route tests.
for (const onlyNoise of [false, true]) {
  test(`file change cards exclude external and Git-ignored files${onlyNoise ? ' when a turn only contains noise' : ''}`, async ({
    page,
    baseURL,
  }, testInfo) => {
    const cwd = '/tmp/qwen-file-changes';
    const visible = onlyNoise ? [] : ['src/app.ts', 'tracked.log'];
    const paths = [
      ...visible.map((file) => `${cwd}/${file}`),
      `${cwd}/ignored.log`,
      `${cwd}/.qwen/tmp/helper.py`,
      `${cwd}-other/outside.ts`,
      '/Users/example/.qwen/memory/feedback.md',
    ];
    const controlEvents = onlyNoise
      ? [
          userTextEvent('Create a visible control file.', {
            id: paths.length + 4,
          }),
          toolCallEvent(
            'control-write',
            'write_file',
            { file_path: `${cwd}/control.ts`, content: 'control\n' },
            {
              id: paths.length + 5,
              rawOutput: { originalContent: '', newContent: 'control\n' },
            },
          ),
          assistantTextEvent('Control ready.', { id: paths.length + 6 }),
          turnCompleteEvent('control', { id: paths.length + 7 }),
        ]
      : [];
    const scenario = createWebShellDaemonScenario({
      workspaceCwd: cwd,
      events: [
        userTextEvent('Update the project and auxiliary files.', {
          id: 1,
        }),
        ...paths.map((file_path, index) =>
          toolCallEvent(
            `write-${index}`,
            'write_file',
            { file_path, content: 'one line\n' },
            {
              id: index + 2,
              rawOutput: { originalContent: '', newContent: 'one line\n' },
            },
          ),
        ),
        assistantTextEvent('Project updated.', {
          id: paths.length + 2,
        }),
        turnCompleteEvent('file-changes', { id: paths.length + 3 }),
        ...controlEvents,
      ],
    });
    scenario.capabilities.features.push(
      'workspace_git_check_ignore',
      'workspace_qualified_rest_core',
    );
    scenario.transcriptPage = { events: scenario.events, hasMore: false };
    await page.setViewportSize({ width: 1500, height: 1000 });
    await installMockDaemon(page, scenario, { baseURL });
    const batches: string[][] = [];
    const releases: Array<() => void> = [];
    let holdRequests = false;
    await page.route('**/git/check-ignore*', async (route) => {
      const body = route.request().postDataJSON() as { paths: string[] };
      batches.push(body.paths);
      if (holdRequests)
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      await route.fulfill({
        json: { ignoredPaths: ['ignored.log', '.qwen/tmp/helper.py'] },
      });
    });
    await page.goto(`/session/${scenario.sessionId}?lang=en`);
    await expect(
      page.getByText('Project updated.', { exact: true }),
    ).toBeVisible();
    await expect.poll(() => batches.length).toBeGreaterThan(0);
    const rows = page.locator('[class*="fileRow"]');
    await expect(rows).toHaveCount(onlyNoise ? 1 : visible.length);
    await expect
      .poll(() => [...new Set(batches.flat())].sort())
      .toEqual(
        [
          ...visible,
          'ignored.log',
          '.qwen/tmp/helper.py',
          ...(onlyNoise ? ['control.ts'] : []),
        ].sort(),
      );
    expect(batches.flat().every((path) => !path.startsWith('/'))).toBe(true);
    if (!onlyNoise) {
      await expect(
        page.getByText('Edited 2 files', { exact: true }),
      ).toBeVisible();
      await expect(rows).toHaveText(['src/app.ts+1-0', 'tracked.log+1-0']);
      await page.screenshot({
        path: testInfo.outputPath('filtered-card.png'),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Changes', exact: true }).click();
      const reviewRows = page.locator('[class*="reviewRowToggle"]');
      await expect(reviewRows).toHaveCount(2);
      await expect(reviewRows.nth(0)).toHaveAttribute(
        'aria-label',
        `${cwd}/src/app.ts`,
      );
      await expect(reviewRows.nth(1)).toHaveAttribute(
        'aria-label',
        `${cwd}/tracked.log`,
      );
      holdRequests = true;
      await page.reload();
      await expect.poll(() => releases.length).toBeGreaterThan(0);
      await expect(page.locator('[class*="fileRow"]')).toHaveCount(0);
      holdRequests = false;
      for (const release of releases.splice(0)) release();
      await expect(
        page.getByText('Edited 2 files', { exact: true }),
      ).toBeVisible();
      await expect(page.locator('[class*="reviewRowToggle"]')).toHaveCount(2);
    } else {
      await expect(rows).toHaveText(['control.ts+1-0']);
      await expect(page.getByText(/^Edited \d+ files$/)).toHaveCount(1);
    }
  });
}
