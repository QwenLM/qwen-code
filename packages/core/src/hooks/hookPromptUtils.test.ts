/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  substituteHookArguments,
  DEFAULT_AGENT_HOOK_PROMPT,
} from './hookPromptUtils.js';

describe('hookPromptUtils', () => {
  describe('DEFAULT_AGENT_HOOK_PROMPT', () => {
    it('should contain the $ARGUMENTS placeholder', () => {
      expect(DEFAULT_AGENT_HOOK_PROMPT).toContain('$ARGUMENTS');
    });

    it('should mention report_verdict tool', () => {
      expect(DEFAULT_AGENT_HOOK_PROMPT).toContain('report_verdict');
    });
  });

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

    it('should handle the default prompt template', () => {
      const jsonInput = '{"session_id":"abc","cwd":"/tmp"}';
      const result = substituteHookArguments(
        DEFAULT_AGENT_HOOK_PROMPT,
        jsonInput,
      );
      expect(result).not.toContain('$ARGUMENTS');
      expect(result).toContain(jsonInput);
    });
  });
});
