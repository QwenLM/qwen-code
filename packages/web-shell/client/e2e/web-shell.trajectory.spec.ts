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
} from './utils/mockDaemon';

/**
 * Turns in the served page. Five rows each — header, prompt, request, answer,
 * tool — is well past what fits, which is the point: the grid is virtualized,
 * so every assertion about scrolling needs rows that are not all mounted.
 */
const TURNS = 40;
const ROWS_PER_TURN = 5;

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
function transcriptEvents(turns: number): DaemonEvent[] {
  const events: DaemonEvent[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
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
  options: { hasMore?: boolean } = {},
): Promise<Locator> {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: '/tmp/qwen-web-shell-e2e',
    transcriptPage: {
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
});
