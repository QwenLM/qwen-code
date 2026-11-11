/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { flattenMemory } from './memory.js';

describe('memory', () => {
  describe('flattenMemory', () => {
    it('should return empty string for null or undefined', () => {
      expect(flattenMemory(undefined)).toBe('');
      expect(flattenMemory(null as unknown as undefined)).toBe('');
    });

    it('should return the string itself if a string is provided', () => {
      expect(flattenMemory('raw string')).toBe('raw string');
    });

    it('should return empty string for an empty object', () => {
      expect(flattenMemory({})).toBe('');
    });

    it('should return content with headers even if only global memory is present', () => {
      expect(flattenMemory({ global: 'global content' })).toBe(
        `--- Global ---
global content`,
      );
    });

    it('should return content with headers even if only plugin memory is present', () => {
      expect(flattenMemory({ plugin: 'extension content' })).toBe(
        `--- Plugin ---
extension content`,
      );
    });

    it('should return content with headers even if only project memory is present', () => {
      expect(flattenMemory({ project: 'project content' })).toBe(
        `--- Project ---
project content`,
      );
    });

    it('should include headers if multiple levels are present (global + project)', () => {
      const result = flattenMemory({
        global: 'global content',
        project: 'project content',
      });
      expect(result).toContain('--- Global ---');
      expect(result).toContain('global content');
      expect(result).toContain('--- Project ---');
      expect(result).toContain('project content');
      expect(result).not.toContain('--- Plugin ---');
    });

    it('should include headers if all levels are present', () => {
      const result = flattenMemory({
        global: 'global content',
        plugin: 'extension content',
        project: 'project content',
      });
      expect(result).toContain('--- Global ---');
      expect(result).toContain('--- Plugin ---');
      expect(result).toContain('--- Project ---');
      expect(result).toBe(
        `--- Global ---
global content

--- Plugin ---
extension content

--- Project ---
project content`,
      );
    });

    it('should trim content and ignore empty strings', () => {
      const result = flattenMemory({
        global: '  trimmed global  ',
        plugin: '   ',
        project: 'project\n',
      });
      expect(result).toBe(
        `--- Global ---
trimmed global

--- Project ---
project`,
      );
    });

    it('should return empty string if all levels are only whitespace', () => {
      expect(
        flattenMemory({
          global: '  ',
          plugin: '\n',
          project: ' 	 ',
        }),
      ).toBe('');
    });
  });
});
