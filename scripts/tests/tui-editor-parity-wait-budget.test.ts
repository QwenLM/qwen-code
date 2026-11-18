/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isImportDeclaration,
  isNamedImports,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  ScriptTarget,
  type CallExpression,
  type Node,
} from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_READY_PROMPT_BUDGET_MS,
  readyPromptBudgetMs,
} from '../../integration-tests/ready-prompt-budget.js';

// A wait ceiling is invisible on a green run: the editor-parity repaints land
// in well under a second locally, so nothing here observes #17544's CI expiry,
// and whether that expiry is a pool stall or an ink-leg render defect is still
// open on the issue. This pins the executed budget, not that verdict, where
// test:scripts collects it on every PR.
//
// The budgets are imported and executed, not matched against the suite's
// text: a source pin greens on a commented-out copy and reds on a
// behaviour-identical reformat. Same shape as ready-prompt-budget.test.ts.
//
// Whole runner environments, like the process.env the suite passes: a CI tier
// carries Actions' CI=true beside the runner marker.
const SELF_HOSTED = { CI: 'true', RUNNER_ENVIRONMENT: 'self-hosted' };
const SELF_HOSTED_DOCKER = { ...SELF_HOSTED, QWEN_SANDBOX: 'docker' };

async function budgetsIn(ci: boolean) {
  vi.stubEnv('CI', ci ? 'true' : '');
  vi.resetModules();
  return import(
    '../../integration-tests/interactive/tui-editor-parity-budget.js'
  );
}

