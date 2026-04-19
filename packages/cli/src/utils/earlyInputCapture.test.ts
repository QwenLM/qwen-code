/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startEarlyInputCapture,
  stopEarlyInputCapture,
  getAndClearCapturedInput,
  stopAndGetCapturedInput,
  hasCapturedInput,
  resetCaptureState,
} from './earlyInputCapture.js';
import { PassThrough } from 'node:stream';

describe('earlyInputCapture', () => {
  let mockStdin: PassThrough;
  let originalStdin: typeof process.stdin;
  let originalIsTTY: boolean;

  beforeEach(() => {
    resetCaptureState();

    // Save original stdin
    originalStdin = process.stdin;
    originalIsTTY = process.stdin.isTTY ?? false;

    // Create mock stdin
    mockStdin = new PassThrough();
    Object.defineProperty(process, 'stdin', {
      value: mockStdin,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });

    delete process.env['QWEN_CODE_DISABLE_EARLY_CAPTURE'];
  });

  afterEach(() => {
    resetCaptureState();

    // Restore original stdin
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  describe('capture lifecycle', () => {
    it('should start and stop capture correctly', () => {
      startEarlyInputCapture();
      expect(hasCapturedInput()).toBe(false);

      mockStdin.write(Buffer.from('a'));
      expect(hasCapturedInput()).toBe(true);

      stopEarlyInputCapture();
      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('a');
    });

    it('should not capture after stop', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('a'));
      stopEarlyInputCapture();
      mockStdin.write(Buffer.from('b'));

      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('a');
    });

    it('should not start capture if not TTY', () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false });
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('a'));
      stopEarlyInputCapture();

      expect(hasCapturedInput()).toBe(false);
    });

    it('should not start capture twice', () => {
      startEarlyInputCapture();
      startEarlyInputCapture(); // Second call should be ignored

      mockStdin.write(Buffer.from('a'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('a');
    });

    it('stopAndGetCapturedInput should atomically stop and return input', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('hello'));

      const input = stopAndGetCapturedInput();
      expect(input.toString()).toBe('hello');

      // Further writes should not be captured
      mockStdin.write(Buffer.from('world'));
      expect(hasCapturedInput()).toBe(false);
    });
  });

  describe('terminal response filtering', () => {
    it('should filter DEC private mode responses (ESC [ ?)', () => {
      startEarlyInputCapture();
      // DEC private mode response: ESC [ ? 1 0 0 4 h
      mockStdin.write(Buffer.from('\x1b[?1004h'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.length).toBe(0);
    });

    it('should filter DA2 responses (ESC [ >)', () => {
      startEarlyInputCapture();
      // DA2 response: ESC [ > 0 ; 9 5 ; 0 c
      mockStdin.write(Buffer.from('\x1b[>0;95;0c'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.length).toBe(0);
    });

    it('should filter OSC sequences (ESC ])', () => {
      startEarlyInputCapture();
      // OSC sequence: ESC ] 0 ; title BEL
      mockStdin.write(Buffer.from('\x1b]0;window title\x07'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.length).toBe(0);
    });

    it('should filter DCS sequences (ESC P)', () => {
      startEarlyInputCapture();
      // DCS sequence: ESC P ... ST
      mockStdin.write(Buffer.from('\x1bP$data\x1b\\'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.length).toBe(0);
    });

    it('should keep user input mixed with terminal responses', () => {
      startEarlyInputCapture();
      // Mix of user input and terminal response
      mockStdin.write(Buffer.from('a\x1b[?1004hb\x1b]0;title\x07c'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('abc');
    });

    it('should keep arrow key sequences (user input)', () => {
      startEarlyInputCapture();
      // Arrow up: ESC [ A (this is a user input, not terminal response)
      mockStdin.write(Buffer.from('\x1b[A'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      // Arrow key sequence should be kept (it's user input)
      expect(input.toString()).toBe('\x1b[A');
    });

    it('should keep function key sequences (user input)', () => {
      startEarlyInputCapture();
      // F1: ESC O P
      mockStdin.write(Buffer.from('\x1bOP'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('\x1bOP');
    });

    it('should filter terminal responses split across chunks', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('\x1b[?1004'));
      mockStdin.write(Buffer.from('h'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.length).toBe(0);
    });

    it('should keep user input around split terminal responses', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('a\x1b[?100'));
      mockStdin.write(Buffer.from('4hbc'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('abc');
    });

    it('should filter terminal responses split at ESC[ prefix', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('\x1b['));
      mockStdin.write(Buffer.from('?1004h'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.length).toBe(0);
    });

    it('should filter terminal responses split at ESC prefix', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('\x1b'));
      mockStdin.write(Buffer.from('[?1004h'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.length).toBe(0);
    });

    it('should drop incomplete DEC private response on capture end', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('\x1b[?1004'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.length).toBe(0);
    });

    it('should drop incomplete OSC sequence on capture end', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('\x1b]0;title'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.length).toBe(0);
    });

    it('should keep arrow key sequence split across chunks', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('\x1b['));
      mockStdin.write(Buffer.from('A'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('\x1b[A');
    });

    it('should drop incomplete ESC[ prefix on capture end', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('\x1b['));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('');
    });

    it('should replay standalone ESC on capture end', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('\x1b'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('\x1b');
    });
  });

  describe('UTF-8 handling', () => {
    it('should capture simple ASCII characters', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('abc'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('abc');
    });

    it('should capture UTF-8 multibyte characters', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('你好世界'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('你好世界');
    });

    it('should capture emoji', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('👋🎉'));
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.toString()).toBe('👋🎉');
    });
  });

  describe('edge cases', () => {
    it('should handle empty input', () => {
      startEarlyInputCapture();
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      expect(input.length).toBe(0);
    });

    it('should clear captured input after getAndClearCapturedInput', () => {
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('test'));
      stopEarlyInputCapture();

      const input1 = getAndClearCapturedInput();
      expect(input1.toString()).toBe('test');

      const input2 = getAndClearCapturedInput();
      expect(input2.length).toBe(0);
    });

    it('should skip when QWEN_CODE_DISABLE_EARLY_CAPTURE is set', () => {
      process.env['QWEN_CODE_DISABLE_EARLY_CAPTURE'] = '1';
      startEarlyInputCapture();
      mockStdin.write(Buffer.from('a'));
      stopEarlyInputCapture();

      expect(hasCapturedInput()).toBe(false);
    });

    it('should limit buffer size', () => {
      startEarlyInputCapture();

      // Write more than 64KB
      const largeData = Buffer.alloc(100 * 1024, 'a');
      mockStdin.write(largeData);
      stopEarlyInputCapture();

      const input = getAndClearCapturedInput();
      // Should be truncated to 64KB
      expect(input.length).toBeLessThanOrEqual(64 * 1024);
    });
  });
});
