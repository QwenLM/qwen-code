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
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

/**
 * Turns in the served page. Five rows each — header, prompt, request, answer,
 * tool — is well past what fits, which is the point: the grid is virtualized,
 * so every assertion about scrolling needs rows that are not all mounted.
 */
const TURNS = 40;
const OLDER_TURNS = 5;
const ROWS_PER_TURN = 5;
/**
 * The newest page starts after the older one ends. Record and call ids carry
 * identity, so two pages numbered from 1 would describe the same records twice
 * and the fold would rightly merge them — the walk has to be one continuous
 * session, not two copies of its beginning.
 */
const NEWEST_FIRST_TURN = OLDER_TURNS + 1;
const ANCHOR_TURN = OLDER_TURNS + TURNS - 1;
/** The newest page's last turn, whose row the table opens on. */
const LAST_TURN = OLDER_TURNS + TURNS;
const OLDER_CURSOR = 'older-page-1';

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
    older?: NonNullable<WebShellDaemonScenario['transcriptPage']>['older'];
  } = {},
): Promise<{ grid: Locator; daemon: MockDaemonController }> {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: '/tmp/qwen-web-shell-e2e',
    transcriptPage: {
      events: transcriptEvents(TURNS, NEWEST_FIRST_TURN),
      ...(options.older
        ? { hasMore: true, nextCursor: OLDER_CURSOR, older: options.older }
        : {}),
    },
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Toggle right panel' }).click();
  await page.getByTestId('right-panel-open-trajectory').click();
  const grid = page.getByTestId('trajectory-rows');
  await expect(grid).toBeVisible();
  return { grid, daemon };
}

/** Requests the client actually made for transcript pages, in order. */
function transcriptRequests(daemon: MockDaemonController): string[] {
  return daemon.requests
    .filter((request) => /\/session\/[^/]+\/transcript$/.test(request.path))
    .map((request) => request.search);
}

/** Rows the virtualizer has mounted, which is never the whole page. */
function mountedRows(page: Page): Locator {
  return page.locator('[data-testid="trajectory-rows"] [role="row"]');
}

test.describe('trajectory panel', () => {
  test('shows what each request and tool cost @smoke', async ({
    page,
  }, testInfo) => {
    const { grid } = await openTrajectory(
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
      `${((1000 + LAST_TURN) / 1000).toFixed(1)}s`,
    );
    await expect(
      page.locator('[data-testid="trajectory-row-tool"]').last(),
    ).toContainText('read_file');
  });

  test('keeps its rows through the fullscreen toggle @smoke', async ({
    page,
  }, testInfo) => {
    const { grid } = await openTrajectory(
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
    const { grid } = await openTrajectory(
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

  test('keeps the reader on the same row when earlier records land @smoke', async ({
    page,
  }, testInfo) => {
    const { grid } = await openTrajectory(
      page,
      String(testInfo.project.use.baseURL),
      { older: { [OLDER_CURSOR]: { events: transcriptEvents(OLDER_TURNS) } } },
    );

    // Anchored on a row the reader can see, found by its text: an older page
    // renumbers every row behind it, so the index is not an identity.
    const anchor = page
      .locator('[data-testid="trajectory-rows"] [role="row"]')
      .filter({ hasText: `Prompt number ${ANCHOR_TURN}` });
    await expect(anchor).toBeVisible();
    const before = await anchor.boundingBox();
    expect(before).not.toBeNull();

    await page.getByTestId('trajectory-load-older').click();
    await expect(grid).toHaveAttribute(
      'aria-rowcount',
      String((TURNS + OLDER_TURNS) * ROWS_PER_TURN),
    );

    // The rows above grew by a known amount, so the row the reader was on has
    // to stay where it was rather than being pushed down by that amount.
    const after = await anchor.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
  });

  test('retries the page that failed rather than starting over @smoke', async ({
    page,
  }, testInfo) => {
    const { grid, daemon } = await openTrajectory(
      page,
      String(testInfo.project.use.baseURL),
      { older: { [OLDER_CURSOR]: { status: 500 } } },
    );

    await page.getByTestId('trajectory-load-older').click();
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();

    // The failed read is not the one on screen: the window it could not add to
    // is still there, whole.
    await expect(grid).toHaveAttribute(
      'aria-rowcount',
      String(TURNS * ROWS_PER_TURN),
    );

    await alert.getByRole('button').click();
    const reads = transcriptRequests(daemon);
    // Re-reading the newest page instead would throw away everything the
    // reader had already paged back through.
    expect(reads.at(-1)).toContain(`cursor=${OLDER_CURSOR}`);
  });
});
