/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMessageQueue, type QueuedSubmission } from './useMessageQueue.js';

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

      let popped: QueuedSubmission | null = null;
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

      let popped: QueuedSubmission | null = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toEqual({
        modelText: 'Message 1\n\nMessage 2\n\nMessage 3',
      });
      expect(result.current.messageQueue).toEqual([]);
    });

    it('returns a single message without separator', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('Only message');
      });

      let popped: QueuedSubmission | null = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toEqual({ modelText: 'Only message' });
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

      let popped: QueuedSubmission | null = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toEqual({
        modelText: '/model\n\nhello\n\nworld',
      });
      expect(result.current.messageQueue).toEqual([]);
    });

    it('aggregates provenance only when every queued message has it', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('model one', false, 'user one');
        result.current.addMessage('model two', false, 'user two');
      });

      let popped: QueuedSubmission | null = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toEqual({
        modelText: 'model one\n\nmodel two',
        submittedPrompt: 'user one\n\nuser two',
      });
    });

    it('omits aggregate provenance when any queued message lacks it', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('model one', false, 'user one');
        result.current.addMessage('restored steer');
      });

      let popped: QueuedSubmission | null = null;
      act(() => {
        popped = result.current.popAllMessages();
      });

      expect(popped).toEqual({
        modelText: 'model one\n\nrestored steer',
      });
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

    it('drains goal commands during an active turn', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('steer now');
        result.current.addMessage('/goal clear');
        result.current.addMessage('/model');
        result.current.addMessage('/goal replace the active goal');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });

      expect(drained).toEqual([
        'steer now',
        '/goal clear',
        '/goal replace the active goal',
      ]);
      expect(result.current.messageQueue).toEqual(['/model']);
    });

    it('leaves goal commands queued at the idle boundary', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('/goal clear');
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue(true);
      });

      expect(drained).toEqual([]);
      expect(result.current.messageQueue).toEqual(['/goal clear']);
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

    it('leaves Ctrl+Q messages queued during an active turn', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('steer now');
        result.current.addMessage('wait for idle', true);
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue();
      });

      expect(drained).toEqual(['steer now']);
      expect(result.current.messageQueue).toEqual(['wait for idle']);
    });

    it('drains Ctrl+Q messages at the idle boundary', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('wait for idle', true);
      });

      let drained: string[] = [];
      act(() => {
        drained = result.current.drainQueue(true);
      });

      expect(drained).toEqual(['wait for idle']);
      expect(result.current.messageQueue).toEqual([]);
    });

    it('restores interrupted steer messages ahead of newer queued input', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('steer now');
      });
      act(() => {
        result.current.drainQueue();
        result.current.addMessage('newer input');
        result.current.restoreMessages(['steer now']);
      });

      expect(result.current.messageQueue).toEqual(['steer now', 'newer input']);
    });

    it('drops provenance when interrupted steer messages are restored', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('steer now', false, 'raw steer');
      });
      act(() => {
        const drained = result.current.drainQueue();
        result.current.restoreMessages(drained);
      });

      let submission: QueuedSubmission | null = null;
      act(() => {
        submission = result.current.popNextTurn();
      });

      expect(submission).toEqual({ modelText: 'steer now' });
    });
  });

  describe('popNextTurn', () => {
    it('returns null when the queue is empty', () => {
      const { result } = renderHook(() => useMessageQueue());

      let submission: QueuedSubmission | null = null;
      act(() => {
        submission = result.current.popNextTurn();
      });
      expect(submission).toBeNull();
    });

    it('pops the first slash command and leaves the rest queued', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('/model');
        result.current.addMessage('/help');
      });

      let submission: QueuedSubmission | null = null;
      act(() => {
        submission = result.current.popNextTurn();
      });
      expect(submission).toEqual({ modelText: '/model' });
      expect(result.current.messageQueue).toEqual(['/help']);
    });

    it('drains slash commands one item at a time across repeated calls', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('/model');
        result.current.addMessage('/theme');
        result.current.addMessage('/help');
      });

      const submissions: Array<QueuedSubmission | null> = [];
      act(() => {
        submissions.push(result.current.popNextTurn());
      });
      act(() => {
        submissions.push(result.current.popNextTurn());
      });
      act(() => {
        submissions.push(result.current.popNextTurn());
      });
      act(() => {
        submissions.push(result.current.popNextTurn());
      });

      expect(submissions).toEqual([
        { modelText: '/model' },
        { modelText: '/theme' },
        { modelText: '/help' },
        null,
      ]);
      expect(result.current.messageQueue).toEqual([]);
    });

    it('batches all plain prompts while leaving interleaved slash commands', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('/model');
        result.current.addMessage('model one', false, 'user one');
        result.current.addMessage('/help');
        result.current.addMessage('model two', true, 'user two');
      });

      let submission: QueuedSubmission | null = null;
      act(() => {
        submission = result.current.popNextTurn();
      });

      expect(submission).toEqual({
        modelText: 'model one\n\nmodel two',
        submittedPrompt: 'user one\n\nuser two',
      });
      expect(result.current.messageQueue).toEqual(['/model', '/help']);
    });

    it('fails closed when a batched prompt lacks provenance', () => {
      const { result } = renderHook(() => useMessageQueue());

      act(() => {
        result.current.addMessage('model one', false, 'user one');
        result.current.addMessage('model two');
      });

      let submission: QueuedSubmission | null = null;
      act(() => {
        submission = result.current.popNextTurn();
      });

      expect(submission).toEqual({
        modelText: 'model one\n\nmodel two',
      });
    });
  });
});
