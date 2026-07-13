/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { GenerateContentResponse } from '@google/genai';
import { setToolCallPreparations } from '@qwen-code/qwen-code-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallEmitter } from './emitters/tool-call-emitter.js';
import { ToolCallPreparationTracker } from './tool-call-preparation-tracker.js';

describe('ToolCallPreparationTracker', () => {
  let emitStart: ReturnType<typeof vi.fn>;
  let emitPreparationDiscarded: ReturnType<typeof vi.fn>;
  let emitter: ToolCallEmitter;

  beforeEach(() => {
    emitStart = vi.fn().mockResolvedValue(true);
    emitPreparationDiscarded = vi.fn().mockResolvedValue(undefined);
    emitter = {
      emitStart,
      emitPreparationDiscarded,
    } as unknown as ToolCallEmitter;
  });

  it('emits a preparation once and does not discard it after resolution', async () => {
    const tracker = new ToolCallPreparationTracker(emitter);
    const response = new GenerateContentResponse();
    setToolCallPreparations(response, [
      { callId: 'call-1', toolName: 'read_file' },
    ]);

    await tracker.observe(response);
    await tracker.observe(response);

    expect(emitStart).toHaveBeenCalledTimes(1);
    expect(emitStart).toHaveBeenCalledWith({
      callId: 'call-1',
      toolName: 'read_file',
      args: {},
      status: 'pending',
      phase: 'preparing',
    });

    tracker.resolve([
      { id: 'call-1', name: 'read_file', args: { file_path: 'a.sql' } },
    ]);
    await tracker.discard();

    expect(emitPreparationDiscarded).not.toHaveBeenCalled();
  });

  it('discards every unresolved preparation exactly once', async () => {
    const tracker = new ToolCallPreparationTracker(emitter);
    const response = new GenerateContentResponse();
    setToolCallPreparations(response, [
      { callId: 'call-1', toolName: 'read_file' },
      { callId: 'call-2', toolName: 'shell' },
    ]);

    await tracker.observe(response);
    await tracker.discard();
    await tracker.discard();

    expect(emitPreparationDiscarded.mock.calls).toEqual([
      ['call-1', 'read_file'],
      ['call-2', 'shell'],
    ]);
  });

  it('discards a resolved preparation when the stream attempt is abandoned', async () => {
    const tracker = new ToolCallPreparationTracker(emitter);
    const response = new GenerateContentResponse();
    setToolCallPreparations(response, [
      { callId: 'call-1', toolName: 'read_file' },
    ]);

    await tracker.observe(response);
    tracker.resolve([
      { id: 'call-1', name: 'read_file', args: { file_path: 'a.sql' } },
    ]);
    await tracker.discard(true);

    expect(emitPreparationDiscarded).toHaveBeenCalledOnce();
    expect(emitPreparationDiscarded).toHaveBeenCalledWith(
      'call-1',
      'read_file',
    );
  });

  it('attempts every unresolved discard before surfacing the first cleanup error', async () => {
    const cleanupError = new Error('first discard failed');
    emitPreparationDiscarded
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValueOnce(undefined);
    const tracker = new ToolCallPreparationTracker(emitter);
    const response = new GenerateContentResponse();
    setToolCallPreparations(response, [
      { callId: 'call-1', toolName: 'read_file' },
      { callId: 'call-2', toolName: 'shell' },
    ]);

    await tracker.observe(response);

    await expect(tracker.discard()).rejects.toBe(cleanupError);
    expect(emitPreparationDiscarded.mock.calls).toEqual([
      ['call-1', 'read_file'],
      ['call-2', 'shell'],
    ]);
    await tracker.discard();
    expect(emitPreparationDiscarded).toHaveBeenCalledTimes(2);
  });

  it('does not retry a preparation when the emitter suppresses its start', async () => {
    emitStart.mockResolvedValue(false);
    const tracker = new ToolCallPreparationTracker(emitter);
    const response = new GenerateContentResponse();
    setToolCallPreparations(response, [
      { callId: 'todo-1', toolName: 'TodoWrite' },
    ]);

    await tracker.observe(response);
    await tracker.observe(response);
    await tracker.discard();

    expect(emitStart).toHaveBeenCalledTimes(1);
    expect(emitPreparationDiscarded).not.toHaveBeenCalled();
  });
});
