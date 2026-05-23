/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parse } from 'shell-quote';
import { DEFAULT_FORTUNE_COMMAND } from '../../config/constants.js';

describe('fortune', () => {
  describe('DEFAULT_FORTUNE_COMMAND', () => {
    it('should use PATH lookup without absolute path', () => {
      expect(DEFAULT_FORTUNE_COMMAND).toBe('fortune -s -n 45');
    });
  });

  describe('shell-quote parsing', () => {
    // Test the shell-quote parsing logic used in getFortuneQuote
    // This verifies how commands are parsed into executable and args

    it('should parse simple command with no args', () => {
      const parsed = parse('fortune');
      expect(parsed).toEqual(['fortune']);
    });

    it('should parse command with multiple args', () => {
      const parsed = parse('fortune -s -n 45');
      expect(parsed).toEqual(['fortune', '-s', '-n', '45']);
    });

    it('should detect pipe operator as object', () => {
      const parsed = parse('fortune | cat');
      const pipeOp = parsed.find((p) => typeof p !== 'string');
      expect(pipeOp).toBeDefined();
      expect(typeof pipeOp).toBe('object');
    });

    it('should detect redirect > operator as object', () => {
      const parsed = parse('fortune > file.txt');
      const redirectOp = parsed.find((p) => typeof p !== 'string');
      expect(redirectOp).toBeDefined();
    });

    it('should detect redirect < operator as object', () => {
      const parsed = parse('fortune < input.txt');
      const redirectOp = parsed.find((p) => typeof p !== 'string');
      expect(redirectOp).toBeDefined();
    });

    it('should detect && operator as object', () => {
      const parsed = parse('fortune && echo done');
      const chainOp = parsed.find((p) => typeof p !== 'string');
      expect(chainOp).toBeDefined();
    });

    it('should detect | operator as object', () => {
      const parsed = parse('fortune | cat');
      const pipeOp = parsed.find((p) => typeof p !== 'string');
      expect(pipeOp).toBeDefined();
    });

    it('should handle quoted arguments', () => {
      const parsed = parse('fortune -s -n "45 chars"');
      expect(parsed).toEqual(['fortune', '-s', '-n', '45 chars']);
    });
  });

  describe('Environment variable detection regex', () => {
    const envVarPattern = /\$[a-zA-Z_][a-zA-Z0-9_]*|\$\{[^}]+\}/;

    it('should match $VAR pattern', () => {
      expect(envVarPattern.test('fortune $HOME -s')).toBe(true);
      expect(envVarPattern.test('fortune $PATH')).toBe(true);
      expect(envVarPattern.test('$VAR')).toBe(true);
    });

    it('should match ${VAR} pattern', () => {
      expect(envVarPattern.test('fortune ${HOME} -s')).toBe(true);
      expect(envVarPattern.test('fortune ${PATH}')).toBe(true);
      expect(envVarPattern.test('${VAR}')).toBe(true);
    });

    it('should not match valid command arguments', () => {
      expect(envVarPattern.test('fortune -s -n 45')).toBe(false);
      expect(envVarPattern.test('fortune -o')).toBe(false);
      expect(envVarPattern.test('fortune')).toBe(false);
    });

    it('should not match dollar signs in other contexts', () => {
      expect(envVarPattern.test('fortune -n $5')).toBe(false); // $5 is not a valid env var
      expect(envVarPattern.test('fortune')).toBe(false);
    });
  });

  describe('ANSI stripping', () => {
    const stripAnsi = (str: string): string => 
      // eslint-disable-next-line no-control-regex
       str.replace(/[\x1b][[0-9;]*m/g, '')
    ;

    it('should strip SGR color codes', () => {
      expect(stripAnsi('\u001b[32mGreen text\u001b[0m')).toBe('Green text');
      expect(stripAnsi('\u001b[1;31mBold red\u001b[0m')).toBe('Bold red');
    });

    it('should strip multiple ANSI codes', () => {
      const input = '\u001b[32m\u001b[1mBold green\u001b[0m';
      expect(stripAnsi(input)).toBe('Bold green');
    });

    it('should handle text without ANSI codes', () => {
      expect(stripAnsi('Plain text')).toBe('Plain text');
    });

    it('should handle OSC hyperlink codes', () => {
      const hyperlink =
        '\u001b]8;;https://example.com\u001b\\Link\u001b]8;;\u001b\\';
      // Note: Our simplified regex doesn't handle OSC sequences
      // Full implementation uses strip-ansi package which does handle them
      // This test documents the limitation - actual code uses strip-ansi
      const actual = stripAnsi(hyperlink);
      // The actual strip-ansi package would fully strip this
      expect(actual).toContain('Link'); // Text content remains
    });
  });

  describe('Whitespace normalization', () => {
    const normalizeWhitespace = (str: string): string => str.trim().replace(/\s+/g, ' ');

    it('should trim leading/trailing whitespace', () => {
      expect(normalizeWhitespace('  text  ')).toBe('text');
    });

    it('should collapse multiple spaces', () => {
      expect(normalizeWhitespace('Multiple   spaces')).toBe('Multiple spaces');
    });

    it('should collapse newlines and tabs', () => {
      expect(normalizeWhitespace('Line1\n\nLine2\n')).toBe('Line1 Line2');
      expect(normalizeWhitespace('Tab\there')).toBe('Tab here');
    });

    it('should handle mixed whitespace', () => {
      expect(normalizeWhitespace('  Mixed   \n\t  whitespace  \n')).toBe(
        'Mixed whitespace',
      );
    });
  });
});
