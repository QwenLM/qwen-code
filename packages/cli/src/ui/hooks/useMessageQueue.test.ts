/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMessageQueue } from './useMessageQueue.js';

describe('useMessageQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should initialize with empty queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    expect(result.current.messageQueue).toEqual([]);
  });

  it('should add messages to queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.addMessage('Test message 1');
      result.current.addMessage('Test message 2');
    });

    expect(result.current.messageQueue).toEqual([
      'Test message 1',
      'Test message 2',
    ]);
  });

  it('should filter out empty messages', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.addMessage('Valid message');
      result.current.addMessage('   '); // Only whitespace
      result.current.addMessage(''); // Empty
      result.current.addMessage('Another valid message');
    });

    expect(result.current.messageQueue).toEqual([
      'Valid message',
      'Another valid message',
    ]);
  });

  it('should clear queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.addMessage('Test message');
    });

    expect(result.current.messageQueue).toEqual(['Test message']);

    act(() => {
      result.current.clearQueue();
    });

    expect(result.current.messageQueue).toEqual([]);
  });

  it('should pop the last message from queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.addMessage('First');
      result.current.addMessage('Second');
      result.current.addMessage('Third');
    });

    let popped: string | undefined;
    act(() => {
      popped = result.current.popLast();
    });

    expect(popped).toBe('Third');
    expect(result.current.messageQueue).toEqual(['First', 'Second']);
  });

  it('should return undefined when popping from empty queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    let popped: string | undefined;
    act(() => {
      popped = result.current.popLast();
    });

    expect(popped).toBeUndefined();
    expect(result.current.messageQueue).toEqual([]);
  });

  it('should drain all messages and clear queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.addMessage('Message 1');
      result.current.addMessage('Message 2');
      result.current.addMessage('Message 3');
    });

    let drained: string[] = [];
    act(() => {
      drained = result.current.drain();
    });

    expect(drained).toEqual(['Message 1', 'Message 2', 'Message 3']);
    expect(result.current.messageQueue).toEqual([]);
  });

  it('should return empty array when draining empty queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    let drained: string[] = [];
    act(() => {
      drained = result.current.drain();
    });

    expect(drained).toEqual([]);
    expect(result.current.messageQueue).toEqual([]);
  });

  it('should allow adding after drain', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.addMessage('Before drain');
    });

    act(() => {
      result.current.drain();
    });

    act(() => {
      result.current.addMessage('After drain');
    });

    expect(result.current.messageQueue).toEqual(['After drain']);
  });
});
