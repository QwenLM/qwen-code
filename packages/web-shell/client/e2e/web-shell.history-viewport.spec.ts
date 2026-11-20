import { expect, test, type Locator } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

function recordEvent(record: number, text = `HISTORY ${record}`) {
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

async function readingAnchor(viewport: Locator) {
  return viewport.evaluate((root) => {
    const scroll = root.querySelector<HTMLElement>(
      '[data-web-shell-message-list]',
    )!;
    const top = scroll.getBoundingClientRect().top;
    const row = [
      ...root.querySelectorAll<HTMLElement>('[data-source-block-ids]'),
    ].find(
      (row) =>
        row.getBoundingClientRect().bottom > top &&
        row.getBoundingClientRect().top < top + scroll.clientHeight,
    )!;
    return {
      source: row.dataset.sourceBlockIds!.split(',')[0],
      rowKey: row.dataset.messageRowKey,
      offset: row.getBoundingClientRect().top - top,
    };
  });
}

async function historyScenario(
  page: import('@playwright/test').Page,
  baseURL: string | undefined,
  pageRecords: number,
  options: { answer?: (record: number) => string } = {},
) {
  // Even records are prompts, odd records are answers.
  const event = (record: number) =>
    recordEvent(
      record,
      record % 2 && options.answer ? options.answer(record) : undefined,
    );
  await page.setViewportSize({ width: 1600, height: 900 });
  const count = pageRecords * 12;
  const sessionId = `history-navigation-${pageRecords}`;
  const live = Array.from({ length: 40 }, (_, index) =>
    recordEvent(count + index, `LIVE ${count + index}`),
  );
  const scenario = createWebShellDaemonScenario({ sessionId, events: live });
  scenario.capabilities.features.push(
    'session_turn_navigation',
    'session_transcript_pagination',
  );
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const requests: Array<{ start: number; end: number; anchored: boolean }> = [];
  let hold = false;
  let fail = false;
  let release: (() => void) | undefined;
  await page.route(`${baseURL}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (/\/session\/[^/]+\/(load|resume)$/.test(url.pathname)) {
      await route.fulfill({
        json: {
          sessionId,
          workspaceCwd: scenario.workspaceCwd,
          attached: true,
          createdAt: new Date().toISOString(),
          hasActivePrompt: false,
          clientId: scenario.clientId,
          state: scenario.state,
          compactedReplay: live,
          liveJournal: [],
          lastEventId: count + 60,
          historyHasMore: true,
          historyAnchorRecordId: `record-${count}`,
        },
      });
    } else if (url.pathname.endsWith('/turn-index')) {
      const totalTurns = (count + 40) / 2;
      const limit = Number(url.searchParams.get('limit'));
      const start = Number(
        url.searchParams.get('start') ?? Math.max(0, totalTurns - limit),
      );
      await route.fulfill({
        json: {
          v: 1,
          sessionId,
          snapshot: 'mock-snapshot',
          totalTurns,
          start,
          turns: Array.from(
            { length: Math.min(limit, totalTurns - start) },
            (_, index) => ({
              ordinal: start + index,
              turnId: `record-${2 * (start + index)}`,
              kind: 'prompt',
              label: `History ${start + index}`,
            }),
          ),
        },
      });
    } else if (url.pathname.endsWith('/transcript')) {
      const at = url.searchParams.get('atRecordId');
      const before = url.searchParams.get('beforeRecordId');
      const after = url.searchParams.get('afterRecordId');
      const cursor = url.searchParams.get('cursor');
      const backward = !!before || cursor?.startsWith('before:');
      const boundary = Number(
        (at ?? before ?? after ?? cursor)?.split(/[-:]/).at(-1),
      );
      const start = backward
        ? Math.max(0, boundary - pageRecords)
        : boundary + (after ? 1 : 0);
      const end = backward
        ? boundary
        : Math.min(count + 40, start + pageRecords);
      requests.push({ start, end, anchored: !!at });
      if (hold && !at)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (fail && !at) {
        await route.fulfill({ status: 500, json: { error: 'page failed' } });
        return;
      }
      await route.fulfill({
        json: {
          v: 1,
          sessionId,
          events: Array.from({ length: end - start }, (_, index) =>
            event(start + index),
          ),
          hasMore: backward ? start > 0 : end < count + 40,
          ...((backward ? start > 0 : end < count + 40)
            ? { nextCursor: backward ? `before:${start}` : `after:${end}` }
            : {}),
          ...(at ? { targetRecordId: at, hasOlder: start > 0 } : {}),
        },
      });
    } else await route.fallback();
  });
  await page.goto(`/session/${sessionId}`);
  // CPU-throttled browser startup can exceed the transport's default 10s.
  await daemon.sse.waitForConnection(sessionId, { timeout: 30_000 });
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId, replayedCount: live.length }),
  );
  return {
    count,
    sessionId,
    daemon,
    requests,
    hold: () => {
      hold = true;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    release: () => {
      hold = false;
      release?.();
      release = undefined;
    },
  };
}

test('continuous history preserves the original upward loader with global navigation enabled @smoke', async ({
  page,
  baseURL,
}) => {
  const { requests } = await historyScenario(page, baseURL, 16);
  const scroll = page.locator('[data-web-shell-message-list]');
  await expect(page.locator('[data-global-turn-navigation]')).toBeVisible();
  await expect(
    page.getByText(
      /Historical snapshot|历史快照|Open earlier history|打开更早历史/,
    ),
  ).toHaveCount(0);
  await scroll.hover();
  await page.mouse.wheel(0, -100000);
  await expect
    .poll(() => requests.filter((request) => !request.anchored).length)
    .toBeGreaterThan(0);
  await expect(page.locator('[data-history-viewport="live"]')).toBeVisible();
});

for (const pageRecords of [16, 200]) {
  test(`global turn navigation preserves the reading row across bounded ${pageRecords}-record pages @smoke`, async ({
    page,
    baseURL,
  }) => {
    if (pageRecords === 200) {
      // 4x CPU throttling over a 2,400-record fixture ran at 75-91% of the
      // shared 60s budget and timed out on all 3 attempts on CI (#11736); the
      // 120s budget held on hosted runners but not on the loaded ECS pool —
      // on 2026-10-26 it timed out on all attempts of three unrelated PR runs
      // (40285903183, 40297391221, 40337428619), each 367/368 green otherwise.
      test.setTimeout(300_000);
      const client = await page.context().newCDPSession(page);
      await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    const fixture = await historyScenario(page, baseURL, pageRecords);
    const ordinal = (fixture.count - 2 * pageRecords) / 2;
    const rail = page.locator('[data-global-turn-navigation]');
    await expect(rail).toBeVisible();
    await rail
      .locator('div')
      .first()
      .evaluate((element, ordinal) => {
        const item = element.querySelector<HTMLElement>('[aria-setsize]')!;
        element.scrollTop =
          ordinal *
          (element.scrollHeight / Number(item.getAttribute('aria-setsize')));
      }, ordinal);
    await rail.locator(`[data-turn-ordinal="${ordinal}"]`).click();
    const viewport = page.locator('[data-history-viewport="historical"]');
    await expect(viewport).toBeVisible();
    await expect
      .poll(() => fixture.requests.filter((request) => request.anchored).length)
      .toBe(1);
    const scroll = viewport.locator('[data-web-shell-message-list]');
    await expect(scroll).toContainText(`HISTORY ${ordinal * 2}`);
    for (const direction of [
      'older',
      'older',
      'older',
      'older',
      'older',
      'older',
      'newer',
      'newer',
    ] as const) {
      await test.step(`scroll ${direction}`, async () => {
        fixture.hold();
        const previous = fixture.requests.length;
        await scroll.hover();
        await page.mouse.wheel(0, direction === 'older' ? -100000 : 100000);
        await expect
          .poll(() => fixture.requests.length)
          .toBeGreaterThan(previous);
        const anchor = await readingAnchor(viewport);
        const pill = viewport.locator('[role="status"]').locator('..');
        await expect(pill).toBeVisible();
        const row = viewport.locator('[data-web-shell-message-row]').first();
        const composer = page.locator('[data-web-shell-composer]');
        for (const content of [row, composer]) {
          await expect
            .poll(async () => {
              const pillBox = await pill.boundingBox();
              const contentBox = await content.boundingBox();
              if (!pillBox || !contentBox) return Infinity;
              return Math.abs(
                pillBox.x +
                  pillBox.width / 2 -
                  (contentBox.x + contentBox.width / 2),
              );
            })
            .toBeLessThanOrEqual(1);
        }
        fixture.release();
        await expect(viewport.locator('[role="status"]')).toHaveCount(0);
        await expect(viewport.locator('[role="alert"]')).toHaveCount(0);
        await expect
          .poll(async () => {
            return viewport.evaluate((root, anchor) => {
              const scroll = root.querySelector<HTMLElement>(
                '[data-web-shell-message-list]',
              )!;
              const row = [
                ...root.querySelectorAll<HTMLElement>('[data-message-row-key]'),
              ].find((row) => row.dataset.messageRowKey === anchor.rowKey);
              return row
                ? Math.abs(
                    row.getBoundingClientRect().top -
                      scroll.getBoundingClientRect().top -
                      anchor.offset,
                  )
                : Number.MAX_VALUE;
            }, anchor);
          })
          .toBeLessThanOrEqual(2);
      });
    }
    await expect(rail).toBeVisible();
    const anchor = await readingAnchor(viewport);
    await fixture.daemon.sendEvent({
      ...recordEvent(fixture.count + 41, 'BACKGROUND LIVE answer'),
      id: fixture.count + 100,
    });
    await page.waitForTimeout(250);
    expect(await readingAnchor(viewport)).toEqual(anchor);
    await expect(viewport).not.toContainText('BACKGROUND LIVE answer');
    await page
      .getByRole('button', { name: /Scroll to bottom|回到底部/ })
      .click();
    await expect(page.locator('[data-history-viewport="live"]')).toContainText(
      'BACKGROUND LIVE answer',
    );
  });
}

test('stacks the pinned prompt below the history error banner, and its Retry loads the page', async ({
  page,
  baseURL,
}) => {
  const pageRecords = 16;
  // Answers taller than the viewport, so a prompt row can be above it.
  const fixture = await historyScenario(page, baseURL, pageRecords, {
    answer: (record) =>
      `ANSWER ${record} ` + 'lorem ipsum dolor sit amet '.repeat(400),
  });
  const ordinal = (fixture.count - 2 * pageRecords) / 2;
  const rail = page.locator('[data-global-turn-navigation]');
  await expect(rail).toBeVisible();
  await rail
    .locator('div')
    .first()
    .evaluate((element, ordinal) => {
      const item = element.querySelector<HTMLElement>('[aria-setsize]')!;
      element.scrollTop =
        ordinal *
        (element.scrollHeight / Number(item.getAttribute('aria-setsize')));
    }, ordinal);
  await rail.locator(`[data-turn-ordinal="${ordinal}"]`).click();
  const viewport = page.locator('[data-history-viewport="historical"]');
  await expect(viewport).toBeVisible();
  const scroll = viewport.locator('[data-web-shell-message-list]');
  await expect(scroll).toContainText(`ANSWER ${ordinal * 2 + 1}`);

  // The older page fails, so the error banner stays.
  fixture.fail(true);
  const previous = fixture.requests.length;
  await scroll.hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => fixture.requests.length).toBeGreaterThan(previous);
  const alert = viewport.locator('[role="alert"]');
  await expect(alert).toBeVisible();

  // Put the first answer under the top edge, with its prompt row above it.
  await scroll.evaluate((element) => {
    const answer = [
      ...element.querySelectorAll('[data-web-shell-message-row]'),
    ].find((row) => row.textContent?.includes('ANSWER'))!;
    element.scrollTop +=
      answer.getBoundingClientRect().top -
      element.getBoundingClientRect().top +
      200;
  });
  const pinned = viewport.locator('[data-pinned-turn-prompt]');
  await expect(pinned).toBeVisible();
  await expect(alert).toBeVisible();
  const bannerBox = (await alert.locator('..').boundingBox())!;
  const pinnedBox = (await pinned.boundingBox())!;
  expect(pinnedBox.y).toBeGreaterThanOrEqual(bannerBox.y + bannerBox.height);

  // Retry takes the click through the top stack, which passes other clicks
  // to the transcript.
  fixture.fail(false);
  const failed = fixture.requests.length;
  await alert.getByRole('button').click();
  await expect.poll(() => fixture.requests.length).toBeGreaterThan(failed);
  await expect(alert).toHaveCount(0);
});
