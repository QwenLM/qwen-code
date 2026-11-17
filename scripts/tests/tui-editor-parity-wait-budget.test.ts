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
import { blankComments } from './blank-comments.js';

// A wait ceiling is invisible on a green run: the editor-parity repaints land
// in well under a second, so only the non-deterministic pool stall of #17544
// surfaces a revert to the old literal. Pinned here, where test:scripts
// collects it on every PR.
const repo = resolve(import.meta.dirname, '../..');
const rawSource = readFileSync(
  join(repo, 'integration-tests/interactive/tui-editor-parity.test.ts'),
  'utf8',
);
// Blanked, so a commented-out copy of a pinned line cannot satisfy the pin.
const source = blankComments(rawSource);
const integrationConfig = blankComments(
  readFileSync(join(repo, 'integration-tests/vitest.config.ts'), 'utf8'),
);

const WAIT_LITERAL_PIN = /^const WAIT_LOCAL_MS = ([\d_]+);$/m;
const UNTIL_PIN = /^const until = createUntil\(WAIT_LOCAL_MS\);$/m;
const CASE_OPTIONS_PIN =
  /^const PERMISSIONS_CASE_OPTIONS = \{\s*timeout:\s*readyPromptBudgetMs\(process\.env\)\s*\+\s*(\d+) \* scaledWait\(WAIT_LOCAL_MS\)\s*\+\s*60_000,?\s*retry: 0,?\s*\};$/m;
