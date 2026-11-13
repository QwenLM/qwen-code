import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

const TURNS = 12;
// Output rows in one turn. More than the virtualizer's overscan once expanded.
const OUTPUTS = 60;
const PER_TURN = OUTPUTS + 1;

function recordEvent(record: number) {
  const turn = Math.floor(record / PER_TURN);
  const output = record % PER_TURN;
  const kind =
    output === 0
      ? 'user_message_chunk'
      : output % 2
        ? 'agent_thought_chunk'
        : 'agent_message_chunk';
  const text =
    output === 0
      ? `QUESTION ${turn} `
      : `ANSWER ${turn}.${output} ` +
        'lorem ipsum dolor sit amet '.repeat(output === OUTPUTS ? 200 : 20);
  return {
    v: 1 as const,
    id: record + 10,
    type: 'session_update' as const,
    data: {
      update: {
        sessionUpdate: kind,
        content: { type: 'text', text },
        _meta: {
          'qwen.session.recordId': `record-${record}`,
          qwenTranscript: { sourceRecordIds: [`record-${record}`] },
        },
      },
    },
  };
}

async function openSession(page: Page, baseURL: string | undefined) {
  const live = Array.from({ length: TURNS * PER_TURN }, (_, index) =>
    recordEvent(index),
  );
  const sessionId = 'pinned-prompt';
  const scenario = createWebShellDaemonScenario({ sessionId, events: live });
  scenario.capabilities.features.push(
    'session_turn_navigation',
    'session_transcript_pagination',
  );
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.route(`${baseURL}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/turn-index')) return route.fallback();
    const limit = Number(url.searchParams.get('limit'));
    const start = Number(
      url.searchParams.get('start') ?? Math.max(0, TURNS - limit),
    );
    await route.fulfill({
      json: {
        v: 1,
        sessionId,
        snapshot: 'mock-snapshot',
        totalTurns: TURNS,
        start,
        turns: Array.from(
          { length: Math.min(limit, TURNS - start) },
          (_, index) => ({
            ordinal: start + index,
            turnId: `record-${PER_TURN * (start + index)}`,
            kind: 'prompt',
            label: `Prompt of turn ${start + index}`,
          }),
        ),
      },
    });
  });
  await page.goto(`/session/${sessionId}`);
  await daemon.sse.waitForConnection(sessionId, { timeout: 30_000 });
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId, replayedCount: live.length }),
  );
  await expect(
    page.locator('[data-web-shell-message-row]').first(),
  ).toBeVisible();
}

const list = (page: Page) => page.locator('[data-web-shell-message-list]');
const pinned = (page: Page) => page.locator('[data-pinned-turn-prompt]');
const rowWith = (page: Page, text: string) =>
  list(page).locator('[data-web-shell-message-row]', { hasText: text });

// Rows are virtualized, so walk up from the live tail until the row is mounted,
// then put its top `below` pixels under the top edge of the viewport.
async function scrollToRow(page: Page, text: string, below = 0) {
  await expect
    .poll(() =>
      list(page).evaluate(
        (element, { text, below }) => {
          const row = [
            ...element.querySelectorAll('[data-web-shell-message-row]'),
          ].find((candidate) => candidate.textContent?.includes(text));
          if (!row) {
            element.scrollTop -= 1000;
            return false;
          }
          element.scrollTop +=
            row.getBoundingClientRect().top -
            element.getBoundingClientRect().top +
            below;
          return true;
        },
        { text, below },
      ),
    )
    .toBe(true);
}

test('pins the prompt of the turn being read when the rail is hidden @smoke', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await openSession(page, baseURL);
  await expect(page.locator('[data-global-turn-navigation]')).toBeHidden();

  await scrollToRow(page, `ANSWER 5.${OUTPUTS}`, 200);
  // The collapsed turn keeps its question row mounted above the reading
  // line, so the label is the user message text, not the turn index label.
  await expect(pinned(page)).toHaveText('QUESTION 5');
  await expect(pinned(page)).toHaveAttribute('data-pinned-turn-prompt', '5');

  // The overlay sits at the viewport edge and stays there during a scroll.
  const box = (await pinned(page).boundingBox())!;
  const listBox = (await list(page).boundingBox())!;
  expect(box.y - listBox.y).toBeGreaterThanOrEqual(0);
  expect(box.y - listBox.y).toBeLessThan(20);
  await list(page).evaluate((element) => {
    element.scrollTop += 60;
  });
  expect((await pinned(page).boundingBox())!.y).toBe(box.y);

  // The next turn switches the label, and its prompt row in view hides it.
  await scrollToRow(page, `ANSWER 6.${OUTPUTS}`, 200);
  await expect(pinned(page)).toHaveText('QUESTION 6');
  await scrollToRow(page, 'QUESTION 6');
  await expect(pinned(page)).toHaveCount(0);
});

test('keeps the label after the prompt row leaves the virtualizer window', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await openSession(page, baseURL);
  await scrollToRow(page, 'QUESTION 5');
  await rowWith(page, 'QUESTION 5')
    .locator('xpath=following-sibling::*')
    .first()
    .getByRole('button')
    .first()
    .click();
  await expect(rowWith(page, 'ANSWER 5.2 ').first()).toBeVisible();
  await expect
    .poll(async () => {
      await list(page).evaluate((element) => {
        element.scrollTop += 800;
      });
      return rowWith(page, 'QUESTION 5').count();
    })
    .toBe(0);
  await expect(rowWith(page, 'ANSWER 5.')).not.toHaveCount(0);
  // Every user row above the reading line is unmounted here, so the label
  // falls back to the turn index label.
  await expect(pinned(page)).toHaveText('Prompt of turn 5');
});

test('stays out of row sizing, scroll position and hit testing', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await openSession(page, baseURL);
  await scrollToRow(page, `ANSWER 5.${OUTPUTS}`, 200);
  await expect(pinned(page)).toBeVisible();
  await expect(list(page).locator('[data-pinned-turn-prompt]')).toHaveCount(0);

  const measure = () =>
    list(page).evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
    }));
  // Hiding the overlay is the control: nothing in the list may move.
  let shown = await measure();
  await expect
    .poll(async () => {
      shown = await measure();
      return shown;
    })
    .toEqual(shown);
  await pinned(page).evaluate((element) => {
    element.style.display = 'none';
  });
  expect(await measure()).toEqual(shown);
  await pinned(page).evaluate((element) => {
    element.style.display = '';
  });

  // A wheel over the overlay still scrolls the transcript.
  const box = (await pinned(page).boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.wheel(0, 100);
  await expect
    .poll(() => list(page).evaluate((element) => element.scrollTop))
    .toBeGreaterThan(shown.scrollTop);
});

test('agrees with the rail highlight when the rail is visible', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openSession(page, baseURL);
  await expect(page.locator('[data-global-turn-navigation]')).toBeVisible();
  await scrollToRow(page, `ANSWER 5.${OUTPUTS}`, 200);
  await expect(pinned(page)).toHaveAttribute('data-pinned-turn-prompt', '5');
  await expect(
    page.locator('[data-global-turn-navigation] [aria-current]'),
  ).toHaveAttribute('data-turn-ordinal', '5');
});

test('takes one line on a small viewport', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 900, height: 480 });
  await openSession(page, baseURL);
  await scrollToRow(page, `ANSWER 5.${OUTPUTS}`, 200);
  await expect(pinned(page)).toBeVisible();
  expect((await pinned(page).boundingBox())!.height).toBeLessThanOrEqual(30);
});
