/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

/**
 * Turns in the served page. Five rows each — header, prompt, request, answer,
 * tool — is well past what fits, which is the point: the grid is virtualized,
 * so every assertion about scrolling needs rows that are not all mounted.
 */
const TURNS = 40;
const ROWS_PER_TURN = 5;
/**
 * Turns start a minute apart and each is busy for about a second, so the
 * overview's idle-time cut is what makes the spans wide enough to click.
 */
const SESSION_START = 1_760_000_000_000;
const turnStart = (turn: number) => SESSION_START + turn * 60_000;

function sessionUpdate(update: Record<string, unknown>): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: update,
  } as unknown as DaemonEvent;
}

function recordMeta(recordId: string): Record<string, unknown> {
  return {
    qwenTranscript: { sourceRecordIds: [recordId], segmentId: `${recordId}:0` },
    'qwen.session.recordId': recordId,
  };
}

/**
 * One page of transcript events in the shape paged replay produces: a prompt,
 * a request timing frame, an answer, and a tool call whose own frame carries
 * its duration.
 */
function transcriptEvents(turns: number, firstTurn = 1): DaemonEvent[] {
  const events: DaemonEvent[] = [];
  for (let turn = firstTurn; turn < firstTurn + turns; turn += 1) {
    const callId = `call_${String(turn).padStart(4, '0')}`;
    events.push(
      sessionUpdate({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: `Prompt number ${turn}` },
        _meta: recordMeta(`rec-${turn}-user`),
      }),
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          timing: {
            kind: 'request',
            durationMs: 1000 + turn,
            startedAt: turnStart(turn),
            ttftMs: 400 + turn,
            status: 'ok',
            model: 'qwen3.8-max',
            responseId: `chatcmpl-${turn}`,
          },
          'qwen.session.recordId': `rec-${turn}-timing`,
        },
      }),
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Answer number ${turn}` },
        _meta: recordMeta(`rec-${turn}-answer`),
      }),
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        status: 'in_progress',
        title: `ReadFile: note-${turn}.txt`,
        kind: 'read',
        rawInput: { file_path: `/workspace/demo/note-${turn}.txt` },
        _meta: { toolName: 'read_file', ...recordMeta(`rec-${turn}-call`) },
      }),
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          timing: {
            kind: 'tool',
            durationMs: 20 + turn,
            // The request's end: the tool ran as soon as the model asked.
            startedAt: turnStart(turn) + 1000 + turn,
            callId,
            toolName: 'read_file',
            toolStatus: 'success',
          },
          'qwen.session.recordId': `rec-${turn}-tooltiming`,
        },
      }),
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status: 'completed',
        _meta: { toolName: 'read_file', ...recordMeta(`rec-${turn}-result`) },
      }),
    );
  }
  return events;
}

async function openTrajectory(
  page: Page,
  baseURL: string,
  options: {
    hasMore?: boolean;
    transcriptPage?: WebShellDaemonScenario['transcriptPage'];
  } = {},
): Promise<Locator> {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: '/tmp/qwen-web-shell-e2e',
    transcriptPage: options.transcriptPage ?? {
      events: transcriptEvents(TURNS),
      ...(options.hasMore ? { hasMore: true } : {}),
    },
  });
  await installMockDaemon(page, scenario, { baseURL });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Toggle right panel' }).click();
  await page.getByTestId('right-panel-open-trajectory').click();
  const grid = page.getByTestId('trajectory-rows');
  await expect(grid).toBeVisible();
  return grid;
}

function overviewSpans(page: Page): Locator {
  return page.locator(
    '[data-testid="trajectory-overview"] [data-testid="trajectory-span"]',
  );
}

async function activeRowOf(page: Page, grid: Locator): Promise<Locator> {
  const active = await grid.getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  // Matched as an attribute, not as `#id`: React's `useId` puts colons in
  // the value, which a CSS id selector cannot carry.
  return page.locator(`[id="${active}"]`);
}

/** Rows the virtualizer has mounted, which is never the whole page. */
function mountedRows(page: Page): Locator {
  return page.locator('[data-testid="trajectory-rows"] [role="row"]');
}

