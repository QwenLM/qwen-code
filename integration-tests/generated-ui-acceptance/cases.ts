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

import type { Frame } from 'playwright';
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
} from './fixtures.js';
import {
  setValue,
  settle,
  text,
  userTurns,
  waitForCardOn,
  type AcceptanceEnv,
  type Card,
} from './harness.js';
import { formatCents, parseLastAmount, parseSingleAmount } from './money.js';
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

  async guard(id: string, covers: string, run: () => Promise<boolean>) {
    try {
      return await run();
    } catch (error) {
      return this.add(
        id,
        covers,
        'fail',
        `error: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`,
      );
    }
  }
}

async function shareAmounts(view: Frame): Promise<number[]> {
  const items = view.locator('#shares > *');
  const texts = await items.allTextContents();
  return texts
    .map((value) => parseLastAmount(value))
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

async function chartState(view: Frame) {
  return view.locator('#chart').evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    const ids = new Map(
      [...clone.querySelectorAll('[id]')].map((node, index) => [
        node.id,
        `chart-id-${index}`,
      ]),
    );
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const attribute of [...node.attributes]) {
        if (attribute.name === 'id') {
          node.id = ids.get(attribute.value) ?? attribute.value;
        } else {
          node.setAttribute(
            attribute.name,
            attribute.value.replace(/#([\w:.-]+)/g, (reference, id: string) =>
              ids.has(id) ? `#${ids.get(id)}` : reference,
            ),
          );
        }
      }
    }
    return JSON.stringify({
      html: clone.outerHTML,
      canvases: [
        ...(element instanceof HTMLCanvasElement ? [element] : []),
        ...element.querySelectorAll('canvas'),
      ].map((canvas) => canvas.toDataURL()),
    });
  });
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

  const chartBefore = await view
    .locator('#chart')
    .innerHTML()
    .catch(() => '');
  const chartStateBefore = await chartState(view).catch(() => undefined);

  await checks.guard('scenario', 'case 1', async () => {
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
    const chartAfter = await view
      .locator('#chart')
      .innerHTML()
      .catch(() => '');
    checks.expect(
      'chart-updates',
      'case 1 / R1',
      /<(svg|canvas)\b/i.test(chartAfter) && chartAfter !== chartBefore,
      chartAfter
        ? 'the chart did not change with the inputs'
        : 'no #chart content',
    );
    return true;
  });

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
    await view.locator('#copy').click();
    await env.page.waitForTimeout(500);
    const copied = await env.page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    return checks.expect(
      'copies-current',
      'case 1 / R5',
      copied.includes(formatCents(billTotal(BILL_SCENARIO))),
      copied
        ? `clipboard holds "${copied.slice(0, 80)}"`
        : 'nothing reached the clipboard',
    );
  });

  await checks.guard('reset', 'case 1', async () => {
    await setValue(view, 'subtotal', formatCents(BILL_DEFAULTS.subtotal + 100));
    await view.locator('#reset').click();
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
      chart: await chartState(view),
    });
    const matches = (value: Awaited<ReturnType<typeof readReset>>) =>
      value.total === billTotal(BILL_DEFAULTS) &&
      JSON.stringify(value.shares) === JSON.stringify(expectedDefault) &&
      Object.entries(expectedInputs).every(
        ([id, expected]) => value.inputs[id] === expected,
      ) &&
      chartStateBefore !== undefined &&
      value.chart === chartStateBefore;
    const reset = await settle(readReset, matches);
    return checks.expect(
      'reset',
      'case 1',
      matches(reset),
      `after reset: ${describeBill(reset)} inputs=${JSON.stringify(reset.inputs)} chart restored=${chartStateBefore === undefined ? 'initial chart unavailable' : reset.chart === chartStateBefore}`,
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
        .map((element) => (element.textContent ?? '').trim())
        .filter(Boolean),
    )
    .catch(() => []);
}

