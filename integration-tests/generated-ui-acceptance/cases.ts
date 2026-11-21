/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The four #14019 acceptance cases. Each runner drives a real card through
 * the harness and records one result per check. A check observes behavior;
 * it never assumes a capability is missing. When a precondition fails (for
 * example nothing was persisted, so isolation cannot be judged), dependent
 * checks report `not-applicable` with the reason.
 *
 * Harness contract: the prompts in `prompts.ts` name the element IDs used
 * here. Amounts are compared in integer cents.
 */

import type { Frame, Page } from 'playwright';
import {
  BILL_DEFAULTS,
  BILL_SCENARIO,
  COMPARATOR_SCENARIO,
  COMPARATOR_SELECTED_PLAN,
  PLANS,
  billShares,
  billTotal,
  comparatorMonthlyEquivalent,
  comparatorPayment,
  type ComparatorInputs,
  type Plan,
} from './fixtures.js';
import {
  SHOW_TOOL,
  clickWhenStill,
  messageText,
  saveOutcome,
  setValue,
  settle,
  text,
  userTurns,
  waitForCardOn,
  waitForStill,
  type AcceptanceEnv,
  type Card,
  type ChatMessage,
} from './harness.js';
import {
  formatCents,
  parseAmounts,
  parseShareAmount,
  parseSingleAmount,
} from './money.js';
import type { CheckResult, CheckStatus } from './report.js';

class Checks {
  readonly results: CheckResult[] = [];
  constructor(private readonly prefix: string) {}

  add(id: string, covers: string, status: CheckStatus, detail?: string) {
    this.results.push({ id: `${this.prefix}.${id}`, covers, status, detail });
    return status === 'pass';
  }

  expect(id: string, covers: string, ok: boolean, detail: string) {
    return this.add(id, covers, ok ? 'pass' : 'fail', ok ? undefined : detail);
  }

  has(id: string) {
    return this.results.some((result) => result.id === `${this.prefix}.${id}`);
  }

  /**
   * Runs one check. A throw records `id` as failed; checks listed in
   * `dependents` that the run did not reach are recorded as `not-applicable`,
   * so a case always reports the same set of ids.
   */
  async guard(
    id: string,
    covers: string,
    run: () => Promise<boolean>,
    dependents: Array<[id: string, covers: string]> = [],
  ) {
    let ok: boolean;
    let reason = `"${id}" did not complete`;
    try {
      ok = await run();
    } catch (error) {
      reason = `error: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`;
      ok = this.has(id) ? false : this.add(id, covers, 'fail', reason);
    }
    for (const [dependent, dependentCovers] of dependents) {
      if (!this.has(dependent)) {
        this.add(dependent, dependentCovers, 'not-applicable', reason);
      }
    }
    return ok;
  }

  /** Records checks that cannot run because a precondition failed. */
  skip(ids: Array<[id: string, covers: string]>, reason: string) {
    for (const [id, covers] of ids) {
      if (!this.has(id)) this.add(id, covers, 'not-applicable', reason);
    }
  }
}

async function shareAmounts(view: Frame): Promise<number[]> {
  // Join text nodes with spaces: `<span>1</span><span>137.84</span>` is a
  // label and an amount, not 1137.84.
  const texts = await view
    .locator('#shares > *')
    .evaluateAll((items) =>
      items.map((item) => {
        const parts: string[] = [];
        const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
        while (walker.nextNode())
          parts.push(walker.currentNode.nodeValue ?? '');
        return parts.join(' ');
      }),
    )
    .catch(() => [] as string[]);
  return texts
    .map((value) => parseShareAmount(value))
    .filter((value): value is number => value !== undefined);
}

async function readBill(view: Frame) {
  return {
    total: parseSingleAmount(await text(view, 'total')),
    shares: await shareAmounts(view),
  };
}

function describeBill(observed: { total?: number; shares: number[] }) {
  return `total=${observed.total === undefined ? 'unreadable' : formatCents(observed.total)} shares=[${observed.shares.map(formatCents).join(', ')}]`;
}

/** Attributes that hold bare element ids rather than `#id` references. */
const ID_LIST_ATTRIBUTES = [
  'aria-activedescendant',
  'aria-controls',
  'aria-describedby',
  'aria-details',
  'aria-errormessage',
  'aria-flowto',
  'aria-labelledby',
  'aria-owns',
  'for',
  'form',
  'headers',
  'list',
];

/**
 * A snapshot of `#chart` that ignores regenerated element ids and includes
 * canvas pixels, so a redraw with the same data compares equal and a canvas
 * chart is observable. `hasContent` is false for an empty chart.
 */
async function chartState(view: Frame) {
  return view.locator('#chart').evaluate((element, idListAttributes) => {
    const clone = element.cloneNode(true) as HTMLElement;
    const ids = new Map(
      [...clone.querySelectorAll('[id]')].map((node, index) => [
        node.id,
        `chart-id-${index}`,
      ]),
    );
    const references = (value: string) =>
      value.replace(/#([\w:.-]+)/g, (reference, id: string) =>
        ids.has(id) ? `#${ids.get(id)}` : reference,
      );
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const attribute of [...node.attributes]) {
        if (attribute.name === 'id') {
          node.id = ids.get(attribute.value) ?? attribute.value;
        } else if (idListAttributes.includes(attribute.name)) {
          node.setAttribute(
            attribute.name,
            attribute.value
              .split(/\s+/)
              .map((id) => ids.get(id) ?? id)
              .join(' '),
          );
        } else {
          node.setAttribute(attribute.name, references(attribute.value));
        }
      }
      if (node.tagName.toLowerCase() === 'style') {
        node.textContent = references(node.textContent ?? '');
      }
    }
    const canvases = [
      ...(element instanceof HTMLCanvasElement ? [element] : []),
      ...element.querySelectorAll('canvas'),
    ];
    const pixels = canvases.map((canvas) => canvas.toDataURL());
    const blank = canvases.map((canvas) => {
      const empty = document.createElement('canvas');
      empty.width = canvas.width;
      empty.height = canvas.height;
      return empty.toDataURL();
    });
    return {
      hasContent:
        element.children.length > 0 ||
        (element.textContent ?? '').trim().length > 0 ||
        pixels.some((data, index) => data !== blank[index]),
      state: JSON.stringify({ html: clone.outerHTML, canvases: pixels }),
    };
  }, ID_LIST_ATTRIBUTES);
}

