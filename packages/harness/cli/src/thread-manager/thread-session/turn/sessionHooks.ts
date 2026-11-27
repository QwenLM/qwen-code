/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SessionStart / SessionEnd hook 的会话级触发与一次性记账。
 *
 * `attempted` 与 `succeeded` 必须分开：SessionStart 只跑一次，失败也算尝试过，
 * 重试会把企业安全 hook 重复执行。
 */

import {
  flushPendingAsyncRewakeHooks,
  HookEventName,
  SessionEndReason,
  SessionStartSource,
  runLogger,
  isResumeReadError,
  type Config,
} from '@qwen-code/core';
import type { SessionQueryRunner } from '../query/sessionQueryRunner.js';

export interface SessionHooksContext {
  readonly sessionId: string;
  /** 会话级中止信号。hook 在途时会话被关掉，靠它判定要不要继续记账。 */
  readonly signal: AbortSignal;
  readonly isTerminated: () => boolean;
  /** Config 在 `start()` 之后才存在；未装配时回 undefined。 */
  readonly getConfig: () => Config | undefined;
  /** 当前已装配的 runner；懒建，未建时回 null。不触发装配。 */
  readonly peekQueryRunner: () => SessionQueryRunner | null;
  /**
   * 触发 runner 装配；SessionStart 之前必须先建好，失败由调用方吞掉并 warn。
   */
  readonly ensureQueryRunner: () => Promise<SessionQueryRunner>;
  /**
   * resume 会话用 Resume、新会话用 Startup；本会话的 resume 信号是 `resumeTranscriptPath`。
   */
  readonly isResume: () => boolean;
}

export interface SessionHooks {
  /** 确保 runner 已装配，然后跑一次 SessionStart hook（一次性）。 */
  ensureStart(): Promise<void>;
  /** 按会话补一次 SessionEnd。 */
  fireEnd(): Promise<void>;
  /** Cancel an in-flight startup hook without aborting SessionEnd or later turns. */
  cancelStart(): void;
}

export function createSessionHooks(context: SessionHooksContext): SessionHooks {
  const { sessionId, isTerminated } = context;
  const startupAbort = new AbortController();
  const signal = AbortSignal.any([context.signal, startupAbort.signal]);
  /**
   * SessionStart 的一次性记账：失败也算尝试过——只跑一次，重试会重复执行 hook。
   */
  let startPromise: Promise<void> | null = null;
  let attempted = false;
  let succeeded = false;

  /**
   * 确保 runner 已装配，然后跑一次 SessionStart hook（一次性）。
   *
   * runner 必须先建好：缺 runner 时若进入尝试会烧掉这一次机会，additionalContext 永远
   * 进不了模型上下文。装配失败只 warn 不抛，让首个 turn 用既有错误出口报。
   */
  async function ensureStart(): Promise<void> {
    await context.ensureQueryRunner().catch((error) => {
      // 恢复失败由会话 owner 记为 opening 终态，不可降为普通 hook 预热告警。
      if (isResumeReadError(error)) throw error;
      runLogger.warn(
        '[thread-session] runner build failed before SessionStart hooks',
        { sessionId, error },
      );
    });
    if (isTerminated() || signal.aborted || succeeded || attempted) return;

    const config = context.getConfig();
    const hookSystem = config?.getHookSystem();
    const runner = context.peekQueryRunner();
    // 判空在 promise 之前而不是之内：缺任一个就直接返回，不烧尝试次数（理由见上）。
    if (!config || !hookSystem || !runner) return;

    startPromise ??= (async () => {
      let completedAttempt = false;
      const source = context.isResume()
        ? SessionStartSource.Resume
        : SessionStartSource.Startup;
      try {
        runLogger.log('[thread-session] SessionStart hook firing', {
          sessionId,
          source,
        });
        const result = await hookSystem.fireSessionStartEvent(
          source,
          config.getModel(),
          signal,
        );
        if (isTerminated() || signal.aborted) return;
        completedAttempt = true;
        // hook 上下文直接进 runner 队列，不与用户输入文本混在一起。
        const additionalContext = result?.getAdditionalContext();
        if (additionalContext) {
          runner.queueHookOutput(
            HookEventName.SessionStart,
            additionalContext,
            undefined,
            { sourceType: 'additionalContext' },
          );
        }
        const stdoutForModel = result?.getStdoutForModel(
          HookEventName.SessionStart,
        );
        if (stdoutForModel && !result?.suppressOutput) {
          runner.queueHookOutput(
            HookEventName.SessionStart,
            stdoutForModel,
            undefined,
            { sourceType: 'stdout' },
          );
        }
        succeeded = true;
        runLogger.log('[thread-session] SessionStart hook completed', {
          sessionId,
          source,
          // hook 输出正文刻意不打，只记有没有排队进 runner。
          queuedAdditionalContext: additionalContext !== undefined,
          queuedStdout: stdoutForModel !== undefined,
        });
      } catch (error) {
        if (isTerminated() || signal.aborted) return;
        completedAttempt = true;
        runLogger.warn('[thread-session] SessionStart hook execution failed', {
          sessionId,
          error,
        });
      } finally {
        if (completedAttempt) {
          attempted = true;
        } else if (!succeeded && signal.aborted) {
          attempted = true;
        } else if (!succeeded) {
          // 既没跑成也没被中止：清空 memo，下一次调用还能再试。
          startPromise = null;
        }
      }
    })();
    await startPromise;
  }

  /**
   * SessionEnd hook：按会话补发一次（reason 取 Other），先等 core 的在途异步 rewake hook
   * （4s 上界、只 await 不改状态）。fireEnd 跑在 SessionEnd 收尾窗口内，窗口期间
   * hook_callback 与 hook_started / hook_response 照常上 wire，宿主才能看到触发。
   */
  async function fireEnd(): Promise<void> {
    const hookSystem = context.getConfig()?.getHookSystem();
    if (!hookSystem) return;
    try {
      runLogger.log('[thread-session] SessionEnd hook firing', { sessionId });
      await flushPendingAsyncRewakeHooks();
      await hookSystem.fireSessionEndEvent(SessionEndReason.Other);
      runLogger.log('[thread-session] SessionEnd hook completed', {
        sessionId,
      });
    } catch (error) {
      runLogger.warn('[thread-session] SessionEnd hook execution failed', {
        sessionId,
        error,
      });
    }
  }

  return {
    ensureStart,
    fireEnd,
    cancelStart: () => {
      if (startPromise && !succeeded) startupAbort.abort();
    },
  };
}
