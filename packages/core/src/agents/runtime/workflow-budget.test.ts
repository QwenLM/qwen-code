/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Config } from '../../config/config.js';
import { TurnBudget } from '../../core/turn-budget.js';
import { EVENT_API_RESPONSE } from '../../telemetry/constants.js';
import { uiTelemetryService } from '../../telemetry/uiTelemetry.js';
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

  it('returns null on hex / scientific / non-decimal-integer overrides', () => {
    // Number('0x2BF20')=180000, Number('1e6')=1000000, Number('5.0')=5 all
    // pass Number.isInteger; only plain decimal integers should set a cap.
    for (const raw of ['0x2BF20', '1e6', '5.0']) {
      expect(
        resolveMaxTokensPerWorkflow({ [MAX_TOKENS_PER_WORKFLOW_ENV]: raw }),
      ).toBeNull();
    }
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
  });

  it('R2 #14: message does NOT advise removing/raising the cap (model-coaching mitigation)', () => {
    const err = new WorkflowBudgetExceededError('wf_abc123', 10_000, 12_500);
    // The error reaches the LLM via `tool_result`; the advisory tail
    // would coach the model to tell the user how to disable the
    // operator's budget. Keep the factual portion only.
    expect(err.message).not.toMatch(/Increase /i);
    expect(err.message).not.toMatch(/remove the cap/i);
    expect(err.message).not.toContain(MAX_TOKENS_PER_WORKFLOW_ENV);
  });

  it('name is the class name (for duck-typed detection)', () => {
    const err = new WorkflowBudgetExceededError('wf_x', 1, 2);
    expect(err.name).toBe('WorkflowBudgetExceededError');
  });

  it('is throwable and catchable as Error', () => {
    expect(() => {
      throw new WorkflowBudgetExceededError('wf_x', 100, 200);
    }).toThrow(/token budget exceeded/);
  });
});

describe('WorkflowBudgetImpl sources', () => {
  it('an env cap measures this run alone', () => {
    const b = new WorkflowBudgetImpl(1_000, {
      source: 'env',
      turnSpent: () => 999_999,
    });
    b.recordSpent(400);
    expect(b.spent()).toBe(400);
    expect(b.runSpent()).toBe(400);
    expect(b.runCap()).toBe(1_000);
    expect(b.remaining()).toBe(600);
  });

  it('a turn target measures the whole turn, and is no cap on the run', () => {
    let turn = 120_000;
    const b = new WorkflowBudgetImpl(500_000, {
      source: 'directive',
      turnSpent: () => turn,
      directiveText: '+500k',
    });
    b.recordSpent(20_000);
    expect(b.spent()).toBe(120_000);
    expect(b.runSpent()).toBe(20_000);
    expect(b.runCap()).toBeNull();
    expect(b.remaining()).toBe(380_000);
    turn = 600_000;
    expect(b.remaining()).toBe(0);
    expect(b.directiveText).toBe('+500k');
  });

  it('with no total, spent() still reports the turn when one is known', () => {
    const b = new WorkflowBudgetImpl(null, { turnSpent: () => 42 });
    b.recordSpent(7);
    expect(b.source).toBeUndefined();
    expect(b.spent()).toBe(42);
    expect(b.runSpent()).toBe(7);
    expect(b.runCap()).toBeNull();
    expect(b.remaining()).toBe(Infinity);
  });

  it('defaults a numeric total to a per-run env cap', () => {
    expect(new WorkflowBudgetImpl(10).source).toBe('env');
    expect(new WorkflowBudgetImpl(null).source).toBeUndefined();
  });
});

describe('WorkflowBudgetImpl.fromConfig', () => {
  // The session's real token ledger, fed the way LoggingContentGenerator
  // feeds it, under a session id no other test shares.
  function session() {
    const sessionId = `budget-${randomUUID()}`;
    const turns = new TurnBudget();
    const config = {
      getSessionId: () => sessionId,
      getTurnBudget: () => turns,
    } as unknown as Config;
    const charge = (outputTokens: number) =>
      uiTelemetryService.addEvent(
        {
          'event.name': EVENT_API_RESPONSE,
          model: 'qwen-test',
          prompt_id: 'p',
          duration_ms: 1,
          input_token_count: 1,
          output_token_count: outputTokens,
          total_token_count: outputTokens + 1,
          cached_content_token_count: 0,
          thoughts_token_count: 0,
        } as unknown as Parameters<typeof uiTelemetryService.addEvent>[0],
        sessionId,
      );
    const beginTurn = (budget: number | null) =>
      turns.beginTurn({
        promptId: 'p',
        sessionId,
        budget,
        ...(budget !== null ? { directiveText: `+${budget / 1000}k` } : {}),
        outputTokensAtTurnStart:
          uiTelemetryService.getTotalOutputTokens(sessionId),
      });
    return { sessionId, turns, config, charge, beginTurn };
  }

  it('prefers the turn directive over the env cap', () => {
    const { config, charge, beginTurn } = session();
    charge(70_000);
    beginTurn(300_000);
    charge(5_000);
    const b = WorkflowBudgetImpl.fromConfig(config, {
      [MAX_TOKENS_PER_WORKFLOW_ENV]: '1000',
    });
    expect(b.source).toBe('directive');
    expect(b.total).toBe(300_000);
    expect(b.spent()).toBe(5_000);
    expect(b.directiveText).toBe('+300k');
  });

  it('falls back to the env cap when the turn set no target', () => {
    const { config, beginTurn } = session();
    beginTurn(null);
    const b = WorkflowBudgetImpl.fromConfig(config, {
      [MAX_TOKENS_PER_WORKFLOW_ENV]: '1000',
    });
    expect(b.source).toBe('env');
    expect(b.total).toBe(1_000);
  });

  it('has no total with neither, but still reports the turn spend', () => {
    const { config, charge, beginTurn } = session();
    charge(9_000);
    beginTurn(null);
    charge(250);
    const b = WorkflowBudgetImpl.fromConfig(config, {});
    expect(b.total).toBeNull();
    expect(b.spent()).toBe(250);
  });

  // A run reads the turn once, at launch: a later turn starting while the run
  // is still going does not move its starting point or drop its target.
  it('keeps the turn it launched in when the next turn begins', () => {
    const { config, charge, beginTurn } = session();
    beginTurn(300_000);
    const b = WorkflowBudgetImpl.fromConfig(config, {});
    charge(1_000);
    beginTurn(null);
    charge(2_000);
    expect(b.total).toBe(300_000);
    expect(b.spent()).toBe(3_000);
  });

  it('ignores a turn that belongs to another session', () => {
    const { turns, charge } = session();
    const other = {
      getSessionId: () => 'some-other-session',
      getTurnBudget: () => turns,
    } as unknown as Config;
    charge(1);
    turns.beginTurn({
      promptId: 'p',
      sessionId: 'not-this-one',
      budget: 300_000,
      outputTokensAtTurnStart: 0,
    });
    const b = WorkflowBudgetImpl.fromConfig(other, {});
    expect(b.total).toBeNull();
    expect(b.spent()).toBe(0);
  });

  it('works for a config with no turn support at all', () => {
    const b = WorkflowBudgetImpl.fromConfig({} as unknown as Config, {
      [MAX_TOKENS_PER_WORKFLOW_ENV]: '5000',
    });
    expect(b.source).toBe('env');
    expect(b.total).toBe(5_000);
  });
});
