/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { substituteHookArguments } from './hookPromptUtils.js';

describe('hookPromptUtils', () => {
  describe('substituteHookArguments', () => {
    it('should replace $ARGUMENTS with the provided JSON input', () => {
      const result = substituteHookArguments(
        'Check this: $ARGUMENTS',
        '{"key":"value"}',
      );
      expect(result).toBe('Check this: {"key":"value"}');
    });

    it('should replace all occurrences of $ARGUMENTS', () => {
      const result = substituteHookArguments(
        'First: $ARGUMENTS, Second: $ARGUMENTS',
        'data',
      );
      expect(result).toBe('First: data, Second: data');
    });

    it('should return the prompt unchanged when no placeholder exists', () => {
      const result = substituteHookArguments(
        'No placeholder here',
        '{"key":"value"}',
      );
      expect(result).toBe('No placeholder here');
    });

    it('should handle empty JSON input', () => {
      const result = substituteHookArguments('Data: $ARGUMENTS', '');
      expect(result).toBe('Data: ');
    });

    it('should not interpret $& as a special replacement sequence', () => {
      const result = substituteHookArguments(
        'Path: $ARGUMENTS',
        '{"path":"/foo/$&/bar"}',
      );
      expect(result).toBe('Path: {"path":"/foo/$&/bar"}');
    });
  });
});
