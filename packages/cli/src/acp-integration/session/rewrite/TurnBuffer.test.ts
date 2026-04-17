/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TurnBuffer } from './TurnBuffer.js';

describe('TurnBuffer', () => {
  let buffer: TurnBuffer;

  beforeEach(() => {
    buffer = new TurnBuffer();
  });

  describe('isEmpty', () => {
    it('should be empty initially', () => {
      expect(buffer.isEmpty).toBe(true);
    });

    it('should not be empty after appending a message', () => {
      buffer.appendMessage('hello');
      expect(buffer.isEmpty).toBe(false);
    });

    it('should not be empty after appending a thought', () => {
      buffer.appendThought('thinking...');
      expect(buffer.isEmpty).toBe(false);
    });

    it('should be empty after flush', () => {
      buffer.appendMessage('hello');
      buffer.flush();
      expect(buffer.isEmpty).toBe(true);
    });
  });

  describe('appendMessage / appendThought', () => {
    it('should ignore empty strings', () => {
      buffer.appendMessage('');
      buffer.appendThought('');
      expect(buffer.isEmpty).toBe(true);
    });
  });

  describe('markToolCall', () => {
    it('should set hasToolCalls in flushed content', () => {
      buffer.appendMessage('text');
      buffer.markToolCall();
      const content = buffer.flush();
      expect(content?.hasToolCalls).toBe(true);
    });

    it('should default hasToolCalls to false', () => {
      buffer.appendMessage('text');
      const content = buffer.flush();
      expect(content?.hasToolCalls).toBe(false);
    });
  });

  describe('flush', () => {
    it('should return null when buffer is empty', () => {
      expect(buffer.flush()).toBeNull();
    });

    it('should return null when only whitespace was appended', () => {
      buffer.appendMessage('   ');
      buffer.appendThought('  \n  ');
      expect(buffer.flush()).toBeNull();
    });

    it('should return accumulated messages and thoughts', () => {
      buffer.appendThought('thought 1');
      buffer.appendThought('thought 2');
      buffer.appendMessage('msg 1');
      buffer.appendMessage('msg 2');

      const content = buffer.flush();
      expect(content).toEqual({
        thoughts: ['thought 1', 'thought 2'],
        messages: ['msg 1', 'msg 2'],
        hasToolCalls: false,
      });
    });

    it('should filter out whitespace-only entries', () => {
      buffer.appendThought('  ');
      buffer.appendThought('real thought');
      buffer.appendMessage('');
      buffer.appendMessage('real message');

      const content = buffer.flush();
      expect(content?.thoughts).toEqual(['real thought']);
      expect(content?.messages).toEqual(['real message']);
    });

    it('should reset buffer after flush', () => {
      buffer.appendMessage('first');
      buffer.markToolCall();
      buffer.flush();

      buffer.appendMessage('second');
      const content = buffer.flush();
      expect(content).toEqual({
        thoughts: [],
        messages: ['second'],
        hasToolCalls: false,
      });
    });
  });
});
