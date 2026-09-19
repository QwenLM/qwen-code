import { expect, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './mockDaemon';

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

export async function setupConversationSearch(
  page: Page,
  baseURL: string | undefined,
  options: {
    count?: number;
    history?: boolean;
    theme?: string;
    language?: string;
    externalNavigation?: boolean;
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
      if (url.searchParams.has('start') && !url.searchParams.has('snapshot')) {
        return route.fulfill({
          status: 400,
          json: { error: '`start` requires `snapshot`' },
        });
      }
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
    `${options.externalNavigation ? '/e2e/message-navigation-harness.html?sessionId=' : '/session/'}${scenario.sessionId}${options.externalNavigation ? '&' : '?'}theme=${options.theme ?? 'light'}&language=${options.language ?? 'en'}`,
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
