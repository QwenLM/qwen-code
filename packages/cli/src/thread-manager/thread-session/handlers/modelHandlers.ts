/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 模型能力组：`setModel` / `setContextWindow` / `setMaxThinkingTokens`。
 *
 * 入参是宿主解析好的产品语义值，返回产品语义结果，失败抛 `ThreadCapabilityError`，均不带 code。
 * context window 的两种 wire 拼写归一由宿主完成，本组只做值级校验。
 */

import {
  applyExplicitModelChange,
  parseReasoningEffortLevel,
  type ModelConfig,
} from '@qwen-code/core';
import { setModelPreference } from '../../../utils/modelPreference.js';
import { parseContextWindow } from '../../../session/contextWindow.js';
import type { ThreadCallContext } from '../contract/hostContext.js';
import {
  ThreadCapabilityError,
  type ThreadSessionInternals,
} from '../contract/handlerContract.js';

/**
 * 切换模型，可同时携带 reasoning effort 与 context window；成功无回包 payload。
 *
 * `set_model` 在 turn 进行中必须立刻生效：切换会使在途请求的模型快照失效，排队会让 SDK
 * 在长 turn 期间拿不到回执；空闲时则排队等 initialize 落地——时序由宿主派发层保证。
 * context_window 在同一次调用内先校验，无效则模型不变更；
 * `reasoning_effort: null` 表示清空。
 */
export async function setModel(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  request: {
    model?: string;
    reasoningEffort?: string | null;
    contextWindow?: unknown;
    persisted?: boolean;
  },
): Promise<void> {
  const config = session.requireConfig();
  if (typeof request.model !== 'string') {
    throw new ThreadCapabilityError('missing model');
  }
  try {
    // 先校验 context window：无效则模型不变更。
    // undefined＝缺省，null＝显式清空，其余走值级校验。
    let contextWindowToSet: number | undefined;
    let clearContextWindow = false;
    if (request.contextWindow !== undefined) {
      if (request.contextWindow === null) {
        clearContextWindow = true;
      } else {
        const parsed = parseContextWindow(request.contextWindow);
        if (parsed === undefined) {
          throw new ThreadCapabilityError('invalid context_window');
        }
        contextWindowToSet = parsed;
      }
    }

    const identity = config.getModelRequestIdentity();
    const stillCurrent = () =>
      !session.isTerminated() &&
      !session.signal.aborted &&
      session.requireConfig() === config &&
      config.getModel() === request.model &&
      identity === config.getModelRequestIdentity();
    await applyExplicitModelChange(config, request.model, {
      trigger: 'headless_control',
      isTemporary: true,
      persisted: request.persisted === true,
    });
    if (!stillCurrent())
      throw new ThreadCapabilityError('会话目标已变化，模型更新已取消。');
    session
      .peekQueryRunner()
      ?.refreshRuntimeContext({ resetModelRouting: true });
    const reasoningEffort = parseReasoningEffortLevel(request.reasoningEffort);
    // wire 上的 `reasoning_effort: null`＝清空（宿主归一成 null 传入）。
    const patch: ModelConfig = {
      ...(reasoningEffort !== undefined || request.reasoningEffort === null
        ? { reasoning: { effort: reasoningEffort } }
        : {}),
      ...(contextWindowToSet !== undefined || clearContextWindow
        ? { context: { contextWindow: contextWindowToSet } }
        : {}),
    };
    if (patch.reasoning || patch.context) {
      await setModelPreference(config, patch);
    }
    if (!stillCurrent())
      throw new ThreadCapabilityError('会话目标已变化，模型更新已取消。');
    // 成功无回包 payload，宿主装空 success。
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'set_model failed',
    );
  }
}

/**
 * 单独设置或清空 context window，并重置模型路由。
 *
 * `undefined` 表示缺省（抛 `missing context_window`），`null` 表示清空，其余交给
 * `parseContextWindow` 判定（非法抛 `invalid context_window`）。写入只落在本会话 Config 与 runner。
 */
export async function setContextWindow(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  value: unknown,
): Promise<void> {
  const config = session.requireConfig();
  if (value === undefined) {
    throw new ThreadCapabilityError('missing context_window');
  }
  let contextWindow: number | undefined;
  if (value !== null) {
    contextWindow = parseContextWindow(value);
    if (contextWindow === undefined) {
      throw new ThreadCapabilityError('invalid context_window');
    }
  }
  try {
    await setModelPreference(config, { context: { contextWindow } });
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'set_context_window failed',
    );
  }
  session.peekQueryRunner()?.refreshRuntimeContext({ resetModelRouting: true });
}

/**
 * 设置当前模型的 thinking budget；`0` 表示关闭 thinking。
 *
 * 覆写写入当前模型的会话级 generation config（不落盘）。非数字抛
 * `invalid max_thinking_tokens`，不带 code。
 */
export async function setMaxThinkingTokens(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  maxThinkingTokens: number,
): Promise<void> {
  const config = session.requireConfig();
  if (typeof maxThinkingTokens !== 'number') {
    throw new ThreadCapabilityError('invalid max_thinking_tokens');
  }
  try {
    await setModelPreference(config, {
      reasoning: {
        thinking:
          maxThinkingTokens > 0
            ? { type: 'enabled', budgetTokens: maxThinkingTokens }
            : { type: 'disabled' },
      },
    });
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'set_max_thinking_tokens failed',
    );
  }
}
