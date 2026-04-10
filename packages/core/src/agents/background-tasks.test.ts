/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BackgroundTaskRegistry,
  BACKGROUND_NOTIFICATION_PREFIX,
  BACKGROUND_NOTIFICATION_SEPARATOR,
} from './background-tasks.js';

describe('BackgroundTaskRegistry', () => {
  let registry: BackgroundTaskRegistry;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
  });

  it('registers and retrieves a background agent', () => {
    const entry = {
      agentId: 'test-1',
      description: 'test agent',
      status: 'running' as const,
      startTime: Date.now(),
      abortController: new AbortController(),
    };

    registry.register(entry);
    expect(registry.get('test-1')).toBe(entry);
  });

  it('completes a background agent and sends notification', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });

    registry.complete('test-1', 'The result text');

    const entry = registry.get('test-1')!;
    expect(entry.status).toBe('completed');
    expect(entry.result).toBe('The result text');
    expect(entry.endTime).toBeDefined();
    expect(callback).toHaveBeenCalledOnce();
    const msg = callback.mock.calls[0][0] as string;
    expect(msg.startsWith(BACKGROUND_NOTIFICATION_PREFIX)).toBe(true);
    const body = msg.slice(BACKGROUND_NOTIFICATION_PREFIX.length);
    // Display part (before separator) should be a short summary
    const sepIdx = body.indexOf(BACKGROUND_NOTIFICATION_SEPARATOR);
    expect(sepIdx).toBeGreaterThan(0);
    const displayPart = body.slice(0, sepIdx);
    const modelPart = body.slice(
      sepIdx + BACKGROUND_NOTIFICATION_SEPARATOR.length,
    );
    expect(displayPart).toContain('completed');
    expect(displayPart).toContain('test agent');
    expect(displayPart).not.toContain('The result text');
    // Model part should include the result for the LLM
    expect(modelPart).toContain('The result text');
  });

  it('fails a background agent and sends notification', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });

    registry.fail('test-1', 'Something went wrong');

    const entry = registry.get('test-1')!;
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('Something went wrong');
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toContain('failed');
  });

  it('cancels a running background agent', () => {
    const abortController = new AbortController();

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController,
    });

    registry.cancel('test-1');

    expect(registry.get('test-1')!.status).toBe('cancelled');
    expect(abortController.signal.aborted).toBe(true);
  });

  it('does not cancel a non-running agent', () => {
    const abortController = new AbortController();

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController,
    });

    registry.complete('test-1', 'done');
    registry.cancel('test-1'); // should be a no-op

    expect(registry.get('test-1')!.status).toBe('completed');
    expect(abortController.signal.aborted).toBe(false);
  });

  it('lists running agents', () => {
    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });

    registry.complete('a', 'done');

    const running = registry.getRunning();
    expect(running).toHaveLength(1);
    expect(running[0].agentId).toBe('b');
  });

  it('finds agent by name', () => {
    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      name: 'my-agent',
    });

    expect(registry.findByName('my-agent')?.agentId).toBe('test-1');
    expect(registry.findByName('nonexistent')).toBeUndefined();
  });

  it('aborts all running agents', () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: ac1,
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: ac2,
    });

    registry.abortAll();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    expect(registry.get('a')!.status).toBe('cancelled');
    expect(registry.get('b')!.status).toBe('cancelled');
  });

  it('complete is a no-op after cancellation (state race guard)', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });

    registry.cancel('test-1');
    registry.complete('test-1', 'late result');

    // Status should remain 'cancelled', not flip to 'completed'
    expect(registry.get('test-1')!.status).toBe('cancelled');
    // No notification should have been sent
    expect(callback).not.toHaveBeenCalled();
  });

  it('fail is a no-op after cancellation (state race guard)', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });

    registry.cancel('test-1');
    registry.fail('test-1', 'late error');

    expect(registry.get('test-1')!.status).toBe('cancelled');
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not send notification without callback', () => {
    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });

    // Should not throw
    registry.complete('test-1', 'done');
    expect(registry.get('test-1')!.status).toBe('completed');
  });
});
