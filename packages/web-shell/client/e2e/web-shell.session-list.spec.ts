import { expect, test } from '@playwright/test';
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
  const rename = sidebar.getByRole('textbox', { name: /^Rename:/ });
  await expect(rename).toHaveCount(0);
  await title.dblclick();
  await expect(rename).toBeVisible();
  await expect(rename).toHaveValue(LONG_SESSION_TITLE);
});
