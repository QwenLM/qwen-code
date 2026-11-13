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

// The browser gate that consumes these budgets is exempt from every
// PR-gated integration leg (no-ak-integration-ci.test.js records it as a
// runtime-budget omission), so the #17158 ceiling decision is pinned here,
// where test:scripts collects it on every PR — the same shape as
// scripts/tests/ready-prompt-budget.test.ts.
describe('document export budgets', () => {
  it('keeps the tight 60s ceiling outside CI', () => {
    expect(documentExportBudgetMs({})).toBe(60_000);
    expect(documentExportBudgetMs({ CI: 'false' })).toBe(60_000);
    expect(documentExportTestTimeoutMs({})).toBe(90_000);
  });

  it('widens the ceiling on CI hosts, where the gate measured 68.4s (#17158)', () => {
    expect(documentExportBudgetMs({ CI: 'true' })).toBe(180_000);
  });

  it('derives the per-case timeout from the budget so the two cannot drift', () => {
    expect(documentExportTestTimeoutMs({ CI: 'true' })).toBe(
      documentExportBudgetMs({ CI: 'true' }) + 30_000,
    );
    // The explicit per-case timeout replaces the suite's 5-minute default;
    // the widened CI ceiling must stay under that default to be meaningful.
    expect(documentExportTestTimeoutMs({ CI: 'true' })).toBeLessThan(300_000);
  });
});
