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
    expect(result.current.getQueuedMessagesText()).toBe('');
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

  it('should return queued messages as text with double newlines', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.addMessage('Message 1');
      result.current.addMessage('Message 2');
      result.current.addMessage('Message 3');
    });

    expect(result.current.getQueuedMessagesText()).toBe(
      'Message 1\n\nMessage 2\n\nMessage 3',
    );
  });

  describe('popAllMessages (cancel and ESC/Up restore)', () => {
    it('returns null when the queue is empty', () => {
      const { result } = renderHook(() => useMessageQueue());

      let popped: string | null = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toBeNull();
      expect(result.current.messageQueue).toEqual([]);
    });

    it('joins all queued messages with double newlines and clears the queue', () => {
      const { result } = renderHook(() => useMessageQueue());

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

    it('returns a single message without separator', () => {
      const { result } = renderHook(() => useMessageQueue());

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

    it('joins mixed slash commands and prompts in original order', () => {
      // Edit-restore intentionally collapses segment boundaries: the user is
      // recovering input into the buffer to edit before resubmitting, so
      // typing order matters more than slash-vs-prompt routing boundaries.
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('/model');
        result.current.addMessage('hello');
        result.current.addMessage('world');
      });

      let popped: string | null = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toBe('/model\n\nhello\n\nworld');
      expect(result.current.messageQueue).toEqual([]);
    });
  });

  describe('drainQueue (mid-turn drain for tool-result injection)', () => {
    it('returns an empty array when the queue is empty', () => {
      const { result } = renderHook(() => useMessageQueue());

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });
      expect(drained).toEqual([]);
    });

    it('drains all plain-text messages and leaves slash commands queued', () => {
      const { result } = renderHook(() => useMessageQueue());

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

      expect(drained).toEqual(['one', 'two', 'three']);
      expect(result.current.messageQueue).toEqual(['/model']);
    });

    it('returns an empty array when the queue contains only slash commands', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('/model');
        result.current.addMessage('/help');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });

      expect(drained).toEqual([]);
      expect(result.current.messageQueue).toEqual(['/model', '/help']);
    });

    it('drains the whole queue when it contains no slash commands', () => {
      const { result } = renderHook(() => useMessageQueue());

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
      const { result } = renderHook(() => useMessageQueue());

      let segment: string | null = null;
      act(() => {
        segment = result.current.popNextSegment();
      });
      expect(segment).toBeNull();
    });

    it('pops the first item and leaves the rest queued', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('/model');
        result.current.addMessage('/help');
      });

      let segment: string | null = null;
      act(() => {
        segment = result.current.popNextSegment();
      });
      expect(segment).toBe('/model');
      expect(result.current.messageQueue).toEqual(['/help']);
    });

    it('drains the queue one item at a time across repeated calls', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('/model');
        result.current.addMessage('/theme');
        result.current.addMessage('/help');
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

      expect(segments).toEqual(['/model', '/theme', '/help', null]);
      expect(result.current.messageQueue).toEqual([]);
    });
  });
});
