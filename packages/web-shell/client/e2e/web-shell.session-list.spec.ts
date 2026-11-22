import { expect, test } from '@playwright/test';
import { TOUCH_COMPOSER_QUERY } from '../hooks/useIsTouchComposer';
import {
  createSessionListDensityScenario,
  LONG_SESSION_TITLE,
} from './utils/sessionListDensityFixture';
import {
  gotoSession,
  installScenario,
  resolveBaseURL,
} from './visuals/harness';

test('Desktop double-click on a plain session title starts Rename @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createSessionListDensityScenario();
  const daemon = await installScenario(
    page,
    scenario,
    resolveBaseURL(testInfo),
  );
  await gotoSession(page, scenario, daemon, 'dark');
  const sidebar = page.getByRole('complementary', {
    name: 'Workspace sidebar',
  });
  const title = sidebar
    .locator('[data-web-shell-session-title]')
    .filter({ hasText: LONG_SESSION_TITLE });
  await expect(title).toHaveCount(1);
  await expect(title).toHaveCSS('flex-shrink', '1');
  const titleBox = await title.boundingBox();
  if (!titleBox) throw new Error('The desktop session title is not laid out.');
  expect(titleBox.width).toBeGreaterThan(120);
  const actionLayer = title
    .locator('..')
    .locator('div[class*="sessionActions"]');
  await expect(actionLayer).toHaveCSS('opacity', '0');
  await expect(actionLayer).toHaveCSS('pointer-events', 'none');
  await title.hover();
  await expect(actionLayer).toHaveCSS('opacity', '1');
  await expect(actionLayer).toHaveCSS('pointer-events', 'auto');
  const rename = sidebar.getByRole('textbox', { name: /^Rename:/ });
  await expect(rename).toHaveCount(0);
  await title.dblclick();
  await expect(rename).toBeVisible();
  await expect(rename).toHaveValue(LONG_SESSION_TITLE);
});

test('Narrow drawers preserve fine-pointer width and use 85 percent only for touch @smoke', async ({
  page,
  context,
}, testInfo) => {
  const scenario = createSessionListDensityScenario();
  const daemon = await installScenario(
    page,
    scenario,
    resolveBaseURL(testInfo),
  );
  await page.setViewportSize({ width: 400, height: 700 });
  await gotoSession(page, scenario, daemon, 'dark');
  const client = await context.newCDPSession(page);
  const media = async (coarse: boolean) => {
    await client.send('Emulation.setTouchEmulationEnabled', {
      enabled: coarse,
      ...(coarse ? { maxTouchPoints: 1 } : {}),
    });
    await expect
      .poll(() =>
        page.evaluate(
          (query) => matchMedia(query).matches,
          TOUCH_COMPOSER_QUERY,
        ),
      )
      .toBe(coarse);
  };
  await media(false);
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  const sidebar = page.getByRole('complementary', {
    name: 'Workspace sidebar',
  });
  await expect(sidebar).toBeVisible();
  const measure = () =>
    sidebar.evaluate((element) => ({
      sidebar: element.getBoundingClientRect().width,
      drawer: element.parentElement!.getBoundingClientRect().width,
    }));
  const fine = await measure();
  expect(fine.sidebar).toBeCloseTo(
    Math.min(Math.max(fine.drawer * 0.7, 220), 420),
    0,
  );
  await media(true);
  await expect
    .poll(async () => Math.round((await measure()).sidebar))
    .toBe(340);
  await media(false);
  await expect.poll(async () => (await measure()).sidebar).toBe(fine.sidebar);
});
