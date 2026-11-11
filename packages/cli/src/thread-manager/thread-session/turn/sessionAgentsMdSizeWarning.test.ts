/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoreEvent,
  coreEvents,
  type AgentsMdSizeSnapshot,
  type Config,
} from '@qwen-code/core';
import {
  installSessionAgentsMdSizeWarning,
  type SessionAgentsMdSizeWarningBridge,
} from './sessionAgentsMdSizeWarning.js';

const SESSION_ID = 'session-agents-md-size';
const bridges: SessionAgentsMdSizeWarningBridge[] = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
});

function snapshot(
  overrides: Partial<AgentsMdSizeSnapshot> = {},
): AgentsMdSizeSnapshot {
  return {
    files: [{ path: '/project/AGENTS.md', bytes: 120, depth: 0 }],
    totalBytes: 120,
    measuredAt: 1,
    loadStatus: 'complete',
    readErrorCount: 0,
    thresholdBytes: 100,
    thresholdSource: 'default',
    thresholdReached: true,
    reason: 'startup',
    ...overrides,
  };
}

function install(current = snapshot()) {
  const emit = vi.fn();
  const config = {
    getSessionId: () => SESSION_ID,
    getMemoryContextManager: () => ({
      getAgentsMdSizeSnapshot: () => current,
    }),
  } as unknown as Config;
  const bridge = installSessionAgentsMdSizeWarning({ config, emit });
  bridges.push(bridge);
  return { bridge, emit };
}

describe('session AGENTS.md size warning bridge', () => {
  it('init 后发布超限快照，字段与 worker 一致', () => {
    const { bridge, emit } = install();

    expect(emit).not.toHaveBeenCalled();
    bridge.onInitialized();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      type: 'system',
      subtype: 'agents_md_size_warning',
      code: 'AGENTS_MD_SIZE_THRESHOLD_REACHED',
      severity: 'warning',
      total_bytes: 120,
      threshold_bytes: 100,
      threshold_source: 'default',
      files: [{ path: '/project/AGENTS.md', bytes: 120 }],
      load_status: 'complete',
      truncated: false,
      session_id: SESSION_ID,
    });
  });

  it('init 前、跨会话、notifyWarning=false 与未超限均不发布', () => {
    const { bridge, emit } = install();

    coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
      sessionId: SESSION_ID,
      snapshot: snapshot(),
    });
    expect(emit).not.toHaveBeenCalled();

    bridge.onInitialized();
    emit.mockClear();

    coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
      sessionId: 'other-session',
      snapshot: snapshot(),
    });
    coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
      sessionId: SESSION_ID,
      snapshot: snapshot(),
      notifyWarning: false,
    });
    coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
      sessionId: SESSION_ID,
      snapshot: snapshot({ thresholdReached: false }),
    });
    coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
      sessionId: SESSION_ID,
      snapshot: snapshot({ loadStatus: 'blocked' }),
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('init 后收到本会话评估事件会再次发布', () => {
    const { bridge, emit } = install();

    bridge.onInitialized();
    emit.mockClear();
    coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
      sessionId: SESSION_ID,
      snapshot: snapshot({ totalBytes: 200 }),
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ total_bytes: 200 });
  });
});
