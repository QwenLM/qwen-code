/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const ITEMS = [
  'Read the session transcript',
  'Map the daemon routes',
  'Draft the reading-position oracle',
  'Run the head arm',
  'Run the control arm',
  'Compare the anchor shifts',
  'Write up the results table',
];

/** `done` items completed, the next one in progress, the rest pending. */
function plan(done: number) {
  return {
    todos: ITEMS.map((content, index) => ({
      id: String(index + 1),
      content,
      status:
        index < done ? 'completed' : index === done ? 'in_progress' : 'pending',
    })),
  };
}

const TRANSCRIPT = Array.from(
  { length: 80 },
  (_, index) =>
    `LINE-${String(index + 1).padStart(3, '0')} transcript paragraph ${index + 1}.`,
).join('\n\n');

/** The pinned strip: the "Current tasks" region that sits beside the list. */
function stickyPlan(page: Page) {
  return page.locator(
    'section[aria-label="Current tasks"]:has(~ * [data-web-shell-message-list])',
  );
}

/** The bottom chip: the other "Current tasks" region. */
function planChip(page: Page) {
  return page.locator(
    'section[aria-label="Current tasks"]:not(:has(~ * [data-web-shell-message-list]))',
  );
}

async function openSession(page: Page, baseURL: string, withPlan: boolean) {
  const scenario = createWebShellDaemonScenario({
    // The reader parks inside the first turn; the plan belongs to the second,
    // so nothing above the reader changes except the strip itself.
    events: [
      userTextEvent('Walk me through the transcript.', { id: 1 }),
      assistantTextEvent(TRANSCRIPT, { id: 2 }),
      turnCompleteEvent('prompt-transcript', { id: 3 }),
      userTextEvent('Now run the plan.', { id: 4 }),
      ...(withPlan
        ? [toolCallEvent('todo-0', 'todo_write', plan(0), { id: 5 })]
        : []),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  await expect(page.getByText('Now run the plan.')).toBeVisible();
  return daemon;
}

/** Scroll up with real wheel input so follow mode really pauses. */
async function parkReader(page: Page) {
  const list = page.locator('[data-web-shell-message-list]');
  const box = await list.boundingBox();
  if (!box) throw new Error('message list is not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(500);
  // Anchor on a paragraph that is on screen now, without scrolling to it.
  const text = await list.evaluate((element) => {
    const listTop = element.getBoundingClientRect().top;
    const paragraph = [...element.querySelectorAll('p')].find((node) => {
      const nodeTop = node.getBoundingClientRect().top;
      return (
        /^LINE-\d{3}/.test(node.textContent ?? '') &&
        nodeTop > listTop + 150 &&
        nodeTop < listTop + 350
      );
    });
    return paragraph?.textContent?.slice(0, 8) ?? null;
  });
  if (!text) throw new Error('no transcript paragraph on screen to anchor on');
  return page.getByText(text, { exact: false });
}

async function top(locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('anchor is not laid out');
  return box.y;
}

test('pins the plan above the transcript, in step with the chip @smoke', async ({
  page,
}, testInfo) => {
  const daemon = await openSession(
    page,
    String(testInfo.project.use.baseURL),
    true,
  );
  const strip = stickyPlan(page);
  await expect(strip).toHaveCount(1);
  await expect(strip).toContainText('Step 1 / 7');
  await expect(planChip(page)).toContainText('Step 1 / 7');
  // Expanded by default, five open rows plus the overflow tail.
  await expect(strip.getByRole('listitem')).toHaveCount(6);
  await expect(strip).toContainText('... 2 more');

  const stripBox = await strip.boundingBox();
  const listBox = await page
    .locator('[data-web-shell-message-list]')
    .boundingBox();
  expect(stripBox!.y + stripBox!.height).toBeLessThanOrEqual(listBox!.y + 1);

  await daemon.sendEvent(toolCallEvent('todo-3', 'todo_write', plan(3)));
  await expect(strip).toContainText('Step 4 / 7');
  await expect(planChip(page)).toContainText('Step 4 / 7');
  await expect(strip.getByRole('listitem')).toHaveCount(4);

  await daemon.sendEvent(toolCallEvent('todo-7', 'todo_write', plan(7)));
  await expect(strip).toHaveCount(0);
});

test('keeps a scrolled-up reader in place while the plan shrinks @smoke', async ({
  page,
}, testInfo) => {
  const daemon = await openSession(
    page,
    String(testInfo.project.use.baseURL),
    true,
  );
  await expect(stickyPlan(page)).toContainText('Step 1 / 7');
  const anchor = await parkReader(page);
  const before = await top(anchor);

  // Completing three items at once drops two rows (~44px) from the strip.
  await daemon.sendEvent(toolCallEvent('todo-3', 'todo_write', plan(3)));
  await expect(stickyPlan(page)).toContainText('Step 4 / 7');
  await expect
    .poll(async () => Math.abs((await top(anchor)) - before))
    .toBeLessThan(2);
});

test('keeps a scrolled-up reader in place when the plan appears and completes @smoke', async ({
  page,
}, testInfo) => {
  const daemon = await openSession(
    page,
    String(testInfo.project.use.baseURL),
    false,
  );
  const anchor = await parkReader(page);
  const before = await top(anchor);

  await daemon.sendEvent(toolCallEvent('todo-0', 'todo_write', plan(0)));
  await expect(stickyPlan(page)).toContainText('Step 1 / 7');
  await expect
    .poll(async () => Math.abs((await top(anchor)) - before))
    .toBeLessThan(2);

  const mid = await top(anchor);
  await daemon.sendEvent(toolCallEvent('todo-7', 'todo_write', plan(7)));
  await expect(stickyPlan(page)).toHaveCount(0);
  await expect
    .poll(async () => Math.abs((await top(anchor)) - mid))
    .toBeLessThan(2);
});

/** Distance from the bottom of the transcript content, in pixels. */
function fromBottom(page: Page) {
  return page
    .locator('[data-web-shell-message-list]')
    .evaluate(
      (element) =>
        (element as HTMLElement).scrollHeight -
        (element as HTMLElement).scrollTop -
        (element as HTMLElement).clientHeight,
    );
}

test('pins a follow-paused reader to the bottom when the strip collapses @smoke', async ({
  page,
}, testInfo) => {
  await openSession(page, String(testInfo.project.use.baseURL), true);
  const strip = stickyPlan(page);
  await expect(strip).toContainText('Step 1 / 7');

  // Pause follow mode just below the guard band: the collapse shrink
  // (~135px) is larger than this distance, so the browser clamps scrollTop
  // before the strip's ResizeObserver can reconstruct a pre-change distance.
  const list = page.locator('[data-web-shell-message-list]');
  const box = await list.boundingBox();
  if (!box) throw new Error('message list is not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(400);
  const readerDistance = await fromBottom(page);
  expect(readerDistance).toBeGreaterThan(30);

  await strip.getByRole('button', { name: 'Collapse task list' }).click();
  await expect(
    strip.getByRole('button', { name: 'Expand task list' }),
  ).toBeAttached();

  // The shrink pins the reader to the bottom; a double-applied compensation
  // would park them a whole shrink height short of it.
  await expect.poll(async () => fromBottom(page)).toBeLessThan(30);
});

test('does not move a reader when a covering panel hides and reshows the chat @smoke', async ({
  page,
}, testInfo) => {
  await openSession(page, String(testInfo.project.use.baseURL), true);
  const strip = stickyPlan(page);
  await expect(strip).toContainText('Step 1 / 7');
  const anchor = await parkReader(page);
  const before = await top(anchor);

  // The settings panel covers the chat with display:none; the strip keeps
  // its pre-hide height so the re-show is a no-op. On a session page the
  // settings entry lives in the sidebar's More popover.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .first()
    .click();
  await expect(page.getByTestId('inline-panel')).toBeVisible();
  await page.getByTestId('panel-back').click();
  await expect(page.getByTestId('inline-panel')).toHaveCount(0);

  await expect
    .poll(async () => Math.abs((await top(anchor)) - before))
    .toBeLessThan(2);
});

test('does not fetch older history when the strip compensates near the top @smoke', async ({
  page,
}, testInfo) => {
  const sessionId = 'sticky-plan-top-compensation';
  const record = (recordId: number, text: string, id: number) => ({
    v: 1 as const,
    id,
    type: 'session_update' as const,
    data: {
      update: {
        sessionUpdate: 'agent_message_chunk' as const,
        content: { type: 'text', text },
        _meta: {
          'qwen.session.recordId': `record-${recordId}`,
          qwenTranscript: { sourceRecordIds: [`record-${recordId}`] },
        },
      },
    },
  });
  const live = [
    record(1, 'Persisted opening paragraph.', 11),
    record(2, TRANSCRIPT, 12),
    record(3, 'Persisted closing paragraph.', 13),
    userTextEvent('Now run the plan.', { id: 4 }),
    toolCallEvent('todo-0', 'todo_write', plan(0), { id: 5 }),
  ];
  const scenario = createWebShellDaemonScenario({ sessionId, events: live });
  scenario.capabilities.features.push('session_transcript_pagination');
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  // Advertise an older page the way a truncated persisted session does.
  const baseURL = String(testInfo.project.use.baseURL);
  await page.route(
    new RegExp(
      `^${baseURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/session/${sessionId}/(?:load|resume)$`,
    ),
    async (route) => {
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
          lastEventId: 13,
          historyHasMore: true,
          historyAnchorRecordId: 'record-3',
        },
      });
    },
  );
  await page.goto(`/session/${sessionId}`);
  await daemon.sse.waitForConnection(sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId, replayedCount: live.length }),
  );
  await expect(page.getByText('Now run the plan.')).toBeVisible();
  const strip = stickyPlan(page);
  await expect(strip).toContainText('Step 1 / 7');

  const transcriptRequests = () =>
    daemon.requests.filter((request) =>
      /\/session\/[^/]+\/transcript\/?$/.test(request.path),
    ).length;

  // Park the reader near the top with a real wheel gesture so follow mode
  // pauses on user intent: a bare scrollTop write would be re-pinned when
  // the list resizes. Land just inside the older-history threshold.
  const list = page.locator('[data-web-shell-message-list]');
  const parkedFrom = await list.evaluate(
    (element) => (element as HTMLElement).scrollTop,
  );
  const box = await list.boundingBox();
  if (!box) throw new Error('message list is not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -(parkedFrom - 200));
  await page.waitForTimeout(400);
  expect(
    await list.evaluate((element) => (element as HTMLElement).scrollTop),
  ).toBeLessThanOrEqual(200);

  const before = transcriptRequests();
  await strip.getByRole('button', { name: 'Collapse task list' }).click();
  await expect(
    strip.getByRole('button', { name: 'Expand task list' }),
  ).toBeAttached();

  // The compensation write must not read as the user scrolling to the
  // older-history edge: no transcript page fetch may fire.
  await page.waitForTimeout(500);
  expect(transcriptRequests()).toBe(before);

  // Positive control: a real user scroll into the threshold does fetch.
  const box2 = await list.boundingBox();
  if (!box2) throw new Error('message list is not laid out');
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.wheel(0, -80);
  await page.waitForTimeout(500);
  expect(transcriptRequests()).toBeGreaterThan(before);
});