/** Bill splitter: immediate updates, cent conservation, invalid input, copy, reset. */
export async function runBillSplitter(
  env: AcceptanceEnv,
  prompt: string,
): Promise<CheckResult[]> {
  const checks = new Checks('bill');
  await env.startSession(prompt);
  const card = await env.waitForCard(0);
  await env.waitForIdle();
  const before = env.mainRequests().length;
  const { view } = card;

  const expectedDefault = billShares(BILL_DEFAULTS);
  const defaults = await settle(
    () => readBill(view),
    (bill) => bill.total === billTotal(BILL_DEFAULTS),
  );
  checks.expect(
    'defaults',
    'case 1',
    defaults.total === billTotal(BILL_DEFAULTS) &&
      JSON.stringify(defaults.shares) === JSON.stringify(expectedDefault),
    `expected total ${formatCents(billTotal(BILL_DEFAULTS))} and ${BILL_DEFAULTS.people}×${formatCents(expectedDefault[0])}; saw ${describeBill(defaults)}`,
  );

  const chartBefore = await chartState(view).catch(() => undefined);

  await checks.guard(
    'scenario',
    'case 1',
    async () => {
      await setValue(view, 'people', String(BILL_SCENARIO.people));
      await setValue(view, 'discount', formatCents(BILL_SCENARIO.discount));
      await setValue(view, 'service-rate', String(BILL_SCENARIO.serviceRate));
      const total = billTotal(BILL_SCENARIO);
      const observed = await settle(
        () => readBill(view),
        (bill) =>
          bill.total === total && bill.shares.length === BILL_SCENARIO.people,
      );
      const ok =
        observed.total === total &&
        JSON.stringify(observed.shares) ===
          JSON.stringify(billShares(BILL_SCENARIO));
      checks.expect(
        'scenario',
        'case 1',
        ok,
        `expected total ${formatCents(total)} with 4×137.84 + 3×137.83; saw ${describeBill(observed)}`,
      );
      const sum = observed.shares.reduce((a, b) => a + b, 0);
      checks.expect(
        'conserves-cents',
        'case 1',
        observed.total !== undefined &&
          sum === observed.total &&
          observed.shares.length === BILL_SCENARIO.people,
        `shares sum to ${formatCents(sum)} over ${observed.shares.length} people; total ${observed.total === undefined ? 'unreadable' : formatCents(observed.total)}`,
      );
      const spread = observed.shares.length
        ? Math.max(...observed.shares) - Math.min(...observed.shares)
        : Infinity;
      checks.expect(
        'fair-rounding',
        'case 1',
        spread <= 1,
        `shares differ by ${spread} cents`,
      );
      const chartAfter = await chartState(view).catch(() => undefined);
      checks.expect(
        'chart-updates',
        'case 1 / R1',
        !!chartBefore &&
          !!chartAfter?.hasContent &&
          chartAfter.state !== chartBefore.state,
        !chartBefore || !chartAfter
          ? 'no #chart element'
          : chartAfter.hasContent
            ? 'the chart did not change with the inputs'
            : 'no #chart content',
      );
      return true;
    },
    [
      ['conserves-cents', 'case 1'],
      ['fair-rounding', 'case 1'],
      ['chart-updates', 'case 1 / R1'],
    ],
  );

  await checks.guard('rejects-invalid', 'case 1', async () => {
    await setValue(view, 'people', '0');
    const error = await settle(
      () => text(view, 'error'),
      (value) => value.length > 0,
    );
    const total = await text(view, 'total');
    checks.expect(
      'rejects-invalid',
      'case 1',
      error.length > 0 && !/NaN|Infinity/.test(total),
      `error="${error}" total="${total}"`,
    );
    await setValue(view, 'people', String(BILL_SCENARIO.people));
    return true;
  });

  await checks.guard('copies-current', 'case 1 / R5', async () => {
    await env.page.evaluate(() => navigator.clipboard.writeText(''));
    await clickWhenStill(view.locator('#copy'));
    await env.page.waitForTimeout(500);
    const copied = await env.page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    return checks.expect(
      'copies-current',
      'case 1 / R5',
      parseAmounts(copied).includes(billTotal(BILL_SCENARIO)),
      copied
        ? `clipboard holds "${copied.slice(0, 80)}"`
        : 'nothing reached the clipboard',
    );
  });

  await checks.guard('reset', 'case 1', async () => {
    await setValue(view, 'subtotal', formatCents(BILL_DEFAULTS.subtotal + 100));
    await clickWhenStill(view.locator('#reset'));
    const expectedInputs = {
      subtotal: BILL_DEFAULTS.subtotal / 100,
      people: BILL_DEFAULTS.people,
      discount: BILL_DEFAULTS.discount / 100,
      'service-rate': BILL_DEFAULTS.serviceRate,
    };
    const readReset = async () => ({
      ...(await readBill(view)),
      inputs: Object.fromEntries(
        await Promise.all(
          Object.keys(expectedInputs).map(
            async (id) =>
              [id, Number(await view.locator(`#${id}`).inputValue())] as const,
          ),
        ),
      ),
      chart: (await chartState(view)).state,
    });
    const matches = (value: Awaited<ReturnType<typeof readReset>>) =>
      value.total === billTotal(BILL_DEFAULTS) &&
      JSON.stringify(value.shares) === JSON.stringify(expectedDefault) &&
      Object.entries(expectedInputs).every(
        ([id, expected]) => value.inputs[id] === expected,
      ) &&
      chartBefore !== undefined &&
      value.chart === chartBefore.state;
    const reset = await settle(readReset, matches);
    return checks.expect(
      'reset',
      'case 1',
      matches(reset),
      `after reset: ${describeBill(reset)} inputs=${JSON.stringify(reset.inputs)} chart restored=${chartBefore === undefined ? 'initial chart unavailable' : reset.chart === chartBefore.state}`,
    );
  });

  checks.expect(
    'edits-start-no-turn',
    'R3',
    env.mainRequests().length === before,
    `${env.mainRequests().length - before} model request(s) followed local edits`,
  );
  return checks.results;
}

