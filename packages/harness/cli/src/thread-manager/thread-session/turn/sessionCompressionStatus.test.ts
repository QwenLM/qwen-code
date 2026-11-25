/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  coreEvents,
  CoreEvent,
  cloneUsage,
  SDKMessageSchema,
  ENV_EXPOSE_TOKEN_USAGE,
  type CompressionProgressPayload,
} from '@qwen-code/core';
import {
  installSessionCompressionStatusBridge,
  type SessionCompressionStatusBridge,
} from './sessionCompressionStatus.js';

const SESSION_ID = 'session-compression-status';
const bridges: SessionCompressionStatusBridge[] = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  vi.unstubAllEnvs();
});

function progress(
  overrides: Partial<CompressionProgressPayload> = {},
): CompressionProgressPayload {
  return {
    stage: 'starting',
    trigger: 'auto',
    sessionId: SESSION_ID,
    sessionScopeId: SESSION_ID,
    target: 'main',
    tokensBeforeCompact: 100,
    ...overrides,
  };
}

function install() {
  const emit = vi.fn();
  const bridge = installSessionCompressionStatusBridge({
    sessionId: SESSION_ID,
    emit,
  });
  bridges.push(bridge);
  return { bridge, emit };
}

describe('session compression status bridge', () => {
  it('仅透出本会话压缩比例和费用，并在释放后停止透出', () => {
    vi.stubEnv(ENV_EXPOSE_TOKEN_USAGE, 'false');
    const { emit, bridge } = install();
    const payload = {
      sessionId: SESSION_ID,
      usage: { ...cloneUsage(), input_tokens: 100, context_usage_ratio: 0.2, credits: 0 },
      modelRequestIds: ['failed-request'],
    };
    coreEvents.emit(CoreEvent.CompressionUsage, {
      ...payload,
      sessionId: 'other',
    });
    coreEvents.emit(CoreEvent.CompressionUsage, payload);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(SDKMessageSchema().parse(emit.mock.calls[0][0])).toMatchObject({
      type: 'system',
      subtype: 'status',
      status: null,
      session_id: SESSION_ID,
      usage: { context_usage_ratio: 0.2, credits: 0 },
      modelRequestIds: ['failed-request'],
    });
    expect(emit.mock.calls[0][0].usage).toEqual({ context_usage_ratio: 0.2, credits: 0 });
    bridge.dispose();
    coreEvents.emit(CoreEvent.CompressionUsage, payload);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('自动压缩 starting/done 投影成 compacting/null', () => {
    const { emit } = install();

    coreEvents.emitCompressionProgress(progress());
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      session_id: SESSION_ID,
    });

    coreEvents.emitCompressionProgress(progress({ stage: 'summarizing' }));
    coreEvents.emitCompressionProgress(progress({ stage: 'post_processing' }));
    expect(emit).toHaveBeenCalledTimes(1);

    coreEvents.emitCompressionProgress(
      progress({ stage: 'done', tokensAfterCompact: 40 }),
    );
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]?.[0]).toMatchObject({
      type: 'system',
      subtype: 'status',
      status: null,
      session_id: SESSION_ID,
    });
  });

  it('忽略 manual、子 Agent 与其他会话的进度', () => {
    const { emit } = install();

    coreEvents.emitCompressionProgress(progress({ trigger: 'manual' }));
    coreEvents.emitCompressionProgress(progress({ target: 'subagent' }));
    coreEvents.emitCompressionProgress(
      progress({ sessionId: 'other-session', sessionScopeId: 'other-session' }),
    );

    expect(emit).not.toHaveBeenCalled();
  });

  it('failed 与 clear 都清掉运行状态，重复 clear 不重复发帧', () => {
    const { emit, bridge } = install();

    coreEvents.emitCompressionProgress(progress());
    coreEvents.emitCompressionProgress(progress());
    expect(emit).toHaveBeenCalledTimes(1);

    coreEvents.emitCompressionProgress(
      progress({ stage: 'failed', failureReason: 'summary empty' }),
    );
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]?.[0]).toMatchObject({ status: null });

    bridge.clear();
    expect(emit).toHaveBeenCalledTimes(2);

    coreEvents.emitCompressionProgress(progress());
    expect(emit).toHaveBeenCalledTimes(3);
    bridge.dispose();
    expect(emit).toHaveBeenCalledTimes(4);
    expect(emit.mock.calls[3]?.[0]).toMatchObject({ status: null });

    coreEvents.emitCompressionProgress(progress());
    expect(emit).toHaveBeenCalledTimes(4);
  });
});
