/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SDKArtifactInfo } from '@qwen-code/core';

/**
 * `resolve_session_artifacts`：向宿主请求本会话的产物清单，灌回 artifact 外部快照。
 *
 * 自带 10s 上界与会话中止信号；取消只通过 signal 表达。本模块不构造帧。
 */

import { runLogger, type Config } from '@qwen-code/core';
import type { ThreadHostRequests } from '../contract/hostContext.js';
import { parseResolveSessionArtifactsResponse } from '../../../session/artifacts/sdkArtifactResolver.js';
import type { HostArtifactRefresh } from '../../../session/artifacts/sessionArtifactRuntime.js';

/** 宿主解析产物的超时上界。 */
const SESSION_ARTIFACT_RESOLVE_TIMEOUT_MS = 10_000;

export interface SessionArtifactResolverParams {
  readonly config: Config;
  readonly sessionId: string;
  /** 宿主反向请求通道；由会话提供，新会话直接转发 host.requests.resolveSessionArtifacts。 */
  readonly resolveSessionArtifacts: ThreadHostRequests['resolveSessionArtifacts'];
  /** 会话级中止信号；会话关闭时把在途解析一起收掉。 */
  readonly sessionSignal: AbortSignal;
}

export function createHostArtifactRefresh(
  params: SessionArtifactResolverParams,
): HostArtifactRefresh {
  const { config, sessionId, resolveSessionArtifacts, sessionSignal } = params;

  return async (): Promise<readonly SDKArtifactInfo[]> => {
    // 「超时 ∪ 会话中止」合成一个控制器：abort 之后宿主把在途请求收成失败
    // （见文件头），本模块不需要、也拿不到任何 request_id。
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SESSION_ARTIFACT_RESOLVE_TIMEOUT_MS);
    timeout.unref?.();

    const abortForSession = () => controller.abort();
    if (sessionSignal.aborted) {
      abortForSession();
    } else {
      sessionSignal.addEventListener('abort', abortForSession, { once: true });
    }

    try {
      const response = await resolveSessionArtifacts(
        { localSessionId: sessionId, cwd: config.getWorkingDir() },
        { signal: controller.signal },
      );
      return parseResolveSessionArtifactsResponse(response);
    } catch (error) {
      if (timedOut) {
        throw new Error(
          `resolve_session_artifacts timed out after ${SESSION_ARTIFACT_RESOLVE_TIMEOUT_MS}ms`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      sessionSignal.removeEventListener('abort', abortForSession);
      runLogger.debug('[thread-session] resolve_session_artifacts settled', {
        sessionId,
        timedOut,
      });
    }
  };
}
