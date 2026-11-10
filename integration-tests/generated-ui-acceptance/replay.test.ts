/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic replay of the #14019 acceptance cases through the real daemon,
 * Web Shell, bundled Generated UI provider and Chromium. The model is replaced
 * by reference documents, so this measures what the runtime and host support.
 *
 * Opt-in: set QWEN_GENERATED_UI_ACCEPTANCE=1 (needs a bundled `dist/cli.js`
 * via TEST_CLI_PATH and Playwright Chromium). The expected status table is
 * pinned: a later stage that adds a capability flips its entries here.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runActivityForm,
  runBillSplitter,
  runChecklist,
  runComparator,
} from './cases.js';
import {
  startAcceptanceEnv,
  type AcceptanceEnv,
  type ReplayScript,
} from './harness.js';
import {
  ACTIVITY_FORM_PROMPT,
  BILL_SPLITTER_PROMPT,
  CHECKLIST_PROMPT,
  COMPARATOR_PROMPT,
  COMPARATOR_RESET_PROMPT,
  COMPARATOR_SUPPORT_PROMPT,
} from './prompts.js';
import {
  activityFormReplay,
  billSplitterReplay,
  checklistReplay,
  comparatorReplay,
} from './replay.js';
import {
  renderMarkdown,
  statusMap,
  type CaseResult,
  type CheckResult,
} from './report.js';

const enabled = process.env['QWEN_GENERATED_UI_ACCEPTANCE'] === '1';

let env: AcceptanceEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function run(
  name: string,
  script: ReplayScript,
  drive: (env: AcceptanceEnv) => Promise<CheckResult[]>,
  workspaces = 1,
): Promise<CaseResult> {
  env = await startAcceptanceEnv({
    mode: { kind: 'replay', script },
    workspaces,
  });
  const checks = await drive(env);
  const result: CaseResult = {
    case: name,
    model: 'replay',
    trial: 1,
    calledTool: true,
    viewErrors: 0,
    secondsToFirstCard:
      env.firstCardMs === undefined
        ? undefined
        : Math.round(env.firstCardMs / 1000),
    checks,
  };
  const out = process.env['QWEN_GENERATED_UI_ACCEPTANCE_OUT'];
  if (out) {
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(
      path.join(out, `replay-${name}.json`),
      JSON.stringify(result, null, 2),
    );
  }
  console.log(renderMarkdown([result]));
  return result;
}

describe.runIf(enabled)('Generated UI acceptance replay (#14019)', () => {
  it('bill splitter', async () => {
    const result = await run('bill', billSplitterReplay, (e) =>
      runBillSplitter(e, BILL_SPLITTER_PROMPT),
    );
    expect(statusMap([result])).toEqual(EXPECTED.bill);
  }, 600_000);

  it('checklist', async () => {
    const result = await run('checklist', checklistReplay, (e) =>
      runChecklist(e, CHECKLIST_PROMPT),
    );
    expect(statusMap([result])).toEqual(EXPECTED.checklist);
  }, 600_000);

  it('activity form', async () => {
    const result = await run('form', activityFormReplay, (e) =>
      runActivityForm(e, ACTIVITY_FORM_PROMPT),
    );
    expect(statusMap([result])).toEqual(EXPECTED.form);
  }, 600_000);

  it('comparator', async () => {
    const result = await run('comparator', comparatorReplay, (e) =>
      runComparator(e, {
        initial: COMPARATOR_PROMPT,
        support: COMPARATOR_SUPPORT_PROMPT,
        reset: COMPARATOR_RESET_PROMPT,
      }),
    );
    expect(statusMap([result])).toEqual(EXPECTED.comparator);
  }, 900_000);
});

/**
 * Baseline on main, 2026-11. `fail` entries are the gaps later stages close:
 * copy and export need host-mediated clipboard/download (stage 8), the
 * checklist needs persisted view state (stage 6), extension needs card
 * revisions (stage 8). `form.first-click-submits` and
 * `form.reports-acceptance` are defects in today's host, found by this run.
 */
const EXPECTED: Record<string, Record<string, string>> = {
  bill: {
    'bill.called-tool': 'pass',
    'bill.defaults': 'pass',
    'bill.scenario': 'pass',
    'bill.conserves-cents': 'pass',
    'bill.fair-rounding': 'pass',
    'bill.chart-updates': 'pass',
    'bill.rejects-invalid': 'pass',
    'bill.copies-current': 'fail',
    'bill.reset': 'pass',
    'bill.edits-start-no-turn': 'pass',
  },
  checklist: {
    'checklist.called-tool': 'pass',
    'checklist.empty-state': 'pass',
    'checklist.add': 'pass',
    'checklist.check-and-filter': 'pass',
    'checklist.delete': 'pass',
    'checklist.repeated-undo': 'pass',
    'checklist.persists-after-reload': 'fail',
    'checklist.persists-after-reopen': 'fail',
    'checklist.save-acknowledged': 'not-applicable',
    'checklist.isolated-across-sessions': 'not-applicable',
  },
  form: {
    'form.called-tool': 'pass',
    'form.edits-start-no-turn': 'pass',
    'form.first-click-submits': 'fail',
    'form.one-submission': 'pass',
    'form.submits-every-field': 'pass',
    'form.reports-acceptance': 'fail',
    'form.answer-uses-values': 'pass',
  },
  comparator: {
    'comparator.called-tool': 'pass',
    'comparator.monthly-vs-payment': 'pass',
    'comparator.support-totals': 'pass',
    'comparator.keeps-choices': 'pass',
    'comparator.extends-existing-card': 'fail',
    'comparator.exports-current-csv': 'fail',
    'comparator.reset-via-follow-up': 'pass',
  },
};
