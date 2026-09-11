import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const fixture = `## Citation preview acceptance

Adjacent sources[^1][^ticket] [^1][^说明]. Separated sources[^1], text[^ticket].

| Dimension | Conclusion |
| --- | --- |
| Official news | Current tour information[^1][^ticket][^说明] |
| Public appearances | Single source[^ticket] |

Ordinary explanation[^note].

[^1]: [Macao Government Tourism Office](https://tourism.example.test/event) Official concert details and final show dates. ![Concert poster](https://images.example.test/concert.png)
[^ticket]: [Official ticket website](https://tickets.example.test/show) Tickets and venue information.
[^说明]: This is a plain note without a link or image.
[^note]: This ordinary footnote also has a preview.
`;

const triggerSelector = '[data-web-shell-footnote-trigger]';
const cardSelector = '[data-web-shell-footnote-card]';

async function openFixture(
  page: Page,
  testInfo: TestInfo,
  options: {
    text?: string;
    theme?: 'light' | 'dark';
    language?: 'en' | 'zh-CN';
    shadow?: boolean;
    secondMessage?: boolean;
    narrow?: boolean;
    brokenImage?: boolean;
  } = {},
) {
  await page.setViewportSize(
    options.narrow
      ? { width: 390, height: 844 }
      : { width: 1365, height: 1100 },
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !(
        options.brokenImage &&
        message.location().url.startsWith('https://images.example.test/')
      )
    ) {
      errors.push(message.text());
    }
  });
  await page.route('https://images.example.test/**', async (route) => {
    if (options.brokenImage) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
  });
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Show citation preview acceptance.', { id: 1 }),
      assistantTextEvent(options.text ?? fixture, { id: 2 }),
      turnCompleteEvent('prompt-footnotes', { id: 3 }),
      ...(options.secondMessage
        ? [
            userTextEvent('Another message with the same note ID.', { id: 4 }),
            assistantTextEvent(
              'Second message source[^1].\n\n[^1]: **Second source** Second definition.',
              { id: 5 },
            ),
            turnCompleteEvent('prompt-footnotes-second', { id: 6 }),
          ]
        : []),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  if (options.shadow) {
    await page.goto('/e2e/session-overview-shadow-dom.html');
    await page
      .getByRole('button', {
        name: `${scenario.displayName} More actions`,
        exact: true,
      })
      .click();
  } else {
    await page.goto(
      `/session/${encodeURIComponent(scenario.sessionId)}?theme=${options.theme ?? 'dark'}&lang=${options.language ?? 'en'}`,
    );
  }
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.getByText('Loading...', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Citation preview acceptance' }),
  ).toBeVisible();
  return { daemon, scenario, errors };
}

