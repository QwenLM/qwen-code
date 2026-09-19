import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

function message(record: number, text: string) {
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

async function setup(
  page: Page,
  baseURL: string | undefined,
  options: {
    count?: number;
    history?: boolean;
    theme?: string;
    language?: string;
  } = {},
) {
  const count = options.count ?? 40;
  const all = Array.from({ length: count }, (_, index) =>
    message(
      index,
      index === 3
        ? 'Archived UNIQUE-NEEDLE answer.'
        : index === count - 1
          ? '当前答复：中文检索\n\n```ts\nconst sampleNeedle = 42;\n```'
          : `Synthetic message ${index}`,
    ),
  );
  const live = options.history ? all.slice(-12) : all;
  const scenario = createWebShellDaemonScenario({
    sessionId: 'search-fixture',
    events: live,
  });
  if (options.history)
    scenario.capabilities.features.push(
      'session_turn_navigation',
      'session_transcript_pagination',
    );
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const anchors: string[] = [];
  await page.route(`${baseURL}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/workspace/models'))
      return route.fulfill({ json: { models: [] } });
    if (!options.history) return route.fallback();
    if (/\/session\/[^/]+\/(load|resume)$/.test(url.pathname)) {
      return route.fulfill({
        json: {
          sessionId: scenario.sessionId,
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
          historyAnchorRecordId: `record-${count - live.length}`,
        },
      });
    }
    if (url.pathname.endsWith('/turn-index')) {
      const totalTurns = count / 2;
      const limit = Number(url.searchParams.get('limit'));
      const start = Number(
        url.searchParams.get('start') ?? Math.max(0, totalTurns - limit),
      );
      return route.fulfill({
        json: {
          v: 1,
          sessionId: scenario.sessionId,
          snapshot: 'search-snapshot',
          totalTurns,
          start,
          turns: Array.from(
            { length: Math.min(limit, totalTurns - start) },
            (_, index) => ({
              ordinal: start + index,
              turnId: `record-${2 * (start + index)}`,
              kind: 'prompt',
              label: `Synthetic turn ${start + index}`,
            }),
          ),
        },
      });
    }
    if (url.pathname.endsWith('/transcript')) {
      const at = url.searchParams.get('atRecordId');
      const before = url.searchParams.get('beforeRecordId');
      const after = url.searchParams.get('afterRecordId');
      const cursor = url.searchParams.get('cursor');
      const backward = !!before || !!cursor?.startsWith('before:');
      const boundary = Number(
        (at ?? before ?? after ?? cursor)?.split(/[-:]/).at(-1),
      );
      const start = backward
        ? Math.max(0, boundary - 8)
        : boundary + (after ? 1 : 0);
      const end = backward ? boundary : Math.min(count, start + 8);
      const hasMore = backward ? start > 0 : end < count;
      if (at) anchors.push(at);
      return route.fulfill({
        json: {
          v: 1,
          sessionId: scenario.sessionId,
          events: all.slice(start, end),
          hasMore,
          ...(hasMore
            ? { nextCursor: backward ? `before:${start}` : `after:${end}` }
            : {}),
          ...(at ? { targetRecordId: at, hasOlder: start > 0 } : {}),
        },
      });
    }
    return route.fallback();
  });
  await page.goto(
    `/session/${scenario.sessionId}?theme=${options.theme ?? 'light'}&language=${options.language ?? 'en'}`,
  );
  await daemon.sse.waitForConnection(scenario.sessionId, { timeout: 30_000 });
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: live.length,
    }),
  );
  await expect(page.locator('[data-web-shell-message-list]')).toBeVisible();
  return { anchors };
}

const searchButton = (page: Page) =>
  page.getByRole('button', {
    name: /Search this conversation|搜索当前会话/,
    exact: true,
  });

for (const count of [10, 11]) {
  test(`conversation search defaults to strictly more than ten messages: ${count} @smoke`, async ({
    page,
    baseURL,
  }) => {
    await setup(page, baseURL, { count });
    await expect(
      page.getByText(`Synthetic message ${count - 2}`, { exact: true }),
    ).toBeVisible();
    await expect(searchButton(page)).toHaveCount(count > 10 ? 1 : 0);
  });
}

test('search locates persisted history outside the live window without changing a draft @smoke', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { anchors } = await setup(page, baseURL, { history: true });
  const prompt = page.locator('[data-web-shell-composer-editor] .cm-content');
  await prompt.click();
  await page.keyboard.type('Unsaved synthetic draft');
  await searchButton(page).click();
  const dialog = page.locator('[data-conversation-search]');
  const input = dialog.locator('input');
  await expect(input).toBeFocused();
  await input.fill('unique-needle');
  const hit = dialog
    .getByRole('button')
    .filter({ hasText: 'Archived UNIQUE-NEEDLE answer.' });
  await expect(hit).toBeVisible();
  await page.screenshot({ path: '/tmp/qwen-12231-search-history-dialog.png' });
  await hit.click();
  await expect(dialog).toHaveCount(0);
  const historical = page.locator('[data-history-viewport="historical"]');
  await expect(historical).toContainText('Archived UNIQUE-NEEDLE answer.');
  await expect(historical.locator('[class*="flash"]')).toBeVisible();
  await page.screenshot({ path: '/tmp/qwen-12231-search-history-located.png' });
  expect(anchors).toContain('record-2');
  await expect(prompt).toHaveText('Unsaved synthetic draft');
});

for (const theme of ['light', 'dark']) {
  for (const language of ['en', 'zh-CN']) {
    for (const width of [1440, 390]) {
      test(`conversation search content and layout ${theme} ${language} ${width} @smoke`, async ({
        page,
        baseURL,
      }) => {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        await setup(page, baseURL, { theme, language });
        const button = searchButton(page);
        const scroll = page.locator('[data-web-shell-message-list]');
        await scroll.hover();
        await page.mouse.wheel(0, -100000);
        const bottom = page.getByRole('button', {
          name: /Scroll to bottom|回到底部/,
          exact: true,
        });
        await expect(bottom).toBeVisible();
        const searchBox = await button.boundingBox();
        const bottomBox = await bottom.boundingBox();
        expect(searchBox!.x).toBeGreaterThan(bottomBox!.x + bottomBox!.width);
        await button.click();
        const dialog = page.locator('[data-conversation-search]');
        const input = dialog.locator('input');
        await input.fill('中文检索');
        await expect(dialog.locator('mark')).toHaveText('中文检索');
        await input.fill('sampleNeedle');
        await expect(dialog.locator('mark')).toHaveText('sampleNeedle');
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: `/tmp/qwen-12231-search-${theme}-${language}-${width}.png`,
        });
        await input.fill('nonexistent-synthetic-keyword');
        await expect(dialog.locator('ol > li')).toHaveCount(0);
        await expect(dialog.getByRole('status')).toContainText(
          /No matching messages|没有|未找到/,
        );
        await input.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(button).toBeFocused();
      });
    }
  }
}
