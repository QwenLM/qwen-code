/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_READY_PROMPT_BUDGET_MS,
  readyPromptBudgetMs,
} from '../../integration-tests/ready-prompt-budget.js';
import { blankComments } from './blank-comments.js';

// A wait ceiling is invisible on a green run: the editor-parity repaints land
// in well under a second, so only the non-deterministic pool stall of #17544
// surfaces a revert to the old literal. Pinned here, where test:scripts
// collects it on every PR — the PR-gated integration lanes enumerate files
// and omit this one (scripts/tests/ready-prompt-budget.test.ts).
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
  /^const PERMISSIONS_CASE_OPTIONS = \{\s*timeout:\s*readyPromptBudgetMs\(process\.env\)\s*\+\s*scaledWait\(WAIT_LOCAL_MS\)\s*\+\s*60_000,?\s*retry: 0,?\s*\};$/m;
const PERMISSIONS_CASE_PIN = /^it\(\n {2}'permissions-[^']+',\n/gm;
const CASE_REGISTRATION_PIN =
  /^it\(\n {2}'permissions-[^']+',\n {2}PERMISSIONS_CASE_OPTIONS,\n {2}\(\) =>$/gm;
const LITERAL_CEILING_PIN = /^ {2}[\d_]+,\n\);$/gm;
const FOCUS_PIN = /^\s*(?:it|describe|test)\s*\.\s*(?:only|skip|todo)\s*\(/m;
// Scoped to the shared options object and key-order agnostic: a skip key in
// any position disables all three cases while every other pin still matches.
const SKIP_OPTIONS_PIN =
  /^const PERMISSIONS_CASE_OPTIONS = \{[^}]*\b(?:skip|only|todo|skipIf|runIf)\s*:/m;

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
    // The options ride in the second argument: an object in the third is the
    // deprecated form Vitest 4 throws on, and a bare number there is the
    // literal ceiling this pin exists to red.
    const cases = [...source.matchAll(PERMISSIONS_CASE_PIN)];
    expect(cases.length).toBeGreaterThan(0);
    expect([...source.matchAll(CASE_REGISTRATION_PIN)]).toHaveLength(
      cases.length,
    );
    expect([...source.matchAll(LITERAL_CEILING_PIN)]).toEqual([]);
    expect(source).not.toMatch(FOCUS_PIN);
    expect(source).not.toMatch(SKIP_OPTIONS_PIN);
  });

  it('does not witness a commented-out revert', () => {
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
    // so only the registration pin can see it.
    const registered = [...rawSource.matchAll(CASE_REGISTRATION_PIN)].length;
    const droppedOptions = rawSource.replace(
      "  'permissions-clear-undo-replace-without-model',\n  PERMISSIONS_CASE_OPTIONS,\n",
      "  'permissions-clear-undo-replace-without-model',\n",
    );
    expect([...droppedOptions.matchAll(CASE_REGISTRATION_PIN)]).toHaveLength(
      registered - 1,
    );

    const optionsSkip = rawSource.replace(
      '  retry: 0,\n};',
      '  retry: 0,\n  skip: true,\n};',
    );
    expect(optionsSkip).toMatch(SKIP_OPTIONS_PIN);
  });
});
