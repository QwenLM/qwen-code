import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

const TURNS = 20;

function recordEvent(record: number, text: string) {
  return {
    v: 1 as const,
    id: record + 10,
    type: 'session_update' as const,
    data: {
      update: {
        sessionUpdate:
          record % 2 ? 'agent_message_chunk' : 'user_message_chunk',
        content: { type: 'text', text },
        _meta: {
          'qwen.session.recordId': `record-${record}`,
          qwenTranscript: { sourceRecordIds: [`record-${record}`] },
        },
      },
    },
  };
}

function ariaOrdinal(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const current = document.querySelector(
      '[data-global-turn-navigation] [aria-current]',
    );
    const ordinal = current?.getAttribute('data-turn-ordinal');
    return ordinal === null || ordinal === undefined ? null : Number(ordinal);
  });
}

function inRangeCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.querySelectorAll(
        '[data-global-turn-navigation] [data-in-current-range]',
      ).length,
  );
}

async function scrollTranscriptTo(page: Page, ratio: number) {
  await page.evaluate((value) => {
    const el = document.querySelector<HTMLElement>(
      '[data-web-shell-message-list]',
    );
    if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) * value;
  }, ratio);
}

test('global turn navigation follows transcript scrolling @smoke', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const live = Array.from({ length: TURNS * 2 }, (_, index) =>
    recordEvent(
      index,
      `${index % 2 ? 'ANSWER' : 'QUESTION'} ${index} ` +
        'lorem ipsum dolor sit amet '.repeat(30),
    ),
  );
  const sessionId = 'scroll-follow-global-nav';
  const scenario = createWebShellDaemonScenario({ sessionId, events: live });
  scenario.capabilities.features.push(
    'session_turn_navigation',
    'session_transcript_pagination',
  );
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.route(`${baseURL}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/turn-index')) {
      const limit = Number(url.searchParams.get('limit'));
      const start = Number(
        url.searchParams.get('start') ?? Math.max(0, TURNS - limit),
      );
      await route.fulfill({
        json: {
          v: 1,
          sessionId,
          snapshot: 'mock-snapshot',
          totalTurns: TURNS,
          start,
          turns: Array.from(
            { length: Math.min(limit, TURNS - start) },
            (_, index) => ({
              ordinal: start + index,
              turnId: `record-${2 * (start + index)}`,
              kind: 'prompt',
              label: `Turn ${start + index}`,
            }),
          ),
        },
      });
    } else {
      await route.fallback();
    }
  });
  await page.goto(`/session/${sessionId}`);
  await daemon.sse.waitForConnection(sessionId, { timeout: 30_000 });
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId, replayedCount: live.length }),
  );
  const rail = page.locator('[data-global-turn-navigation]');
  await expect(rail).toBeVisible();
  await expect(
    page.locator('[data-web-shell-message-row]').first(),
  ).toBeVisible();
  await expect
    .poll(() =>
      rail
        .locator('div')
        .first()
        .evaluate((element) => getComputedStyle(element).scrollbarWidth),
    )
    .toBe('none');

  // The rail highlights the reading position without any click.
  await expect.poll(() => ariaOrdinal(page)).not.toBeNull();
  const atBottom = (await ariaOrdinal(page))!;
  expect(atBottom).toBeGreaterThanOrEqual(TURNS - 6);
  await expect.poll(() => inRangeCount(page)).toBeGreaterThan(0);

  // Scrolling up moves the highlight to older turns.
  await scrollTranscriptTo(page, 0.3);
  await expect.poll(() => ariaOrdinal(page)).toBeLessThan(atBottom - 3);
  const inMiddle = (await ariaOrdinal(page))!;

  // The highlight reaches the first turn at the scroll top.
  await scrollTranscriptTo(page, 0);
  await expect.poll(() => ariaOrdinal(page)).toBe(0);

  // Scrolling back down moves it to newer turns again.
  await scrollTranscriptTo(page, 0.9);
  await expect.poll(() => ariaOrdinal(page)).toBeGreaterThan(inMiddle + 3);

  // Clicking a tick still jumps, and the highlight lands on the jumped turn.
  await rail
    .locator('div')
    .first()
    .evaluate((element) => {
      element.scrollTop = 0;
    });
  await rail.locator('[data-turn-ordinal="0"]').click();
  await expect
    .poll(() => ariaOrdinal(page), { timeout: 15_000 })
    .toBeLessThanOrEqual(3);
});
