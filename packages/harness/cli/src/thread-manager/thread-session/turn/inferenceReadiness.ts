/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 推理面就绪：先由宿主准备身份，再由宿主完成会话 Config 的推理绑定与模型目录归一。
 * ThreadManager 只负责去重与会话时序；凭据、端点、模型归一都是宿主逻辑，经
 * `ThreadHostRequests.ensureAuthReady` / `prepareInference` 注入；基础 ACP 不需要
 * 认证时两者都可省略。
 */

import { runLogger, type AuthType, type Config } from '@qwen-code/core';
import type { LoadedSettings } from '../../../config/settings.js';
import type { ThreadInferencePreparation } from '../contract/hostContext.js';
import type { SessionPhaseLog } from '../phase-log/sessionPhaseLog.js';

export interface InferenceReadinessContext {
  readonly sessionId: string;
  /** 会话级中止信号；宿主准备挂它，会话关闭时立刻收手。 */
  readonly signal: AbortSignal;
  /** 宿主提供的身份准备入口。 */
  readonly ensureAuthReady?: () => Promise<void>;
  /** 宿主提供的推理准备入口：refreshAuth、模型目录与归一都由宿主完成。 */
  readonly prepareInference?: (
    input: ThreadInferencePreparation,
  ) => Promise<void>;
  /** 宿主已确立的认证类型；缺省从会话 settings 推导后交给宿主。 */
  readonly authType?: AuthType;
  /** Config 在 `start()` 之后才存在，因此用 getter 读当前值。 */
  readonly getConfig: () => Config;
  readonly getSettings: () => LoadedSettings;
  /** Host 是否声明了 catalog-ready initialize。 */
  readonly isCatalogReadyInitializeEnabled: () => boolean;
  readonly getPhaseLog: () => SessionPhaseLog;
}

export interface InferenceReadiness {
  /**
   * 幂等：initialize 与首轮 prompt 可能并发触达，合并成一次；失败时清空记账以便重试。
   */
  ensure(): Promise<void>;
}

export function createInferenceReadiness(
  context: InferenceReadinessContext,
): InferenceReadiness {
  const { sessionId, signal, getConfig, getSettings } = context;
  let readyPromise: Promise<void> | null = null;

  async function ready(): Promise<void> {
    const phaseLog = context.getPhaseLog();

    await phaseLog.phase(
      '身份准备',
      '宿主负责凭据来源与按需落地；ThreadManager 只等待结算',
      async () => {
        await context.ensureAuthReady?.();
      },
    );

    const prepareInference = context.prepareInference;
    if (prepareInference) {
      await phaseLog.phase(
        '推理就绪',
        '宿主刷新会话 Config 的推理身份、等待模型目录并归一模型',
        () =>
          prepareInference({
            config: getConfig(),
            selectedAuthType:
              context.authType ??
              getSettings().merged.security.auth.selectedType,
            catalogReadyInitialize: context.isCatalogReadyInitializeEnabled(),
            signal,
          }),
      );
    } else {
      runLogger.debug(
        '[thread-session] host did not provide inference preparation; continuing without it',
        { sessionId },
      );
    }
  }

  return {
    async ensure(): Promise<void> {
      readyPromise ??= ready().catch((error) => {
        readyPromise = null;
        throw error;
      });
      await readyPromise;
    },
  };
}
