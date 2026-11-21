import { expect, test, type Page } from '@playwright/test';

// The harness hosts the real TodoPanel inside the real .footer /
// .bottomPanels container (App.module.css) above a click-counting
// transcript, so these specs exercise true pointer geometry: the card
// floats 8px above the bar, and that band is what separates the pill from
// the card for a moving pointer (issue #16970).

interface Stats {
  opened: number;
  transcriptClicks: number;
}

async function openHarness(page: Page) {
  await page.goto('/e2e/todo-tooltip-harness.html');
  await expect(page.locator('[data-demo-composer]')).toBeVisible();
}

async function stats(page: Page): Promise<Stats> {
  return JSON.parse(
    (await page.locator('#demo-stats').textContent()) || '{}',
  ) as Stats;
}

function detail(page: Page) {
  return page.locator('[data-testid="todo-panel-detail"]');
}

function pill(page: Page) {
  return page.locator('[data-demo-stage] button[aria-label="Step 1 / 3"]');
}

async function pillBox(page: Page) {
  const box = await pill(page).boundingBox();
  if (!box) throw new Error('pill box not found');
  return box;
}

async function panelBox(page: Page) {
  // The band is referenced from the .panel (section) box, not the pill
  // button box: .summary padding offsets the button from the panel top,
  // and the bridge covers exactly the 8px between the panel top and the
  // lifted card.
  const box = await page.locator('[data-demo-stage] section').boundingBox();
  if (!box) throw new Error('panel box not found');
  return box;
}

test('a real pointer walks from the pill through the band into the card and opens the panel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openHarness(page);

  const box = await pillBox(page);
  const pbox = await panelBox(page);
  const cardBox = await detail(page).boundingBox();
  if (!cardBox) throw new Error('card box not found');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const endX = cardBox.x + cardBox.width / 2;
  const endY = cardBox.y + cardBox.height / 2;

  await page.mouse.move(startX, startY);
  // Discrete samples, so the pointer crosses the 8px band the way a user's
  // mouse does: each intermediate sample is a real hit-test.
  await page.mouse.move(endX, endY, { steps: 40 });

  // At the middle of the band the hit must still be the panel (the band is
  // its pseudo-element), not the transcript behind — otherwise the click
  // below can only land on the transcript.
  const bandHit = await page.evaluate(
    ([x, y]: [number, number]) => {
      const el = document.elementFromPoint(x, y);
      const section =
        document.querySelector('[data-demo-stage] section') ?? null;
      return (
        el !== null &&
        section !== null &&
        section.contains(el) &&
        !el.closest('[data-demo-transcript]')
      );
    },
    [startX, pbox.y - 4],
  );
  expect(bandHit).toBe(true);

  const cardHit = await page.evaluate(() => {
    const card =
      document.querySelector('[data-testid="todo-panel-detail"]') ?? null;
    if (!card) return false;
    const rect = card.getBoundingClientRect();
    const el = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return el !== null && card.contains(el);
  });
  expect(cardHit).toBe(true);

  await page.mouse.click(endX, endY);
  const after = await stats(page);
  expect(after.opened).toBe(1);
  expect(after.transcriptClicks).toBe(0);
});

test('passes clicks through the band to the transcript while the card is hidden', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openHarness(page);

  const pbox = await panelBox(page);
  // Park the pointer far from the panel so the card and the band are inert.
  await page.mouse.move(10, 10);
  const x = pbox.x + pbox.width / 2;
  const y = pbox.y - 4;
  const hit = await page.evaluate(
    ([x, y]: [number, number]) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest('[data-demo-transcript]') !== null;
    },
    [x, y],
  );
  expect(hit).toBe(true);
  await page.mouse.click(x, y);
  const after = await stats(page);
  expect(after.opened).toBe(0);
  expect(after.transcriptClicks).toBe(1);
});

test('a drag-selection released inside the card does not open the panel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openHarness(page);

  const first = page.locator('[title="First todo row one"]');
  const third = page.locator('[title="Third todo row three"]');
  const start = await first.boundingBox();
  const end = await third.boundingBox();
  if (!start || !end) throw new Error('row boxes not found');

  // Hover the pill first: while the card is hidden its rows are
  // pointer-events: none, so a mousedown there would fall through to the
  // transcript behind instead of selecting the card's text.
  const pb = await pillBox(page);
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.move(start.x + 40, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 40, end.y + end.height / 2, { steps: 10 });
  await page.mouse.up();

  const after = await stats(page);
  expect(after.opened).toBe(0);
  const selection = await page.evaluate(
    () => window.getSelection()?.toString() ?? '',
  );
  expect(selection).toContain('Second todo row two');
});

test('the card is a real tab stop that activates on Enter', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openHarness(page);

  const section = page.locator('[data-demo-stage] section');
  await section.focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
    'BUTTON',
  );
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid'),
    ),
  ).toBe('todo-panel-detail');
  await page.keyboard.press('Enter');
  const after = await stats(page);
  expect(after.opened).toBe(1);
});

test('the card spans the column, capped at 560px, without being clipped', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openHarness(page);

  const measure = () =>
    page.evaluate(() => {
      const card =
        document.querySelector('[data-testid="todo-panel-detail"]') ?? null;
      if (!card) return null;
      const rect = card.getBoundingClientRect();
      return {
        width: rect.width,
        left: rect.left,
        right: window.innerWidth - rect.right,
      };
    });

  expect((await measure())?.width).toBeCloseTo(560, 0);

  await page.setViewportSize({ width: 480, height: 800 });
  const narrow = await measure();
  expect(narrow).not.toBeNull();
  expect(narrow!.width).toBeLessThan(560);
  expect(narrow!.left).toBeGreaterThanOrEqual(0);
  expect(narrow!.right).toBeGreaterThanOrEqual(0);
});
