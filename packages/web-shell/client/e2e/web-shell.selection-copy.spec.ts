import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const reply =
  '## Selection copying\n\nSelect **bold words** in this reply.\n\nThe result is $x^2 + 1$ units.\n\nBefore ![diagram](/e2e/selection-copy.png) after.';

async function dragParagraph(page: Page, paragraph: Locator) {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const start = await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild!, 0);
    range.setEnd(element.firstChild!, 1);
    const rect = range.getBoundingClientRect();
    const last = element.lastChild!;
    range.setStart(last, last.textContent!.length - 1);
    range.setEnd(last, last.textContent!.length);
    const end = range.getBoundingClientRect();
    return {
      x: rect.left + 1,
      y: rect.top + rect.height / 2,
      endX: end.right - 1,
      endY: end.top + end.height / 2,
    };
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.endX, start.endY, { steps: 12 });
  await page.mouse.up();
}

async function dragBoldSubstring(
  page: Page,
  paragraph: Locator,
  releaseOutside = false,
) {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const points = await paragraph.locator('strong').evaluate((element) => {
    const text = element.firstChild!;
    const first = document.createRange();
    first.setStart(text, 0);
    first.setEnd(text, 1);
    const last = document.createRange();
    last.setStart(text, 3);
    last.setEnd(text, 4);
    const start = first.getBoundingClientRect();
    const end = last.getBoundingClientRect();
    return {
      x1: start.left + 1,
      y1: start.top + start.height / 2,
      x2: end.right - 1,
      y2: end.top + end.height / 2,
    };
  });
  await page.mouse.move(points.x1, points.y1);
  await page.mouse.down();
  const paragraphBox = await paragraph.boundingBox();
  await page.mouse.move(
    releaseOutside ? paragraphBox!.x + paragraphBox!.width + 8 : points.x2,
    points.y2,
    { steps: 12 },
  );
  await page.mouse.up();
}

test('partial mouse selection offers plain text and Markdown copying without changing whole-reply copy', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/e2e/selection-copy.png', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    }),
  );
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Show formatted text.', { id: 1 }),
      assistantTextEvent(reply, { id: 2 }),
      turnCompleteEvent('selection-copy', { id: 3 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?theme=light&lang=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  const heading = page.getByRole('heading', { name: 'Selection copying' });
  await expect(heading).toBeVisible();
  const row = page
    .locator('[data-web-shell-message-row]')
    .filter({ has: heading });
  await expect
    .poll(() =>
      row
        .locator('img')
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
  const paragraph = row.locator('p').filter({ hasText: 'Select' });
  const plain = page.getByRole('button', {
    name: 'Copy plain text',
    exact: true,
  });
  const markdown = page.getByRole('button', {
    name: 'Copy Markdown',
    exact: true,
  });

  for (const [button, expected] of [
    [plain, 'bold'],
    [markdown, '**bold**'],
  ] as const) {
    await dragBoldSubstring(page, paragraph);
    await expect(plain).toBeVisible();
    await expect(markdown).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      'bold',
    );
    await button.click();
    await expect(plain).toHaveCount(0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      expected,
    );
  }

  for (const [button, expected] of [
    [plain, 'bold words in this reply.'],
    [markdown, '**bold words** in this reply.'],
  ] as const) {
    await dragBoldSubstring(page, paragraph, true);
    await expect(plain).toBeVisible();
    await expect(markdown).toBeVisible();
    await button.click();
    await expect(plain).toHaveCount(0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      expected,
    );
  }

  await dragBoldSubstring(page, paragraph);
  await expect(markdown).toBeVisible();
  const firstMenuBox = await markdown.boundingBox();
  await dragParagraph(
    page,
    row.locator('p').filter({ hasText: 'The result is' }),
  );
  await expect(markdown).toBeVisible();
  await expect
    .poll(async () =>
      Math.abs((await markdown.boundingBox())!.y - firstMenuBox!.y),
    )
    .toBeGreaterThan(10);
  await page.keyboard.press('Escape');

  await dragBoldSubstring(page, paragraph);
  await expect(plain).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(plain).toHaveCount(0);
  await dragBoldSubstring(page, paragraph);
  await expect(plain).toBeVisible();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(plain).toHaveCount(0);

  for (const [label, text, formatted] of [
    [
      'The result is',
      'The result is x^2 + 1 units.',
      'The result is $x^2 + 1$ units.',
    ],
    [
      'Before',
      'Before diagram after.',
      'Before ![diagram](/e2e/selection-copy.png) after.',
    ],
  ]) {
    for (const [button, expected] of [
      [plain, text],
      [markdown, formatted],
    ] as const) {
      await dragParagraph(page, row.locator('p').filter({ hasText: label }));
      await expect(button).toBeVisible();
      await button.click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        expected,
      );
    }
  }

  await dragBoldSubstring(page, paragraph);
  await expect(plain).toBeVisible();
  const clipboardState = await page.evaluateHandle(() => ({
    write: navigator.clipboard.writeText,
    exec: document.execCommand,
  }));
  try {
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error('denied');
      };
      document.execCommand = () => false;
    });
    await plain.click();
    await expect(plain).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      'bold',
    );
  } finally {
    await clipboardState.evaluate((state) => {
      navigator.clipboard.writeText = state.write;
      document.execCommand = state.exec;
    });
    await clipboardState.dispose();
  }
  await plain.click();
  await expect(plain).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'bold',
  );

  await row.hover();
  await row.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(reply);
});

test('copies through the real clipboard fallback from a ShadowRoot menu', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Check fallback copying.', { id: 1 }),
      assistantTextEvent('## Shadow copy\n\nSelect **bold words** here.', {
        id: 2,
      }),
      turnCompleteEvent('shadow-selection-copy', { id: 3 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(
    `/e2e/table-fullscreen-shadow.html?sessionId=${scenario.sessionId}`,
  );
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  const row = page.locator('[data-web-shell-message-row]').filter({
    has: page.getByRole('heading', { name: 'Shadow copy' }),
  });
  await expect(row).toBeVisible();
  await dragBoldSubstring(page, row.locator('p'));
  const button = page.getByRole('button', {
    name: 'Copy Markdown',
    exact: true,
  });
  await expect(button).toBeVisible();
  const clipboard = await page.evaluateHandle(() => navigator.clipboard);
  try {
    await clipboard.evaluate((value) => value.writeText('SENTINEL'));
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: undefined,
      }),
    );
    await button.click();
    await expect(button).toHaveCount(0);
    expect(await clipboard.evaluate((value) => value.readText())).toBe(
      '**bold**',
    );
  } finally {
    await clipboard.evaluate((value) =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value,
      }),
    );
    await clipboard.dispose();
  }
});
