/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMessageQueue } from './useMessageQueue.js';
import { StreamingState } from '../types.js';

describe('useMessageQueue', () => {
  let mockSubmitQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSubmitQuery = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should initialize with empty queue', () => {
    const { result } = renderHook(() =>
      useMessageQueue({
        isConfigInitialized: true,
        streamingState: StreamingState.Idle,
        submitQuery: mockSubmitQuery,
      }),
    );

    expect(result.current.messageQueue).toEqual([]);
    expect(result.current.getQueuedMessagesText()).toBe('');
  });

  it('should add messages to queue', () => {
    const { result } = renderHook(() =>
      useMessageQueue({
        isConfigInitialized: true,
        streamingState: StreamingState.Responding,
        submitQuery: mockSubmitQuery,
      }),
    );

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
    const { result } = renderHook(() =>
      useMessageQueue({
        isConfigInitialized: true,
        streamingState: StreamingState.Responding,
        submitQuery: mockSubmitQuery,
      }),
    );

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
    const { result } = renderHook(() =>
      useMessageQueue({
        isConfigInitialized: true,
        streamingState: StreamingState.Responding,
        submitQuery: mockSubmitQuery,
      }),
    );

    act(() => {
      result.current.addMessage('Test message');
    });

    expect(result.current.messageQueue).toEqual(['Test message']);

    act(() => {
      result.current.clearQueue();
    });

    expect(result.current.messageQueue).toEqual([]);
  });

  it('should return queued messages as text with double newlines', () => {
    const { result } = renderHook(() =>
      useMessageQueue({
        isConfigInitialized: true,
        streamingState: StreamingState.Responding,
        submitQuery: mockSubmitQuery,
      }),
    );

    act(() => {
      result.current.addMessage('Message 1');
      result.current.addMessage('Message 2');
      result.current.addMessage('Message 3');
    });

    expect(result.current.getQueuedMessagesText()).toBe(
      'Message 1\n\nMessage 2\n\nMessage 3',
    );
  });

  it('should pop all messages from queue', () => {
    const { result } = renderHook(() =>
      useMessageQueue({
        isConfigInitialized: true,
        streamingState: StreamingState.Responding,
        submitQuery: mockSubmitQuery,
      }),
    );

    act(() => {
      result.current.addMessage('Message 1');
      result.current.addMessage('Message 2');
      result.current.addMessage('Message 3');
    });

    let popped: string | null = null;
    act(() => {
      popped = result.current.popAllMessages();
    });

    expect(popped).toBe('Message 1\n\nMessage 2\n\nMessage 3');
    expect(result.current.messageQueue).toEqual([]);
  });

  it('should pop single message without separator', () => {
    const { result } = renderHook(() =>
      useMessageQueue({
        isConfigInitialized: true,
        streamingState: StreamingState.Responding,
        submitQuery: mockSubmitQuery,
      }),
    );

    act(() => {
      result.current.addMessage('Only message');
    });

    let popped: string | null = null;
    act(() => {
      popped = result.current.popAllMessages();
    });

    expect(popped).toBe('Only message');
    expect(result.current.messageQueue).toEqual([]);
  });

  it('should return null when popping from empty queue', () => {
    const { result } = renderHook(() =>
      useMessageQueue({
        isConfigInitialized: true,
        streamingState: StreamingState.Responding,
        submitQuery: mockSubmitQuery,
      }),
    );

    let popped: string | null = null;
    act(() => {
      popped = result.current.popAllMessages();
    });

    expect(popped).toBeNull();
    expect(result.current.messageQueue).toEqual([]);
  });

  describe('drainQueue (mid-turn drain for tool-result injection)', () => {
    it('returns an empty array when the queue is empty', () => {
      const { result } = renderHook(() =>
        useMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Responding,
          submitQuery: mockSubmitQuery,
        }),
      );

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });
      expect(drained).toEqual([]);
    });

    it('drains only leading plain-text messages and leaves slash commands queued', () => {
      const { result } = renderHook(() =>
        useMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Responding,
          submitQuery: mockSubmitQuery,
        }),
      );

      act(() => {
        result.current.addMessage('one');
        result.current.addMessage('two');
        result.current.addMessage('/model');
        result.current.addMessage('three');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });

      expect(drained).toEqual(['one', 'two']);
      expect(result.current.messageQueue).toEqual(['/model', 'three']);
    });

    it('drains nothing when a slash command leads the queue', () => {
      const { result } = renderHook(() =>
        useMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Responding,
          submitQuery: mockSubmitQuery,
        }),
      );

      act(() => {
        result.current.addMessage('/model');
        result.current.addMessage('hello');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });

      expect(drained).toEqual([]);
      expect(result.current.messageQueue).toEqual(['/model', 'hello']);
    });

    it('drains the whole queue when it contains no slash commands', () => {
      const { result } = renderHook(() =>
        useMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Responding,
          submitQuery: mockSubmitQuery,
        }),
      );

      act(() => {
        result.current.addMessage('a');
        result.current.addMessage('b');
        result.current.addMessage('c');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });

      expect(drained).toEqual(['a', 'b', 'c']);
      expect(result.current.messageQueue).toEqual([]);
    });
  });

  describe('popNextSegment', () => {
    it('returns null when the queue is empty', () => {
      const { result } = renderHook(() =>
        useMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Idle,
          submitQuery: mockSubmitQuery,
        }),
      );

      let segment: string | null = null;
      act(() => {
        segment = result.current.popNextSegment();
      });
      expect(segment).toBeNull();
    });

    it('batches leading plain-text messages into one segment', () => {
      const { result } = renderHook(() =>
        useMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Responding,
          submitQuery: mockSubmitQuery,
        }),
      );

      act(() => {
        result.current.addMessage('hello');
        result.current.addMessage('world');
      });

      let segment: string | null = null;
      act(() => {
        segment = result.current.popNextSegment();
      });
      expect(segment).toBe('hello\n\nworld');
      expect(result.current.messageQueue).toEqual([]);
    });

    it('stops batching at the first slash command and leaves it queued', () => {
      const { result } = renderHook(() =>
        useMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Responding,
          submitQuery: mockSubmitQuery,
        }),
      );

      act(() => {
        result.current.addMessage('hello');
        result.current.addMessage('world');
        result.current.addMessage('/model');
        result.current.addMessage('after');
      });

      let segment: string | null = null;
      act(() => {
        segment = result.current.popNextSegment();
      });
      expect(segment).toBe('hello\n\nworld');
      expect(result.current.messageQueue).toEqual(['/model', 'after']);
    });

    it('returns a slash command alone when it leads the queue', () => {
      const { result } = renderHook(() =>
        useMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Responding,
          submitQuery: mockSubmitQuery,
        }),
      );

      act(() => {
        result.current.addMessage('/model');
        result.current.addMessage('hello');
      });

      let segment: string | null = null;
      act(() => {
        segment = result.current.popNextSegment();
      });
      expect(segment).toBe('/model');
      expect(result.current.messageQueue).toEqual(['hello']);
    });

    it('drains segments one at a time across repeated calls', () => {
      const { result } = renderHook(() =>
        useMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Responding,
          submitQuery: mockSubmitQuery,
        }),
      );

      act(() => {
        result.current.addMessage('hello');
        result.current.addMessage('/model');
        result.current.addMessage('world');
      });

      const segments: Array<string | null> = [];
      act(() => {
        segments.push(result.current.popNextSegment());
      });
      act(() => {
        segments.push(result.current.popNextSegment());
      });
      act(() => {
        segments.push(result.current.popNextSegment());
      });
      act(() => {
        segments.push(result.current.popNextSegment());
      });

      expect(segments).toEqual(['hello', '/model', 'world', null]);
      expect(result.current.messageQueue).toEqual([]);
    });

    it('preserves remaining messages so popAllMessages can restore them after a cancel', () => {
      const { result } = renderHook(() =>
        useMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Responding,
          submitQuery: mockSubmitQuery,
        }),
      );

      act(() => {
        result.current.addMessage('hello');
        result.current.addMessage('/model');
        result.current.addMessage('after');
      });

      act(() => {
        result.current.popNextSegment();
      });
      expect(result.current.messageQueue).toEqual(['/model', 'after']);

      let popped: string | null = null;
      act(() => {
        popped = result.current.popAllMessages();
      });
      expect(popped).toBe('/model\n\nafter');
    });
  });
});
