/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  WorkflowBudgetImpl,
  WorkflowBudgetExceededError,
  resolveMaxTokensPerWorkflow,
  MAX_TOKENS_PER_WORKFLOW_ENV,
  HARD_MAX_TOKENS_CEILING,
} from './workflow-budget.js';

describe('resolveMaxTokensPerWorkflow', () => {
  it('returns null when env is unset', () => {
    expect(resolveMaxTokensPerWorkflow({})).toBeNull();
  });

  it('returns null when env is empty / whitespace', () => {
    expect(
      resolveMaxTokensPerWorkflow({ [MAX_TOKENS_PER_WORKFLOW_ENV]: '' }),
    ).toBeNull();
    expect(
      resolveMaxTokensPerWorkflow({ [MAX_TOKENS_PER_WORKFLOW_ENV]: '   ' }),
    ).toBeNull();
  });

  it('parses a positive integer env value', () => {
    expect(
      resolveMaxTokensPerWorkflow({
        [MAX_TOKENS_PER_WORKFLOW_ENV]: '50000',
      }),
    ).toBe(50_000);
  });

  it('returns null on non-integer override (treats misconfig as no cap)', () => {
    expect(
      resolveMaxTokensPerWorkflow({
        [MAX_TOKENS_PER_WORKFLOW_ENV]: 'abc',
      }),
    ).toBeNull();
    expect(
      resolveMaxTokensPerWorkflow({
        [MAX_TOKENS_PER_WORKFLOW_ENV]: '1.5',
      }),
    ).toBeNull();
  });

  it('returns null on zero / negative override', () => {
    expect(
      resolveMaxTokensPerWorkflow({
        [MAX_TOKENS_PER_WORKFLOW_ENV]: '0',
      }),
    ).toBeNull();
    expect(
      resolveMaxTokensPerWorkflow({
        [MAX_TOKENS_PER_WORKFLOW_ENV]: '-100',
      }),
    ).toBeNull();
  });

  it('clamps to HARD_MAX_TOKENS_CEILING on over-large override', () => {
    expect(
      resolveMaxTokensPerWorkflow({
        [MAX_TOKENS_PER_WORKFLOW_ENV]: String(HARD_MAX_TOKENS_CEILING + 1),
      }),
    ).toBe(HARD_MAX_TOKENS_CEILING);
    expect(
      resolveMaxTokensPerWorkflow({
        [MAX_TOKENS_PER_WORKFLOW_ENV]: '999999999',
      }),
    ).toBe(HARD_MAX_TOKENS_CEILING);
  });
});

describe('WorkflowBudgetImpl', () => {
  it('total is null when constructed with null (no cap)', () => {
    const b = new WorkflowBudgetImpl(null);
    expect(b.total).toBeNull();
    expect(b.spent()).toBe(0);
    expect(b.remaining()).toBe(Infinity);
  });

  it('total is the cap when constructed with a number', () => {
    const b = new WorkflowBudgetImpl(10_000);
    expect(b.total).toBe(10_000);
    expect(b.spent()).toBe(0);
    expect(b.remaining()).toBe(10_000);
  });

  it('recordSpent accumulates positive deltas', () => {
    const b = new WorkflowBudgetImpl(10_000);
    b.recordSpent(1_500);
    b.recordSpent(2_500);
    expect(b.spent()).toBe(4_000);
    expect(b.remaining()).toBe(6_000);
  });

  it('remaining() never goes negative — clamps at 0', () => {
    const b = new WorkflowBudgetImpl(1_000);
    b.recordSpent(2_500); // overshoot
    expect(b.spent()).toBe(2_500);
    expect(b.remaining()).toBe(0);
  });

  it('remaining() stays Infinity even after spending when total is null', () => {
    const b = new WorkflowBudgetImpl(null);
    b.recordSpent(1_000);
    b.recordSpent(50_000);
    expect(b.spent()).toBe(51_000);
    expect(b.remaining()).toBe(Infinity);
  });

  it('recordSpent ignores zero / negative / non-finite deltas', () => {
    const b = new WorkflowBudgetImpl(10_000);
    b.recordSpent(1_000);
    b.recordSpent(0);
    b.recordSpent(-500);
    b.recordSpent(Number.NaN);
    b.recordSpent(Number.POSITIVE_INFINITY);
    expect(b.spent()).toBe(1_000);
  });

  it('fromEnv builds a budget from process env (null when env unset)', () => {
    const b = WorkflowBudgetImpl.fromEnv({});
    expect(b.total).toBeNull();
    expect(b.remaining()).toBe(Infinity);
  });

  it('fromEnv reads the env override', () => {
    const b = WorkflowBudgetImpl.fromEnv({
      [MAX_TOKENS_PER_WORKFLOW_ENV]: '25000',
    });
    expect(b.total).toBe(25_000);
    expect(b.remaining()).toBe(25_000);
  });
});

describe('WorkflowBudgetExceededError', () => {
  it('carries runId, budgetTotal, and spent fields', () => {
    const err = new WorkflowBudgetExceededError('wf_abc123', 10_000, 12_500);
    expect(err.runId).toBe('wf_abc123');
    expect(err.budgetTotal).toBe(10_000);
    expect(err.spent).toBe(12_500);
  });

  it('message is self-describing (extractErrorMessage compatible)', () => {
    const err = new WorkflowBudgetExceededError('wf_abc123', 10_000, 12_500);
    expect(err.message).toContain('wf_abc123');
    expect(err.message).toContain('12500');
    expect(err.message).toContain('10000');
    expect(err.message).toContain(MAX_TOKENS_PER_WORKFLOW_ENV);
  });

  it('name is the class name (for duck-typed detection)', () => {
    const err = new WorkflowBudgetExceededError('wf_x', 1, 2);
    expect(err.name).toBe('WorkflowBudgetExceededError');
  });

  it('is throwable and catchable as Error', () => {
    expect(() => {
      throw new WorkflowBudgetExceededError('wf_x', 100, 200);
    }).toThrow(/exceeded the token budget/);
  });
});