test('footnote baseline before grouped previews', async ({
  page,
}, testInfo) => {
  test.skip(
    process.env['FOOTNOTE_BASELINE'] !== '1',
    'Before-change capture only.',
  );
  const { errors } = await openFixture(page, testInfo);
  await expect(page.locator('sup a[href^="#user-content-fn-"]')).toHaveCount(
    11,
  );
  await expect(page.locator('[data-footnotes] li')).toHaveCount(4);
  await page.locator('sup a[href^="#user-content-fn-"]').first().hover();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('footnotes-before-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});

test.describe('footnote source previews', () => {
  test.skip(
    process.env['FOOTNOTE_BASELINE'] === '1',
    'After-change acceptance only.',
  );

  test('groups paragraph and table references and paginates on hover', async ({
    page,
  }, testInfo) => {
    const { errors } = await openFixture(page, testInfo);
    const triggers = page.locator(triggerSelector);
    await expect(triggers).toHaveCount(6);
    await expect(triggers).toHaveText(['3', '', '', '3', '', '']);
    await expect(page.locator('[data-footnotes] li')).toHaveCount(0);
    await expect(
      page.locator('[data-web-shell-footnote-sources-trigger]'),
    ).toHaveText('4 citations');
    await triggers.first().hover();
    const card = page.locator(cardSelector);
    await expect(card).toBeVisible();
    await expect(
      card.getByRole('link', { name: 'Macao Government Tourism Office' }),
    ).toHaveAttribute('href', 'https://tourism.example.test/event');
    await expect(card).toContainText('tourism.example.test');
    await expect(card).toContainText(
      'Official concert details and final show dates.',
    );
    await expect(card.locator('img')).toBeVisible();
    await expect
      .poll(() =>
        card
          .locator('img')
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(
      card.getByRole('button', { name: /Previous/i }),
    ).toBeDisabled();
    await card.hover();
    await page.waitForTimeout(300);
    await expect(card).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('footnotes-after-dark.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await card.getByRole('button', { name: /Next/i }).click();
    await expect(card).toContainText('Official ticket website');
    await expect(card).not.toContainText('Macao Government Tourism Office');
    await expect(card.locator('img')).toHaveCount(0);
    await card.getByRole('button', { name: /Next/i }).click();
    await expect(card).toContainText('Footnote 3');
    await expect(card).toContainText(
      'This is a plain note without a link or image.',
    );
    await expect(card.getByRole('button', { name: /Next/i })).toBeDisabled();
    await card.getByRole('button', { name: /Previous/i }).click();
    await expect(card).toContainText('Official ticket website');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await page.mouse.move(0, 0);
    await triggers.first().hover();
    await expect(card).toContainText('Macao Government Tourism Office');
    await page.mouse.move(0, 0);
    await page
      .getByRole('heading', { name: 'Citation preview acceptance' })
      .click();
    await expect(card).toHaveCount(0);
    const tableTrigger = page
      .getByRole('table')
      .locator(triggerSelector)
      .first();
    await tableTrigger.hover();
    await expect(card).toContainText('Macao Government Tourism Office');
    await card.getByRole('button', { name: /Next/i }).click();
    await expect(card).toContainText('Official ticket website');
    await page.screenshot({
      path: testInfo.outputPath('footnotes-table-page-two.png'),
      fullPage: true,
      animations: 'disabled',
    });
    expect(errors).toEqual([]);
  });

  test('keyboard opening and message citation lists stay isolated', async ({
    page,
  }, testInfo) => {
    const { errors } = await openFixture(page, testInfo, {
      secondMessage: true,
    });
    const triggers = page.locator(triggerSelector);
    await expect(triggers).toHaveCount(7);
    await triggers.first().focus();
    const card = page.locator(cardSelector);
    await expect(card).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await triggers.nth(1).click();
    await expect(card).toBeVisible();
    await expect(
      card.getByRole('button', { name: /Next|Previous/i }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('body').click({ position: { x: 1, y: 1 } });

    const sourceFooters = page.locator(
      '[data-web-shell-footnote-sources-trigger]',
    );
    await expect(sourceFooters).toHaveText(['4 citations', '1 citation']);
    const assistantFooter = sourceFooters.first().locator('..');
    await expect(assistantFooter).toHaveCSS('opacity', '0');
    await sourceFooters.first().hover();
    await expect(assistantFooter).toHaveCSS('opacity', '1');
    await expect(card).toBeVisible();
    await card.evaluate((element) =>
      element.dispatchEvent(
        new PointerEvent('pointerout', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      ),
    );
    await card.getByRole('button', { name: /Next/i }).dispatchEvent('click');
    await card.evaluate((element) =>
      element.dispatchEvent(
        new PointerEvent('pointerout', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      ),
    );
    await page.waitForTimeout(350);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Official ticket website');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await sourceFooters.first().hover();
    await expect(card).toBeVisible();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await expect(card).toHaveCount(0);
    const ids = await triggers.evaluateAll((elements) =>
      elements.map((element) => element.id),
    );
    expect(new Set(ids).size).toBe(ids.length);

    await expect(page.locator('[data-footnotes]')).toHaveCount(0);
    await triggers.last().click();
    await expect(card).toContainText('Second definition.');
    await expect(card).not.toContainText('Official concert details');
    expect(errors).toEqual([]);
  });

  for (const key of ['Enter', 'ArrowDown', 'Space']) {
    test(`keyboard reaches pagination after opening a reference with ${key}`, async ({
      page,
    }, testInfo) => {
      const { errors } = await openFixture(page, testInfo);
      await page.locator(triggerSelector).first().focus();
      const initialCard = page.locator(cardSelector);
      await expect(initialCard).toBeVisible();
      const cardId = await initialCard.getAttribute('id');
      const card = page.locator(`[id="${cardId}"]`);
      await page.keyboard.press(key);
      await page.keyboard.press('Tab');
      await expect
        .poll(() =>
          card.evaluateAll((elements) =>
            elements.some((element) => element.matches(':focus-within')),
          ),
        )
        .toBe(true);
      const next = card.getByRole('button', { name: /Next/i });
      for (
        let attempts = 0;
        attempts < 3 &&
        !(await next.evaluate((element) => element.matches(':focus')));
        attempts++
      ) {
        await page.keyboard.press('Tab');
      }
      await expect(next).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(card).toContainText('Official ticket website');
      expect(errors).toEqual([]);
    });
  }

  test('streaming definitions create a group and preserve a selected source', async ({
    page,
  }, testInfo) => {
    const { daemon, errors } = await openFixture(page, testInfo);
    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    await editor.fill('Stream the next answer.');
    await page.locator('[data-web-shell-composer-submit]').click();
    await expect.poll(() => daemon.promptRequests().length).toBe(1);
    await daemon.sse.split(
      assistantTextEvent(
        'Streaming citations[^source-first][^source-second][^source-third].',
        {
          id: 4,
        },
      ),
    );
    const list = page.locator('[data-web-shell-message-list]');
    await expect(list).toContainText(
      'Streaming citations[^source-first][^source-second][^source-third].',
    );
    await daemon.sse.split(
      assistantTextEvent(
        '\n\n[^source-first]: [First source](https://first.example.test) First summary.\n[^source-second]: [Second source](https://second.example.test) Second summary.',
        { id: 5 },
      ),
    );
    const streamTrigger = page.locator(triggerSelector).last();
    await expect(streamTrigger).toHaveText('2');
    await streamTrigger.hover();
    const card = page.locator(cardSelector);
    await expect(card).toContainText('First source');
    await card.getByRole('button', { name: /Next/i }).click();
    await expect(card).toContainText('Second source');
    await daemon.sse.split(
      assistantTextEvent(
        '\n[^source-third]: [Third source](https://third.example.test) Third summary.',
        { id: 6 },
      ),
    );
    await expect(streamTrigger).toHaveText('3');
    await expect(card).toContainText('Second source');
    await card.getByRole('button', { name: /Next/i }).click();
    await expect(card).toContainText('Third source');
    await daemon.sse.split(turnCompleteEvent('prompt-e2e', { id: 7 }));
    expect(errors).toEqual([]);
  });

  test('light and narrow cards stay within the viewport and load the SVG', async ({
    page,
  }, testInfo) => {
    const { errors } = await openFixture(page, testInfo, {
      theme: 'light',
      narrow: true,
    });
    const trigger = page.locator(triggerSelector).first();
    await trigger.click();
    const card = page.locator(cardSelector);
    await expect(card).toBeVisible();
    await expectInsideViewport(page, card);
    const icon = await trigger
      .locator('[aria-hidden="true"]')
      .first()
      .evaluate(async (element) => {
        const mask = getComputedStyle(element).maskImage;
        const image = new Image();
        const width = await new Promise<number>((resolve) => {
          image.onload = () => resolve(image.naturalWidth);
          image.onerror = () => resolve(0);
          image.src = mask.slice(4, -1).replace(/^"|"$/g, '');
        });
        return { mask, width };
      });
    expect(icon.mask).toMatch(/svg|data:image/);
    expect(icon.width).toBeGreaterThan(0);
    await page.screenshot({
      path: testInfo.outputPath('footnotes-after-light-narrow.png'),
      fullPage: true,
      animations: 'disabled',
    });
    expect(errors).toEqual([]);
  });

  test('touch taps open and paginate sources and the title opens its URL', async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      baseURL: String(testInfo.project.use.baseURL),
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    try {
      await context.route('https://tickets.example.test/**', async (route) => {
        await route.fulfill({
          contentType: 'text/html',
          body: '<h1>Opened official ticket source</h1>',
        });
      });
      const page = await context.newPage();
      const { errors } = await openFixture(page, testInfo, { narrow: true });
      await page.locator(triggerSelector).first().tap();
      const card = page.locator(cardSelector);
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: /Next/i }).tap();
      await expect(card).toContainText('Official ticket website');
      await expectInsideViewport(page, card);
      await page.screenshot({
        path: testInfo.outputPath('footnotes-touch-page-two.png'),
        fullPage: true,
        animations: 'disabled',
      });
      const popupPromise = page.waitForEvent('popup');
      await card.getByRole('link', { name: 'Official ticket website' }).tap();
      const popup = await popupPromise;
      await expect(
        popup.getByRole('heading', { name: 'Opened official ticket source' }),
      ).toBeVisible();
      expect(popup.url()).toBe('https://tickets.example.test/show');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('Chinese language labels cover the trigger, pagination and plain-note title', async ({
    page,
  }, testInfo) => {
    const { errors } = await openFixture(page, testInfo, { language: 'zh-CN' });
    await page
      .getByRole('button', { name: '查看 3 条引用', exact: true })
      .first()
      .hover();
    const card = page.getByRole('dialog', { name: '引用预览', exact: true });
    await expect(card).toBeVisible();
    await expect(
      card.getByRole('button', { name: '上一条引用', exact: true }),
    ).toBeDisabled();
    const next = card.getByRole('button', { name: '下一条引用', exact: true });
    await next.click();
    await expect(card).toContainText('Official ticket website');
    await next.click();
    await expect(card).toContainText('脚注 3');
    await expect(card).toContainText(
      'This is a plain note without a link or image.',
    );
    await expect(next).toBeDisabled();
    await page.screenshot({
      path: testInfo.outputPath('footnotes-chinese-page-three.png'),
      fullPage: true,
      animations: 'disabled',
    });
    expect(errors).toEqual([]);
  });

  test('plain multiline notes preserve complete scrollable descriptions', async ({
    page,
  }, testInfo) => {
    const explanation =
      'A complete explanation with additional context. '.repeat(100);
    const { errors } = await openFixture(page, testInfo, {
      text: `## Citation preview acceptance\n\nDetails[^说明].\n\n[^说明]: First paragraph.\n\n    ${explanation}End of the explanation.`,
    });
    const trigger = page.locator(triggerSelector);
    await trigger.click();
    const card = page.locator(cardSelector);
    await expect(card).toContainText('Footnote 1');
    await expect(card.locator('a')).toHaveCount(0);
    const summary = card.locator('[data-web-shell-footnote-summary]');
    await expect(summary).toContainText('First paragraph.');
    await expect(summary).toContainText('End of the explanation.');
    await expect(summary).toHaveCSS('overflow-y', 'auto');
    expect(
      await summary.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    await summary.focus();
    await page.keyboard.press('End');
    await expect
      .poll(() => summary.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expectInsideViewport(page, card);
    expect(errors).toEqual([]);
  });

  test('failed thumbnails collapse and previewing sources does not fetch website metadata', async ({
    page,
  }, testInfo) => {
    const sourceRequests: string[] = [];
    page.on('request', (request) => {
      if (/https:\/\/(tourism|tickets)\.example\.test/.test(request.url()))
        sourceRequests.push(request.url());
    });
    const { errors } = await openFixture(page, testInfo, { brokenImage: true });
    await page.locator(triggerSelector).first().hover();
    const card = page.locator(cardSelector);
    await expect(card).toBeVisible();
    await expect(card.locator('img')).toHaveCount(0);
    await expect(card).toContainText(
      'Official concert details and final show dates.',
    );
    await card.getByRole('button', { name: /Next/i }).click();
    await expect(card).toContainText('Official ticket website');
    expect(sourceRequests).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('shadow DOM basic-table previews use the shell portal', async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env['FOOTNOTE_BUILT'] === '1',
      'The source-only shadow harness is not a production entrypoint.',
    );
    const { errors } = await openFixture(page, testInfo, { shadow: true });
    await page.getByRole('table').locator(triggerSelector).first().hover();
    const card = page.locator(cardSelector);
    await expect(card).toBeVisible();
    expect(
      await card.evaluate(
        (element) => element.getRootNode() instanceof ShadowRoot,
      ),
    ).toBe(true);
    expect(
      await card.evaluate((element) =>
        Boolean(element.closest('[data-web-shell-portal-root]')),
      ),
    ).toBe(true);
    await card.getByRole('button', { name: /Next/i }).click();
    await expect(card).toContainText('Official ticket website');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

async function expectInsideViewport(page: Page, locator: Locator) {
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(10);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width - 10);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height);
}

test('source locator demo delegates the card link to its host panel', async ({
  page,
}, testInfo) => {
  test.skip(
    process.env['FOOTNOTE_BUILT'] === '1',
    'The interactive host demo is a source-only development entrypoint.',
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/e2e/footnote-citation-demo.html');

  await expect(
    page.getByRole('heading', { name: '订单主题分析' }),
  ).toBeVisible();
  const triggers = page.locator(triggerSelector);
  await expect(triggers).toHaveCount(2);
  await expect(triggers.first()).toHaveText('2');
  await expect(triggers.nth(1)).toHaveText('');
  const footerSelectorForDemo = '[data-web-shell-footnote-sources-trigger]';
  const footerTrigger = page.locator(footerSelectorForDemo);
  await expect(footerTrigger).toHaveText('3 个引用');
  const assistantFooter = footerTrigger.locator('..');
  await expect(assistantFooter).toHaveCSS('opacity', '0');
  await expect(page.locator('[data-footnotes]')).toHaveCount(0);
  const footerMetrics = await footerTrigger.evaluate((element) => {
    const footer = element.parentElement!;
    const citationIcon = element.querySelector<HTMLElement>(
      '[aria-hidden="true"]',
    )!;
    const copyIcon = footer.querySelector<SVGElement>(
      'button[aria-label="复制"] svg',
    )!;
    const time = footer.querySelector<HTMLElement>(
      ':scope > span[aria-hidden="true"]',
    )!;
    const center = (target: Element) => {
      const rect = target.getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    return {
      citationFontSize: getComputedStyle(element).fontSize,
      citationIconWidth: citationIcon.getBoundingClientRect().width,
      copyIconWidth: copyIcon.getBoundingClientRect().width,
      iconCenterOffset: center(citationIcon) - center(copyIcon),
      textCenterDelta: Math.abs(center(element) - center(time)),
      timeFontSize: getComputedStyle(time).fontSize,
    };
  });
  expect(footerMetrics).toMatchObject({
    citationFontSize: '11px',
    citationIconWidth: 14,
    copyIconWidth: 14,
    timeFontSize: '11px',
  });
  expect(footerMetrics.iconCenterOffset).toBe(0);
  expect(footerMetrics.textCenterDelta).toBeLessThan(0.1);
  const painted = await assistantFooter.evaluate(async (footer) => {
    const copy = footer.querySelector<SVGElement>(
      'button[aria-label="复制"] svg',
    )!;
    const citation = footer.querySelector<HTMLElement>(
      '[data-web-shell-footnote-sources-trigger] > span',
    )!;
    const mask = getComputedStyle(citation).maskImage;
    const maskUrl = mask.slice(4, -1).replace(/^"|"$/g, '');
    const measure = async (markup: string, element: Element) => {
      const svg = new DOMParser().parseFromString(
        markup,
        'image/svg+xml',
      ).documentElement;
      const size = 512;
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      const url = URL.createObjectURL(
        new Blob([new XMLSerializer().serializeToString(svg)], {
          type: 'image/svg+xml',
        }),
      );
      try {
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () =>
            reject(new Error('Cannot rasterize footer icon'));
          image.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        let minX = size,
          minY = size,
          maxX = -1,
          maxY = -1,
          alpha = 0,
          momentY = 0;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const opacity = pixels[(y * size + x) * 4 + 3];
            if (opacity >= 16) {
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
            }
            alpha += opacity;
            momentY += (y + 0.5) * opacity;
          }
        }
        const rect = element.getBoundingClientRect();
        return {
          width: ((maxX - minX + 1) / size) * rect.width,
          height: ((maxY - minY + 1) / size) * rect.height,
          centerY: rect.y + ((minY + maxY + 1) / 2 / size) * rect.height,
          centroidY: rect.y + (momentY / alpha / size) * rect.height,
        };
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    return {
      copy: await measure(new XMLSerializer().serializeToString(copy), copy),
      citation: await measure(await (await fetch(maskUrl)).text(), citation),
    };
  });
  expect(painted.copy.width).toBeGreaterThan(0);
  expect(painted.citation.width).toBeGreaterThan(0);
  expect(Math.abs(painted.citation.width - painted.copy.width)).toBeLessThan(
    0.5,
  );
  expect(Math.abs(painted.citation.height - painted.copy.height)).toBeLessThan(
    0.5,
  );
  expect(
    Math.abs(painted.citation.centerY - painted.copy.centerY),
  ).toBeLessThan(0.4);
  expect(
    Math.abs(painted.citation.centroidY - painted.copy.centroidY),
  ).toBeLessThan(0.4);

  const inlineMetrics = await triggers.nth(1).evaluate((element) => {
    const icon = element.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    const triggerRect = element.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    return {
      centerDelta: Math.abs(
        triggerRect.top +
          triggerRect.height / 2 -
          (iconRect.top + iconRect.height / 2),
      ),
      verticalAlign: getComputedStyle(element).verticalAlign,
    };
  });
  expect(inlineMetrics).toEqual({ centerDelta: 0, verticalAlign: 'middle' });
  const iconResources = await page
    .locator(`${triggerSelector} > span, ${footerSelectorForDemo} > span`)
    .evaluateAll(async (elements) =>
      Promise.all(
        elements.map(async (element) => {
          const mask = getComputedStyle(element).maskImage;
          const image = new Image();
          const width = await new Promise<number>((resolve) => {
            image.onload = () => resolve(image.naturalWidth);
            image.onerror = () => resolve(0);
            image.src = mask.slice(4, -1).replace(/^"|"$/g, '');
          });
          return { mask, width };
        }),
      ),
    );
  expect(iconResources).toHaveLength(3);
  expect(new Set(iconResources.map((icon) => icon.mask)).size).toBe(3);
  expect(iconResources.every((icon) => icon.width > 0)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('source-footnote-host-demo-idle.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await triggers.first().click();
  const card = page.locator(cardSelector);
  const sourceLink = card.getByRole('button', { name: '订单业务定义' });
  await expect(sourceLink).toHaveAttribute('href', '#');
  await sourceLink.click();
  const hostPanel = page.locator('[data-demo-source-panel]');
  await expect(hostPanel).toBeVisible();
  await expect(hostPanel).toContainText('OpenCode 已接管 locator');
  await expect(hostPanel).toContainText('semantic');
  await expect(hostPanel).toContainText('instance-a');
  await expect(hostPanel).toContainText('kb:order');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await footerTrigger.hover();
  await expect(assistantFooter).toHaveCSS('opacity', '1');
  await expect(card).toBeVisible();
  await expect(card).toContainText('1 / 3');

  await page.screenshot({
    path: testInfo.outputPath('source-footnote-host-demo.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
