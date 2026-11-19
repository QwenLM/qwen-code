import { expect, test } from '@playwright/test';
import { createGitWorkspaceScenario } from './utils/gitScenario';
import { installMockDaemon } from './utils/mockDaemon';

test('wraps long lines inside the Changes panel @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario();
  const longLine = '    ' + 'x'.repeat(240);
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.route('**/git/diff/file?**', (route) =>
    route.fulfill({
      json: {
        v: 1,
        available: true,
        workspaceCwd: scenario.workspaceCwd,
        path: 'src/foo.ts',
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-short', '+' + longLine],
          },
        ],
      },
    }),
  );

  await page.goto('/session/' + encodeURIComponent(scenario.sessionId), {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('[data-web-shell-environment-toggle]').click();
  await page
    .getByTestId('environment-panel')
    .getByRole('button', { name: /Changes/ })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /src\/foo\.ts/ }).click();
  const content = dialog.locator('code').filter({ hasText: longLine.trim() });
  await expect(content).toBeVisible();
  await page.setViewportSize({ width: 560, height: 760 });
  expect(await content.innerText()).toBe(longLine);
  const layout = await content.evaluate((line) => ({
    fits: line.scrollWidth <= line.clientWidth,
    wraps: line.clientHeight > parseFloat(getComputedStyle(line).lineHeight),
  }));
  expect(layout).toEqual({ fits: true, wraps: true });
});
