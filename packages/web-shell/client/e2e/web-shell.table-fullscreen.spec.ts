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
    page
      .locator('[data-selection-copy-table]')
      .getByRole('button', { name: 'Copy', exact: true }),
  ).toBeVisible();
  await page
    .locator('[data-selection-copy-table]')
    .getByRole('button', { name: 'Copy', exact: true })
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
    await page.getByRole('button', { name: 'Table density' }).click();
    await page
      .getByRole('menuitemradio', { name: 'Comfortable', exact: true })
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
    const selectedScroller = page.getByRole('table').locator('..');
    await expect(selectedScroller).toHaveAttribute(
      'data-pointer-focus',
      'true',
    );
    await expect(selectedScroller).toHaveCSS('outline-style', 'none');
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
        page.getByRole('button', { name: 'Table density' }),
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
        page.getByRole('button', { name: 'Copy text', exact: true }),
      ).toBeVisible();
    };
    await assertState();
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await assertState();
    await page.getByRole('button', { name: 'Copy text', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('Item 79');
    await page
      .locator('[data-selection-copy-table]')
      .getByRole('button', { name: 'Copy', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'Copy text', exact: true })
      .click();
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
    await page.getByRole('button', { name: 'Table density' }).click();
    await expect(
      page.getByRole('menu', { name: 'Table density' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Table density' })).toHaveCount(
      0,
    );
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
    const copy = page
      .locator('[data-selection-copy-table]')
      .getByRole('button', { name: 'Copy', exact: true });
    const expand = page.getByRole('button', {
      name: 'Expand text',
      exact: true,
    });
    await expect(copy.locator('span')).toBeHidden();
    await expect(expand.locator('span')).toBeHidden();
    await expect(copy.locator('svg').first()).toBeVisible();
    await expect(expand.locator('svg')).toBeVisible();
    await expand.click();
    await expect(
      page.getByRole('button', { name: 'Collapse text', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Collapse text', exact: true })
      .click();
    await page.screenshot({
      path: testInfo.outputPath('table-toolbar-narrow-inline.png'),
    });
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Fullscreen',
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(copy.locator('span')).toBeHidden();
    await expect(expand.locator('span')).toBeHidden();
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
      page.getByRole('button', { name: 'Copy text', exact: true }),
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

  test('keeps header controls beside the label and auto-scrolls while dragging', async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page, testInfo);
    await expect(
      page
        .getByRole('button', { name: 'Expand text', exact: true })
        .locator('svg'),
    ).toBeVisible();
    await page
      .locator('[data-selection-copy-table]')
      .getByRole('button', { name: 'Copy', exact: true })
      .click();
    const copyMenu = page.getByRole('menu', { name: 'Copy' });
    await expect(copyMenu).toBeVisible();
    expect((await copyMenu.boundingBox())!.width).toBeLessThan(220);
    await page
      .getByRole('menuitem', { name: 'Copy Markdown', exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('| Name | Category |');
    await expect(
      page
        .locator('[data-selection-copy-table]')
        .getByRole('button', { name: 'Copy', exact: true }),
    ).toContainText('Copy');
    await page
      .locator('[data-selection-copy-table]')
      .getByRole('button', { name: 'Copy', exact: true })
      .click();
    await page.keyboard.press('ArrowDown');
    await expect(
      page.getByRole('menuitem', { name: 'Copy text', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(
      page.getByRole('menuitem', { name: 'Copy Markdown', exact: true }),
    ).toBeFocused();
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('| Name | Category |');
    await page
      .locator('[data-selection-copy-table]')
      .getByRole('button', { name: 'Copy', exact: true })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(
      page
        .locator('[data-selection-copy-table]')
        .getByRole('button', { name: 'Copy', exact: true }),
    ).toBeFocused();
    const header = page.getByRole('columnheader', { name: /^Name/ });
    const headerText = header.locator('span').first();
    const filter = page.getByRole('button', {
      name: 'Filter Name',
      exact: true,
    });
    const headerTextBox = await headerText.boundingBox();
    const filterBox = await filter.boundingBox();
    expect(headerTextBox).not.toBeNull();
    expect(filterBox).not.toBeNull();
    const gap = filterBox!.x - (headerTextBox!.x + headerTextBox!.width);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(24);

    const sortPathColors = (label: string) =>
      page
        .getByRole('button', { name: label, exact: true })
        .locator('svg path')
        .evaluateAll((paths) =>
          paths.map((path) => getComputedStyle(path).stroke),
        );
    const sortButton = page.getByRole('button', {
      name: 'Sort by Name',
      exact: true,
    });
    await expect(sortButton.locator('svg')).toHaveCount(1);
    await sortButton.click();
    const ascendingColors = await sortPathColors('Sort by Name, ascending');
    expect(ascendingColors).toHaveLength(4);
    expect(ascendingColors[0]).toBe(ascendingColors[1]);
    expect(ascendingColors[2]).toBe(ascendingColors[3]);
    expect(ascendingColors[0]).not.toBe(ascendingColors[3]);
    await page
      .getByRole('button', { name: 'Sort by Name, ascending', exact: true })
      .click();
    const descendingColors = await sortPathColors('Sort by Name, descending');
    expect(descendingColors[0]).toBe(ascendingColors[3]);
    expect(descendingColors[2]).toBe(ascendingColors[0]);
    await page
      .getByRole('button', { name: 'Sort by Name, descending', exact: true })
      .click();

    const scroller = page.getByRole('table').locator('..');
    await scroller.scrollIntoViewIfNeeded();
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    const cell = page.locator('td[data-row-index="0"][data-column-index="0"]');
    const cellBox = await cell.boundingBox();
    const scrollerBox = await scroller.boundingBox();
    expect(cellBox).not.toBeNull();
    expect(scrollerBox).not.toBeNull();
    await page.mouse.move(
      cellBox!.x + cellBox!.width / 2,
      cellBox!.y + cellBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      scrollerBox!.x + scrollerBox!.width / 2,
      scrollerBox!.y + scrollerBox!.height - 10,
      { steps: 12 },
    );
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const selectedRows = () =>
      page
        .locator('td[data-row-index][class*="selectedCell"]')
        .evaluateAll((cells) =>
          Math.max(
            ...cells.map((cell) =>
              Number((cell as HTMLElement).dataset.rowIndex),
            ),
          ),
        );
    const initialEnd = await selectedRows();
    await expect.poll(selectedRows).toBeGreaterThan(initialEnd);
    await page.mouse.up();
    const stoppedAt = await scroller.evaluate((element) => element.scrollTop);
    await page.waitForTimeout(100);
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(
      stoppedAt,
    );
  });

  test('uses a non-color cue for sort direction in forced colors', async ({
    page,
  }, testInfo) => {
    await openFixture(page, testInfo);
    await page.emulateMedia({ forcedColors: 'active' });
    const header = page.getByRole('columnheader', { name: /^Name/ });
    const opacities = () =>
      header
        .locator('button[aria-label^="Sort by"] svg path')
        .evaluateAll((paths) =>
          paths.map((path) => getComputedStyle(path).opacity),
        );
    await page
      .getByRole('button', { name: 'Sort by Name', exact: true })
      .click();
    await expect.poll(opacities).toEqual(['0.35', '0.35', '1', '1']);
    await page
      .getByRole('button', { name: 'Sort by Name, ascending', exact: true })
      .click();
    await expect.poll(opacities).toEqual(['1', '1', '0.35', '0.35']);
    await page.screenshot({
      path: testInfo.outputPath('table-sort-forced-colors.png'),
    });
  });

  for (const fullscreen of [false, true]) {
    test(`supports toolbar menus with a Shadow DOM portal, fullscreen=${fullscreen}`, async ({
      page,
      context,
    }, testInfo) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openFixture(page, testInfo, { shadow: true });
      if (fullscreen)
        await page
          .getByRole('button', { name: 'Fullscreen', exact: true })
          .click();
      const density = page.getByRole('button', { name: 'Table density' });
      await density.focus();
      await page.keyboard.press('ArrowDown');
      const standard = page.getByRole('menuitemradio', {
        name: 'Standard',
        exact: true,
      });
      const compact = page.getByRole('menuitemradio', {
        name: 'Compact',
        exact: true,
      });
      await expect(
        page.getByRole('menu', { name: 'Table density', exact: true }),
      ).toBeVisible();
      await expect(standard).toBeFocused();
      await expect(standard).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('ArrowDown');
      await expect(compact).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(density).toContainText('Compact density');
      await expect(density).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(compact).toHaveAttribute('aria-checked', 'true');
      await expect(standard).toHaveAttribute('aria-checked', 'false');
      await page.keyboard.press('Escape');
      await expect(density).toBeFocused();
      await expect(page.getByRole('menu')).toHaveCount(0);
      const copy = page
        .locator('[data-selection-copy-table]')
        .getByRole('button', {
          name: 'Copy',
          exact: true,
        });
      await copy.focus();
      await page.keyboard.press('ArrowDown');
      const tsv = page.getByRole('menuitem', {
        name: 'Copy text',
        exact: true,
      });
      const markdown = page.getByRole('menuitem', {
        name: 'Copy Markdown',
        exact: true,
      });
      await expect(
        page.getByRole('menu', { name: 'Copy', exact: true }),
      ).toBeVisible();
      await expect(tsv).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(markdown).toBeFocused();
      await page.keyboard.press('Enter');
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain('| Name | Category |');
      await expect(
        page.locator('[data-selection-copy-table]').getByRole('status'),
      ).toContainText('Copied!');
      await copy.focus();
      await page.keyboard.press('ArrowDown');
      await expect(
        page.getByRole('menu', { name: 'Copy', exact: true }),
      ).toBeVisible();
      await expect(tsv).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(copy).toBeFocused();
      await expect(page.getByRole('menu')).toHaveCount(0);
      if (fullscreen)
        await expect(
          page.getByRole('dialog', { name: 'Fullscreen', exact: true }),
        ).toBeVisible();
    });
  }

  for (const shadow of [false, true]) {
    for (const fullscreen of [false, true]) {
      test(`keeps table controls nonmodal, shadow=${shadow}, fullscreen=${fullscreen}`, async ({
        page,
      }, testInfo) => {
        await openFixture(page, testInfo, { shadow });
        if (fullscreen)
          await page
            .getByRole('button', { name: 'Fullscreen', exact: true })
            .click();
        const pageModality = () =>
          page.evaluate(() => ({
            pointerEvents: document.body.style.pointerEvents,
            scrollLock: document.body.getAttribute('data-scroll-locked'),
          }));
        const baseline = await pageModality();
        expect(baseline.scrollLock).toBe(fullscreen ? '1' : null);
        const density = page.getByRole('button', { name: 'Table density' });
        const copy = page
          .locator('[data-selection-copy-table]')
          .getByRole('button', { name: 'Copy', exact: true });
        await copy.click();
        await expect(page.getByRole('menu', { name: 'Copy' })).toBeVisible();
        await expect.poll(pageModality).toEqual(baseline);
        await density.click();
        await expect(page.getByRole('menu', { name: 'Copy' })).toHaveCount(0);
        await expect(
          page.getByRole('menu', { name: 'Table density' }),
        ).toBeVisible();
        await expect.poll(pageModality).toEqual(baseline);
        await page
          .getByRole('menuitemradio', { name: 'Compact', exact: true })
          .click();
        await expect(density).toContainText('Compact density');
        await density.click();
        await expect(
          page.getByRole('menu', { name: 'Table density' }),
        ).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(density).toBeFocused();
        await expect(page.getByRole('menu')).toHaveCount(0);
        await copy.click();
        await page
          .getByRole('menuitem', { name: 'Copy text', exact: true })
          .click();
        await copy.click();
        await expect(page.getByRole('menu', { name: 'Copy' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(copy).toBeFocused();
        await expect(page.getByRole('menu')).toHaveCount(0);

        const columns = page.getByRole('button', {
          name: 'Custom columns',
          exact: true,
        });
        await columns.click();
        await expect(
          page.getByText('Columns shown in the table', { exact: true }),
        ).toBeVisible();
        await expect.poll(pageModality).toEqual(baseline);
        await page.keyboard.press('Escape');

        for (const [column, operatorName, optionName] of [
          ['Category', 'Text filter for Category', 'Equals'],
          ['Score', 'Number filter for Score', 'Between'],
        ]) {
          await page
            .getByRole('button', { name: `Filter ${column}`, exact: true })
            .click();
          const filter = page.getByRole('dialog', {
            name: column,
            exact: true,
          });
          await expect(filter).toBeVisible();
          await expect.poll(pageModality).toEqual(baseline);
          const operator = filter.getByRole('button', {
            name: operatorName,
            exact: true,
          });
          await operator.focus();
          await page.keyboard.press('ArrowDown');
          await expect(page.getByRole('menu')).toBeVisible();
          await expect.poll(pageModality).toEqual(baseline);
          await page.keyboard.press('End');
          await expect(page.getByRole('menuitemradio').last()).toBeFocused();
          if (column === 'Category') {
            await page.keyboard.press('Home');
            await expect(page.getByRole('menuitemradio').first()).toBeFocused();
            await page.keyboard.press('ArrowDown');
          }
          await expect(
            page.getByRole('menuitemradio', { name: optionName, exact: true }),
          ).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(operator).toContainText(optionName);
          await expect(operator).toBeFocused();
          await expect(filter).toBeVisible();
          await operator.click();
          await expect(
            page.getByRole('menuitemradio', { name: optionName, exact: true }),
          ).toHaveAttribute('aria-checked', 'true');
          await page.keyboard.press('Escape');
          await expect(page.getByRole('menu')).toHaveCount(0);
          await expect(filter).toBeVisible();
          await expect(operator).toBeFocused();
          await operator.click();
          const input = filter.getByRole('textbox').first();
          await input.click();
          await expect(page.getByRole('menu')).toHaveCount(0);
          await expect(filter).toBeVisible();
          await expect(input).toBeFocused();
          await filter
            .getByRole('button', { name: 'Cancel', exact: true })
            .click();
          await expect(filter).toHaveCount(0);
          await expect.poll(pageModality).toEqual(baseline);
        }
        if (fullscreen)
          await expect(
            page.getByRole('dialog', { name: 'Fullscreen', exact: true }),
          ).toBeVisible();
      });
    }
  }

  for (const fullscreen of [false, true]) {
    test(`copies through the legacy clipboard fallback, fullscreen=${fullscreen}`, async ({
      page,
      context,
    }, testInfo) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openFixture(page, testInfo, { shadow: fullscreen });
      if (fullscreen)
        await page
          .getByRole('button', { name: 'Fullscreen', exact: true })
          .click();
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: undefined,
        });
      });
      const probe = await context.newPage();
      await probe.route('**/clipboard-probe', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<title>Clipboard probe</title>',
        }),
      );
      await probe.goto('/clipboard-probe');
      for (const [label, expectedHeader] of [
        ['Copy text', headers.join('\t')],
        ['Copy Markdown', `| ${headers.join(' | ')} |`],
      ]) {
        await probe.bringToFront();
        await probe.evaluate(() =>
          navigator.clipboard.writeText('before copy'),
        );
        await page.bringToFront();
        await page
          .locator('[data-selection-copy-table]')
          .getByRole('button', { name: 'Copy', exact: true })
          .click();
        await page.getByRole('menuitem', { name: label, exact: true }).click();
        await expect(page.getByRole('menu')).toHaveCount(0);
        await probe.bringToFront();
        await expect
          .poll(() => probe.evaluate(() => navigator.clipboard.readText()))
          .toContain(expectedHeader);
        expect(
          await probe.evaluate(() => navigator.clipboard.readText()),
        ).toContain('Item 01');
      }
      await probe.close();
    });
  }

  for (const freeze of [false, true]) {
    test(`extends selection through the left action gutter while scrolling, frozen=${freeze}`, async ({
      page,
    }, testInfo) => {
      await openFixture(page, testInfo);
      await page
        .getByRole('button', { name: 'Fullscreen', exact: true })
        .click();
      if (freeze) {
        await page
          .getByRole('columnheader', { name: /^Name/ })
          .click({ button: 'right' });
        await page
          .getByRole('menuitem', { name: 'Freeze first column', exact: true })
          .click();
      }
      const scroller = page.getByRole('table').locator('..');
      const anchor = await page
        .locator('td[data-row-index="3"][data-column-index="0"]')
        .boundingBox();
      const bounds = (await scroller.boundingBox())!;
      await page.mouse.move(
        anchor!.x + anchor!.width / 2,
        anchor!.y + anchor!.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(bounds.x + 1, bounds.y + bounds.height - 10, {
        steps: 4,
      });
      const endRow = () =>
        page
          .locator('td[data-row-index][class*="selectedCell"]')
          .evaluateAll((cells) =>
            Math.max(
              ...cells.map((cell) =>
                Number((cell as HTMLElement).dataset.rowIndex),
              ),
            ),
          );
      const initialEnd = await endRow();
      await expect.poll(endRow).toBeGreaterThan(initialEnd + 3);
      await page.mouse.up();
      const stoppedAt = await scroller.evaluate((element) => element.scrollTop);
      const finalEnd = await endRow();
      await page.waitForTimeout(100);
      expect(await scroller.evaluate((element) => element.scrollTop)).toBe(
        stoppedAt,
      );
      expect(await endRow()).toBe(finalEnd);
    });
  }
});