async function itemTexts(view: Frame): Promise<string[]> {
  return view
    .locator('[id^="item-"][id$="-text"]')
    .evaluateAll((elements) =>
      elements
        .filter((element) => (element as HTMLElement).offsetParent !== null)
        .map((element) =>
          (['INPUT', 'TEXTAREA'].includes(element.tagName)
            ? (element as HTMLInputElement).value
            : (element.textContent ?? '')
          ).trim(),
        )
        .filter(Boolean),
    )
    .catch(() => []);
}

async function itemStates(view: Frame) {
  return view.locator('[id^="item-"][id$="-text"]').evaluateAll((elements) =>
    elements
      .filter((element) => (element as HTMLElement).offsetParent !== null)
      .map((element) => ({
        text: (['INPUT', 'TEXTAREA'].includes(element.tagName)
          ? (element as HTMLInputElement).value
          : (element.textContent ?? '')
        ).trim(),
        checked: (
          document.getElementById(
            element.id.replace(/-text$/, '-check'),
          ) as HTMLInputElement | null
        )?.checked,
      }))
      .sort(
        (a, b) =>
          a.text.localeCompare(b.text) || Number(a.checked) - Number(b.checked),
      ),
  );
}

async function itemSlot(
  view: Frame,
  label: string,
): Promise<string | undefined> {
  const ids = await view
    .locator('[id^="item-"][id$="-text"]')
    .evaluateAll((elements, wanted) => {
      const match = elements.find(
        (element) =>
          (['INPUT', 'TEXTAREA'].includes(element.tagName)
            ? (element as HTMLInputElement).value
            : (element.textContent ?? '')
          ).trim() === wanted,
      );
      return match ? [match.id] : [];
    }, label);
  return ids[0]?.replace(/-text$/, '');
}

/**
 * Clicks a checkbox or radio and waits for the view to show it checked. The
 * view may re-render the box in response, so Playwright's `check()`, which
 * asserts on the clicked element right away, can report a re-rendered box as
 * unchanged.
 */
async function checkBox(view: Frame, id: string) {
  const box = view.locator(`#${id}`);
  if (!(await box.isChecked())) await clickWhenStill(box);
  await settle(
    () => box.isChecked().catch(() => false),
    (checked) => checked,
  );
}

async function addItem(view: Frame, label: string) {
  await setValue(view, 'new-item', label);
  await clickWhenStill(view.locator('#add'));
  await settle(
    () => itemTexts(view),
    (texts) => texts.includes(label),
  );
}

/**
 * Checklist: add, filter, delete, undo, edit, persistence, the host's save
 * acknowledgement and isolation.
 */
const EDITED_LABEL = 'Agenda (edited)';