const FOCUS_PIN = /^\s*(?:it|describe|test)\s*\.\s*(?:only|skip|todo)\s*\(/m;
// Scoped to the shared options object and key-order agnostic: a skip key in
// any position disables all three cases while every other pin still matches.
const SKIP_OPTIONS_PIN =
  /^const PERMISSIONS_CASE_OPTIONS = \{[^}]*\b(?:skip|only|todo|skipIf|runIf)\s*:/m;

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
  });

  it('gives a mid-turn repaint the shared-pool boot stall tier in CI', async () => {
    const literal = source.match(WAIT_LITERAL_PIN)?.[1];
    expect(literal).toBeDefined();
    expect(source).toMatch(UNTIL_PIN);
    // The wait the suite really runs, not a second spelling of its factor:
    // CI_MULTIPLIER binds at module load, so the stub precedes a fresh import.
    vi.stubEnv('CI', 'true');
    vi.resetModules();
    const { scaledWait } = await import(
      '../../integration-tests/interactive/wait.js'
    );
    const ciWaitMs = scaledWait(Number(literal?.replaceAll('_', '')));
    expect(ciWaitMs).toBeGreaterThanOrEqual(
      readyPromptBudgetMs({ RUNNER_ENVIRONMENT: 'self-hosted' }),
    );
    // A case spends its boot window before the wait starts, so the pair must
    // fit the per-test default together; otherwise a stalled repaint dies as
    // vitest's bare "Test timed out" with no until label.
    expect(MAX_READY_PROMPT_BUDGET_MS + ciWaitMs).toBeLessThan(300_000);
    // 300s is the config's fallback, not a constant; pin both halves of the
    // derivation so lowering it moves this bound too.
    expect(integrationConfig).toMatch(
      /Number\(process\.env\['TB_TIMEOUT_MINUTES'\] \|\| '5'\)/,
    );
    expect(integrationConfig).toMatch(
      /const testTimeoutMs = timeoutMinutes \* 60 \* 1000;/,
    );
  });

  it('keeps every per-case ceiling derived, enabled and unretried', () => {
    expect(source).toMatch(CASE_OPTIONS_PIN);
    // A governed case polls a dozen times and every poll can burn a full wait
    // budget and still pass, so one wait of headroom lets passing repaints
    // exhaust the ceiling before any wait reports its own label.
    expect(Number(source.match(CASE_OPTIONS_PIN)?.[1])).toBeGreaterThanOrEqual(
      2,
    );
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
    expect(source).not.toMatch(FOCUS_PIN);
    expect(source).not.toMatch(SKIP_OPTIONS_PIN);
  });

  it('does not witness a commented-out or re-spelled revert', () => {
    // The pins read the blanked copy: the suite's license header is trivia,
    // so it must be gone from the source every pin above matches against.
    expect(source).not.toContain('@license');
    const derivation = rawSource.match(CASE_OPTIONS_PIN)?.[0] ?? '';
    expect(derivation).not.toBe('');
    const blockComment = (text: string) => `/*\n${text}\n*/`;

    // Derivation commented out, a literal ceiling restored: the raw text still
    // satisfies the pin, so only the blanking can red this revert.
    const ceilingRevert = rawSource.replace(
      derivation,
      `${blockComment(derivation)}\nconst PERMISSIONS_CASE_OPTIONS = { timeout: 90_000, retry: 0 };`,
    );
    expect(ceilingRevert).toMatch(CASE_OPTIONS_PIN);
    expect(blankComments(ceilingRevert)).not.toMatch(CASE_OPTIONS_PIN);

    // Same shape for the wait literal: blanking must expose the value the
    // suite really uses, not the commented copy the regex captures first.
    // Derived from the source so a legitimate raise does not red the fixture.
    const waitLiteral = rawSource.match(WAIT_LITERAL_PIN)?.[1];
    expect(waitLiteral).toBeDefined();
    const wait = `const WAIT_LOCAL_MS = ${waitLiteral};`;
    const waitRevert = rawSource.replace(
      wait,
      `${blockComment(wait)}\nconst WAIT_LOCAL_MS = 12_000;`,
    );
    expect(waitRevert.match(WAIT_LITERAL_PIN)?.[1]).toBe(waitLiteral);
    expect(blankComments(waitRevert).match(WAIT_LITERAL_PIN)?.[1]).toBe(
      '12_000',
    );

    // A skipped case leaves every other line verbatim, so only the focus and
    // options pins can see it.
    const skipped = rawSource.replace(
      "it(\n  'permissions-clear-undo-replace-without-model',",
      "it.skip(\n  'permissions-clear-undo-replace-without-model',",
    );
    expect(skipped).toMatch(FOCUS_PIN);

    // A case that drops the shared options keeps its name and body verbatim,
    // so only the registration check can see it.
    const droppedOptions = rawSource.replace(
      "  'permissions-clear-undo-replace-without-model',\n  PERMISSIONS_CASE_OPTIONS,\n",
      "  'permissions-clear-undo-replace-without-model',\n",
    );
    const dropped = permissionsCases(testCalls(droppedOptions)).find(
      ({ name }) => name === 'permissions-clear-undo-replace-without-model',
    );
    expect(dropped?.call.arguments[1]?.getText()).not.toBe(
      'PERMISSIONS_CASE_OPTIONS',
    );

    const optionsSkip = rawSource.replace(
      '  retry: 0,\n};',
      '  retry: 0,\n  skip: true,\n};',
    );
    expect(optionsSkip).toMatch(SKIP_OPTIONS_PIN);

    // A deleted case and a for-loop case with a literal ceiling both left the
    // spelling pins green, so the expected set and the call-tree ceiling check
    // have to red them.
    const deleted = rawSource.slice(
      0,
      rawSource.indexOf(
        "it(\n  'permissions-second-control-c-exits-without-model',",
      ),
    );
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

    // One wait of headroom instead of several: the multiplier disappears, or
    // stays spelled out as 1. Derived so a legitimate raise keeps the fixture.
    const term = `${rawSource.match(CASE_OPTIONS_PIN)?.[1]} * scaledWait(WAIT_LOCAL_MS)`;
    expect(rawSource).toContain(term);
    expect(
      blankComments(rawSource.replace(term, 'scaledWait(WAIT_LOCAL_MS)')),
    ).not.toMatch(CASE_OPTIONS_PIN);
    const single = blankComments(
      rawSource.replace(term, '1 * scaledWait(WAIT_LOCAL_MS)'),
    );
    expect(single).toMatch(CASE_OPTIONS_PIN);
    expect(Number(single.match(CASE_OPTIONS_PIN)?.[1])).toBeLessThan(2);
  });
});
