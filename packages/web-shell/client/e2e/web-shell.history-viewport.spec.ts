import { expect, test, type Locator } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  permissionRequestEvent,
  replayCompleteEvent,
  turnCompleteEvent,
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
      offset: row.getBoundingClientRect().top - top,
    };
  });
}

async function moveReadingPosition(
  scroll: Locator,
  direction: 'older' | 'newer',
) {
  await scroll.hover();
  const edgeDistance = () =>
    scroll.evaluate(
      (element, direction) =>
        direction === 'older'
          ? element.scrollTop
          : element.scrollHeight - element.clientHeight - element.scrollTop,
      direction,
    );
  for (const offset of [0, 80]) {
    await expect
      .poll(async () => {
        const delta = (await edgeDistance()) - offset;
        if (Math.abs(delta) > 2) {
          await scroll
            .page()
            .mouse.wheel(0, direction === 'older' ? -delta : delta);
        }
        return Math.abs((await edgeDistance()) - offset);
      })
      .toBeLessThanOrEqual(2);
  }
}

for (const pageRecords of [16, 200]) {
  test(`history viewport preserves the reading row across bounded ${pageRecords}-record pages`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const count = pageRecords * 12;
    const sessionId = `history-viewport-${pageRecords}`;
    const live = [
      recordEvent(count, 'LIVE prompt'),
      recordEvent(count + 1, 'LIVE answer'),
      turnCompleteEvent('live-prompt', { id: count + 20 }),
      permissionRequestEvent('live-approval', { id: count + 21, sessionId }),
    ];
    const scenario = createWebShellDaemonScenario({ sessionId, events: live });
    scenario.capabilities.features.push(
      'session_turn_navigation',
      'session_transcript_pagination',
    );
    const daemon = await installMockDaemon(page, scenario, { baseURL });
    const transcriptRequests: Array<{ start: number; end: number }> = [];
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
            lastEventId: count + 21,
            historyHasMore: true,
            historyAnchorRecordId: `record-${count}`,
          },
        });
      } else if (url.pathname.endsWith('/turn-index')) {
        const totalTurns = count / 2 + 1;
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
        const before = url.searchParams.get('beforeRecordId');
        const cursor = url.searchParams.get('cursor');
        const end = Number(
          before?.split('-').at(-1) ?? cursor?.split(':').at(-1),
        );
        const start = Math.max(0, end - pageRecords);
        transcriptRequests.push({ start, end });
        await route.fulfill({
          json: {
            v: 1,
            sessionId,
            events: Array.from({ length: end - start }, (_, index) =>
              recordEvent(start + index),
            ),
            hasMore: start > 0,
            ...(start > 0 ? { nextCursor: `before:${start}` } : {}),
          },
        });
      } else await route.fallback();
    });
    await page.goto(`/session/${sessionId}`);
    await daemon.sse.waitForConnection(sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId, replayedCount: live.length }),
    );
    await page
      .getByRole('button', { name: /^(Open earlier history|打开更早历史)$/ })
      .click();
    const viewport = page.locator('[data-history-viewport="historical"]');
    await expect(viewport).toBeVisible();
    const bootstrapEnd = transcriptRequests.at(-1)!.end;
    const scroll = viewport.locator('[data-web-shell-message-list]');
    const directions = [
      'older',
      'older',
      'older',
      'older',
      'older',
      'older',
      'newer',
      'newer',
    ] as const;
    for (const [round, direction] of directions.entries()) {
      await test.step(`${direction} admission ${round + 1}`, async () => {
        await moveReadingPosition(scroll, direction);
        const anchor = await readingAnchor(viewport);
        const requests = transcriptRequests.length;
        const button = viewport.getByRole('button', {
          name:
            direction === 'older'
              ? /^(Load earlier|加载更早记录)$/
              : /^(Load newer|加载较新记录)$/,
        });
        await button.click();
        await expect
          .poll(() => transcriptRequests.length)
          .toBeGreaterThan(requests);
        await expect(
          viewport.getByText(/^(Loading earlier messages…|正在加载更早消息…)$/),
        ).toHaveCount(0);
        await expect(viewport.locator('[role="alert"]')).toHaveCount(0);
        let stableAnchorSamples = 0;
        await expect
          .poll(
            async () => {
              const delta = await viewport.evaluate((root, anchor) => {
                const scroll = root.querySelector<HTMLElement>(
                  '[data-web-shell-message-list]',
                )!;
                const row = [
                  ...root.querySelectorAll<HTMLElement>(
                    '[data-source-block-ids]',
                  ),
                ].find((row) =>
                  row.dataset.sourceBlockIds
                    ?.split(',')
                    .includes(anchor.source),
                );
                return row
                  ? Math.abs(
                      row.getBoundingClientRect().top -
                        scroll.getBoundingClientRect().top -
                        anchor.offset,
                    )
                  : Number.MAX_VALUE;
              }, anchor);
              stableAnchorSamples = delta <= 2 ? stableAnchorSamples + 1 : 0;
              return stableAnchorSamples;
            },
            { intervals: [100] },
          )
          .toBeGreaterThanOrEqual(4);
        if (direction === 'newer') {
          await moveReadingPosition(scroll, 'newer');
          const expectedNewest = bootstrapEnd - pageRecords * (7 - round) - 1;
          await expect(scroll).toContainText(`HISTORY ${expectedNewest}`);
        }
      });
    }
    await expect(
      viewport.getByRole('button', { name: /第 \d+ 轮|Turn \d+/ }),
    ).toHaveCount(0);
    await expect(
      viewport.locator('[data-web-shell-permission-option]'),
    ).toHaveCount(0);
    await page
      .locator(
        '[data-web-shell-permission-option][data-option-id="allow_once"]',
      )
      .first()
      .click();
    await expect
      .poll(() => daemon.permissionRequests().length)
      .toBeGreaterThan(0);
    const anchor = await readingAnchor(viewport);
    await daemon.sendEvent({
      ...recordEvent(count + 3, 'BACKGROUND LIVE answer'),
      id: count + 40,
    });
    await page.waitForTimeout(250);
    expect(await readingAnchor(viewport)).toEqual(anchor);
    await viewport
      .getByRole('button', { name: /^(Return to latest|返回最新)$/ })
      .first()
      .click();
    await expect(page.locator('[data-history-viewport="live"]')).toContainText(
      'BACKGROUND LIVE answer',
    );
  });
}
