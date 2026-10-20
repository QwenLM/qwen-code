/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readyPromptBudgetMs } from '../../integration-tests/ready-prompt-budget.js';

// The interactive real-spawn cases sit in a file no PR-triggered job
// collects: ci.yml's PR-gated integration_no_ak leg runs an explicit
// allow-list under --root ./integration-tests that does not name it, and the
// whole-root legs run post-merge and at release. The #13552 budget decision
// is therefore pinned here, where test:scripts collects it on every PR — the
// same shape as integration-vitest-config.test.ts's RUNNER_ENVIRONMENT pin.
describe('readyPromptBudgetMs', () => {
  it('widens the ready-prompt budget on shared self-hosted runners (#13552)', () => {
    expect(readyPromptBudgetMs({ RUNNER_ENVIRONMENT: 'self-hosted' })).toBe(
      90_000,
    );
  });

  it('widens the self-hosted docker boot budget past the #14191 stall', () => {
    expect(
      readyPromptBudgetMs({
        RUNNER_ENVIRONMENT: 'self-hosted',
        QWEN_SANDBOX: 'docker',
      }),
    ).toBe(180_000);
    // The self-hosted no-sandbox legs (e2e.yml's sandbox:none matrix and the
    // release sandbox:none legs) export QWEN_SANDBOX=false, not an unset
    // variable: a truthiness check instead of === 'docker' would widen them.
    expect(
      readyPromptBudgetMs({
        RUNNER_ENVIRONMENT: 'self-hosted',
        QWEN_SANDBOX: 'false',
      }),
    ).toBe(90_000);
  });

  it('keeps the tight 30s budget in every other runner state', () => {
    expect(readyPromptBudgetMs({ RUNNER_ENVIRONMENT: 'github-hosted' })).toBe(
      30_000,
    );
    expect(readyPromptBudgetMs({})).toBe(30_000);
    expect(readyPromptBudgetMs({ RUNNER_ENVIRONMENT: 'unmapped-value' })).toBe(
      30_000,
    );
    // The docker-boot stall class has only been observed on the shared
    // self-hosted ECS pool; hosted VMs keep the tight fail-fast budget.
    expect(
      readyPromptBudgetMs({
        RUNNER_ENVIRONMENT: 'github-hosted',
        QWEN_SANDBOX: 'docker',
      }),
    ).toBe(30_000);
  });
});
