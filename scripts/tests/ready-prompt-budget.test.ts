/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_READY_PROMPT_BUDGET_MS,
  readyPromptBudgetMs,
} from '../../integration-tests/ready-prompt-budget.js';

// The interactive real-spawn cases sit in a file no PR-triggered job
// collects: ci.yml's PR-gated integration_no_ak leg runs an explicit
// allow-list under --root ./integration-tests that does not name it, and the
// whole-root legs run post-merge and at release. The #13552 budget decision
// is therefore pinned here, where test:scripts collects it on every PR — the
// same shape as integration-vitest-config.test.ts's RUNNER_ENVIRONMENT pin.
describe('readyPromptBudgetMs', () => {
  it('exports the widest budget so suite ceilings derive from it', () => {
    const branches = [
      readyPromptBudgetMs({}),
      readyPromptBudgetMs({ RUNNER_ENVIRONMENT: 'github-hosted' }),
      readyPromptBudgetMs({
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'macOS',
        RUNNER_ARCH: 'X64',
      }),
      readyPromptBudgetMs({ RUNNER_ENVIRONMENT: 'self-hosted' }),
      readyPromptBudgetMs({
        RUNNER_ENVIRONMENT: 'self-hosted',
        QWEN_SANDBOX: 'docker',
      }),
    ];
    // MAX derives from every TIER, so this cross-check reddens when a new
    // tier is added without being sampled here. The parity suite sizes its
    // per-case timeouts from MAX, so a raise moves those ceilings too.
    expect(Math.max(...branches)).toBe(MAX_READY_PROMPT_BUDGET_MS);
    // "Any budget here must stay under the suite's testTimeout"
    // (ready-prompt-budget.ts): interactive-session.test.ts sets no per-case
    // timeout and inherits integration-tests/vitest.config.ts's 300s default.
    expect(MAX_READY_PROMPT_BUDGET_MS).toBeLessThan(300_000);
  });

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

  it('widens the ready-prompt budget on GitHub-hosted macOS x64 (#15677)', () => {
    // macos-15-intel is the slowest host in the tui-parity matrix: the
    // installed-distribution darwin-x64 leg stalled past the 30s default on
    // 5 of its first 6 runs with the banner already rendered, so it joins
    // the 90s stall tier the self-hosted hosts already carry.
    expect(
      readyPromptBudgetMs({
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'macOS',
        RUNNER_ARCH: 'X64',
      }),
    ).toBe(90_000);
    // The stall has only been observed on the intel image; the arm64
    // macos-15 legs keep the tight fail-fast budget.
    expect(
      readyPromptBudgetMs({
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'macOS',
        RUNNER_ARCH: 'ARM64',
      }),
    ).toBe(30_000);
  });

  it('keeps the tight 30s budget in every other runner state', () => {
    expect(readyPromptBudgetMs({ RUNNER_ENVIRONMENT: 'github-hosted' })).toBe(
      30_000,
    );
    expect(readyPromptBudgetMs({})).toBe(30_000);
    expect(readyPromptBudgetMs({ RUNNER_ENVIRONMENT: 'unmapped-value' })).toBe(
      30_000,
    );
    // The ubuntu legs of every workflow keep the tight fail-fast budget.
    expect(
      readyPromptBudgetMs({
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
      }),
    ).toBe(30_000);
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
