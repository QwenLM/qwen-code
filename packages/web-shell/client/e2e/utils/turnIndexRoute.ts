import type { Page, Route } from '@playwright/test';

export interface TurnIndexMock {
  sessionId: string;
  totalTurns: number;
  /** The record id of the prompt that starts a turn. */
  turnId: (ordinal: number) => string;
  label: (ordinal: number) => string;
  snapshot?: string;
}

/**
 * Answers a `/turn-index` request the way the daemon route does: the newest
 * page when no `start` is given, and a 400 for a `start` without the
 * `snapshot` of the page it continues.
 */
export function fulfillTurnIndex(route: Route, url: URL, mock: TurnIndexMock) {
  if (url.searchParams.has('start') && !url.searchParams.has('snapshot')) {
    return route.fulfill({
      status: 400,
      json: { error: '`start` requires `snapshot`' },
    });
  }
  const limit = Number(url.searchParams.get('limit'));
  const start = Number(
    url.searchParams.get('start') ?? Math.max(0, mock.totalTurns - limit),
  );
  return route.fulfill({
    json: {
      v: 1,
      sessionId: mock.sessionId,
      snapshot: mock.snapshot ?? 'mock-snapshot',
      totalTurns: mock.totalTurns,
      start,
      turns: Array.from(
        { length: Math.min(limit, mock.totalTurns - start) },
        (_, index) => ({
          ordinal: start + index,
          turnId: mock.turnId(start + index),
          kind: 'prompt',
          label: mock.label(start + index),
        }),
      ),
    },
  });
}

/** Routes the mock daemon's `/turn-index` requests to `fulfillTurnIndex`. */
export function installTurnIndexRoute(
  page: Page,
  baseURL: string | undefined,
  mock: TurnIndexMock,
) {
  return page.route(`${baseURL}/**`, (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/turn-index')) return route.fallback();
    return fulfillTurnIndex(route, url, mock);
  });
}
