import { expect, test } from '@playwright/test';

const springUrl = process.env['W0D_SPRING_URL'];

test.skip(
  !springUrl,
  'Start WorkspaceBrowserFixtureMain and set W0D_SPRING_URL',
);

test('creates a fixed empty Session against Spring and SQL at desktop and mobile widths', async ({
  page,
}) => {
  let dropNextCreate = false;
  const createRequests: unknown[] = [];
  const createdIds: string[] = [];
  await page.route('**/api/agent/web-shell/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events/stream')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
      return;
    }
    if (path.endsWith('/sessions/create')) {
      createRequests.push(route.request().postDataJSON());
    }
    const response = await route.fetch({
      url: new URL(path, springUrl!).toString(),
    });
    if (path.endsWith('/sessions/create')) {
      const admission = await response.json();
      createdIds.push(admission.sessionId as string);
      if (dropNextCreate) {
        dropNextCreate = false;
        await route.abort('failed');
        return;
      }
    }
    await route.fulfill({ response });
  });

  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.goto('/e2e/fixtures/managed-workspace-w0d.html');
    await expect(
      page.getByRole('button', { name: 'Create session' }),
    ).toBeEnabled();
    await page.getByRole('combobox', { name: 'Workspace' }).click();
    await expect(
      page.getByRole('option', { name: /Restricted Workspace/ }),
    ).toBeDisabled();
    await expect(
      page.getByRole('option', { name: /Hidden Workspace/ }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByLabel('Relative directory').fill('services/./api');
    if (size.width === 390) dropNextCreate = true;
    await page.getByRole('button', { name: 'Create session' }).click();
    if (size.width === 390) {
      await expect(
        page.getByText('Creation is unconfirmed', { exact: false }),
      ).toBeVisible();
      await page.reload();
      await page
        .getByRole('button', { name: 'Retry the same request' })
        .click();
    }
    await expect(
      page.locator('[data-managed-workspace-binding]'),
    ).toContainText('services/api');
    await expect(
      page.locator('[data-managed-workspace-binding]'),
    ).toContainText('ws-default');
    if (size.width === 390) {
      expect(createRequests[2]).toEqual(createRequests[1]);
      expect(createdIds[2]).toBe(createdIds[1]);
    }
    await expect(page.locator('[data-managed-progress]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel turn' })).toHaveCount(
      0,
    );
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
