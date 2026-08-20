/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { looksLikeDiagramOrArt } from './CodeColorizer.js';

describe('looksLikeDiagramOrArt', () => {
  describe('structural box-drawing characters', () => {
    it('returns true for lines with structural box-drawing characters', () => {
      expect(looksLikeDiagramOrArt('│  ├─ step1')).toBe(true);
      expect(looksLikeDiagramOrArt('└─ final step')).toBe(true);
      expect(looksLikeDiagramOrArt('┌──────────┐')).toBe(true);
    });

    it('returns true for ASCII art timeline lines', () => {
      const timelineLine = '      ├─ acpAgent.newSession()';
      expect(looksLikeDiagramOrArt(timelineLine)).toBe(true);
    });

    it('returns true for lines with box frames', () => {
      expect(looksLikeDiagramOrArt('┌─────────────────────────────────┐')).toBe(
        true,
      );
      expect(looksLikeDiagramOrArt('│ await tryGenerateSessionTitle() │')).toBe(
        true,
      );
      expect(looksLikeDiagramOrArt('└─────────────────────────────────┘')).toBe(
        true,
      );
    });

    it('returns true for lines with tree structure chars', () => {
      expect(looksLikeDiagramOrArt('  ├─ child node')).toBe(true);
      expect(looksLikeDiagramOrArt('  └─ last child')).toBe(true);
      expect(looksLikeDiagramOrArt('│  vertical line')).toBe(true);
    });
  });

  describe('CJK characters', () => {
    it('returns true for lines with high CJK ratio', () => {
      expect(looksLikeDiagramOrArt('这是一个中文句子')).toBe(true);
      expect(looksLikeDiagramOrArt('初始化项目上下文')).toBe(true);
    });

    it('returns false for lines with low CJK ratio', () => {
      expect(looksLikeDiagramOrArt('testing 测试 testing')).toBe(false);
    });
  });

  describe('regular code', () => {
    it('returns false for typical JavaScript code', () => {
      expect(looksLikeDiagramOrArt('const x = 42;')).toBe(false);
      expect(looksLikeDiagramOrArt('function hello() {')).toBe(false);
      expect(looksLikeDiagramOrArt('  return result;')).toBe(false);
    });

    it('returns false for typical TypeScript code', () => {
      expect(looksLikeDiagramOrArt('interface User {')).toBe(false);
      expect(looksLikeDiagramOrArt('  name: string;')).toBe(false);
      expect(looksLikeDiagramOrArt('}')).toBe(false);
    });

    it('returns false for typical Python code', () => {
      expect(looksLikeDiagramOrArt('def hello():')).toBe(false);
      expect(looksLikeDiagramOrArt('    print("world")')).toBe(false);
    });

    it('returns false for HTML/XML code', () => {
      expect(looksLikeDiagramOrArt('<div class="container">')).toBe(false);
      expect(looksLikeDiagramOrArt('  <p>Hello</p>')).toBe(false);
      expect(looksLikeDiagramOrArt('</div>')).toBe(false);
    });

    it('returns false for shell commands', () => {
      expect(looksLikeDiagramOrArt('$ npm install')).toBe(false);
      expect(looksLikeDiagramOrArt('git commit -m "fix"')).toBe(false);
    });

    it('returns false for code with horizontal line chars (─)', () => {
      // The horizontal line char (─) alone is not a strong signal
      // because it can appear in ASCII art used for decoration in code output
      expect(looksLikeDiagramOrArt('──────────')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for empty lines', () => {
      expect(looksLikeDiagramOrArt('')).toBe(false);
      expect(looksLikeDiagramOrArt('   ')).toBe(false);
      expect(looksLikeDiagramOrArt('\t')).toBe(false);
    });

    it('returns false for lines with only whitespace', () => {
      expect(looksLikeDiagramOrArt('    ')).toBe(false);
    });

    it('handles lines with few special characters', () => {
      // A code line with a single CJK char should not trigger
      expect(looksLikeDiagramOrArt('const 名前 = "test";')).toBe(false);
    });

    it('handles code with comments containing CJK', () => {
      // Code line with CJK comment - ratio is low
      expect(looksLikeDiagramOrArt('const x = 42; // 这是注释')).toBe(false);
    });
  });

  describe('threshold behavior', () => {
    it('returns true when CJK ratio > 30%', () => {
      // 4 CJK chars out of 10 non-whitespace = 40%
      expect(looksLikeDiagramOrArt('test 测试测试 test')).toBe(true);
    });

    it('returns false when CJK ratio <= 30%', () => {
      // 2 CJK chars out of 10 non-whitespace = 20%
      expect(looksLikeDiagramOrArt('testing 测试 testing')).toBe(false);
    });
  });
});