const rawSource = readFileSync(
  join(
    resolve(import.meta.dirname, '../..'),
    'integration-tests/interactive/tui-editor-parity.test.ts',
  ),
  'utf8',
);
const FOCUS_PIN = /^\s*(?:it|describe|test)\s*\.\s*(?:only|skip|todo)\s*\(/m;

// Registrations come from the parse tree, not from a line spelling: this
// suite also registers cases inside for loops, and a ceiling can ride in an
// options object as well as in a bare third argument.
const TEST_CALLEE = /^(?:it|test|describe)(?:\.\w+)?$/;
function testCalls(text: string): CallExpression[] {
  const tree = createSourceFile('suite.ts', text, ScriptTarget.Latest, true);
  const calls: CallExpression[] = [];
  const visit = (node: Node) => {
    if (isCallExpression(node) && TEST_CALLEE.test(node.expression.getText()))
      calls.push(node);
    forEachChild(node, visit);
  };
  visit(tree);
  return calls;
}
const calls = testCalls(rawSource);

// What the suite binds, not what the module exports: a local
// createUntil(12_000) beside a dropped import reverts the ceiling with every
// budget assertion still green.
function budgetImports(): string[] {
  const tree = createSourceFile(
    'suite.ts',
    rawSource,
    ScriptTarget.Latest,
    true,
  );
  return tree.statements.flatMap((stmt) =>
    isImportDeclaration(stmt) &&
    isStringLiteral(stmt.moduleSpecifier) &&
    stmt.moduleSpecifier.text === './tui-editor-parity-budget.js' &&
    stmt.importClause?.namedBindings &&
    isNamedImports(stmt.importClause.namedBindings)
      ? stmt.importClause.namedBindings.elements.map(
          (element) => (element.propertyName ?? element.name).text,
        )
      : [],
  );
}

function permissionsCases(parsed: CallExpression[]) {
  return parsed.flatMap((call) => {
    const [name] = call.arguments;
    return name && isStringLiteral(name) && name.text.startsWith('permissions-')
      ? [{ name: name.text, call }]
      : [];
  });
}

// A literal ceiling in either spelling vitest accepts: a bare number, or a
// `timeout: <number>` options object.
function literalCeiling(arg: Node): boolean {
  return (
    isNumericLiteral(arg) ||
    (isObjectLiteralExpression(arg) &&
      arg.properties.some(
        (prop) =>
          isPropertyAssignment(prop) &&
          prop.name.getText() === 'timeout' &&
          isNumericLiteral(prop.initializer),
      ))
  );
}

describe('tui-editor-parity wait ceiling (#17544)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('gives a mid-turn repaint the shared-pool boot stall tier in CI', async () => {
    const { WAIT_LOCAL_MS, until } = await budgetsIn(true);
    const { scaledWait } = await import(
      '../../integration-tests/interactive/wait.js'
    );
    const ciWaitMs = scaledWait(WAIT_LOCAL_MS);
    expect(ciWaitMs).toBeGreaterThanOrEqual(readyPromptBudgetMs(SELF_HOSTED));

    // A case spends its boot window before the wait starts, so the pair must
    // fit the per-test default together; otherwise a stalled repaint dies as
    // vitest's bare "Test timed out" with no until label. The config's own
    // value, so lowering it moves this bound too.
    const { default: config } = await import(
      '../../integration-tests/vitest.config.js'
    );
    expect(MAX_READY_PROMPT_BUDGET_MS + ciWaitMs).toBeLessThan(
      config.test?.testTimeout ?? 0,
    );

    expect(budgetImports().sort()).toEqual(['permissionsCaseOptions', 'until']);

    // The helper the suite really polls with, measured rather than re-spelled:
    // wiring it to a smaller budget than WAIT_LOCAL_MS reds here. Advancing by
    // the derived wait keeps a legitimate raise green.
    vi.useFakeTimers();
    const start = Date.now();
    const expiry = until(() => false, 'repaint').then(
      () => -1,
      () => Date.now() - start,
    );
    await vi.advanceTimersByTimeAsync(ciWaitMs);
    expect(await expiry).toBe(ciWaitMs);
  });

  it('keeps every per-case ceiling at the documented tier, enabled and unretried', async () => {
    // The figures both design versions advertise, matched as whole objects:
    // an undocumented cut of the repaint multiplier, a dropped retry: 0 or a
    // skip key in any position reds here. The CI tiers lead so a multiplier
    // cut reports a documented figure, and each tier runs with the ambient CI
    // stubbed the other way, so a process.env read reds here too.
    const ci = await budgetsIn(false);
    expect(ci.permissionsCaseOptions(SELF_HOSTED)).toEqual({
      timeout: 420_000,
      retry: 0,
    });
    expect(ci.permissionsCaseOptions(SELF_HOSTED_DOCKER)).toEqual({
      timeout: 510_000,
      retry: 0,
    });
    const local = await budgetsIn(true);
    expect(local.permissionsCaseOptions({})).toEqual({
      timeout: 180_000,
      retry: 0,
    });

    // The set the design doc's contract needs, not a count of whatever the
    // file happens to register: deleting the case that carries the "must
    // still exit" half reds here.
    const cases = permissionsCases(calls);
    expect(cases.map(({ name }) => name)).toEqual([
      'permissions-edits-and-completes-without-model',
      'permissions-clear-undo-replace-without-model',
      'permissions-second-control-c-exits-without-model',
    ]);
    // The options ride in the second argument: an object in the third is the
    // deprecated form Vitest 4 throws on.
    for (const { call } of cases) {
      expect(call.arguments[1]?.getText()).toBe('PERMISSIONS_CASE_OPTIONS');
    }
    expect(
      calls
        .filter((call) => call.arguments.slice(1).some(literalCeiling))
        .map((call) => call.arguments[0]?.getText()),
    ).toEqual([]);
    expect(rawSource).not.toMatch(FOCUS_PIN);
  });

  it('reds a registration revert the budget values cannot see', () => {
    // Spliced at parse-tree positions, not at a hardcoded spelling: a reflow
    // of the registration must not silently turn a fixture into a no-op.
    const [, undoReplace, secondControlC] = permissionsCases(calls).map(
      ({ call }) => call,
    );

    const calleeEnd = undoReplace.expression.end;
    const skipped =
      rawSource.slice(0, calleeEnd) + '.skip' + rawSource.slice(calleeEnd);
    expect(skipped).toMatch(FOCUS_PIN);

    const options = undoReplace.arguments[1];
    const droppedOptions =
      rawSource.slice(0, options.pos) +
      rawSource.slice(options.end).replace(/^,/, '');
    const dropped = permissionsCases(testCalls(droppedOptions)).find(
      ({ name }) => name === 'permissions-clear-undo-replace-without-model',
    );
    expect(dropped?.call.arguments[1]?.getText()).not.toBe(
      'PERMISSIONS_CASE_OPTIONS',
    );

    const deleted = rawSource.slice(0, secondControlC.getStart());
    expect(
      permissionsCases(testCalls(deleted)).map(({ name }) => name),
    ).not.toContain('permissions-second-control-c-exits-without-model');

    const loopCase = `${rawSource}
for (const variant of ['extra']) {
  it(\`permissions-\${variant}\`, { timeout: 90_000 }, () => Promise.resolve());
}
`;
    expect(
      testCalls(loopCase).filter((call) =>
        call.arguments.slice(1).some(literalCeiling),
      ),
    ).not.toHaveLength(0);
  });
});
