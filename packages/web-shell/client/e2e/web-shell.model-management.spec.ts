import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';
import {
  completeReplay,
  fillComposer,
  submitLocalCommand,
} from './visuals/harness';

async function openHarness(
  page: Page,
  testInfo: TestInfo,
  policy: { allowAdd?: boolean; allowDelete?: boolean } = {},
) {
  const scenario = createWebShellDaemonScenario();
  scenario.providers.providers.push({
    kind: 'model_provider',
    status: 'ok',
    authType: 'openai',
    current: false,
    models: [
      {
        modelId: 'managed-test-model',
        configurationKey: 'managed-test-key',
        baseModelId: 'managed-test-model',
        name: 'Managed Test Model',
        isCurrent: false,
        isRuntime: false,
      },
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.route('**/workspace/models', async (route) => {
    if (route.request().method() === 'GET')
      await route.fulfill({
        json: {
          models: [
            {
              key: 'managed-test-key',
              authType: 'openai',
              modelId: 'managed-test-model',
              name: 'Managed Test Model',
              purpose: 'chat',
            },
          ],
        },
      });
    else await route.fallback();
  });
  await page.route('**/workspace/auth/providers', (route) =>
    route.fulfill({
      json: {
        v: 1,
        workspaceCwd: scenario.workspaceCwd,
        providers: [],
        groups: [],
      },
    }),
  );
  const params = new URLSearchParams({ sessionId: scenario.sessionId });
  for (const [key, value] of Object.entries(policy))
    params.set(key, String(value));
  await page.goto(`/e2e/settings-harness.html?${params}`);
  await completeReplay(page, daemon, scenario.sessionId);
  return daemon;
}
async function openModels(page: Page) {
  await submitLocalCommand(page, '/settings');
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: /^Model/ })
    .click();
  await expect(page.getByTestId('model-management')).toContainText(
    'Managed Test Model',
  );
}
async function evidence(page: Page, name: string) {
  const directory = resolve('../../.qwen/e2e-tests/model-management-evidence');
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, `${name}.png`),
    fullPage: true,
  });
  if (
    process.env['QWEN_MODEL_MANAGEMENT_EVIDENCE'] === '1' &&
    (name === 'default-model-controls' || name === 'disabled-model-controls')
  ) {
    // Stays inside the git-ignored tree: refreshing the tracked
    // docs/design/assets PNGs is a deliberate copy from here, never a test
    // side effect.
    const assets = resolve(directory, 'assets');
    await mkdir(assets, { recursive: true });
    await page.getByTestId('model-management').screenshot({
      path: resolve(
        assets,
        `web-shell-model-management-${name === 'default-model-controls' ? 'before' : 'after'}.png`,
      ),
    });
  }
}
test('default host retains add and delete controls @smoke', async ({
  page,
}, testInfo) => {
  await openHarness(page, testInfo);
  await openModels(page);
  await expect(
    page.getByRole('button', { name: '+ Add Model', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Delete Managed Test Model',
      exact: true,
    }),
  ).toBeVisible();
  await evidence(page, 'default-model-controls');
});
for (const allowAdd of [true, false]) {
  for (const allowDelete of [true, false]) {
    test(`host controls add=${allowAdd} delete=${allowDelete} @smoke`, async ({
      page,
    }, testInfo) => {
      await openHarness(page, testInfo, {
        allowAdd,
        allowDelete,
      });
      await openModels(page);
      await expect(
        page.getByRole('button', { name: '+ Add Model', exact: true }),
      ).toHaveCount(allowAdd ? 1 : 0);
      await expect(
        page.getByRole('button', {
          name: 'Delete Managed Test Model',
          exact: true,
        }),
      ).toHaveCount(allowDelete ? 1 : 0);
      await expect(
        page.getByRole('button', {
          name: 'Edit context window Managed Test Model',
          exact: true,
        }),
      ).toBeVisible();
      if (!allowAdd && !allowDelete)
        await evidence(page, 'disabled-model-controls');
    });
  }
}
for (const allowAdd of [true, false]) {
  test(`auth command respects add=${allowAdd} @smoke`, async ({
    page,
  }, testInfo) => {
    const daemon = await openHarness(page, testInfo, { allowAdd });
    await fillComposer(page, '/');
    const menu = page.locator('[data-web-shell-slash-menu]');
    await expect(menu).toBeVisible();
    await expect(menu.getByText('/auth', { exact: true })).toHaveCount(
      allowAdd ? 1 : 0,
    );
    await submitLocalCommand(page, '/auth');
    const dialog = page.getByRole('dialog', { name: 'Connect a Provider' });
    if (allowAdd) await expect(dialog).toBeVisible();
    else {
      await expect(
        page.getByText('Adding models is disabled by the host.'),
      ).toBeVisible();
      await expect(dialog).toHaveCount(0);
      // /prompt is the only refusal-relevant route the mock daemon records;
      // the /auth/provider half was decorative, so the request-level install
      // guarantee is carried by AuthMessage.dom.test.tsx instead.
      // Positive control: a plain prompt on this same arm must reach the
      // recorder, then verify both its identity and the total request count.
      await submitLocalCommand(page, 'plain text prompt');
      await expect
        .poll(() =>
          daemon
            .promptRequests()
            .some(({ body }) =>
              JSON.stringify(body).includes('plain text prompt'),
            ),
        )
        .toBe(true);
      expect(daemon.promptRequests()).toHaveLength(1);
      expect(JSON.stringify(daemon.promptRequests()[0]?.body)).toContain(
        'plain text prompt',
      );
      await evidence(page, 'disabled-auth-command');
    }
  });
}
test('closing add permission dismisses an open provider dialog @smoke', async ({
  page,
}, testInfo) => {
  await openHarness(page, testInfo);
  await submitLocalCommand(page, '/auth');
  const dialog = page.getByRole('dialog', { name: 'Connect a Provider' });
  await expect(dialog).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('model-management-change', {
        detail: { allowAdd: false, allowDelete: false },
      }),
    ),
  );
  await expect(dialog).toHaveCount(0);
});

test('disabled model management preserves model switching @smoke', async ({
  page,
}, testInfo) => {
  const daemon = await openHarness(page, testInfo, {
    allowAdd: false,
    allowDelete: false,
  });
  await submitLocalCommand(page, '/model');
  await expect(page.locator('[data-web-shell-model-dialog]')).toBeVisible();
  await page
    .locator('[data-web-shell-model-option][data-model-id="qwen-test-alt"]')
    .click();
  await expect(page.locator('[data-web-shell-model-dialog]')).toHaveCount(0);
  await expect.poll(() => daemon.modelRequests().length).toBe(1);
});

test('closing deletion permission clears pending confirmation @smoke', async ({
  page,
}, testInfo) => {
  await openHarness(page, testInfo);
  await openModels(page);
  await page
    .getByRole('button', { name: 'Delete Managed Test Model', exact: true })
    .click();
  const confirm = page.getByRole('button', {
    name: /Confirm.*Managed Test Model/,
  });
  await expect(confirm).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('model-management-change', {
        detail: { allowAdd: false, allowDelete: false },
      }),
    ),
  );
  await expect(confirm).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('model-management-change', {
        detail: { allowAdd: false, allowDelete: true },
      }),
    ),
  );
  await expect(
    page.getByRole('button', {
      name: 'Delete Managed Test Model',
      exact: true,
    }),
  ).toBeVisible();
  await expect(confirm).toHaveCount(0);
});