test.describe('trajectory panel', () => {
  test('shows what each request and tool cost @smoke', async ({
    page,
  }, testInfo) => {
    const grid = await openTrajectory(
      page,
      String(testInfo.project.use.baseURL),
    );

    await expect(grid).toHaveAttribute(
      'aria-rowcount',
      String(TURNS * ROWS_PER_TURN),
    );
    // The tail is where the panel opens: the newest turn is the one the reader
    // just watched run. Asserted on the real row rather than on a scroll
    // offset, because a stale offset leaves rows mounted below the viewport.
    const lastRow = mountedRows(page).last();
    await expect(lastRow).toHaveAttribute(
      'aria-rowindex',
      String(TURNS * ROWS_PER_TURN),
    );
    await expect(lastRow).toBeInViewport();

    const lastRequest = page
      .locator('[data-testid="trajectory-row-request"]')
      .last();
    await expect(lastRequest).toContainText('qwen3.8-max');
    await expect(lastRequest).toContainText(
      `${((1000 + TURNS) / 1000).toFixed(1)}s`,
    );
    await expect(
      page.locator('[data-testid="trajectory-row-tool"]').last(),
    ).toContainText('read_file');
  });

  test('keeps its rows through the fullscreen toggle @smoke', async ({
    page,
  }, testInfo) => {
    const grid = await openTrajectory(
      page,
      String(testInfo.project.use.baseURL),
    );
    const before = await mountedRows(page).count();
    expect(before).toBeGreaterThan(0);

    // Hiding the dock resets its scroll offset without a scroll event. The
    // virtualizer goes on rendering rows for the offset it last saw, so every
    // one of them lands below the viewport and the reader is left with a blank
    // table under a header still reporting the run's totals.
    await page.getByRole('button', { name: 'Fullscreen' }).click();
    await expect(mountedRows(page).first()).toBeVisible();
    expect(await mountedRows(page).count()).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Exit fullscreen' }).click();
    await expect(mountedRows(page).first()).toBeVisible();
    expect(await mountedRows(page).count()).toBeGreaterThan(0);
    await expect(grid).toBeVisible();
  });

  test('walks the rows from the keyboard @smoke', async ({
    page,
  }, testInfo) => {
    const grid = await openTrajectory(
      page,
      String(testInfo.project.use.baseURL),
    );
    await grid.click();

    await page.keyboard.press('ArrowDown');
    const first = await grid.getAttribute('aria-activedescendant');
    expect(first).toBeTruthy();
    await page.keyboard.press('ArrowDown');
    const second = await grid.getAttribute('aria-activedescendant');
    expect(second).not.toBe(first);

    // The last row has to be reachable and on screen, not merely mounted:
    // a stale scroll offset leaves rows in the DOM below the viewport.
    await page.keyboard.press('End');
    const active = await grid.getAttribute('aria-activedescendant');
    // Matched as an attribute, not as `#id`: React's `useId` puts colons in
    // the value, which a CSS id selector cannot carry.
    const activeRow = page.locator(`[id="${active}"]`);
    await expect(activeRow).toBeVisible();
    const [rowBox, gridBox] = await Promise.all([
      activeRow.boundingBox(),
      grid.boundingBox(),
    ]);
    expect(rowBox).not.toBeNull();
    expect(gridBox).not.toBeNull();
    expect(rowBox!.y).toBeGreaterThanOrEqual(gridBox!.y - 1);
    expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(
      gridBox!.y + gridBox!.height + 1,
    );
  });

  test('comes back with its rows after a reload @smoke', async ({
    page,
  }, testInfo) => {
    const baseURL = String(testInfo.project.use.baseURL);
    await openTrajectory(page, baseURL);

    await page.reload();
    await expect(
      page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
    ).toBeVisible();

    // The loader is a function and cannot be stored, so a restored tab is
    // inert until the host rewires it — which is what this asserts.
    await expect(page.getByTestId('trajectory-rows')).toBeVisible();
    await expect(mountedRows(page).first()).toBeVisible();
  });

  test('says when the page left older history out @smoke', async ({
    page,
  }, testInfo) => {
    await openTrajectory(page, String(testInfo.project.use.baseURL), {
      hasMore: true,
    });

    await expect(page.getByTestId('trajectory-truncated')).toBeVisible();
  });

  test('draws one span per timed record @smoke', async ({ page }, testInfo) => {
    await openTrajectory(page, String(testInfo.project.use.baseURL));

    await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
    await expect(
      page.locator('[data-testid="trajectory-span"][data-lane="0"]'),
    ).toHaveCount(TURNS);
    await expect(
      page.locator('[data-testid="trajectory-span"][data-lane="1"]'),
    ).toHaveCount(TURNS);
  });

  test('clicking a span selects and reveals its row @smoke', async ({
    page,
  }, testInfo) => {
    const grid = await openTrajectory(
      page,
      String(testInfo.project.use.baseURL),
    );
    // Opened at the tail, so turn 3 is far above the viewport and unmounted.
    await expect(grid.getByText('note-3.txt')).toHaveCount(0);

    // Spans run in time order, request then tool, one pair per turn.
    await overviewSpans(page)
      .nth(2 * (3 - 1) + 1)
      .click();

    const row = await activeRowOf(page, grid);
    await expect(row).toContainText('note-3.txt');
    const [rowBox, gridBox] = await Promise.all([
      row.boundingBox(),
      grid.boundingBox(),
    ]);
    expect(rowBox).not.toBeNull();
    expect(gridBox).not.toBeNull();
    expect(rowBox!.y).toBeGreaterThanOrEqual(gridBox!.y - 1);
    expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(
      gridBox!.y + gridBox!.height + 1,
    );
  });

  test('lights the span of the row the keyboard selected @smoke', async ({
    page,
  }, testInfo) => {
    const grid = await openTrajectory(
      page,
      String(testInfo.project.use.baseURL),
    );
    await grid.click();

    // The last row is the last turn's tool call, which is the last span.
    await page.keyboard.press('End');

    const current = page.locator(
      '[data-testid="trajectory-span"][data-current]',
    );
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('data-lane', '1');
    await expect(overviewSpans(page).last()).toHaveAttribute(
      'data-current',
      'true',
    );
  });

  test('holds the table still while the overview reloads @smoke', async ({
    page,
  }, testInfo) => {
    const grid = await openTrajectory(
      page,
      String(testInfo.project.use.baseURL),
    );
    const overview = page.getByTestId('trajectory-overview');
    const refresh = page
      .getByTestId('trajectory-panel')
      .getByRole('button', { name: 'Refresh' });
    await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
    const before = await Promise.all([
      overview.boundingBox(),
      grid.boundingBox(),
    ]);

    await refresh.click();
    await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
    await expect(refresh).toBeEnabled();

    const after = await Promise.all([
      overview.boundingBox(),
      grid.boundingBox(),
    ]);
    // The overview is a flex sibling of the scrolled rows: if its height moved
    // at all, so would every row under the reader.
    expect(before[0]!.height).toBe(64);
    expect(after[0]!.height).toBe(64);
    expect(after[1]!.y).toBe(before[1]!.y);
  });

  test.describe('time selection', () => {
    /** Centre of a span, where a press lands on it rather than beside it. */
    async function centreOf(span: Locator) {
      const box = await span.boundingBox();
      expect(box).not.toBeNull();
      return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    }

    /** A real press, travel and release, as a hand makes it. */
    async function dragBetween(
      page: Page,
      from: { x: number; y: number },
      to: { x: number; y: number },
    ) {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
    }

    /**
     * Drag from the middle of turn 11's request to the middle of turn 15's.
     * Idle time is cut, so the stretch covers all of turns 12–14, turn 11's
     * request and the tool after it, and turn 15's request but not its tool.
     * Each kept turn keeps its header and prompt, and no answer ran in time:
     * 5 headers + 5 prompts + 5 requests + 4 tools.
     */
    const NARROWED_ROWS = 19;
    const requestSpan = (page: Page, turn: number) =>
      overviewSpans(page).nth(2 * (turn - 1));

    async function narrow(page: Page) {
      await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
      await dragBetween(
        page,
        await centreOf(requestSpan(page, 11)),
        await centreOf(requestSpan(page, 15)),
      );
    }

    test('narrows the table to the dragged time @smoke', async ({
      page,
    }, testInfo) => {
      const grid = await openTrajectory(
        page,
        String(testInfo.project.use.baseURL),
      );
      const from = await centreOf(requestSpan(page, 11));
      const to = await centreOf(requestSpan(page, 15));

      await narrow(page);

      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(NARROWED_ROWS),
      );
      await expect(page.getByTestId('trajectory-range-status')).toHaveText(
        `Showing ${NARROWED_ROWS - 5} of ${TURNS * (ROWS_PER_TURN - 1)} rows in the selected time`,
      );
      // The band spans what the hand travelled, to within a pixel either end.
      const band = await page.getByTestId('trajectory-range').boundingBox();
      expect(band).not.toBeNull();
      expect(Math.abs(band!.x - from.x)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(band!.x + band!.width - to.x)).toBeLessThanOrEqual(1.5);
      await expect(
        overviewSpans(page).and(page.locator('[data-dimmed]')),
      ).toHaveCount(2 * TURNS - 9);
    });

    test('a click without a drag selects the span and leaves the table whole @smoke', async ({
      page,
    }, testInfo) => {
      const grid = await openTrajectory(
        page,
        String(testInfo.project.use.baseURL),
      );
      const point = await centreOf(requestSpan(page, 3));
      await page.mouse.click(point.x, point.y);

      await expect(page.getByTestId('trajectory-range')).toHaveCount(0);
      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(TURNS * ROWS_PER_TURN),
      );
      const row = await activeRowOf(page, grid);
      await expect(row).toContainText('qwen3.8-max');
    });

    test('Escape and the clear button bring every row back @smoke', async ({
      page,
    }, testInfo) => {
      const grid = await openTrajectory(
        page,
        String(testInfo.project.use.baseURL),
      );
      const all = String(TURNS * ROWS_PER_TURN);

      await narrow(page);
      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(NARROWED_ROWS),
      );
      await grid.focus();
      await page.keyboard.press('Escape');
      await expect(grid).toHaveAttribute('aria-rowcount', all);
      await expect(page.getByTestId('trajectory-range')).toHaveCount(0);

      await narrow(page);
      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(NARROWED_ROWS),
      );
      await page.getByTestId('trajectory-range-clear').click();
      await expect(grid).toHaveAttribute('aria-rowcount', all);
      await expect(page.getByTestId('trajectory-range-clear')).toHaveCount(0);
    });

    test('a right click on the overview clears the selection @smoke', async ({
      page,
    }, testInfo) => {
      const grid = await openTrajectory(
        page,
        String(testInfo.project.use.baseURL),
      );
      await narrow(page);
      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(NARROWED_ROWS),
      );

      const point = await centreOf(requestSpan(page, 30));
      await page.mouse.click(point.x, point.y, { button: 'right' });

      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(TURNS * ROWS_PER_TURN),
      );
      await expect(page.getByTestId('trajectory-range')).toHaveCount(0);
    });

    test('holds the table where it is while it narrows and widens @smoke', async ({
      page,
    }, testInfo) => {
      const grid = await openTrajectory(
        page,
        String(testInfo.project.use.baseURL),
      );
      const before = await grid.boundingBox();

      await narrow(page);
      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(NARROWED_ROWS),
      );
      const narrowed = await grid.boundingBox();
      await page.getByTestId('trajectory-range-clear').click();
      await expect(page.getByTestId('trajectory-range-clear')).toHaveCount(0);
      const after = await grid.boundingBox();

      // The header grows a button and says something else, and neither may
      // move the rows: the header and the overview are fixed-height siblings
      // of the scrolled box.
      expect(narrowed!.y).toBe(before!.y);
      expect(after!.y).toBe(before!.y);
    });
  });

  test.describe('walking back through pages', () => {
    /** Turns per served page; each page is a different run of records. */
    const PAGE_TURNS = 20;

    /**
     * Pages newest first, each older one reached by the cursor the one before
     * it handed out. Turn numbers, record ids and call ids never repeat across
     * pages: two pages of the same records would fold into one another by call
     * id and the row counts below would be measuring that instead.
     */
    function pageChain(
      count: number,
      overrides: Record<string, { status: number; withPage?: boolean }> = {},
    ): NonNullable<WebShellDaemonScenario['transcriptPage']> {
      const pageAt = (index: number) => {
        const firstTurn = (count - 1 - index) * PAGE_TURNS + 1;
        return {
          events: transcriptEvents(PAGE_TURNS, firstTurn),
          ...(index < count - 1
            ? { hasMore: true, nextCursor: `c${index + 1}` }
            : {}),
        };
      };
      const older: NonNullable<
        NonNullable<WebShellDaemonScenario['transcriptPage']>['older']
      > = {};
      for (let index = 1; index < count; index += 1) {
        const cursor = `c${index}`;
        const override = overrides[cursor];
        older[cursor] = override
          ? {
              status: override.status,
              ...(override.withPage ? { then: pageAt(index) } : {}),
            }
          : pageAt(index);
      }
      return { ...pageAt(0), older };
    }

    /** Cursors of the transcript reads the page has made so far. */
    function trackTranscriptCursors(page: Page): string[] {
      const cursors: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (/\/session\/[^/]+\/transcript\/?$/.test(url.pathname)) {
          cursors.push(url.searchParams.get('cursor') ?? '');
        }
      });
      return cursors;
    }

    test('folds every page it walked back through @smoke', async ({
      page,
    }, testInfo) => {
      const grid = await openTrajectory(
        page,
        String(testInfo.project.use.baseURL),
        { transcriptPage: pageChain(3) },
      );

      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(3 * PAGE_TURNS * ROWS_PER_TURN),
      );
      await expect(page.getByTestId('trajectory-totals')).toContainText(
        `${3 * PAGE_TURNS} turns`,
      );
      await expect(page.getByTestId('trajectory-truncated')).toHaveCount(0);
      // The oldest page's first turn is in the table, not only the newest's.
      await grid.click();
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowDown');
      await expect(await activeRowOf(page, grid)).toContainText(
        'Prompt number 1',
      );
    });

    test('stops at the page cap and says so @smoke', async ({
      page,
    }, testInfo) => {
      const cursors = trackTranscriptCursors(page);
      const grid = await openTrajectory(
        page,
        String(testInfo.project.use.baseURL),
        { transcriptPage: pageChain(6) },
      );

      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(4 * PAGE_TURNS * ROWS_PER_TURN),
      );
      await expect(page.getByTestId('trajectory-truncated')).toBeVisible();
      // Three older pages were read and the fourth cursor never asked for.
      expect(cursors).toContain('c3');
      expect(cursors).not.toContain('c4');
    });

    test('keeps the newer pages when an earlier one fails, and fills in on retry @smoke', async ({
      page,
    }, testInfo) => {
      const grid = await openTrajectory(
        page,
        String(testInfo.project.use.baseURL),
        {
          transcriptPage: pageChain(2, { c1: { status: 500, withPage: true } }),
        },
      );

      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(PAGE_TURNS * ROWS_PER_TURN),
      );
      const failed = page.getByTestId('trajectory-older-failed');
      await expect(failed).toBeVisible();
      // The newest page read fine: nothing is raised as an alert.
      await expect(
        page.getByTestId('trajectory-panel').getByRole('alert'),
      ).toHaveCount(0);

      await page.getByTestId('trajectory-older-retry').click();

      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(2 * PAGE_TURNS * ROWS_PER_TURN),
      );
      await expect(failed).toHaveCount(0);
    });

    test('opens whole, at the newest turn, after walking back @smoke', async ({
      page,
    }, testInfo) => {
      // Record every row count the grid ever shows, from before it exists.
      await page.addInitScript(() => {
        const seen: string[] = [];
        (
          window as unknown as { __trajectoryRowCounts: string[] }
        ).__trajectoryRowCounts = seen;
        new MutationObserver(() => {
          const grid = document.querySelector(
            '[data-testid="trajectory-rows"]',
          );
          const count = grid?.getAttribute('aria-rowcount');
          if (count && seen[seen.length - 1] !== count) seen.push(count);
        }).observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['aria-rowcount'],
        });
      });
      const grid = await openTrajectory(
        page,
        String(testInfo.project.use.baseURL),
        { transcriptPage: pageChain(3) },
      );
      const total = String(3 * PAGE_TURNS * ROWS_PER_TURN);
      await expect(grid).toHaveAttribute('aria-rowcount', total);

      // No smaller table ever showed first: the walk lands once, whole.
      const counts = await page.evaluate(
        () =>
          (window as unknown as { __trajectoryRowCounts: string[] })
            .__trajectoryRowCounts,
      );
      expect(counts).toEqual([total]);
      const lastRow = mountedRows(page).last();
      await expect(lastRow).toHaveAttribute('aria-rowindex', total);
      await expect(lastRow).toBeInViewport();
    });

    test('holds the grid still when a refresh changes what the bar says @smoke', async ({
      page,
    }, testInfo) => {
      const grid = await openTrajectory(
        page,
        String(testInfo.project.use.baseURL),
        {
          transcriptPage: pageChain(2, { c1: { status: 500, withPage: true } }),
        },
      );
      const bar = page.getByTestId('trajectory-older-bar');
      await expect(page.getByTestId('trajectory-older-failed')).toBeVisible();
      const before = await Promise.all([bar.boundingBox(), grid.boundingBox()]);

      await page
        .getByTestId('trajectory-panel')
        .getByRole('button', { name: 'Refresh' })
        .click();
      await expect(grid).toHaveAttribute(
        'aria-rowcount',
        String(2 * PAGE_TURNS * ROWS_PER_TURN),
      );
      await expect(bar).toHaveText('');

      const after = await Promise.all([bar.boundingBox(), grid.boundingBox()]);
      expect(before[0]!.height).toBe(26);
      expect(after[0]!.height).toBe(26);
      expect(after[1]!.y).toBe(before[1]!.y);
    });
  });
});
