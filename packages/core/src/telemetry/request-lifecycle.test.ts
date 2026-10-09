/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { subagentIdentityContext } from '../utils/subagentNameContext.js';
import { startRequestLifecycle } from './request-lifecycle.js';

function fixture() {
  const recordUiTelemetryEvent = vi.fn();
  const notifyRequestLifecycle = vi.fn();
  const config = {
    getSessionId: () => 'owner',
    getChatRecordingService: () => ({ recordUiTelemetryEvent }),
    notifyRequestLifecycle,
  } as unknown as Config;
  return { config, recordUiTelemetryEvent, notifyRequestLifecycle };
}

describe('request lifecycle persistence', () => {
  it('retains the start owner after leaving subagent context and ends once', () => {
    const f = fixture();
    const request = subagentIdentityContext.run(
      { id: 'child', type: 'agent' },
      () => startRequestLifecycle(f.config, 'execution', 'prompt', 'model'),
    );
    request.finish('interrupted');
    request.finish('success');
    expect(f.recordUiTelemetryEvent).toHaveBeenCalledTimes(2);
    const events = f.notifyRequestLifecycle.mock.calls.map(([event]) => event);
    expect(events).toEqual([
      expect.objectContaining({
        phase: 'started',
        subagentId: 'child',
        sessionId: 'owner',
      }),
      expect.objectContaining({
        phase: 'ended',
        subagentId: 'child',
        outcome: 'interrupted',
        reason: 'consumer_closed',
      }),
    ]);
    expect(events[1].endedAt - events[0].startedAt).toBe(events[1].durationMs);
    expect(f.recordUiTelemetryEvent.mock.calls.map(([event]) => event)).toEqual(
      events.map((event) => ({ ...event, 'event.name': 'request_lifecycle' })),
    );
  });

  it('continues live delivery when recording fails', () => {
    const f = fixture();
    f.recordUiTelemetryEvent.mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    const request = startRequestLifecycle(
      f.config,
      'execution',
      'prompt',
      'model',
    );
    expect(() => request.finish('error')).not.toThrow();
    expect(f.notifyRequestLifecycle).toHaveBeenCalledTimes(2);
  });

  it('preserves recording when a live listener fails', () => {
    const f = fixture();
    f.notifyRequestLifecycle.mockImplementation(() => {
      throw new Error('listener failed');
    });
    const request = startRequestLifecycle(
      f.config,
      'execution',
      'prompt',
      'model',
    );
    expect(() => request.finish('success')).not.toThrow();
    expect(f.recordUiTelemetryEvent).toHaveBeenCalledTimes(2);
  });
});
