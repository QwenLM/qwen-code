/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { documentExportBudgetMs } from '../../integration-tests/document-export-budget.js';
import integrationConfig from '../../integration-tests/vitest.config.js';

// The browser gate that consumes these budgets runs on both runner classes:
// ci.yml's PR-gated web_shell_e2e_smoke shard 1 selects the shared self-hosted
// ARM64 pool or ubuntu-latest, and e2e.yml's nightly leg runs on ubuntu-latest.
// Only the self-hosted pool measured the overruns, so the tier decision is
// pinned here, where test:scripts collects it on every PR.
const gateSource = readFileSync(
  join(
    resolve(import.meta.dirname, '../..'),
    'integration-tests/chat-transcript-document.test.ts',
  ),
  'utf8',
);

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
    expect(budget).toBeLessThan(integrationConfig.test!.testTimeout!);
  });

  it('wires the resolved budget into the browser gate and its case ceiling', () => {
    // Both lines below are invisible to every PR-gated lane when reverted: the
    // gate itself only runs in web_shell_e2e_smoke shard 1 and the
    // schedule-only nightly leg, where a healthy render sits well under either
    // ceiling. These byte-shape pins give each revert a ~0ms witness through
    // test:scripts, which runs on every PR. The patterns tolerate the reflow
    // and trailing comma Prettier emits for a long call or argument.
    expect(gateSource).toMatch(
      /const MAX_DOCUMENT_DURATION_MS = documentExportBudgetMs\(\s*process\.env,?\s*\);/,
    );
    expect(gateSource).toMatch(/MAX_DOCUMENT_DURATION_MS \+ 30_000,?\s*\);/);
  });
});
