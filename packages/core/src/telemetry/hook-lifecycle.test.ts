/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { HookType, HookEventName } from '../hooks/types.js';
import { startHookLifecycle } from './hook-lifecycle.js';

const owner = {
  runtimeId: 'runtime',
  sessionId: 'session',
  agentId: null,
  historyPromptId: 'turn',
};
const hook = {
  type: HookType.Command as const,
  command: 'SECRET_COMMAND',
  env: { TOKEN: 'SECRET_ENV' },
};
const result = {
  hookConfig: hook,
  eventName: HookEventName.Stop,
  success: true,
  duration: 10,
};

describe('hook lifecycle recording', () => {
  function fixture() {
    const recordUiTelemetryEvent = vi.fn();
    const config = {
      getSessionId: () => 'session',
      getChatRecordingService: () => ({ recordUiTelemetryEvent }),
    } as unknown as Config;
    return { config, recordUiTelemetryEvent };
  }
  it('captures safe immutable identity and records only one terminal', () => {
    const { config, recordUiTelemetryEvent } = fixture();
    const lifecycle = startHookLifecycle(
      config,
      owner,
      'Stop',
      hook,
      0,
      'project',
    )!;
    expect(lifecycle.started).toMatchObject({
      promptId: 'turn',
      name: 'command #1',
      phase: 'started',
      source: 'project',
    });
    expect(lifecycle.finish(result, 'success')).toMatchObject({
      executionId: lifecycle.started.executionId,
      phase: 'ended',
      durationMs: 10,
    });
    expect(lifecycle.finish(result, 'success')).toBeUndefined();
    expect(recordUiTelemetryEvent).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(recordUiTelemetryEvent.mock.calls)).not.toContain(
      'SECRET',
    );
  });
  it('uses the captured recorder after config changes and reports dispatch separately', () => {
    const { config, recordUiTelemetryEvent } = fixture();
    const lifecycle = startHookLifecycle(
      config,
      owner,
      'Stop',
      hook,
      0,
      'user',
    )!;
    config.getChatRecordingService = () => {
      throw new Error('new recorder');
    };
    expect(
      lifecycle.finish({ ...result, duration: 0, isAsync: true }, 'success'),
    ).toMatchObject({ phase: 'dispatched' });
    expect(recordUiTelemetryEvent).toHaveBeenCalledTimes(2);
    expect(recordUiTelemetryEvent.mock.calls[1]?.[0]).not.toHaveProperty(
      'durationMs',
    );
  });
  it('records a refused async handoff as an error rather than dispatch', () => {
    const { config } = fixture();
    const lifecycle = startHookLifecycle(
      config,
      owner,
      'Stop',
      hook,
      0,
      'user',
    )!;
    expect(
      lifecycle.finish({ ...result, isAsync: true, success: false }, 'error'),
    ).toMatchObject({
      phase: 'ended',
      outcome: 'error',
      durationMs: 10,
    });
  });
  it('excludes unowned, child and session lifecycle executions', () => {
    const { config, recordUiTelemetryEvent } = fixture();
    expect(
      startHookLifecycle(
        config,
        { ...owner, historyPromptId: undefined },
        'Stop',
        hook,
        0,
        'user',
      ),
    ).toBeUndefined();
    expect(
      startHookLifecycle(
        config,
        { ...owner, agentId: 'child' },
        'Stop',
        hook,
        0,
        'user',
      ),
    ).toBeUndefined();
    expect(
      startHookLifecycle(config, owner, 'SessionStart', hook, 0, 'user'),
    ).toBeUndefined();
    expect(recordUiTelemetryEvent).not.toHaveBeenCalled();
  });
  it('does not throw when recording fails', () => {
    const { config, recordUiTelemetryEvent } = fixture();
    recordUiTelemetryEvent.mockImplementation(() => {
      throw new Error('disk failed');
    });
    const lifecycle = startHookLifecycle(
      config,
      owner,
      'Stop',
      hook,
      0,
      'user',
    )!;
    expect(() => lifecycle.finish(result, 'error')).not.toThrow();
  });
});
