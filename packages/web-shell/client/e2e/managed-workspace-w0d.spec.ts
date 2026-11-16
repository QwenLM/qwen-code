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
  const createRequests: Array<{
    body: unknown;
    idempotencyKey: string | undefined;
  }> = [];
  const createdIds: string[] = [];
  await page.route('**/v1/agents/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const isCreate =
      path === '/v1/agents/sessions' && request.method() === 'POST';
    if (path.endsWith('/events') && url.searchParams.get('stream') === 'true') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
      return;
    }
    if (isCreate) {
      createRequests.push({
        body: request.postDataJSON(),
        idempotencyKey: request.headers()['idempotency-key'],
      });
    }
    // The Public reads carry their filters in the query string.
    const response = await route.fetch({
      url: new URL(path + url.search, springUrl!).toString(),
    });
    if (isCreate) {
      const session = await response.json();
      createdIds.push(session.id as string);
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
      // The Public create body carries no requestId: the retry repeats it
      // verbatim under the same Idempotency-Key, and Spring replays the
      // original Session.
      expect(createRequests[1].idempotencyKey).toEqual(expect.any(String));
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
