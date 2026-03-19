/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InteractiveSelector } from './interactiveSelector.js';
import { stdin, stdout } from 'node:process';

describe('InteractiveSelector', () => {
  const mockOptions = [
    { value: 'option1', label: 'Option 1', description: 'First option' },
    { value: 'option2', label: 'Option 2', description: 'Second option' },
    { value: 'option3', label: 'Option 3', description: 'Third option' },
  ];

  const mockPrompt = 'Select an option:';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create an instance with default prompt', () => {
      const selector = new InteractiveSelector(mockOptions);
      expect(selector).toBeInstanceOf(InteractiveSelector);
    });

    it('should create an instance with custom prompt', () => {
      const selector = new InteractiveSelector(mockOptions, mockPrompt);
      expect(selector).toBeInstanceOf(InteractiveSelector);
    });
  });

  describe('select', () => {
    it('should reject if raw mode is not available', async () => {
      // Mock stdin without setRawMode
      const originalSetRawMode = stdin.setRawMode;
      (stdin as any).setRawMode = undefined;

      const selector = new InteractiveSelector(mockOptions, mockPrompt);

      await expect(selector.select()).rejects.toThrow(
        'Raw mode not available. Please run in an interactive terminal.',
      );

      // Restore
      (stdin as any).setRawMode = originalSetRawMode;
    });

    it('should select first option with Enter key', async () => {
      const mockSetRawMode = vi.fn();
      const mockResume = vi.fn();
      const mockSetEncoding = vi.fn();
      const mockRemoveListener = vi.fn();
      const mockOn = vi.fn((event: any, callback: any) => {
        // Simulate Enter key press
        setTimeout(() => callback('\r'), 0);
        return stdin;
      });

      (stdin as any).isRaw = false;
      (stdin as any).setRawMode = mockSetRawMode;
      (stdin as any).resume = mockResume;
      (stdin as any).setEncoding = mockSetEncoding;
      (stdin as any).removeListener = mockRemoveListener;
      (stdin as any).on = mockOn;

      const stdoutWriteSpy = vi
        .spyOn(stdout, 'write')
        .mockImplementation(() => true);

      const selector = new InteractiveSelector(mockOptions, mockPrompt);
      const result = await selector.select();

      expect(result).toBe('option1');
      expect(mockSetRawMode).toHaveBeenCalledWith(true);
      expect(mockResume).toHaveBeenCalled();

      stdoutWriteSpy.mockRestore();
    });

    it('should select second option after arrow down then Enter', async () => {
      let dataCallback!: (chunk: string) => void;

      const mockSetRawMode = vi.fn();
      const mockResume = vi.fn();
      const mockOn = vi.fn((event: any, callback: any) => {
        dataCallback = callback;
        return stdin;
      });
      const mockRemoveListener = vi.fn();

      (stdin as any).isRaw = false;
      (stdin as any).setRawMode = mockSetRawMode;
      (stdin as any).resume = mockResume;
      (stdin as any).on = mockOn;
      (stdin as any).removeListener = mockRemoveListener;

      const stdoutWriteSpy = vi
        .spyOn(stdout, 'write')
        .mockImplementation(() => true);

      const selector = new InteractiveSelector(mockOptions, mockPrompt);
      const selectPromise = selector.select();

      // Simulate arrow down
      dataCallback('\x1B[B');

      // Simulate Enter
      setTimeout(() => dataCallback('\r'), 0);

      const result = await selectPromise;

      expect(result).toBe('option2');

      stdoutWriteSpy.mockRestore();
    });

    it('should handle arrow up navigation', async () => {
      let dataCallback!: (chunk: string) => void;

      const mockSetRawMode = vi.fn();
      const mockResume = vi.fn();
      const mockOn = vi.fn((event: any, callback: any) => {
        dataCallback = callback;
        return stdin;
      });
      const mockRemoveListener = vi.fn();

      (stdin as any).isRaw = false;
      (stdin as any).setRawMode = mockSetRawMode;
      (stdin as any).resume = mockResume;
      (stdin as any).on = mockOn;
      (stdin as any).removeListener = mockRemoveListener;

      const stdoutWriteSpy = vi
        .spyOn(stdout, 'write')
        .mockImplementation(() => true);

      const selector = new InteractiveSelector(mockOptions, mockPrompt);
      const selectPromise = selector.select();

      // Move down twice
      dataCallback('\x1B[B');
      dataCallback('\x1B[B');

      // Move up once
      dataCallback('\x1B[A');

      // Simulate Enter
      setTimeout(() => dataCallback('\r'), 0);

      const result = await selectPromise;

      expect(result).toBe('option2');

      stdoutWriteSpy.mockRestore();
    });

    it('should reject with Ctrl+C', async () => {
      let dataCallback!: (chunk: string) => void;

      const mockSetRawMode = vi.fn();
      const mockResume = vi.fn();
      const mockOn = vi.fn((event: any, callback: any) => {
        dataCallback = callback;
        return stdin;
      });
      const mockRemoveListener = vi.fn();

      (stdin as any).isRaw = false;
      (stdin as any).setRawMode = mockSetRawMode;
      (stdin as any).resume = mockResume;
      (stdin as any).on = mockOn;
      (stdin as any).removeListener = mockRemoveListener;

      const selector = new InteractiveSelector(mockOptions, mockPrompt);
      const selectPromise = selector.select();

      // Simulate Ctrl+C
      setTimeout(() => dataCallback('\x03'), 0);

      await expect(selectPromise).rejects.toThrow('Interrupted');
    });

    it('should wrap around when navigating past last option', async () => {
      let dataCallback!: (chunk: string) => void;

      const mockSetRawMode = vi.fn();
      const mockResume = vi.fn();
      const mockOn = vi.fn((event: any, callback: any) => {
        dataCallback = callback;
        return stdin;
      });
      const mockRemoveListener = vi.fn();

      (stdin as any).isRaw = false;
      (stdin as any).setRawMode = mockSetRawMode;
      (stdin as any).resume = mockResume;
      (stdin as any).on = mockOn;
      (stdin as any).removeListener = mockRemoveListener;

      const stdoutWriteSpy = vi
        .spyOn(stdout, 'write')
        .mockImplementation(() => true);

      const selector = new InteractiveSelector(mockOptions, mockPrompt);
      const selectPromise = selector.select();

      // Move down past last option (should wrap to first)
      dataCallback('\x1B[B');
      dataCallback('\x1B[B');
      dataCallback('\x1B[B'); // Now at option1 again (wrapped)

      // Simulate Enter
      setTimeout(() => dataCallback('\r'), 0);

      const result = await selectPromise;

      expect(result).toBe('option1');

      stdoutWriteSpy.mockRestore();
    });

    it('should wrap around when navigating before first option', async () => {
      let dataCallback!: (chunk: string) => void;

      const mockSetRawMode = vi.fn();
      const mockResume = vi.fn();
      const mockOn = vi.fn((event: any, callback: any) => {
        dataCallback = callback;
        return stdin;
      });
      const mockRemoveListener = vi.fn();

      (stdin as any).isRaw = false;
      (stdin as any).setRawMode = mockSetRawMode;
      (stdin as any).resume = mockResume;
      (stdin as any).on = mockOn;
      (stdin as any).removeListener = mockRemoveListener;

      const stdoutWriteSpy = vi
        .spyOn(stdout, 'write')
        .mockImplementation(() => true);

      const selector = new InteractiveSelector(mockOptions, mockPrompt);
      const selectPromise = selector.select();

      // Move up from first option (should wrap to last)
      dataCallback('\x1B[A');

      // Simulate Enter
      setTimeout(() => dataCallback('\r'), 0);

      const result = await selectPromise;

      expect(result).toBe('option3');

      stdoutWriteSpy.mockRestore();
    });

    it('should ignore arrow left/right keys', async () => {
      let dataCallback!: (chunk: string) => void;

      const mockSetRawMode = vi.fn();
      const mockResume = vi.fn();
      const mockOn = vi.fn((event: any, callback: any) => {
        dataCallback = callback;
        return stdin;
      });
      const mockRemoveListener = vi.fn();

      (stdin as any).isRaw = false;
      (stdin as any).setRawMode = mockSetRawMode;
      (stdin as any).resume = mockResume;
      (stdin as any).on = mockOn;
      (stdin as any).removeListener = mockRemoveListener;

      const stdoutWriteSpy = vi
        .spyOn(stdout, 'write')
        .mockImplementation(() => true);

      const selector = new InteractiveSelector(mockOptions, mockPrompt);
      const selectPromise = selector.select();

      // Press arrow right (should be ignored)
      dataCallback('\x1B[C');

      // Press arrow left (should be ignored)
      dataCallback('\x1B[D');

      // Press Enter - should still select first option
      setTimeout(() => dataCallback('\r'), 0);

      const result = await selectPromise;

      expect(result).toBe('option1');

      stdoutWriteSpy.mockRestore();
    });

    it('should handle newline character as Enter', async () => {
      let dataCallback!: (chunk: string) => void;

      const mockSetRawMode = vi.fn();
      const mockResume = vi.fn();
      const mockOn = vi.fn((event: any, callback: any) => {
        dataCallback = callback;
        return stdin;
      });
      const mockRemoveListener = vi.fn();

      (stdin as any).isRaw = false;
      (stdin as any).setRawMode = mockSetRawMode;
      (stdin as any).resume = mockResume;
      (stdin as any).on = mockOn;
      (stdin as any).removeListener = mockRemoveListener;

      const stdoutWriteSpy = vi
        .spyOn(stdout, 'write')
        .mockImplementation(() => true);

      const selector = new InteractiveSelector(mockOptions, mockPrompt);
      const selectPromise = selector.select();

      // Simulate newline
      setTimeout(() => dataCallback('\n'), 0);

      const result = await selectPromise;

      expect(result).toBe('option1');

      stdoutWriteSpy.mockRestore();
    });
  });

  describe('renderMenu', () => {
    it('should render menu with correct formatting', () => {
      const stdoutWriteSpy = vi
        .spyOn(stdout, 'write')
        .mockImplementation(() => true);

      const selector = new InteractiveSelector(mockOptions, mockPrompt);

      // Access private method for testing
      (selector as any).renderMenu();

      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = stdoutWriteSpy.mock.calls.map((call) => call[0]).join('');

      expect(output).toContain('Select an option:');
      expect(output).toContain('Option 1');
      expect(output).toContain('Option 2');
      expect(output).toContain('Option 3');
      expect(output).toContain('First option');
      expect(output).toContain('Second option');
      expect(output).toContain('Third option');
      expect(output).toContain('↑ ↓');
      expect(output).toContain('Enter');
      expect(output).toContain('Ctrl+C');

      stdoutWriteSpy.mockRestore();
    });

    it('should highlight selected option', () => {
      const stdoutWriteSpy = vi
        .spyOn(stdout, 'write')
        .mockImplementation(() => true);

      const selector = new InteractiveSelector(mockOptions, mockPrompt);
      (selector as any).selectedIndex = 1;
      (selector as any).renderMenu();

      const output = stdoutWriteSpy.mock.calls.map((call) => call[0]).join('');

      // Selected option should have cyan color code
      expect(output).toContain('\x1B[36m');

      stdoutWriteSpy.mockRestore();
    });

    it('should calculate correct total lines', () => {
      const selector = new InteractiveSelector(mockOptions, mockPrompt);

      // Access private method for testing
      (selector as any).calculateTotalLines();

      // Expected: 4 (prompt + empty + empty + instructions) + 3 (options) = 7
      expect((selector as any).calculateTotalLines()).toBe(7);
    });

    it('should handle options without descriptions', () => {
      const simpleOptions = [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ];

      const stdoutWriteSpy = vi
        .spyOn(stdout, 'write')
        .mockImplementation(() => true);

      const selector = new InteractiveSelector(simpleOptions, mockPrompt);
      (selector as any).renderMenu();

      const output = stdoutWriteSpy.mock.calls.map((call) => call[0]).join('');

      expect(output).toContain('A');
      expect(output).toContain('B');

      stdoutWriteSpy.mockRestore();
    });
  });
});
