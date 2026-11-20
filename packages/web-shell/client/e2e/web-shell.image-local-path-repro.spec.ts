/**
 * Reproduction for issue #17452: a markdown image whose src is a local
 * filesystem path renders as a broken <img> placeholder with no fallback,
 * and any image whose load fails stays broken (no onError degradation).
 *
 * Assertions encode the EXPECTED behavior from the issue, so these tests
 * FAIL on the unfixed code and should PASS once the fix lands.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
  'base64',
);

async function openAssistantMessage(
  page: Page,
  info: TestInfo,
  markdown: string,
): Promise<void> {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Show the screenshot.', { id: 1 }),
      assistantTextEvent(markdown, { id: 2 }),
      turnCompleteEvent('image-repro', { id: 3 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(info.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?lang=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.getByText('Show the screenshot.')).toBeVisible();
}

/** Broken = load settled (complete) with no decoded pixels (naturalWidth 0). */
async function brokenImages(page: Page, alt: string): Promise<string[]> {
  return page
    .locator(`img[alt="${alt}"]`)
    .evaluateAll((imgs) =>
      imgs
        .filter(
          (el) =>
            (el as HTMLImageElement).complete &&
            (el as HTMLImageElement).naturalWidth === 0,
        )
        .map((el) => el.getAttribute('src') ?? '(no src attribute)'),
    );
}

test('issue-17452: local filesystem path image degrades to readable text, not a broken img', async ({
  page,
}, info) => {
  const localPath = '/Users/foo/Projects/demo/shot.png';
  const responses: Array<{ url: string; status: number }> = [];
  page.on('response', (res) => {
    if (res.url().includes(localPath)) {
      responses.push({ url: res.url(), status: res.status() });
    }
  });

  await openAssistantMessage(page, info, `![screenshot](${localPath})`);

  // Wait until either the buggy <img> settled as broken, or a fixed build
  // shows the path as text.
  await page.waitForFunction(
    (path) => {
      const img = document.querySelector<HTMLImageElement>(
        'img[alt="screenshot"]',
      );
      if (img) return img.complete;
      return document.body.textContent?.includes(path) ?? false;
    },
    localPath,
    { timeout: 20_000 },
  );

  const broken = await brokenImages(page, 'screenshot');
  const bodyHasPath = await page.evaluate(
    (path) => document.body.textContent?.includes(path) ?? false,
    localPath,
  );
  console.log(
    `[issue-17452 evidence] network responses for local path: ${JSON.stringify(responses)}; broken img srcs: ${JSON.stringify(broken)}; path visible as text: ${bodyHasPath}`,
  );
  info.annotations.push({
    type: 'evidence',
    description: `responses=${JSON.stringify(responses)} brokenImgs=${JSON.stringify(broken)} pathAsText=${bodyHasPath}`,
  });

  // Expected behavior per the issue: no broken placeholder; the path is
  // rendered as readable, selectable text.
  expect(broken).toEqual([]);
  expect(bodyHasPath).toBe(true);
});

test('issue-17452: image whose load fails degrades to readable text, not a broken img', async ({
  page,
}, info) => {
  const deadUrl = 'https://example.invalid/missing-chart.png';
  await page.route(deadUrl, async (route) => {
    await route.fulfill({ status: 404, body: 'not found' });
  });

  await openAssistantMessage(page, info, `![chart](${deadUrl})`);

  // The fallback chip shows the alt text OR the src (issue contract), and
  // replaces the img in the same render, so wait for either outcome.
  await page.waitForFunction(
    () => {
      const text = document.body.textContent ?? '';
      if (text.includes('missing-chart.png') || text.includes('chart')) {
        return true;
      }
      const img = document.querySelector<HTMLImageElement>('img[alt="chart"]');
      return img !== null && img.complete;
    },
    undefined,
    { timeout: 20_000 },
  );

  const broken = await brokenImages(page, 'chart');
  const fallbackText = await page.evaluate(() => {
    const text = document.body.textContent ?? '';
    return text.includes('missing-chart.png') || text.includes('chart');
  });
  console.log(
    `[issue-17452 evidence] dead https link: broken img srcs: ${JSON.stringify(broken)}; fallback text present: ${fallbackText}`,
  );
  info.annotations.push({
    type: 'evidence',
    description: `brokenImgs=${JSON.stringify(broken)} fallbackText=${fallbackText}`,
  });

  expect(broken).toEqual([]);
  expect(fallbackText).toBe(true);
});

test('issue-17452 control: a valid same-origin image still renders', async ({
  page,
}, info) => {
  await page.route('**/e2e/repro-image-ok.png', async (route) => {
    await route.fulfill({ contentType: 'image/png', body: PNG_1PX });
  });

  await openAssistantMessage(
    page,
    info,
    '![ok-image](/e2e/repro-image-ok.png)',
  );

  await expect
    .poll(() =>
      page
        .locator('img[alt="ok-image"]')
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
});