export async function runChecklist(
  env: AcceptanceEnv,
  prompt: string,
): Promise<CheckResult[]> {
  const checks = new Checks('checklist');
  await env.startSession(prompt);
  const card = await env.waitForCard(0);
  await env.waitForIdle();
  const sessionUrl = env.page.url();
  const { view } = card;
  const sameState = (
    a: Awaited<ReturnType<typeof itemStates>>,
    b: Awaited<ReturnType<typeof itemStates>>,
  ) => JSON.stringify(a) === JSON.stringify(b);
  const readState = (
    target: Card,
    expected: Awaited<ReturnType<typeof itemStates>>,
  ) =>
    settle(
      () => itemStates(target.view),
      (items) => sameState(items, expected),
    );
  const openChecklist = async (page: Page, url: URL) => {
    const prefix = `${url.pathname}/generated-ui/state/`;
    const cardIds = new Set<string>();
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && path.startsWith(prefix)) {
        cardIds.add(path.slice(prefix.length));
      }
    });
    url.hash = new URLSearchParams({ token: env.daemon.token }).toString();
    await page.goto(url.toString());
    const card = await waitForCardOn(page, 0, env.cardTimeoutMs);
    const [cardId] = cardIds;
    return { page, card, cardId: cardIds.size === 1 ? cardId : undefined };
  };

  const emptyText = await text(view, 'empty');
  const emptyVisible = await view.locator('#empty').first().isVisible();
  checks.expect(
    'empty-state',
    'case 2',
    emptyVisible && emptyText.length > 0,
    'no visible empty-state message before items exist',
  );

  const firstAdd: { outcome?: string; readbackError?: string } = {
    readbackError: 'the first item did not appear',
  };
  const added = await checks.guard('add', 'case 2', async () => {
    await setValue(view, 'new-item', 'Agenda');
    const add = view.locator('#add');
    // Commit any draft change before observing the Add click.
    await add.focus();
    await waitForStill(add);
    firstAdd.outcome = await saveOutcome(card, () => add.click());
    const expected = [{ text: 'Agenda', checked: false }];
    if (
      sameState(await readState(card, expected), expected) &&
      firstAdd.outcome === 'saved'
    ) {
      let probe: Page | undefined;
      try {
        probe = await env.context.newPage();
        const opened = await openChecklist(probe, new URL(sessionUrl));
        const restored = await readState(opened.card, expected);
        firstAdd.readbackError = sameState(restored, expected)
          ? undefined
          : `first Add showed "saved", but a new tab restored ${JSON.stringify(restored)}`;
      } catch (error) {
        firstAdd.readbackError = `could not verify the first Add in a new tab: ${String(error)}`;
      } finally {
        await probe?.close().catch(() => {});
      }
    }
    for (const label of ['Notes', 'Actions']) {
      await addItem(view, label);
    }
    const texts = await itemTexts(view);
    return checks.expect(
      'add',
      'case 2',
      ['Agenda', 'Notes', 'Actions'].every((label) => texts.includes(label)),
      `items: ${JSON.stringify(texts)}`,
    );
  });

  if (added) {
    await checks.guard('check-and-filter', 'case 2', async () => {
      const slot = await itemSlot(view, 'Notes');
      await checkBox(view, `${slot}-check`);
      await env.page.waitForTimeout(300);
      await setValue(view, 'filter', 'done');
      const done = await settle(
        () => itemTexts(view),
        (texts) => texts.length === 1,
      );
      await setValue(view, 'filter', 'open');
      const open = await settle(
        () => itemTexts(view),
        (texts) => texts.length === 2,
      );
      await setValue(view, 'filter', 'all');
      return checks.expect(
        'check-and-filter',
        'case 2',
        JSON.stringify(done) === '["Notes"]' &&
          JSON.stringify([...open].sort()) === '["Actions","Agenda"]',
        `done=${JSON.stringify(done)} open=${JSON.stringify(open)}`,
      );
    });

    await checks.guard('delete', 'case 2', async () => {
      const slot = await itemSlot(view, 'Actions');
      await clickWhenStill(view.locator(`#${slot}-delete`));
      const texts = await settle(
        () => itemTexts(view),
        (value) => !value.includes('Actions'),
      );
      return checks.expect(
        'delete',
        'case 2',
        !texts.includes('Actions') && texts.length === 2,
        `items after delete: ${JSON.stringify(texts)}`,
      );
    });

    const undoWorks = await checks.guard(
      'repeated-undo',
      'case 2',
      async () => {
        await clickWhenStill(view.locator('#undo'));
        const afterFirst = await settle(
          () => itemTexts(view),
          (value) => value.includes('Actions'),
        );
        await clickWhenStill(view.locator('#undo'));
        await env.page.waitForTimeout(500);
        const slot = await itemSlot(view, 'Notes');
        const notesChecked = slot
          ? await view.locator(`#${slot}-check`).isChecked()
          : undefined;
        return checks.expect(
          'repeated-undo',
          'case 2',
          afterFirst.includes('Actions') && notesChecked === false,
          `after one undo: ${JSON.stringify(afterFirst)}; after two, Notes checked=${notesChecked}`,
        );
      },
    );

    await checks.guard('edit', 'case 2', async () => {
      const before = await itemTexts(view);
      const slot = await itemSlot(view, 'Agenda');
      const field = view.locator(`#${slot}-text`);
      const editable = await field
        .evaluate(
          (element) =>
            ['INPUT', 'TEXTAREA'].includes(element.tagName) ||
            (element as HTMLElement).isContentEditable,
        )
        .catch(() => false);
      if (!slot || !editable) {
        return checks.expect(
          'edit',
          'case 2',
          false,
          `item text of "Agenda" is not an editable field (slot ${slot ?? 'not found'})`,
        );
      }
      if (!undoWorks) {
        return checks.add(
          'edit',
          'case 2',
          'not-applicable',
          'undo did not work, so a committed rename cannot be verified',
        );
      }
      const rename = async (target: typeof field) => {
        await target.fill(EDITED_LABEL);
        await target.press('Tab');
      };
      const itemSet = (labels: string[]) => JSON.stringify([...labels].sort());
      const original = itemSet(before);
      const renamed = itemSet(
        before.map((label) => (label === 'Agenda' ? EDITED_LABEL : label)),
      );
      const readItems = async () => itemSet(await itemTexts(view));
      await rename(field);
      const edited = await settle(readItems, (labels) => labels === renamed);
      // Undo must restore exactly the previous list, proving the rename was committed.
      await clickWhenStill(view.locator('#undo'));
      const undone = await settle(readItems, (labels) => labels === original);
      if (edited !== renamed || undone !== original) {
        return checks.expect(
          'edit',
          'case 2',
          false,
          `expected ${renamed} after rename and ${original} after undo, saw ${edited} and ${undone}`,
        );
      }
      const restoredSlot = await itemSlot(view, 'Agenda');
      await rename(view.locator(`#${restoredSlot}-text`));
      const restored = await settle(readItems, (labels) => labels === renamed);
      return checks.expect(
        'edit',
        'case 2',
        restored === renamed,
        `expected ${renamed} after applying the rename again, saw ${restored}`,
      );
    });
  } else {
    checks.skip(
      [
        ['check-and-filter', 'case 2'],
        ['delete', 'case 2'],
        ['repeated-undo', 'case 2'],
        ['edit', 'case 2'],
      ],
      'adding items failed, so there are no items to act on',
    );
  }

  const { beforeDelete, deleted, deleteSlot } = await settle(
    async () => {
      const beforeDelete = await itemStates(view);
      const deleted = beforeDelete.find(
        (item) => item.text && item.text !== 'Notes',
      );
      const deleteSlot = deleted && (await itemSlot(view, deleted.text));
      return { beforeDelete, deleted, deleteSlot };
    },
    ({ beforeDelete, deleteSlot }) =>
      !!deleteSlot &&
      beforeDelete.some((item) => item.text === 'Notes' && !item.checked),
  );
  const beforeSave = beforeDelete.filter((item) => item !== deleted);
  const saved = beforeSave.map((item) =>
    item.text === 'Notes' ? { ...item, checked: true } : item,
  );
  const checkAndSave = async (target: Card, slot: string) => {
    const box = target.view.locator(`#${slot}-check`);
    await waitForStill(box);
    return saveOutcome(target, () => box.click());
  };
  let hasPersistedItems = false;
  let undoOutcome: string | undefined;
  const reloaded = await checks.guard(
    'persists-after-reload',
    'case 2 / R4',
    async () => {
      if (!deleteSlot)
        throw new Error(
          `could not find an item to delete before reload: ${JSON.stringify(beforeDelete)}`,
        );
      await clickWhenStill(view.locator(`#${deleteSlot}-delete`));
      if (!sameState(await readState(card, beforeSave), beforeSave)) {
        throw new Error(
          'could not prepare the deletion to undo after reopening',
        );
      }
      const notesSlot = await itemSlot(view, 'Notes');
      if (
        !notesSlot ||
        !beforeSave.some((item) => item.text === 'Notes' && !item.checked)
      ) {
        throw new Error('could not prepare a checked item and its undo state');
      }
      const outcome = await checkAndSave(card, notesSlot);
      if (outcome === 'saving') {
        throw new Error('the pre-reload save did not settle');
      }
      if (!sameState(await readState(card, saved), saved)) {
        throw new Error('could not prepare a checked item and its undo state');
      }
      await env.page.reload();
      const restoredCard = await env.waitForCard(0);
      const restored = await readState(restoredCard, saved);
      hasPersistedItems = restored.some((item) =>
        saved.some((expected) => expected.text === item.text),
      );
      if (!sameState(restored, saved)) {
        throw new Error(
          `after reload: expected ${JSON.stringify(saved)}, saw ${JSON.stringify(restored)}`,
        );
      }
      const undo = restoredCard.view.locator('#undo');
      await waitForStill(undo);
      undoOutcome = await saveOutcome(restoredCard, () => undo.click());
      const undone = await readState(restoredCard, beforeSave);
      return checks.expect(
        'persists-after-reload',
        'case 2 / R4',
        sameState(undone, beforeSave),
        `undo after reload: expected ${JSON.stringify(beforeSave)}, saw ${JSON.stringify(undone)}`,
      );
    },
  );

  const pages: Page[] = [];
  const openForPersistence = async (url: URL) => {
    const page = await env.context.newPage();
    pages.push(page);
    return openChecklist(page, url);
  };
  try {
    await checks.guard(
      'persists-after-reopen',
      'case 2 / R4',
      async () => {
        if (!reloaded) {
          return checks.add(
            'persists-after-reopen',
            'case 2 / R4',
            'not-applicable',
            'reload did not restore the checked item and its undo history',
          );
        }
        if (undoOutcome === 'saving') {
          throw new Error('the undo save did not settle before reopening');
        }
        const source = await openForPersistence(new URL(sessionUrl));
        const restored = await readState(source.card, beforeSave);
        if (!sameState(restored, beforeSave)) {
          throw new Error(
            `after reopening: expected the undone state ${JSON.stringify(beforeSave)}, saw ${JSON.stringify(restored)} (undo save: ${undoOutcome ?? 'no outcome'})`,
          );
        }

        await checkIsolation(source.cardId);
        await clickWhenStill(source.card.view.locator('#undo'));
        const undone = await readState(source.card, beforeDelete);
        return checks.expect(
          'persists-after-reopen',
          'case 2 / R4',
          sameState(undone, beforeDelete),
          `undo after reopening: expected ${JSON.stringify(beforeDelete)}, saw ${JSON.stringify(undone)}`,
        );
      },
      [['isolated-across-sessions', 'case 2 / R4']],
    );

    if (firstAdd.outcome === undefined && !hasPersistedItems) {
      checks.add(
        'save-acknowledged',
        'case 2 / R4',
        'not-applicable',
        'no items persisted and the host showed no outcome for the first Add',
      );
    } else {
      checks.expect(
        'save-acknowledged',
        'case 2 / R4',
        firstAdd.outcome === 'saved' && firstAdd.readbackError === undefined,
        firstAdd.outcome === 'saved'
          ? (firstAdd.readbackError ?? '')
          : `first Add: host outcome="${firstAdd.outcome ?? 'no new outcome'}"`,
      );
    }
  } finally {
    await Promise.all(pages.map((page) => page.close().catch(() => {})));
  }
  return checks.results;

  async function checkIsolation(sourceCardId: string | undefined) {
    return checks.guard('isolated-across-sessions', 'case 2 / R4', async () => {
      const url = new URL(sessionUrl);
      const id = url.pathname.match(/\/session\/([^/]+)$/)?.[1];
      if (!id) throw new Error('could not identify the source session');
      const sourceId = decodeURIComponent(id);
      const { sessionId } = await env.daemon.client.branchSession(sourceId);
      if (sessionId === sourceId) {
        throw new Error('the branch did not create a distinct session');
      }
      url.pathname = url.pathname.replace(
        /[^/]+$/,
        encodeURIComponent(sessionId),
      );
      const fork = await openForPersistence(url);
      if (!fork.cardId || fork.cardId !== sourceCardId) {
        throw new Error(
          'the two sessions did not load state for the same card ID',
        );
      }
      const inherited = await readState(fork.card, beforeSave);
      if (!sameState(inherited, beforeSave)) {
        throw new Error('the branch did not inherit the original saved state');
      }
      const forkNotesSlot = await itemSlot(fork.card.view, 'Notes');
      if (!forkNotesSlot) throw new Error('could not find Notes in the branch');
      const outcome = await checkAndSave(fork.card, forkNotesSlot);
      if (outcome === 'saving') {
        throw new Error('the branch save did not settle');
      }
      await fork.page.reload();
      const branchState = await readState(
        await waitForCardOn(fork.page, 0, env.cardTimeoutMs),
        saved,
      );
      // Keep the first cold mount intact for its Undo check.
      await env.page.reload();
      const sourceState = await readState(await env.waitForCard(0), beforeSave);
      return checks.expect(
        'isolated-across-sessions',
        'case 2 / R4',
        sameState(branchState, saved) && sameState(sourceState, beforeSave),
        `after saving in the branch: branch=${JSON.stringify(branchState)}, original=${JSON.stringify(sourceState)}`,
      );
    });
  }
}

