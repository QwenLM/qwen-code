/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * hook 结束本轮后的 result 帧语义。
 *
 * `continue:false` 的 UserPromptSubmit hook 在模型调用前就结束了本轮：既没有回答，
 * 也不能按「模型正常返回空」记成 success。这里钉住三件事：
 * 1. 0 轮且被 hook 结束时必须产出 error result（is_error / terminal_reason / error_code）；
 * 2. hook 的 stopReason 要出现在 errors 里，调用方才能看到阻断原因；
 * 3. 已经回答完再被 hook 结束的一轮仍是 success，但带 terminal_reason。
 */

import { describe, expect, it } from 'vitest';
import {
  cloneUsage,
  RESULT_ERROR_CODES,
  clearSessionCredits,
  hydrateSessionCredits,
  recordCompletedRequest,
  type Terminal,
} from '@qwen-code/core';
import {
  buildResultError,
  buildResultSuccess,
  createResultAccumulator,
  terminalResultErrorMessage,
  terminalResultReason,
} from './queryProjection.js';
import {
  SDKResultSuccessSchema,
  SDKResultErrorSchema,
} from '../../../../../core/src/protocol/schemas/sdk-message.js';

describe('incomplete historical credits', () => {
  it.each([false, true])(
    'marks recovered subtotals in result frames (error=%s)',
    (error) => {
      const id = 'recovered-credits';
      hydrateSessionCredits(id, undefined, true);
      recordCompletedRequest({
        sessionId: id,
        requestId: 'r',
        model: 'test',
        usage: { billable: true, credits: 2 },
      });
      try {
        const result = error
          ? buildResultError(
              'error_during_execution',
              { errors: ['failed'], durationMs: 0, numTurns: 0 },
              id,
            )
          : buildResultSuccess('done', null, createResultAccumulator(), id);
        expect(result).toMatchObject({
          total_credits: 2,
          credits_history_incomplete: true,
        });
        const parsed = (
          error ? SDKResultErrorSchema() : SDKResultSuccessSchema()
        ).parse(result);
        expect(parsed).toMatchObject({ credits_history_incomplete: true });
        expect(parsed.modelUsage['test']).not.toHaveProperty('credits');
      } finally {
        clearSessionCredits(id);
      }
    },
  );
});

function hookStopTerminal(overrides: Partial<Terminal> = {}): Terminal {
  return {
    reason: 'end_turn',
    terminalDetail: 'hook_stopped',
    hookStopReason: 'BLOCKED-BY-HOOK',
    numTurns: 0,
    usage: cloneUsage(),
    durationMs: 12,
    ...overrides,
  };
}

describe('hook stop 的 result 投影', () => {
  it('模型调用前被 hook 结束时产出 error result 并保留 stopReason', () => {
    const terminal = hookStopTerminal();
    const terminalErrorMessage = terminalResultErrorMessage(terminal);

    expect(terminalErrorMessage).toBe(
      'Operation stopped by hook: BLOCKED-BY-HOOK',
    );
    expect(terminalResultReason(terminal)).toBe('hook_stopped');

    const result = buildResultError(
      'error_during_execution',
      {
        errors: [terminalErrorMessage!],
        durationMs: terminal.durationMs,
        numTurns: terminal.numTurns,
        usage: terminal.usage,
        resultAcc: createResultAccumulator(),
        terminalReason: terminalResultReason(terminal),
      },
      'session-1',
    );

    expect(result).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 0,
      terminal_reason: 'hook_stopped',
      error_code: RESULT_ERROR_CODES.hookBlocked,
      errors: ['Operation stopped by hook: BLOCKED-BY-HOOK'],
    });
  });

  it('hook 未给 stopReason 时使用通用阻断文案', () => {
    expect(
      terminalResultErrorMessage(hookStopTerminal({ hookStopReason: undefined })),
    ).toBe('Operation stopped by hook');
  });

  it('已产生回答再被 hook 结束时仍是 success，但暴露 terminal_reason', () => {
    const terminal = hookStopTerminal({ numTurns: 1 });

    expect(terminalResultErrorMessage(terminal)).toBeNull();

    const result = buildResultSuccess(
      'done',
      terminal,
      createResultAccumulator('end_turn'),
      'session-1',
    );

    expect(result).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      terminal_reason: 'hook_stopped',
    });
  });

  it('普通完成的轮次不新增 terminal_reason', () => {
    const terminal: Terminal = {
      reason: 'end_turn',
      numTurns: 1,
      usage: cloneUsage(),
      durationMs: 5,
    };

    const result = buildResultSuccess(
      'done',
      terminal,
      createResultAccumulator('end_turn'),
      'session-1',
    ) as unknown as Record<string, unknown>;

    expect(result['terminal_reason']).toBeUndefined();
  });
});
