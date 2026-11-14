/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { documentExportBudgetMs } from '../../integration-tests/document-export-budget.js';

// The browser gate that consumes these budgets runs on both runner classes:
// ci.yml's PR-gated web_shell_e2e_smoke shard 1 selects the shared self-hosted
// ARM64 pool or ubuntu-latest, and e2e.yml's nightly leg runs on ubuntu-latest.
// Only the self-hosted pool measured the overruns, so the tier decision is
// pinned here, where test:scripts collects it on every PR.
const repoRoot = resolve(import.meta.dirname, '../..');
const gateSource = readFileSync(
  join(repoRoot, 'integration-tests/chat-transcript-document.test.ts'),
  'utf8',
);
const integrationConfigSource = readFileSync(
  join(repoRoot, 'integration-tests/vitest.config.ts'),
  'utf8',
);

// Line-start anchored so a commented-out copy of a wired line cannot satisfy
// the pin; the \s* / ,? tolerance still absorbs the reflow and trailing comma
// Prettier emits for a long call or argument. Shared with the commented-out
// fixture case below so that case witnesses these exact patterns.
const WIRING_PIN =
  /^const MAX_DOCUMENT_DURATION_MS = documentExportBudgetMs\(\s*process\.env,?\s*\);/m;
const CASE_CEILING_PIN = /^\s*MAX_DOCUMENT_DURATION_MS \+ 30_000,?\s*\);/m;
const BUDGET_ASSERTION_PIN =
  /^\s*expect\(durationMs\)\.toBeLessThan\(MAX_DOCUMENT_DURATION_MS\);/m;

describe('document export budgets', () => {
  it('keeps the tight 60s ceiling off the shared self-hosted pool', () => {
    expect(documentExportBudgetMs({})).toBe(60_000);
    expect(documentExportBudgetMs({ CI: 'true' })).toBe(60_000);
    expect(
      documentExportBudgetMs({
        CI: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
      }),
    ).toBe(60_000);
  });

  it('widens the ceiling on the self-hosted pool that measured the overruns', () => {
    const budget = documentExportBudgetMs({
      RUNNER_ENVIRONMENT: 'self-hosted',
    });
    expect(budget).toBe(180_000);
    // The gate derives its per-case ceiling from this budget, and a per-case
    // timeout outranks the suite's, so the budget has to stay under the suite
    // ceiling for the budget assertion to be the one that reports a wedged run.
    // Literal, not the imported config: the config derives testTimeout from
    // the ambient TB_TIMEOUT_MINUTES, which would make this config-free lane
    // depend on the caller's shell (same shape as ready-prompt-budget.test.ts).
    expect(budget).toBeLessThan(300_000);
    // The literal is only correct while the integration default stays five
    // minutes; pin the derivation so lowering the '5' fallback reddens here
    // and both ceilings move together.
    expect(integrationConfigSource).toMatch(
      /Number\(process\.env\['TB_TIMEOUT_MINUTES'\] \|\| '5'\)/,
    );
  });

  it('wires the resolved budget into the browser gate and its case ceiling', () => {
    // These lines are invisible to every PR-gated lane when reverted: the
    // gate itself only runs in web_shell_e2e_smoke shard 1 and the
    // schedule-only nightly leg, where a healthy render sits well under either
    // ceiling. These byte-shape pins give each revert a ~0ms witness through
    // test:scripts, which runs on every PR.
    expect(gateSource).toMatch(WIRING_PIN);
    expect(gateSource).toMatch(CASE_CEILING_PIN);
    // The assertion that consumes the budget: a deflake round that deletes it
    // (with the now-unused startedAt/durationMs/nodePerformance locals) would
    // leave the gate enforcing only the case timeout, reporting a bare
    // "Test timed out" instead of the budget.
    expect(gateSource).toMatch(BUDGET_ASSERTION_PIN);
  });

  it('does not witness a commented-out revert of the wiring', () => {
    // Acceptance fixture for the line-start anchors: a revert that comments
    // the wiring out and restores the literal must not match any pin.
    // Removing an anchor turns this case red.
    const commentedOut = [
      '// const MAX_DOCUMENT_DURATION_MS = documentExportBudgetMs(process.env);',
      'const MAX_DOCUMENT_DURATION_MS = 60_000;',
      '    // MAX_DOCUMENT_DURATION_MS + 30_000,',
      '  );',
      '      // expect(durationMs).toBeLessThan(MAX_DOCUMENT_DURATION_MS);',
    ].join('\n');
    expect(commentedOut).not.toMatch(WIRING_PIN);
    expect(commentedOut).not.toMatch(CASE_CEILING_PIN);
    expect(commentedOut).not.toMatch(BUDGET_ASSERTION_PIN);
  });
});