/** Values of a parameters message: `"id": { "value": "...", "checked": ... }`. */
export function parseSubmittedInputs(
  message: string,
): Record<string, { value: string; checked: boolean }> {
  const inputs: Record<string, { value: string; checked: boolean }> = {};
  const pattern =
    /"([A-Za-z][\w-]{0,63})":\s*\{\s*"value":\s*"((?:[^"\\]|\\.)*)",\s*"checked":\s*(true|false)\s*\}/g;
  for (const match of message.matchAll(pattern)) {
    inputs[match[1]] = {
      value: JSON.parse(`"${match[2]}"`) as string,
      checked: match[3] === 'true',
    };
  }
  return inputs;
}

/** How long a click holds the button down, like a person's click. */
const HUMAN_CLICK_MS = 150;

export const FORM_VALUES: Record<string, string> = {
  activity: 'escape-room',
  date: '2026-12-05',
  participants: '12',
  budget: '180',
  notes: 'two vegetarians',
};

/** Activity form: edits send nothing; one explicit submission sends every field once. */
function submittedParameters(
  env: AcceptanceEnv,
  requestMark: number,
  priorUserTurns: number,
) {
  for (const request of env.mainRequests().slice(requestMark)) {
    const userMessages = request.messages.filter(({ role }) => role === 'user');
    for (const message of userMessages.slice(priorUserTurns)) {
      const text = messageText(message.content);
      if (text.includes('"inputs"')) return text;
    }
  }
  return undefined;
}

