/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live evaluation of the #14019 acceptance cases with a real model. Not a
 * pass/fail gate: it writes a per-check report so stages can be compared.
 *
 * Opt-in. Set QWEN_GENERATED_UI_LIVE=1 and, for the gating model,
 *   QWEN_GENERATED_UI_LIVE_BASE_URL  OpenAI-compatible base URL
 *   QWEN_GENERATED_UI_LIVE_API_KEY   API key (never written to the report)
 *   QWEN_GENERATED_UI_LIVE_MODEL     model ID, e.g. a Qwen flagship model
 * Optionally a non-gating comparison model with the same three variables
 * under the QWEN_GENERATED_UI_COMPARE_ prefix, QWEN_GENERATED_UI_LIVE_TRIALS
 * (default 1), QWEN_GENERATED_UI_LIVE_CASES (comma-separated subset) and
 * QWEN_GENERATED_UI_ACCEPTANCE_OUT for the report directory.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runActivityForm,
  runBillSplitter,
  runChecklist,
  runComparator,
} from './cases.js';
import type { AcceptanceEnv } from './harness.js';
import { runLiveCase } from './live-case.js';
import { liveModels, selectCases } from './live-config.js';
import {
  ACTIVITY_FORM_PROMPT,
  BILL_SPLITTER_PROMPT,
  CHECKLIST_PROMPT,
  COMPARATOR_PROMPT,
  COMPARATOR_RESET_PROMPT,
  COMPARATOR_SUPPORT_PROMPT,
} from './prompts.js';
import { renderMarkdown, type CaseResult, type CheckResult } from './report.js';

const enabled = process.env['QWEN_GENERATED_UI_LIVE'] === '1';
// Validated only when enabled, so collecting this file stays harmless.
const models = enabled ? liveModels(process.env) : [];
const trials = Math.max(
  1,
  Number(process.env['QWEN_GENERATED_UI_LIVE_TRIALS'] ?? '1') || 1,
);

const CASES: Record<string, (env: AcceptanceEnv) => Promise<CheckResult[]>> = {
  bill: (env) => runBillSplitter(env, BILL_SPLITTER_PROMPT),
  checklist: (env) => runChecklist(env, CHECKLIST_PROMPT),
  form: (env) => runActivityForm(env, ACTIVITY_FORM_PROMPT),
  comparator: (env) =>
    runComparator(env, {
      initial: COMPARATOR_PROMPT,
      support: COMPARATOR_SUPPORT_PROMPT,
      reset: COMPARATOR_RESET_PROMPT,
    }),
};
const caseNames = enabled
  ? selectCases(Object.keys(CASES), process.env['QWEN_GENERATED_UI_LIVE_CASES'])
  : [];

describe.runIf(enabled)('Generated UI acceptance, live models (#14019)', () => {
  it(
    'runs every selected case for every configured model',
    async () => {
      const results: CaseResult[] = [];
      for (const model of models) {
        for (const name of caseNames) {
          for (let trial = 1; trial <= trials; trial++) {
            results.push(await runLiveCase(model, name, trial, CASES[name]));
          }
        }
      }
      const report = renderMarkdown(results);
      console.log(report);
      const out = process.env['QWEN_GENERATED_UI_ACCEPTANCE_OUT'];
      if (out) {
        await fs.mkdir(out, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fs.writeFile(
          path.join(out, `live-${stamp}.json`),
          JSON.stringify(results, null, 2),
        );
        await fs.writeFile(path.join(out, `live-${stamp}.md`), report);
      }
      expect(results.length).toBe(models.length * caseNames.length * trials);
    },
    4 * 60 * 60 * 1000,
  );
});
