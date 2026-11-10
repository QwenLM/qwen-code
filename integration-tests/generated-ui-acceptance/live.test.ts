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
import {
  SHOW_TOOL,
  messageText,
  startAcceptanceEnv,
  type AcceptanceEnv,
  type LiveModel,
} from './harness.js';
import {
  ACTIVITY_FORM_PROMPT,
  BILL_SPLITTER_PROMPT,
  CHECKLIST_PROMPT,
  COMPARATOR_PROMPT,
  COMPARATOR_RESET_PROMPT,
  COMPARATOR_SUPPORT_PROMPT,
} from './prompts.js';
import { renderMarkdown, type CaseResult, type CheckResult } from './report.js';

function modelFrom(prefix: string, label: string): LiveModel | undefined {
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const apiKey = process.env[`${prefix}_API_KEY`];
  const model = process.env[`${prefix}_MODEL`];
  return baseUrl && apiKey && model
    ? { label: `${label}:${model}`, baseUrl, apiKey, model }
    : undefined;
}

const enabled = process.env['QWEN_GENERATED_UI_LIVE'] === '1';
const models = [
  modelFrom('QWEN_GENERATED_UI_LIVE', 'gating'),
  modelFrom('QWEN_GENERATED_UI_COMPARE', 'comparison'),
].filter((model): model is LiveModel => model !== undefined);
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
const selected = (process.env['QWEN_GENERATED_UI_LIVE_CASES'] ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const caseNames = Object.keys(CASES).filter(
  (name) => selected.length === 0 || selected.includes(name),
);

async function runCase(
  model: LiveModel,
  name: string,
  trial: number,
): Promise<CaseResult> {
  const env = await startAcceptanceEnv({
    mode: { kind: 'live', model },
    cardTimeoutMs: 15 * 60 * 1000,
  });
  let checks: CheckResult[] = [];
  let error: string | undefined;
  try {
    checks = await CASES[name](env);
  } catch (caught) {
    error = String(caught instanceof Error ? caught.message : caught).split(
      '\n',
    )[0];
    await env.screenshot(`${name}-failure`);
  } finally {
    await env.close();
  }
  const main = env.mainRequests();
  const calledTool = main.some((request) =>
    request.messages.some((message) =>
      (message.tool_calls ?? []).some(
        (call) => call.function?.name === SHOW_TOOL,
      ),
    ),
  );
  const last = main[main.length - 1];
  const showIds = new Set(
    (last?.messages ?? []).flatMap((message) =>
      (message.tool_calls ?? [])
        .filter((call) => call.function?.name === SHOW_TOOL)
        .map((call) => call.id),
    ),
  );
  const viewErrors = (last?.messages ?? []).filter(
    (message) =>
      message.role === 'tool' &&
      showIds.has(message.tool_call_id) &&
      messageText(message.content).includes('VIEW_ERROR'),
  ).length;
  if (error) {
    checks.push({
      id: `${name}.harness`,
      covers: '—',
      status: 'fail',
      detail: error,
    });
  }
  return {
    case: name,
    model: model.label,
    trial,
    calledTool,
    viewErrors,
    secondsToFirstCard:
      env.firstCardMs === undefined
        ? undefined
        : Math.round(env.firstCardMs / 1000),
    checks,
  };
}

describe.runIf(enabled && models.length > 0)(
  'Generated UI acceptance, live models (#14019)',
  () => {
    it(
      'runs every selected case for every configured model',
      async () => {
        const results: CaseResult[] = [];
        for (const model of models) {
          for (const name of caseNames) {
            for (let trial = 1; trial <= trials; trial++) {
              results.push(await runCase(model, name, trial));
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
  },
);