interface ContinuationEntry {
  state: string | null;
  text: string;
}

/** Records every change of the card's continuation status from now on. */
async function recordContinuation(app: Frame): Promise<void> {
  await app.evaluate(() => {
    const status = document.getElementById('continuation-status');
    const log: Array<{ state: string | null; text: string }> = [];
    const push = () => {
      const entry = {
        state: status?.getAttribute('data-state') ?? null,
        text: (status?.textContent ?? '').trim(),
      };
      const last = log[log.length - 1];
      if (!last || last.state !== entry.state || last.text !== entry.text)
        log.push(entry);
    };
    push();
    if (status)
      new MutationObserver(push).observe(status, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    (globalThis as { __continuationLog?: typeof log }).__continuationLog = log;
  });
}

async function continuationLog(app: Frame): Promise<ContinuationEntry[]> {
  return app
    .evaluate(
      () =>
        (globalThis as { __continuationLog?: ContinuationEntry[] })
          .__continuationLog ?? [],
    )
    .catch(() => []);
}

function describeLog(log: ContinuationEntry[]): string {
  return log
    .map((entry) =>
      entry.text
        ? `${entry.state} ("${entry.text.slice(0, 60)}")`
        : `${entry.state}`,
    )
    .join(' → ');
}

export async function runActivityForm(
  env: AcceptanceEnv,
  prompt: string,
): Promise<CheckResult[]> {
  const checks = new Checks('form');
  await env.startSession(prompt);
  const card = await env.waitForCard(0);
  await env.waitForIdle();
  const { view, app } = card;
  const before = env.mainRequests().length;

  await checks.guard('edits-start-no-turn', 'case 3 / R3', async () => {
    for (const [id, value] of Object.entries(FORM_VALUES)) {
      await setValue(view, id, value);
    }
    await env.page.waitForTimeout(2_000);
    return checks.expect(
      'edits-start-no-turn',
      'case 3 / R3',
      env.mainRequests().length === before,
      `${env.mainRequests().length - before} model request(s) followed edits`,
    );
  });

  let repliesBefore: number | undefined;
  let hasSubmittedParameters = false;
  await checks.guard(
    'one-submission',
    'case 3 / R3',
    async () => {
      const button = app.locator('#continue-analysis');
      await settle(
        () => button.isEnabled(),
        (enabled) => enabled,
        10_000,
      );
      await button.scrollIntoViewIfNeeded();
      await recordContinuation(app);
      repliesBefore = (await env.assistantTexts()).length;
      const beforeClick = env.mainRequests();
      const clickMark = beforeClick.length;
      const turnsBefore = Math.max(0, ...beforeClick.map(userTurns));
      const submission = () => submittedParameters(env, clickMark, turnsBefore);
      // First attempt straight after typing, at a person's pace: a zero-delay
      // synthetic click releases the button inside the few milliseconds the
      // host disables it while the edited field loses focus, so the browser
      // drops the click. It counts only if it reaches a submitted model request
      // without another click.
      await button.click({ delay: HUMAN_CLICK_MS });
      // A click that changes nothing within 5 s did nothing; one that started a
      // send gets the host's review and admission windows to settle.
      let afterFirst = await settle(
        () => continuationLog(app),
        (log) => log.length > 1,
        5_000,
      );
      if (afterFirst.length > 1) {
        afterFirst = await settle(
          () => continuationLog(app),
          (log) => {
            const last = log[log.length - 1]?.state;
            return last !== 'pending' && last !== null;
          },
          200_000,
        );
        await settle(
          async () => submission(),
          (parameters) => parameters !== undefined,
          afterFirst.some((entry) => entry.state === 'accepted') ? 30_000 : 0,
        );
      }
      const firstSubmitted = submission() !== undefined;
      checks.expect(
        'first-click-submits',
        'case 3',
        firstSubmitted,
        `the first click straight after editing a field sent nothing; status: ${describeLog(afterFirst)}`,
      );
      if (!firstSubmitted) {
        await env.page.waitForTimeout(1_500);
        await button.click({ delay: HUMAN_CLICK_MS });
      }
      await settle(
        async () => submission(),
        (parameters) => parameters !== undefined,
        60_000,
      );
      await env.waitForIdle();
      const submitted = submission();
      hasSubmittedParameters = submitted !== undefined;
      const afterClick = env.mainRequests().slice(clickMark);
      const newTurns =
        Math.max(turnsBefore, ...afterClick.map(userTurns)) - turnsBefore;
      const log = await continuationLog(app);
      checks.expect(
        'one-submission',
        'case 3 / R3',
        hasSubmittedParameters && newTurns === 1,
        `${newTurns} submitted user turn(s); status: ${describeLog(log)}`,
      );
      const inputs = parseSubmittedInputs(submitted ?? '');
      const missing = Object.entries(FORM_VALUES).filter(
        ([id, value]) => inputs[id]?.value !== value,
      );
      checks.expect(
        'submits-every-field',
        'case 3',
        hasSubmittedParameters && missing.length === 0,
        `missing or different: ${JSON.stringify(Object.fromEntries(missing.map(([id]) => [id, inputs[id]?.value])))}`,
      );
      const status = log[log.length - 1]?.state ?? null;
      checks.expect(
        'reports-acceptance',
        'case 3',
        status === 'accepted',
        `continuation status: ${describeLog(log)}`,
      );
      return true;
    },
    [
      ['first-click-submits', 'case 3'],
      ['submits-every-field', 'case 3'],
      ['reports-acceptance', 'case 3'],
    ],
  );

  await checks.guard('answer-uses-values', 'case 3', async () => {
    const replyIndex = repliesBefore;
    if (!hasSubmittedParameters || replyIndex === undefined) {
      return checks.add(
        'answer-uses-values',
        'case 3',
        'not-applicable',
        'no parameter submission reached the model',
      );
    }
    // The answer to the submission is the first reply after it; a long
    // thinking phase can outlast the idle wait, so wait for the reply itself.
    const replies = await settle(
      () => env.assistantTexts(),
      (texts) => texts.length > replyIndex,
      env.cardTimeoutMs,
    );
    const reply = replies[replyIndex];
    if (!reply) {
      return checks.expect(
        'answer-uses-values',
        'case 3',
        false,
        'no assistant reply followed the submission',
      );
    }
    const body = reply.normalize('NFKC').replace(/[*_`]/g, '');
    const [firstLine] = body.trimStart().split(/\r?\n/, 1);
    const count = /^Participants:[ \t]*(\d+)[ \t]*$/i.exec(firstLine)?.[1];
    const date = new RegExp(`(?<!\\d)${FORM_VALUES.date}(?!\\d)`);
    const budget = new RegExp(
      `\\bCNY\\s*${FORM_VALUES.budget}(?:\\.0+)?\\s*(?:each\\b|per\\s+person\\b|/\\s*人)`,
      'i',
    );
    const matched = {
      activity: /escape[\s-]*room|密室/i.test(body),
      date: date.test(body),
      participants: Number(count) === Number(FORM_VALUES.participants),
      budget: budget.test(body),
      notes: body.toLowerCase().includes(FORM_VALUES.notes),
    };
    const missing = Object.entries(matched)
      .filter(([, ok]) => !ok)
      .map(([field]) => field);
    return checks.expect(
      'answer-uses-values',
      'case 3',
      missing.length === 0,
      `reply did not use ${missing.join(', ')}: "${reply.slice(0, 160)}"`,
    );
  });
  return checks.results;
}

async function selectComparator(
  view: Frame,
  inputs: { seats: number; billing: string; plan: string },
) {
  await setValue(view, 'seats', String(inputs.seats));
  await view.locator('#seats').blur();
  await checkBox(view, `billing-${inputs.billing}`);
  await checkBox(view, `plan-${inputs.plan}`);
  await view.page().waitForTimeout(500);
}

async function readComparator(view: Frame) {
  const result: Record<string, { monthly?: number; payment?: number }> = {};
  for (const plan of PLANS) {
    result[plan] = {
      monthly: parseSingleAmount(await text(view, `${plan}-monthly`)),
      payment: parseSingleAmount(await text(view, `${plan}-payment`)),
    };
  }
  return result;
}

function comparatorMatches(
  observed: Awaited<ReturnType<typeof readComparator>>,
  inputs: ComparatorInputs,
) {
  return PLANS.every(
    (plan) =>
      observed[plan].payment === comparatorPayment(plan, inputs) &&
      observed[plan].monthly === comparatorMonthlyEquivalent(plan, inputs),
  );
}

function describeComparator(
  observed: Awaited<ReturnType<typeof readComparator>>,
) {
  return PLANS.map(
    (plan) =>
      `${plan}: monthly=${observed[plan].monthly === undefined ? '?' : formatCents(observed[plan].monthly!)} payment=${observed[plan].payment === undefined ? '?' : formatCents(observed[plan].payment!)}`,
  ).join('; ');
}

async function selectedRadioId(view: Frame, group: 'billing' | 'plan') {
  return view
    .locator(`input[id^="${group}-"]:checked`)
    .evaluateAll((inputs) => {
      if (inputs.length > 1) {
        throw new Error('Expected at most one checked radio per group');
      }
      return inputs[0]?.id ?? null;
    });
}

async function comparatorCardId(view: Frame): Promise<string | null> {
  let outerFrame = view;
  let parent = outerFrame.parentFrame();
  while (parent && parent !== view.page().mainFrame()) {
    outerFrame = parent;
    parent = outerFrame.parentFrame();
  }
  const iframe = await outerFrame.frameElement();
  try {
    return await iframe.evaluate((element) =>
      element instanceof Element
        ? (element
            .closest('[data-transcript-tool-call-id]')
            ?.getAttribute('data-transcript-tool-call-id') ?? null)
        : null,
    );
  } finally {
    await iframe.dispose();
  }
}

function generatedUiCallIds(messages: ChatMessage[]) {
  const calls = messages.flatMap((message) => message.tool_calls ?? []);
  return new Set(
    calls.flatMap((call) =>
      call.id && call.function?.name === SHOW_TOOL ? [call.id] : [],
    ),
  );
}

async function followUpComparator(env: AcceptanceEnv, prompt: string) {
  const requests = env.mainRequests();
  const requestMark = requests.length;
  const previousIds = generatedUiCallIds(
    requests.flatMap((request) => request.messages),
  );
  await env.send(prompt);
  await env.waitForIdle();
  const followUpMessages = env
    .mainRequests()
    .slice(requestMark)
    .flatMap(({ messages }) => {
      const user = messages.findLastIndex((message) => message.role === 'user');
      return user === -1 ? [] : messages.slice(user + 1);
    });
  const freshIds = generatedUiCallIds(followUpMessages);
  for (const id of previousIds) freshIds.delete(id);
  if (!freshIds.size)
    throw new Error('follow-up made no Generated UI tool call');
  const card = await settle(
    async () => {
      const views = env.page
        .frames()
        .filter((frame) => frame.name() === 'view');
      for (const view of views.reverse()) {
        const id = await comparatorCardId(view).catch(() => null);
        if (id && freshIds.has(id)) return { view, id };
      }
      return undefined;
    },
    (card) => card !== undefined,
    Math.min(env.cardTimeoutMs, 5_000),
  );
  if (!card) throw new Error('no card rendered for the follow-up tool call');
  await card.view
    .locator('body *:visible')
    .first()
    .waitFor({ timeout: env.cardTimeoutMs });
  return card;
}

function csvPayment(csv: string, plan: Plan): number | undefined {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  if (!/^(?:"plan"|plan)\s*,\s*(?:"payment"|payment)$/i.test(header.trim())) {
    return undefined;
  }
  const selectedPayments: string[] = [];
  for (const row of rows) {
    if (!row.trim()) continue;
    const fields =
      /^\s*(?:"([a-z]+)"|([a-z]+))\s*,\s*(?:"([^"]+)"|([^,"]+))\s*$/i.exec(row);
    if (!fields) return undefined;
    const [, quotedPlan, barePlan, quotedPayment, barePayment] = fields;
    const key = (quotedPlan ?? barePlan).toLowerCase();
    if (!PLANS.some((candidate) => candidate === key)) return undefined;
    if (key === plan) selectedPayments.push(quotedPayment ?? barePayment);
  }
  return selectedPayments.length === 1
    ? parseSingleAmount(selectedPayments[0])
    : undefined;
}

/** Comparator: monthly equivalent vs payment, extension across turns, export, reset. */
export async function runComparator(
  env: AcceptanceEnv,
  prompts: { initial: string; support: string; reset: string },
): Promise<CheckResult[]> {
  const checks = new Checks('comparator');
  await env.startSession(prompts.initial);
  const first = await env.waitForCard(0);
  await env.waitForIdle();
  // A view without a contract control still reports every check: the reads
  // degrade to null and the checks that need them fail with the reason.
  const initialSeats = await first.view
    .locator('#seats')
    .inputValue({ timeout: 2_000 })
    .catch(() => null);
  const initialBilling = await selectedRadioId(first.view, 'billing').catch(
    () => null,
  );
  const initialPlan = await selectedRadioId(first.view, 'plan').catch(
    () => null,
  );
  const initialInputs: ComparatorInputs = {
    seats: Number(initialSeats),
    billing: initialBilling === 'billing-annual' ? 'annual' : 'monthly',
    support: false,
  };
  const withoutSupport: ComparatorInputs = {
    ...COMPARATOR_SCENARIO,
    support: false,
  };

  await checks.guard('monthly-vs-payment', 'case 4', async () => {
    await selectComparator(first.view, {
      seats: COMPARATOR_SCENARIO.seats,
      billing: COMPARATOR_SCENARIO.billing,
      plan: COMPARATOR_SELECTED_PLAN,
    });
    const observed = await settle(
      () => readComparator(first.view),
      (value) => comparatorMatches(value, withoutSupport),
    );
    return checks.expect(
      'monthly-vs-payment',
      'case 4',
      comparatorMatches(observed, withoutSupport),
      `13 seats annual: ${describeComparator(observed)}`,
    );
  });

  let second: Awaited<ReturnType<typeof followUpComparator>> | undefined;
  await checks.guard(
    'support-totals',
    'case 4',
    async () => {
      // Let the applied values settle into the composer before the follow-up.
      await env.page.waitForTimeout(1_500);
      const updated = await followUpComparator(env, prompts.support);
      second = updated;
      const observed = await settle(
        () => readComparator(updated.view),
        (value) => comparatorMatches(value, COMPARATOR_SCENARIO),
      );
      checks.expect(
        'support-totals',
        'case 4',
        comparatorMatches(observed, COMPARATOR_SCENARIO),
        `with support: ${describeComparator(observed)}`,
      );
      const seats = await second.view.locator('#seats').inputValue();
      const annual = await second.view.locator('#billing-annual').isChecked();
      const team = await second.view
        .locator(`#plan-${COMPARATOR_SELECTED_PLAN}`)
        .isChecked();
      checks.expect(
        'keeps-choices',
        'case 4 / R5',
        seats === String(COMPARATOR_SCENARIO.seats) && annual && team,
        `seats=${seats} annual=${annual} team=${team}`,
      );
      const support = await second.view
        .locator('#support')
        .isChecked()
        .catch(() => false);
      const reusedView = updated.view === first.view;
      return checks.expect(
        'extends-existing-card',
        'R5',
        reusedView && support,
        `follow-up call=${updated.id}, reused original view=${reusedView}, support=${support}`,
      );
    },
    [
      ['keeps-choices', 'case 4 / R5'],
      ['extends-existing-card', 'R5'],
    ],
  );

  await checks.guard('exports-current-csv', 'case 4 / R5', async () => {
    if (!second) {
      checks.skip(
        [['exports-current-csv', 'case 4 / R5']],
        'no card followed the support request, so there is no current support total to export',
      );
      return false;
    }
    const { view } = second;
    const inputs = {
      ...COMPARATOR_SCENARIO,
      seats: COMPARATOR_SCENARIO.seats + 1,
    };
    const expected = comparatorPayment(COMPARATOR_SELECTED_PLAN, inputs);
    await setValue(view, 'seats', String(inputs.seats));
    await view.locator('#seats').blur();
    const payment = await settle(
      async () =>
        parseSingleAmount(
          await text(view, `${COMPARATOR_SELECTED_PLAN}-payment`),
        ),
      (value) => value === expected,
    );
    if (payment !== expected) {
      return checks.add(
        'exports-current-csv',
        'case 4 / R5',
        'not-applicable',
        `could not prepare the ${inputs.seats}-seat payment before exporting`,
      );
    }
    const exportButton = view.locator('#export');
    await exportButton.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await waitForStill(exportButton);
    const download = env.page
      .waitForEvent('download', { timeout: 5_000 })
      .catch(() => undefined);
    await exportButton.click();
    const file = await download;
    if (!file) {
      return checks.expect(
        'exports-current-csv',
        'case 4 / R5',
        false,
        'clicking export produced no download',
      );
    }
    const stream = await file.createReadStream();
    let csv = '';
    for await (const chunk of stream) csv += chunk.toString();
    return checks.expect(
      'exports-current-csv',
      'case 4 / R5',
      csvPayment(csv, COMPARATOR_SELECTED_PLAN) === expected,
      `CSV did not contain the current payment for ${COMPARATOR_SELECTED_PLAN}: ${csv.slice(0, 120)}`,
    );
  });

  await checks.guard('reset-via-follow-up', 'case 4', async () => {
    const reset = await followUpComparator(env, prompts.reset);
    const observed = await settle(
      () => readComparator(reset.view),
      (value) => comparatorMatches(value, initialInputs),
    );
    const seats = await reset.view.locator('#seats').inputValue();
    const billing = await selectedRadioId(reset.view, 'billing');
    const plan = await selectedRadioId(reset.view, 'plan');
    const support = await reset.view
      .locator('#support')
      .isChecked()
      .catch(() => false);
    return checks.expect(
      'reset-via-follow-up',
      'case 4',
      seats === initialSeats &&
        billing === initialBilling &&
        plan === initialPlan &&
        !support &&
        comparatorMatches(observed, initialInputs),
      `after reset: seats=${seats} billing=${billing} plan=${plan} support=${support}; initial seats=${initialSeats} billing=${initialBilling} plan=${initialPlan}; ${describeComparator(observed)}`,
    );
  });
  return checks.results;
}
