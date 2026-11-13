/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { documentExportBudgetMs } from '../../integration-tests/document-export-budget.js';

// The browser gate that consumes these budgets runs on both runner classes:
// ci.yml's PR-gated web_shell_e2e_smoke shard 1 selects the shared self-hosted
// ARM64 pool or ubuntu-latest, and e2e.yml's nightly leg runs on ubuntu-latest.
// Only the self-hosted pool measured the overruns, so the tier decision is
// pinned here, where test:scripts collects it on every PR.
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
    // A case inherits the integration suite's default 5-minute testTimeout, so
    // the widened budget has to stay under it to be observed.
    expect(budget).toBeLessThan(300_000);
  });
});
