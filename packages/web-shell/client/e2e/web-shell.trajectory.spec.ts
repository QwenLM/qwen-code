/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
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

  await page
    .getByRole('button', { name: /Toggle right panel|切换右侧扩展区/ })
    .click();
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
  await expect(grid).toHaveAttribute('aria-activedescendant', /.+/);
  const active = await grid.getAttribute('aria-activedescendant');
  // Matched as an attribute, not as `#id`: React's `useId` puts colons in
  // the value, which a CSS id selector cannot carry.
  return page.locator(`[id="${active}"]`);
}

/** Rows the virtualizer has mounted, which is never the whole page. */
function mountedRows(page: Page): Locator {
  return page.locator('[data-testid="trajectory-rows"] [role="row"]');
}

test.describe('trajectory panel', () => {
  test('keeps inspector content and copy reachable in a short window @smoke', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 600 });
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    await openTrajectory(page, String(testInfo.project.use.baseURL));
    const panel = page.getByTestId('trajectory-panel');
    await panel.getByTestId('trajectory-row-tool').last().click();
    await panel.getByRole('button', { name: 'View details' }).click();
    const inspector = panel.getByTestId('trajectory-inspector');
    await inspector.getByRole('button', { name: 'Input' }).click();
    const content = inspector.locator('pre');
    const copy = inspector.getByRole('button', {
      name: 'Copy displayed content',
    });
    expect(
      await panel.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    ).toBeGreaterThan(0);
    const box = (await panel.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.wheel(0, 600);
    await expect(content).toBeInViewport();
    await expect(copy).toBeInViewport();
    await expect(content).toContainText('/workspace/demo/note-40.txt');
    await copy.click();
    await expect(copy).toBeFocused();
    await expect(inspector.getByRole('status')).toHaveText(
      'Copied displayed content',
    );
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(await content.textContent());
    expect(JSON.parse(copied)).toEqual({
      file_path: `/workspace/demo/note-${TURNS}.txt`,
    });
  });

  test('inspects a selected tool without fetching more transcript data @smoke', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 2400, height: 900 });
    const grid = await openTrajectory(
      page,
      String(testInfo.project.use.baseURL),
    );
    const failedLegend = page.getByText('Failed', { exact: true });
    const legendBox = (await failedLegend.boundingBox())!;
    const iconBox = (await failedLegend.locator('svg').boundingBox())!;
    expect(
      Math.abs(
        iconBox.y + iconBox.height / 2 - (legendBox.y + legendBox.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    let detailRequests = 0;
    page.on('request', (request) => {
      if (/\/transcript(?:\?|$)|\/attachments?\//.test(request.url())) {
        detailRequests += 1;
      }
    });
    const tool = page.getByTestId('trajectory-row-tool').last();
    await tool.click();
    await page.getByRole('button', { name: 'View details' }).click();
    const inspector = page.getByTestId('trajectory-inspector');
    await expect(inspector).toBeVisible();
    await expect(tool).toBeInViewport();
    await inspector.getByRole('button', { name: 'Input' }).click();
    await expect(inspector).toContainText(`/workspace/demo/note-${TURNS}.txt`);
    await inspector.getByRole('button', { name: 'Output' }).click();
    await expect(inspector).toContainText('unrecorded');
    const evidenceDir = resolve(
      process.cwd(),
      '../../.qwen/e2e-tests/trajectory-pr2',
    );
    mkdirSync(evidenceDir, { recursive: true });
    const panel = page.getByTestId('trajectory-panel');
    const resizeHandle = page
      .locator('[role="separator"][aria-orientation="vertical"]')
      .last();
    for (const width of [320, 960]) {
      const current = (await panel.boundingBox())!.width;
      const handle = (await resizeHandle.boundingBox())!;
      await page.mouse.move(
        handle.x + handle.width / 2,
        handle.y + handle.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        handle.x + handle.width / 2 + current - width,
        handle.y + handle.height / 2,
        { steps: 5 },
      );
      await page.mouse.up();
      await expect
        .poll(async () => Math.round((await panel.boundingBox())!.width))
        .toBe(width);
      await expect(tool).toBeInViewport();
      const rowBox = (await tool.boundingBox())!;
      const metricsBox = (await tool
        .getByTestId('trajectory-row-metrics')
        .boundingBox())!;
      expect(metricsBox.y).toBeGreaterThanOrEqual(rowBox.y - 1);
      expect(metricsBox.y + metricsBox.height).toBeLessThanOrEqual(
        rowBox.y + rowBox.height + 1,
      );
      expect(metricsBox.x + metricsBox.width).toBeLessThanOrEqual(
        rowBox.x + rowBox.width + 1,
      );
      expect(
        await panel.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
      await panel.screenshot({
        path: resolve(evidenceDir, `inspector-${width}.png`),
      });
      await inspector.getByRole('button', { name: 'Summary' }).click();
      await expect(inspector).toContainText('call_0040');
      await panel.screenshot({
        path: resolve(evidenceDir, `inspector-summary-${width}.png`),
      });
    }
    await inspector.getByRole('button', { name: 'Close details' }).click();
    await expect(inspector).toHaveCount(0);
    await expect(grid).toBeFocused();
    expect(detailRequests).toBe(0);
  });

  for (const { language, theme } of [
    { language: 'en', theme: 'dark' },
    { language: 'zh-CN', theme: 'light' },
  ]) {
    test(`fits 320, 480 and 960px panel widths in ${language} ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 2400, height: 900 });
      await page.addInitScript(
        ({ language, theme }) => {
          localStorage.setItem('qwen-code-web-shell-language', language);
          localStorage.setItem('qwen-code-web-shell-theme', theme);
        },
        { language, theme },
      );
      await openTrajectory(page, String(testInfo.project.use.baseURL));
      const panel = page.getByTestId('trajectory-panel');
      const resizeHandle = page
        .locator('[role="separator"][aria-orientation="vertical"]')
        .last();
      const output = resolve(
        process.cwd(),
        '../../.qwen/e2e-tests/trajectory-pr1',
      );
      mkdirSync(output, { recursive: true });
      for (const width of [320, 480, 960]) {
        const current = (await panel.boundingBox())!.width;
        const handle = (await resizeHandle.boundingBox())!;
        const x = handle.x + handle.width / 2;
        const y = handle.y + handle.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + current - width, y, { steps: 5 });
        await page.mouse.up();
        await expect
          .poll(async () => Math.round((await panel.boundingBox())!.width))
          .toBe(width);
        await expect(panel.getByTestId('trajectory-mode-active')).toBeVisible();
        await expect(panel.getByTestId('trajectory-mode-clock')).toBeVisible();
        const request = panel.getByTestId('trajectory-row-request').last();
        await request.scrollIntoViewIfNeeded();
        const rowBox = (await request.boundingBox())!;
        const labelBox = (await request.locator('span').nth(1).boundingBox())!;
        const metricsBox = (await request
          .getByTestId('trajectory-row-metrics')
          .boundingBox())!;
        expect(labelBox.width).toBeGreaterThanOrEqual(95);
        expect(metricsBox.y).toBeGreaterThanOrEqual(rowBox.y - 1);
        expect(metricsBox.y + metricsBox.height).toBeLessThanOrEqual(
          rowBox.y + rowBox.height + 1,
        );
        expect(metricsBox.x + metricsBox.width).toBeLessThanOrEqual(
          rowBox.x + rowBox.width + 1,
        );
        const overflow = await panel.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
        await panel.screenshot({
          path: resolve(output, `${language}-${theme}-${width}.png`),
        });
        if (width === 320) {
          const gridY = (await panel
            .getByTestId('trajectory-rows')
            .boundingBox())!.y;
          const help = panel.locator('details summary');
          await help.click();
          await expect(panel.locator('details[open]')).toBeVisible();
          expect(
            (await panel.getByTestId('trajectory-rows').boundingBox())!.y,
          ).toBe(gridY);
          await panel.screenshot({
            path: resolve(output, `${language}-${theme}-metric-help.png`),
          });
          await help.click();
        }
      }
      if (language === 'zh-CN') {
        await panel.getByTestId('trajectory-row-tool').last().click();
        await panel.getByRole('button', { name: '查看详情' }).click();
        const inspector = panel.getByTestId('trajectory-inspector');
        await expect(inspector).toBeVisible();
        const evidenceDir = resolve(
          process.cwd(),
          '../../.qwen/e2e-tests/trajectory-pr2',
        );
        mkdirSync(evidenceDir, { recursive: true });
        await panel.screenshot({
          path: resolve(evidenceDir, 'inspector-zh-light-960.png'),
        });
        await inspector.getByRole('button', { name: '关闭详情' }).click();
      }
      const metricsBefore = await panel
        .getByTestId('trajectory-metrics')
        .innerText();
      await panel.getByTestId('trajectory-mode-clock').focus();
      await page.keyboard.press('Enter');
      await expect(panel.getByTestId('trajectory-mode-clock')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(await panel.getByTestId('trajectory-metrics').innerText()).toBe(
        metricsBefore,
      );
      await panel.getByTestId('trajectory-zoom-in').click();
      expect(await panel.getByTestId('trajectory-metrics').innerText()).toBe(
        metricsBefore,
      );
    });
  }

  test('explains timed rows with no start and a failed refresh over retained data', async ({
    page,
  }, testInfo) => {
    const events = transcriptEvents(1).map((event) => {
      const update = event.data as Record<string, unknown>;
      const meta = update['_meta'] as Record<string, unknown> | undefined;
      const timing = meta?.['timing'] as Record<string, unknown> | undefined;
      if (timing) delete timing['startedAt'];
      return event;
    });
    await openTrajectory(page, String(testInfo.project.use.baseURL), {
      transcriptPage: { events },
    });
    const panel = page.getByTestId('trajectory-panel');
    await expect(panel.getByTestId('trajectory-overview')).toContainText(
      'Recorded durations have no start time',
    );
    await expect(panel.getByTestId('trajectory-context-notice')).toContainText(
      'without start',
    );
    const output = resolve(
      process.cwd(),
      '../../.qwen/e2e-tests/trajectory-pr1',
    );
    mkdirSync(output, { recursive: true });
    await panel.screenshot({ path: resolve(output, 'all-starts-missing.png') });
    const gridY = (await panel.getByTestId('trajectory-rows').boundingBox())!.y;

    await page.route('**/session/*/transcript*', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"refresh unavailable"}',
      });
    });
    await panel.getByRole('button', { name: 'Refresh' }).click();
    await expect(panel.getByRole('alert')).toContainText(
      'Refresh failed; showing the last successful read',
    );
    await expect(panel.getByTestId('trajectory-rows')).toBeVisible();
    expect((await panel.getByTestId('trajectory-rows').boundingBox())!.y).toBe(
      gridY,
    );
    await panel.screenshot({
      path: resolve(output, 'refresh-failed-retained.png'),
    });
  });

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
    const output = resolve(
      process.cwd(),
      '../../.qwen/e2e-tests/trajectory-pr1',
    );
    mkdirSync(output, { recursive: true });
    await page.getByTestId('trajectory-panel').screenshot({
      path: resolve(output, 'fullscreen.png'),
    });

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
    expect(before[0]!.height).toBe(128);
    expect(after[0]!.height).toBe(128);
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
        `Visible records ${NARROWED_ROWS - 5} / window records ${TURNS * (ROWS_PER_TURN - 1)} (including context)`,
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

    test.describe('zoom and pan', () => {
      const plotBox = async (page: Page) => {
        const box = await page.getByTestId('trajectory-plot').boundingBox();
        expect(box).not.toBeNull();
        return box!;
      };

      /** The axis value names the track's right end, so it must end there. */
      async function expectValueAtTrackEnd(page: Page) {
        const [value, plot] = await Promise.all([
          page.getByTestId('trajectory-overview-busy').boundingBox(),
          page.getByTestId('trajectory-plot').boundingBox(),
        ]);
        expect(
          Math.abs(value!.x + value!.width - (plot!.x + plot!.width)),
        ).toBeLessThanOrEqual(1);
      }

      /** Wait until the drawn layer says it is zoomed, or not. */
      async function expectZoomed(page: Page, zoomed: boolean) {
        const domain = page.getByTestId('trajectory-domain');
        if (zoomed) await expect(domain).toHaveAttribute('data-zoomed', 'true');
        else await expect(domain).not.toHaveAttribute('data-zoomed');
      }

      test('zooms in around the pointer @smoke', async ({ page }, testInfo) => {
        const grid = await openTrajectory(
          page,
          String(testInfo.project.use.baseURL),
        );
        await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
        const target = requestSpan(page, 20);
        const before = await target.boundingBox();
        const gridBefore = await grid.boundingBox();
        const point = await centreOf(target);
        // WheelEvent.clientX uses integer CSS pixels in Chromium. Track the
        // domain point at that coordinate, not the span's fractional centre.
        point.x = Math.floor(point.x);
        const domain = page.getByTestId('trajectory-domain');
        const domainBefore = (await domain.boundingBox())!;
        const anchor = (point.x - domainBefore.x) / domainBefore.width;

        await page.mouse.move(point.x, point.y);
        // Three turns of 600px: exp(-2.7), about 15× the length per pixel.
        for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -600);
        await expectZoomed(page, true);

        await expect
          .poll(async () => (await target.boundingBox())!.width)
          .toBeGreaterThan(before!.width * 5);
        const after = (await target.boundingBox())!;
        // The span that was under the pointer is still under it.
        expect(after.x).toBeLessThanOrEqual(point.x);
        expect(after.x + after.width).toBeGreaterThanOrEqual(point.x);
        const domainAfter = (await domain.boundingBox())!;
        // The same time coordinate stays under the actual pointer.
        expect(
          Math.abs(domainAfter.x + anchor * domainAfter.width - point.x),
        ).toBeLessThanOrEqual(2);
        await expectValueAtTrackEnd(page);
        // Zooming happens inside the strip: nothing below it moves.
        expect(
          (await page.getByTestId('trajectory-overview').boundingBox())!.height,
        ).toBe(128);
        expect((await grid.boundingBox())!.y).toBe(gridBefore!.y);
      });

      test('pans with the right button once zoomed @smoke', async ({
        page,
      }, testInfo) => {
        const grid = await openTrajectory(
          page,
          String(testInfo.project.use.baseURL),
        );
        await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
        const plot = await plotBox(page);
        const centre = {
          x: plot.x + plot.width / 2,
          y: plot.y + plot.height / 2,
        };
        await page.mouse.move(centre.x, centre.y);
        await page.mouse.wheel(0, -600);
        await expectZoomed(page, true);

        const target = requestSpan(page, 20);
        const before = (await target.boundingBox())!;
        await page.mouse.move(centre.x, centre.y);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(centre.x - 100, centre.y, { steps: 8 });
        await page.mouse.up({ button: 'right' });

        await expect
          .poll(async () => (await target.boundingBox())!.x)
          .toBeLessThan(before.x - 90);
        const after = (await target.boundingBox())!;
        expect(Math.abs(after.x - (before.x - 100))).toBeLessThanOrEqual(3);
        // A pan is not a right click: nothing was filtered or cleared.
        await expect(grid).toHaveAttribute(
          'aria-rowcount',
          String(TURNS * ROWS_PER_TURN),
        );
      });

      test('selects the same rows through the zoom @smoke', async ({
        page,
      }, testInfo) => {
        const grid = await openTrajectory(
          page,
          String(testInfo.project.use.baseURL),
        );
        await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
        // Halve the length around turn 13, which keeps turns 11–15 in view.
        const anchor = await centreOf(requestSpan(page, 13));
        await page.mouse.move(anchor.x, anchor.y);
        await page.mouse.wheel(0, -462);
        await expectZoomed(page, true);
        const plot = await plotBox(page);
        for (const turn of [11, 15]) {
          const box = (await requestSpan(page, turn).boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(plot.x);
          expect(box.x + box.width).toBeLessThanOrEqual(plot.x + plot.width);
        }

        await narrow(page);

        await expect(grid).toHaveAttribute(
          'aria-rowcount',
          String(NARROWED_ROWS),
        );
      });

      test('the reset button shows the whole run again @smoke', async ({
        page,
      }, testInfo) => {
        await openTrajectory(page, String(testInfo.project.use.baseURL));
        await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
        const plot = await plotBox(page);
        await page.mouse.move(plot.x + plot.width / 2, plot.y + 10);
        await page.mouse.wheel(0, -900);
        await expectZoomed(page, true);
        const first = overviewSpans(page).first();
        const last = overviewSpans(page).last();
        // Zoomed around the middle, both ends of the run are out of view.
        expect((await first.boundingBox())!.x).toBeLessThan(plot.x);

        await page.getByTestId('trajectory-zoom-reset').click();

        await expectZoomed(page, false);
        const firstBox = (await first.boundingBox())!;
        const lastBox = (await last.boundingBox())!;
        expect(firstBox.x).toBeGreaterThanOrEqual(plot.x - 1);
        expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(
          plot.x + plot.width + 1,
        );
        await expect(page.getByTestId('trajectory-zoom-reset')).toHaveAttribute(
          'aria-disabled',
          'true',
        );
        await expectValueAtTrackEnd(page);
      });
    });

    test.describe('real time', () => {
      /**
       * Real time runs from turn 1's request to turn 40's tool: 39 idle-laden
       * minutes plus the last turn's 1100 ms. Worked out from the fixture
       * apart from the code, so a change to the projection shows up here.
       */
      const CLOCK_TOTAL_MS = 39 * 60_000 + 1100;

      async function switchToClock(page: Page) {
        const toggle = page.getByTestId('trajectory-mode-clock');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        return toggle;
      }

      const plotBox = async (page: Page) => {
        const box = await page.getByTestId('trajectory-plot').boundingBox();
        expect(box).not.toBeNull();
        return box!;
      };

      /** Halfway between two turns' request spans: in the idle minute. */
      async function between(page: Page, turn: number) {
        const [a, b] = await Promise.all([
          requestSpan(page, turn).boundingBox(),
          requestSpan(page, turn + 1).boundingBox(),
        ]);
        return { x: (a!.x + b!.x) / 2, y: a!.y + a!.height / 2 };
      }

      test('spreads the run over real time when switched @smoke', async ({
        page,
      }, testInfo) => {
        const grid = await openTrajectory(
          page,
          String(testInfo.project.use.baseURL),
        );
        await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
        const gridBefore = (await grid.boundingBox())!;

        await switchToClock(page);

        await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
        const plot = await plotBox(page);
        const first = (await requestSpan(page, 1).boundingBox())!;
        const lastTool = (await overviewSpans(page).last().boundingBox())!;
        expect(Math.abs(first.x - plot.x)).toBeLessThanOrEqual(2);
        expect(
          Math.abs(lastTool.x + lastTool.width - (plot.x + plot.width)),
        ).toBeLessThanOrEqual(4);
        // A minute between turns is a minute of track.
        const [t20, t21] = await Promise.all([
          requestSpan(page, 20).boundingBox(),
          requestSpan(page, 21).boundingBox(),
        ]);
        expect(
          Math.abs(t21!.x - t20!.x - (plot.width * 60_000) / CLOCK_TOTAL_MS),
        ).toBeLessThanOrEqual(2);
        await expect(page.getByTestId('trajectory-overview-from')).toHaveText(
          /^\d{2}:\d{2}:\d{2}$/,
        );
        await expect(grid).toHaveAttribute(
          'aria-rowcount',
          String(TURNS * ROWS_PER_TURN),
        );
        expect((await grid.boundingBox())!.y).toBe(gridBefore.y);
      });

      test('a selection in idle time empties the table and can be cleared @smoke', async ({
        page,
      }, testInfo) => {
        await openTrajectory(page, String(testInfo.project.use.baseURL));
        await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
        await switchToClock(page);

        // At full width the idle minute is a few pixels; zoom in on turn 20
        // until it is wide enough to drag inside.
        const anchor = await centreOf(requestSpan(page, 20));
        await page.mouse.move(anchor.x, anchor.y);
        for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -600);
        await expect(page.getByTestId('trajectory-domain')).toHaveAttribute(
          'data-zoomed',
          'true',
        );
        const tool20 = (await overviewSpans(page)
          .nth(2 * (20 - 1) + 1)
          .boundingBox())!;
        const request21 = (await requestSpan(page, 21).boundingBox())!;
        const from = { x: tool20.x + tool20.width + 6, y: anchor.y };
        const to = { x: request21.x - 6, y: anchor.y };
        expect(to.x - from.x).toBeGreaterThanOrEqual(20);

        await dragBetween(page, from, to);

        const empty = page.getByTestId('trajectory-range-empty');
        await expect(empty).toContainText(
          'No request or tool ran in the selected time.',
        );
        await expect(page.getByTestId('trajectory-range-status')).toHaveText(
          `Visible records 0 / window records ${TURNS * (ROWS_PER_TURN - 1)} (including context)`,
        );
        await expect(page.getByTestId('trajectory-rows')).toHaveCount(0);

        await empty.getByRole('button').click();

        await expect(empty).toHaveCount(0);
        await expect(page.getByTestId('trajectory-rows')).toHaveAttribute(
          'aria-rowcount',
          String(TURNS * ROWS_PER_TURN),
        );
      });

      test('keeps the turns a real-time selection covers @smoke', async ({
        page,
      }, testInfo) => {
        const grid = await openTrajectory(
          page,
          String(testInfo.project.use.baseURL),
        );
        await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
        await switchToClock(page);

        // From the idle minute before turn 12 to the one after turn 15:
        // turns 12–15 whole, each with its header, prompt, request and tool.
        await dragBetween(
          page,
          await between(page, 11),
          await between(page, 15),
        );

        await expect(grid).toHaveAttribute('aria-rowcount', String(4 * 4));
      });

      test('switching back cuts idle out again and drops the selection @smoke', async ({
        page,
      }, testInfo) => {
        const grid = await openTrajectory(
          page,
          String(testInfo.project.use.baseURL),
        );
        await expect(overviewSpans(page)).toHaveCount(2 * TURNS);
        const toggle = await switchToClock(page);
        await dragBetween(
          page,
          await between(page, 11),
          await between(page, 15),
        );
        await expect(grid).toHaveAttribute('aria-rowcount', String(4 * 4));

        const active = page.getByTestId('trajectory-mode-active');
        await active.click();

        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        await expect(active).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId('trajectory-range')).toHaveCount(0);
        await expect(page.getByTestId('trajectory-overview-from')).toHaveText(
          '0',
        );
        await expect(grid).toHaveAttribute(
          'aria-rowcount',
          String(TURNS * ROWS_PER_TURN),
        );
        const plot = await plotBox(page);
        const lastTool = (await overviewSpans(page).last().boundingBox())!;
        expect(
          Math.abs(lastTool.x + lastTool.width - (plot.x + plot.width)),
        ).toBeLessThanOrEqual(4);
      });
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

test.describe('collapsible waterfall', () => {
  async function resizePanel(page: Page, width: number) {
    const panel = page.getByTestId('trajectory-panel');
    const current = (await panel.boundingBox())!.width;
    const handle = (await page
      .locator('[role="separator"][aria-orientation="vertical"]')
      .last()
      .boundingBox())!;
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      handle.x + handle.width / 2 + current - width,
      handle.y + handle.height / 2,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => Math.round((await panel.boundingBox())!.width))
      .toBe(width);
  }

  test('preserves inspector and clipboard while folding and reveals the original record @smoke', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 2400, height: 900 });
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    const grid = await openTrajectory(
      page,
      String(testInfo.project.use.baseURL),
      { transcriptPage: { events: transcriptEvents(2) } },
    );
    await resizePanel(page, 960);
    const totals = await page.getByTestId('trajectory-metrics').textContent();
    const tool = page.getByTestId('trajectory-row-tool').last();
    const key = await tool.getAttribute('data-row-key');
    await tool.click();
    await page.getByRole('button', { name: 'View details' }).click();
    const inspector = page.getByTestId('trajectory-inspector');
    await inspector.getByRole('button', { name: 'Input', exact: true }).click();
    const content = await inspector.locator('pre').textContent();
    await page
      .getByTestId('trajectory-row-request')
      .last()
      .getByRole('button', { name: /^Collapse/ })
      .click();
    await expect(grid).toHaveAttribute('aria-rowcount', '8');
    const notice = page.getByTestId('trajectory-context-notice');
    const noticeBox = (await notice.boundingBox())!;
    const statusBox = (await page
      .getByTestId('trajectory-range-status')
      .boundingBox())!;
    expect(statusBox.y).toBeGreaterThanOrEqual(noticeBox.y);
    expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(
      noticeBox.y + noticeBox.height + 1,
    );
    await expect(inspector).toContainText(
      'The group containing this record is collapsed.',
    );
    await expect(inspector.locator('pre')).toHaveText(content!);
    await inspector
      .getByRole('button', { name: 'Copy displayed content' })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      content,
    );
    await expect(page.getByTestId('trajectory-metrics')).toHaveText(totals!);
    await inspector.getByRole('button', { name: 'Expand and locate' }).click();
    await expect(grid).toHaveAttribute('aria-rowcount', '10');
    await expect(
      page.locator(`[data-row-key="${key}"][data-selected="true"]`),
    ).toBeInViewport();
    await expect(inspector).not.toContainText('is collapsed');
  });

  test('shares viewport through rapid wheel, resize, mode changes and reset @smoke', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 2400, height: 900 });
    await openTrajectory(page, String(testInfo.project.use.baseURL));
    await resizePanel(page, 960);
    const plot = page.getByTestId('trajectory-plot');
    const cell = page.getByTestId('trajectory-waterfall-cell').last();
    const before = Number(await plot.getAttribute('data-to'));
    const box = (await plot.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -240);
    await expect
      .poll(
        async () =>
          Number(await plot.getAttribute('data-to')) -
          Number(await plot.getAttribute('data-from')),
      )
      .toBeLessThan(before * 0.5);
    await expect
      .poll(async () => await cell.getAttribute('data-from'))
      .toBe(await plot.getAttribute('data-from'));
    await expect(cell).toHaveAttribute(
      'data-to',
      (await plot.getAttribute('data-to'))!,
    );
    const from = await plot.getAttribute('data-from');
    const to = await plot.getAttribute('data-to');
    await resizePanel(page, 320);
    await expect(cell).not.toBeVisible();
    await resizePanel(page, 480);
    await expect(cell).not.toBeVisible();
    await resizePanel(page, 960);
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute('data-from', from!);
    await expect(cell).toHaveAttribute('data-to', to!);
    await page.getByTestId('trajectory-mode-clock').click();
    await expect(plot).toHaveAttribute('data-from', '0');
    await expect
      .poll(async () => await cell.getAttribute('data-to'))
      .toBe(await plot.getAttribute('data-to'));
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(plot).not.toHaveAttribute('data-from', '0');
    await page
      .getByRole('button', { name: 'Show the whole run', exact: true })
      .click();
    await expect(plot).toHaveAttribute('data-from', '0');
    await expect
      .poll(async () => await cell.getAttribute('data-to'))
      .toBe(await plot.getAttribute('data-to'));
  });

  test('expands both a folded turn and request when overview selects a hidden row @smoke', async ({
    page,
  }, testInfo) => {
    await openTrajectory(page, String(testInfo.project.use.baseURL), {
      transcriptPage: { events: transcriptEvents(2) },
    });
    const grid = page.getByTestId('trajectory-rows');
    const tool = page.getByTestId('trajectory-row-tool').last();
    const key = await tool.getAttribute('data-row-key');
    await page
      .getByTestId('trajectory-row-request')
      .last()
      .getByRole('button', { name: /^Collapse/ })
      .click();
    await page
      .getByTestId('trajectory-turn')
      .last()
      .getByRole('button', { name: /^Collapse/ })
      .click();
    await expect(grid).toHaveAttribute('aria-rowcount', '6');
    const overview = page.locator(
      `[data-testid="trajectory-span"][data-row-key="${key}"]`,
    );
    await overview.click({ force: true });
    await expect(grid).toHaveAttribute('aria-rowcount', '10');
    await expect(
      page.locator(`[data-row-key="${key}"][data-selected="true"]`),
    ).toBeInViewport();
  });
});
