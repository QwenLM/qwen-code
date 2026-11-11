/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AGENTS.md 体积超限的瞬时状态桥：把 `AgentsMdSizeEvaluated` 通知成体积告警。
 * 门禁：init 之后、本会话、`notifyWarning` 不为 false、已越阈值且加载状态为
 * complete/partial；帧体字段是对宿主的 wire 契约。
 */

import { randomUUID } from 'node:crypto';
import {
  CoreEvent,
  coreEvents,
  type AgentsMdSizeEvaluatedPayload,
  type AgentsMdSizeSnapshot,
  type Config,
  type SDKAgentsMdSizeWarningMessage,
} from '@qwen-code/core';

export interface SessionAgentsMdSizeWarningBridge {
  /** Publish the current snapshot once the init frame has been emitted. */
  onInitialized(): void;
  dispose(): void;
}

export function installSessionAgentsMdSizeWarning(options: {
  readonly config: Config;
  readonly emit: (message: SDKAgentsMdSizeWarningMessage) => void;
}): SessionAgentsMdSizeWarningBridge {
  let initialized = false;

  const publish = (snapshot?: AgentsMdSizeSnapshot): void => {
    if (
      !snapshot?.thresholdReached ||
      (snapshot.loadStatus !== 'complete' && snapshot.loadStatus !== 'partial')
    ) {
      return;
    }
    options.emit({
      type: 'system',
      subtype: 'agents_md_size_warning',
      code: 'AGENTS_MD_SIZE_THRESHOLD_REACHED',
      severity: 'warning',
      total_bytes: snapshot.totalBytes,
      threshold_bytes: snapshot.thresholdBytes,
      threshold_source: snapshot.thresholdSource,
      files: snapshot.files.map(({ path, bytes }) => ({ path, bytes })),
      load_status: snapshot.loadStatus,
      truncated: false,
      uuid: randomUUID(),
      session_id: options.config.getSessionId(),
    });
  };

  const handle = (payload: AgentsMdSizeEvaluatedPayload): void => {
    if (
      initialized &&
      payload.sessionId === options.config.getSessionId() &&
      payload.notifyWarning !== false
    ) {
      publish(payload.snapshot);
    }
  };

  coreEvents.on(CoreEvent.AgentsMdSizeEvaluated, handle);

  return {
    onInitialized() {
      initialized = true;
      publish(
        options.config.getMemoryContextManager()?.getAgentsMdSizeSnapshot?.(),
      );
    },
    dispose() {
      coreEvents.off(CoreEvent.AgentsMdSizeEvaluated, handle);
    },
  };
}
