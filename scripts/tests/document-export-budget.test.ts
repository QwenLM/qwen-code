/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  documentExportBudgetMs,
  documentExportTestTimeoutMs,
} from '../../integration-tests/document-export-budget.js';

// The browser gate that consumes these budgets runs on both runner classes:
// ci.yml's PR-gated web_shell_e2e_smoke shard 1 selects the shared self-hosted
// ARM64 pool or ubuntu-latest, and e2e.yml's nightly leg runs on ubuntu-latest.
// Only the self-hosted pool measured the #17158 overrun, so the tier decision
// is pinned here, where test:scripts collects it on every PR — the same shape
// as scripts/tests/ready-prompt-budget.test.ts.
describe('document export budgets', () => {
  it('keeps the tight 60s ceiling outside the shared self-hosted pool', () => {
    expect(documentExportBudgetMs({})).toBe(60_000);
    expect(documentExportBudgetMs({ CI: 'true' })).toBe(60_000);
    expect(
      documentExportBudgetMs({
        CI: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
      }),
    ).toBe(60_000);
    expect(documentExportTestTimeoutMs({})).toBe(90_000);
  });

  it('widens the ceiling only on the self-hosted pool that measured 68.4s (#17158)', () => {
    expect(documentExportBudgetMs({ RUNNER_ENVIRONMENT: 'self-hosted' })).toBe(
      180_000,
    );
  });

  it('derives the per-case timeout from the budget so the two cannot drift', () => {
    expect(
      documentExportTestTimeoutMs({ RUNNER_ENVIRONMENT: 'self-hosted' }),
    ).toBe(
      documentExportBudgetMs({ RUNNER_ENVIRONMENT: 'self-hosted' }) + 30_000,
    );
    // The gate passes this as the explicit third argument to `it(...)`, so
    // nothing else bounds it; pin the derived value itself.
    expect(
      documentExportTestTimeoutMs({ RUNNER_ENVIRONMENT: 'self-hosted' }),
    ).toBe(210_000);
  });
});
