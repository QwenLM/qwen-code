/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 自动压缩的瞬时状态桥：把 `CompressionProgress` 通知成压缩中 / 清除状态。
 * 只处理本会话、`target: 'main'` 的非 manual 压缩；manual 归命令链，避免两套状态源。
 */

import { randomUUID } from 'node:crypto';
import {
  CoreEvent,
  coreEvents,
  projectCompactUsageForSdk,
  type CompressionProgressPayload,
  type SDKMessage,
  type SDKStatus,
} from '@qwen-code/core';
import { buildCompactionStatusMessage } from './compactWireFrames.js';

export interface SessionCompressionStatusBridge {
  /** Clear a running status when a turn terminates without a terminal progress event. */
  clear(): void;
  dispose(): void;
}

export function installSessionCompressionStatusBridge(options: {
  readonly sessionId: string;
  readonly emit: (message: SDKMessage) => void;
}): SessionCompressionStatusBridge {
  let running = false;

  const emitStatus = (status: SDKStatus): void => {
    options.emit(buildCompactionStatusMessage(options.sessionId, status));
  };

  const clear = (): void => {
    if (!running) return;
    running = false;
    emitStatus(null);
  };

  const handleProgress = (payload: CompressionProgressPayload): void => {
    if (
      payload.sessionId !== options.sessionId ||
      payload.target !== 'main' ||
      payload.trigger === 'manual'
    ) {
      return;
    }

    if (payload.stage === 'starting') {
      if (running) return;
      running = true;
      emitStatus('compacting');
      return;
    }

    if (payload.stage === 'done' || payload.stage === 'failed') {
      clear();
    }
  };

  coreEvents.on(CoreEvent.CompressionProgress, handleProgress);
  // Failed compression usage also covers manual and subagent requests.
  const unsubscribeUsage = coreEvents.onSessionEvent(
    CoreEvent.CompressionUsage,
    options.sessionId,
    (payload) =>
      options.emit({
        type: 'system',
        subtype: 'status',
        status: null,
        usage: projectCompactUsageForSdk(payload.usage),
        modelRequestIds: payload.modelRequestIds,
        ...(payload.agentId ? { agent_id: payload.agentId } : {}),
        uuid: randomUUID(),
        session_id: options.sessionId,
      }),
  );

  return {
    clear,
    dispose: () => {
      unsubscribeUsage();
      coreEvents.off(CoreEvent.CompressionProgress, handleProgress);
      clear();
    },
  };
}