async function itemStates(view: Frame) {
  return view.locator('[id^="item-"][id$="-text"]').evaluateAll((elements) =>
    elements
      .filter((element) => (element as HTMLElement).offsetParent !== null)
      .map((element) => ({
        text: (element.textContent ?? '').trim(),
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
        (element) => (element.textContent ?? '').trim() === wanted,
      );
      return match ? [match.id] : [];
    }, label);
  return ids[0]?.replace(/-text$/, '');
}

async function addItem(view: Frame, label: string) {
  await setValue(view, 'new-item', label);
  await view.locator('#add').click();
  await settle(
    () => itemTexts(view),
    (texts) => texts.includes(label),
  );
}

/** Checklist: editing, filtering, repeated undo, persistence and isolation. */
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

  const emptyText = await text(view, 'empty');
  checks.expect(
    'empty-state',
    'case 2',
    emptyText.length > 0,
    'no empty-state message before items exist',
  );

  const added = await checks.guard('add', 'case 2', async () => {
    for (const label of ['Agenda', 'Notes', 'Actions']) {
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
      await view.locator(`#${slot}-check`).check();
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
      await view.locator(`#${slot}-delete`).click();
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

    await checks.guard('repeated-undo', 'case 2', async () => {
      await view.locator('#undo').click();
      const afterFirst = await settle(
        () => itemTexts(view),
        (value) => value.includes('Actions'),
      );
      await view.locator('#undo').click();
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
    });
  }

  const beforeSave = await itemStates(view);
  const saved = beforeSave.map((item) =>
    item.text === 'Notes' ? { ...item, checked: true } : item,
  );
  const sameState = (a: typeof saved, b: typeof saved) =>
    JSON.stringify(a) === JSON.stringify(b);
  const notesSlot = await itemSlot(view, 'Notes');
  let prepared = false;
  if (
    notesSlot &&
    beforeSave.some((item) => item.text === 'Notes' && !item.checked)
  ) {
    await view
      .locator(`#${notesSlot}-check`)
      .check()
      .catch(() => {});
    await env.page.waitForTimeout(300);
    prepared = sameState(
      await settle(
        () => itemStates(view),
        (value) => sameState(value, saved),
      ),
      saved,
    );
  }
  let hasPersistedItems = false;
  const persistenceChecks = async (
    id: string,
    label: string,
    open: () => Promise<Card>,
  ) =>
    checks.guard(id, 'case 2 / R4', async () => {
      if (!prepared) {
        return checks.expect(
          id,
          'case 2 / R4',
          false,
          'could not prepare a checked item and its undo state',
        );
      }
      const reopened = await open();
      const restored = await settle(
        () => itemStates(reopened.view),
        (value) => sameState(value, saved),
      );
      hasPersistedItems ||= restored.some((item) =>
        saved.some((expected) => expected.text === item.text),
      );
      if (!sameState(restored, saved)) {
        return checks.expect(
          id,
          'case 2 / R4',
          false,
          `${label}: expected ${JSON.stringify(saved)}, saw ${JSON.stringify(restored)}`,
        );
      }
      await reopened.view.locator('#undo').click();
      const undone = await settle(
        () => itemStates(reopened.view),
        (value) => sameState(value, beforeSave),
      );
      const restoredSlot = await itemSlot(reopened.view, 'Notes');
      await reopened.view.locator(`#${restoredSlot}-check`).check();
      await reopened.view.page().waitForTimeout(300);
      const resaved = await settle(
        () => itemStates(reopened.view),
        (value) => sameState(value, saved),
      );
      return checks.expect(
        id,
        'case 2 / R4',
        sameState(undone, beforeSave) && sameState(resaved, saved),
        `${label}: undo expected ${JSON.stringify(beforeSave)}, saw ${JSON.stringify(undone)}; state restored for the next check=${sameState(resaved, saved)}`,
      );
    });

  await persistenceChecks(
    'persists-after-reload',
    'after reloading the page',
    async () => {
      await env.page.reload();
      return env.waitForCard(0);
    },
  );

  await persistenceChecks(
    'persists-after-reopen',
    'after reopening the conversation in a new tab',
    async () => {
      const page = await env.context.newPage();
      const reopenedUrl = new URL(sessionUrl);
      reopenedUrl.hash = new URLSearchParams({
        token: env.daemon.token,
      }).toString();
      await page.goto(reopenedUrl.toString());
      // The page is closed after the check has read it through `settle`.
      setTimeout(() => void page.close(), 30_000);
      return waitForCardOn(page, 0);
    },
  );

  if (!hasPersistedItems) {
    checks.add(
      'save-acknowledged',
      'case 2 / R4',
      'not-applicable',
      'nothing was persisted, so there is no save to acknowledge',
    );
    checks.add(
      'isolated-across-sessions',
      'case 2 / R4',
      'not-applicable',
      'nothing was persisted, so isolation cannot be distinguished from loss',
    );
  } else {
    checks.add(
      'save-acknowledged',
      'case 2 / R4',
      'fail',
      'no save acknowledgement is observable to the harness yet',
    );
    await checks.guard('isolated-across-sessions', 'case 2 / R4', async () => {
      await env.startSession(prompt);
      const other = await env.waitForCard(0);
      const texts = await itemTexts(other.view);
      return checks.expect(
        'isolated-across-sessions',
        'case 2 / R4',
        texts.length === 0,
        `the same task in a new conversation shows ${JSON.stringify(texts)}`,
      );
    });
  }
  return checks.results;
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

export const FORM_VALUES: Record<string, string> = {
  activity: 'escape-room',
  date: '2026-12-05',
  participants: '12',
  budget: '180',
  notes: 'two vegetarians',
};

/** Activity form: edits send nothing; one explicit submission sends every field once. */
function submittedTurns(env: AcceptanceEnv, before: number) {
  return env
    .mainRequests()
    .slice(before)
    .filter((request) => request.lastUserText.includes('"inputs"'));
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
  const initialRequests = env.mainRequests();
  const before = initialRequests.length;
  const turnsBefore = Math.max(0, ...initialRequests.map(userTurns));

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

  let repliesBefore = 0;
  await checks.guard('one-submission', 'case 3 / R3', async () => {
    const button = app.locator('#continue-analysis');
    await settle(
      () => button.isEnabled(),
      (enabled) => enabled,
      10_000,
    );
    await button.scrollIntoViewIfNeeded();
    await recordContinuation(app);
    repliesBefore = (await env.assistantTexts()).length;
    // First attempt straight after typing, as a user would. It counts only
    // if it reaches a submitted model request without another click.
    await button.click();
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
        () => Promise.resolve(submittedTurns(env, before).length),
        (count) => count > 0,
        afterFirst.some((entry) => entry.state === 'accepted') ? 30_000 : 0,
      );
    }
    const firstSubmitted = submittedTurns(env, before).length > 0;
    checks.expect(
      'first-click-submits',
      'case 3',
      firstSubmitted,
      `the first click straight after editing a field sent nothing; status: ${describeLog(afterFirst)}`,
    );
    if (!firstSubmitted) {
      await env.page.waitForTimeout(1_500);
      await button.click();
    }
    await settle(
      () => Promise.resolve(submittedTurns(env, before).length),
      (count) => count > 0,
      60_000,
    );
    await env.waitForIdle();
    const submitted = submittedTurns(env, before);
    const newTurns =
      Math.max(turnsBefore, ...submitted.map(userTurns)) - turnsBefore;
    const log = await continuationLog(app);
    checks.expect(
      'one-submission',
      'case 3 / R3',
      newTurns === 1,
      `${newTurns} submitted user turn(s); status: ${describeLog(log)}`,
    );
    const inputs = parseSubmittedInputs(submitted[0]?.lastUserText ?? '');
    const missing = Object.entries(FORM_VALUES).filter(
      ([id, value]) => inputs[id]?.value !== value,
    );
    checks.expect(
      'submits-every-field',
      'case 3',
      submitted.length > 0 && missing.length === 0,
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
  });

  await checks.guard('answer-uses-values', 'case 3', async () => {
    // The answer to the submission is the first reply after it; a long
    // thinking phase can outlast the idle wait, so wait for the reply itself.
    const replies = await settle(
      () => env.assistantTexts(),
      (texts) => texts.length > repliesBefore,
      env.cardTimeoutMs,
    );
    if (replies.length <= repliesBefore) {
      return checks.expect(
        'answer-uses-values',
        'case 3',
        false,
        'no assistant reply followed the submission',
      );
    }
    const body = replies.slice(repliesBefore).join('\n');
    const participants = FORM_VALUES.participants;
    const participantCount = new RegExp(
      `(?:\\b${participants}\\s*[-–]?\\s*(?:people|persons?|participants?|attendees?)\\b|(?<!\\d)${participants}\\s*(?:人|位)|(?:\\b(?:participants?|attendees?)|人数)\\s*[:：为是]?\\s*${participants}(?![\\d.]))`,
      'i',
    );
    return checks.expect(
      'answer-uses-values',
      'case 3',
      participantCount.test(body.replace(/[*_`]/g, '')) &&
        /escape|密室/i.test(body),
      `reply after submission: "${body.slice(0, 160)}"`,
    );
  });
  return checks.results;
}

async function selectComparator(
  view: Frame,
  inputs: { seats: number; billing: string; plan: string },
) {
  await setValue(view, 'seats', String(inputs.seats));
  await view.locator(`#billing-${inputs.billing}`).check();
  await view.locator(`#plan-${inputs.plan}`).check();
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

/** Comparator: monthly equivalent vs payment, extension across turns, export, reset. */
export async function runComparator(
  env: AcceptanceEnv,
  prompts: { initial: string; support: string; reset: string },
): Promise<CheckResult[]> {
  const checks = new Checks('comparator');
  await env.startSession(prompts.initial);
  const first = await env.waitForCard(0);
  await env.waitForIdle();
  const initialSeats = await first.view.locator('#seats').inputValue();
  const initialBilling = await selectedRadioId(first.view, 'billing');
  const initialPlan = await selectedRadioId(first.view, 'plan');
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

  // Let the applied values settle into the composer before the follow-up.
  await env.page.waitForTimeout(1_500);
  await env.send(prompts.support);
  const views = () => env.page.frames().filter((f) => f.name() === 'view');
  let second: Card | undefined;
  await checks.guard('extends-after-follow-up', 'case 4 / R5', async () => {
    await env.waitForIdle();
    second = await env.waitForCard(Math.max(0, views().length - 1));
    const observed = await settle(
      () => readComparator(second!.view),
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
    return checks.expect(
      'extends-existing-card',
      'R5',
      views().length === 1 && support,
      `after the follow-up: ${views().length} independent cards, support=${support}`,
    );
  });

  await checks.guard('exports-current-csv', 'case 4 / R5', async () => {
    const target = second ?? first;
    const download = env.page
      .waitForEvent('download', { timeout: 5_000 })
      .catch(() => undefined);
    await target.view.locator('#export').click();
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
      csv.includes(formatCents(comparatorPayment('team', COMPARATOR_SCENARIO))),
      `CSV did not contain the current team total: ${csv.slice(0, 120)}`,
    );
  });

  await checks.guard('reset-via-follow-up', 'case 4', async () => {
    await env.send(prompts.reset);
    await env.waitForIdle();
    const reset = await env.waitForCard(Math.max(0, views().length - 1));
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
