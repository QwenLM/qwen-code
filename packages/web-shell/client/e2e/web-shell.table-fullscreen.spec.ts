import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const headers = [
  'Name',
  'Category',
  'Score',
  'Description',
  'Owner',
  'Region',
  'Status',
  'Notes',
  'Date',
  'Reference',
];
const fixture = [
  '## Fullscreen table acceptance',
  '',
  `| ${headers.join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...Array.from(
    { length: 80 },
    (_, index) =>
      `| Item ${String(index + 1).padStart(2, '0')} | ${index % 2 ? 'Beta' : 'Alpha'} | ${80 - index} | A detailed description for item ${index + 1} that is longer than sixty characters to exercise the cell detail dialog. | Owner ${index % 4} | Region ${index % 5} | Active | Notes ${index} | 2026-10-07 | REF-${index} |`,
  ),
].join('\n');

async function openFixture(
  page: Page,
  testInfo: TestInfo,
  options: {
    narrow?: boolean;
    shadow?: boolean;
    theme?: 'light' | 'dark';
  } = {},
) {
  await page.setViewportSize(
    options.narrow ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  );
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Show a wide and tall table.', { id: 1 }),
      assistantTextEvent(fixture, { id: 2 }),
      turnCompleteEvent('prompt-table', { id: 3 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  if (options.shadow) {
    await page.goto(
      `/e2e/table-fullscreen-shadow.html?sessionId=${encodeURIComponent(scenario.sessionId)}`,
    );
  } else {
    await page.goto(
      `/session/${encodeURIComponent(scenario.sessionId)}?theme=${options.theme ?? 'dark'}&lang=en`,
    );
  }
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(
    page.getByRole('heading', { name: 'Fullscreen table acceptance' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Copy table', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Copy table', exact: true })
    .scrollIntoViewIfNeeded();
  return { daemon, scenario };
}

test('table fullscreen baseline', async ({ page }, testInfo) => {
  test.skip(
    process.env['TABLE_FULLSCREEN_BASELINE'] !== '1',
    'Before-change capture only.',
  );
  await openFixture(page, testInfo);
  await expect(
    page.getByRole('button', { name: 'Fullscreen', exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('table-before-fullscreen.png'),
    fullPage: true,
  });
});

test.describe('enhanced table fullscreen', () => {
  test.skip(
    process.env['TABLE_FULLSCREEN_BASELINE'] === '1',
    'After-change acceptance only.',
  );

  test('fills the viewport, scrolls both axes, and restores inline focus and position', async ({
    page,
  }, testInfo) => {
    await openFixture(page, testInfo, { theme: 'light' });
    const table = page.getByRole('table');
    const scroller = table.locator('..');
    const chat = page.locator('[data-web-shell-message-list]');
    const fullscreen = page.getByRole('button', {
      name: 'Fullscreen',
      exact: true,
    });
    await fullscreen.scrollIntoViewIfNeeded();
    const chatTop = await chat.evaluate((element) => element.scrollTop);
    await scroller.evaluate((element) => {
      element.scrollLeft = 240;
      element.scrollTop = 300;
    });
    const before = await scroller.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    }));
    await fullscreen.click();
    const dialog = page.getByRole('dialog', {
      name: 'Fullscreen',
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(scroller).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeCloseTo(0, 0);
    expect(bounds!.y).toBeCloseTo(0, 0);
    expect(bounds!.width).toBeCloseTo(1280, 0);
    expect(bounds!.height).toBeCloseTo(800, 0);
    await expect
      .poll(() =>
        scroller.evaluate((element) => ({
          left: element.scrollLeft,
          top: element.scrollTop,
        })),
      )
      .toEqual(before);
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) =>
            element.scrollWidth > element.clientWidth &&
            element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    await scroller.evaluate((element) => {
      element.scrollLeft = 280;
      element.scrollTop = 350;
    });
    await expect
      .poll(() =>
        scroller.evaluate((element) => ({
          left: element.scrollLeft,
          top: element.scrollTop,
        })),
      )
      .toEqual({ left: 280, top: 350 });
    await page.screenshot({
      path: testInfo.outputPath('table-fullscreen-light.png'),
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(fullscreen).toBeFocused();
    await expect
      .poll(() =>
        scroller.evaluate((element) => ({
          left: element.scrollLeft,
          top: element.scrollTop,
        })),
      )
      .toEqual({ left: 280, top: 350 });
    await expect
      .poll(() => chat.evaluate((element) => element.scrollTop))
      .toBe(chatTop);
  });

  test('preserves sorting, filters, column settings, density, details and selection', async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page, testInfo);
    await page
      .getByRole('button', { name: 'Sort by Name', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Sort by Name, ascending', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Filter Category', exact: true })
      .click();
    const filter = page.getByRole('dialog', { name: 'Category', exact: true });
    await filter.getByRole('checkbox', { name: /Beta/ }).uncheck();
    await filter.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.getByRole('combobox', { name: 'Table density' }).click();
    await page
      .getByRole('option', { name: 'Comfortable', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Custom columns', exact: true })
      .click();
    await page
      .getByRole('checkbox', { name: 'Reference', exact: true })
      .first()
      .uncheck();
    await page.keyboard.press('Escape');
    const resize = page.getByRole('separator', {
      name: 'Resize Name',
      exact: true,
    });
    await resize.focus();
    await page.keyboard.press('ArrowRight');
    const columnWidth = await resize.getAttribute('aria-valuenow');
    await page
      .getByRole('button', { name: 'View details for row 1', exact: true })
      .click();
    await page.locator('td[data-row-index="0"][data-column-index="0"]').click();
    const assertState = async () => {
      await expect(
        page.locator('td[data-row-index="0"][data-column-index="0"]'),
      ).toHaveText('Item 79');
      await expect(
        page.getByRole('button', {
          name: 'Sort by Name, descending',
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator('td[data-column-index="0"]')).toHaveCount(40);
      await expect(
        page.getByRole('combobox', { name: 'Table density' }),
      ).toContainText('Comfortable');
      await expect(resize).toHaveAttribute('aria-valuenow', columnWidth!);
      await expect(
        page.getByRole('columnheader', { name: /^Reference/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', {
          name: 'Hide details for row 1',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Copy TSV', exact: true }),
      ).toBeVisible();
    };
    await assertState();
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await assertState();
    await page.getByRole('button', { name: 'Copy TSV', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('Item 79');
    await page.getByRole('button', { name: 'Copy table', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('Item 79');
    await page
      .getByRole('button', { name: 'Exit fullscreen', exact: true })
      .click();
    await assertState();
    await expect(
      page.getByRole('button', { name: 'Fullscreen', exact: true }),
    ).toBeFocused();
  });

  test('Escape dismisses inner popovers and cell details before fullscreen', async ({
    page,
  }, testInfo) => {
    const { daemon } = await openFixture(page, testInfo);
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Fullscreen',
      exact: true,
    });
    await page
      .getByRole('button', { name: 'Filter Category', exact: true })
      .click();
    const filter = page.getByRole('dialog', { name: 'Category', exact: true });
    await expect(filter).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(filter).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page
      .locator('td[data-row-index="0"][data-column-index="3"]')
      .dblclick();
    const cell = page.getByRole('dialog', {
      name: 'Current field value',
      exact: true,
    });
    await expect(cell).toBeVisible();
    await expect(cell).toContainText('A detailed description for item 1');
    await page.keyboard.press('Escape');
    await expect(cell).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.getByRole('combobox', { name: 'Table density' }).click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(
      daemon.requests.filter(
        (request) =>
          request.method === 'POST' &&
          /\/(prompt|cancel|interrupt)$/.test(request.path),
      ),
    ).toEqual([]);
  });

  test('keeps narrow-screen controls and Shadow DOM portals usable', async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env['TABLE_FULLSCREEN_BUILT'] === '1',
      'The production bundle does not include test-only host harnesses.',
    );
    await openFixture(page, testInfo, { narrow: true, shadow: true });
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Fullscreen',
      exact: true,
    });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeCloseTo(0, 0);
    expect(bounds!.y).toBeCloseTo(0, 0);
    expect(bounds!.width).toBeCloseTo(390, 0);
    expect(bounds!.height).toBeCloseTo(844, 0);
    expect(
      await dialog.evaluate(
        (element) => element.getRootNode() instanceof ShadowRoot,
      ),
    ).toBe(true);
    expect(
      await dialog.evaluate(
        (element) => element.closest('[data-web-shell-portal-root]') !== null,
      ),
    ).toBe(true);
    await expect(
      page.getByRole('button', { name: 'Exit fullscreen', exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath('table-fullscreen-shadow-narrow.png'),
    });
    const exit = page.getByRole('button', {
      name: 'Exit fullscreen',
      exact: true,
    });
    await exit.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(
      page.getByRole('button', {
        name: 'View details for row 80',
        exact: true,
      }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(exit).toBeFocused();
    await page
      .locator('td[data-row-index="0"][data-column-index="0"]')
      .dblclick();
    const cell = page.getByRole('dialog', {
      name: 'Current field value',
      exact: true,
    });
    await expect(cell).toBeVisible();
    const cellCloseButtons = cell.getByRole('button', {
      name: 'Close',
      exact: true,
    });
    await cellCloseButtons.first().focus();
    await page.keyboard.press('Shift+Tab');
    await expect(cellCloseButtons.last()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cellCloseButtons.first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(cell).toHaveCount(0);
    await expect(page.getByRole('table').locator('..')).toBeFocused();
    await page.locator('td[data-row-index="0"][data-column-index="0"]').click();
    await expect(
      page.getByRole('button', { name: 'Copy TSV', exact: true }),
    ).toHaveCount(1);
    await page
      .getByRole('button', { name: 'Filter Name', exact: true })
      .click();
    const filter = page.getByRole('dialog', { name: 'Name', exact: true });
    await expect(filter).toBeVisible();
    expect(
      await filter.evaluate(
        (element) => element.getRootNode() instanceof ShadowRoot,
      ),
    ).toBe(true);
    const filterSearch = filter.getByRole('textbox').first();
    await filterSearch.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(
      filter.getByRole('button', { name: 'Confirm', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(filterSearch).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(filter).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page
      .getByRole('button', { name: 'Custom columns', exact: true })
      .click();
    const columnCheckboxes = page
      .locator('[data-slot="popover-content"]')
      .getByRole('checkbox');
    await columnCheckboxes.last().focus();
    await page.keyboard.press('Tab');
    await expect(columnCheckboxes.first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(columnCheckboxes.last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Fullscreen', exact: true }),
    ).toBeFocused();
  });
});
