/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parse, stringify } from './yaml-parser.js';

describe('yaml-parser', () => {
  describe('parse', () => {
    it('should parse simple key-value pairs', () => {
      const yaml = 'name: test\ndescription: A test config';
      const result = parse(yaml);
      expect(result).toEqual({
        name: 'test',
        description: 'A test config',
      });
    });

    it('should parse arrays', () => {
      const yaml = 'tools:\n  - file\n  - shell';
      const result = parse(yaml);
      expect(result).toEqual({
        tools: ['file', 'shell'],
      });
    });

    it('should parse nested objects', () => {
      const yaml = 'modelConfig:\n  temperature: 0.7\n  maxTokens: 1000';
      const result = parse(yaml);
      expect(result).toEqual({
        modelConfig: {
          temperature: 0.7,
          maxTokens: 1000,
        },
      });
    });

    it('should parse YAML folded block scalar (>)', () => {
      const input =
        'name: test-skill\ndescription: >\n  This is a folded\n  multiline description.';
      const result = parse(input);
      expect(result['name']).toBe('test-skill');
      expect(result['description']).toBe(
        'This is a folded multiline description.\n',
      );
    });

    it('should parse YAML literal block scalar (|)', () => {
      const input =
        'name: test-skill\ndescription: |\n  Line one.\n  Line two.';
      const result = parse(input);
      expect(result['name']).toBe('test-skill');
      expect(result['description']).toBe('Line one.\nLine two.\n');
    });

    it('should parse YAML block scalar with strip chomping (>-)', () => {
      const input =
        'name: test-skill\ndescription: >-\n  Folded without trailing newline.';
      const result = parse(input);
      expect(result['name']).toBe('test-skill');
      expect(result['description']).toBe('Folded without trailing newline.');
    });

    it('should not coerce date-like strings into Date objects', () => {
      const input = 'name: test\ncreated: 2024-01-01';
      const result = parse(input);
      expect(typeof result['created']).toBe('string');
      expect(result['created']).toBe('2024-01-01');
    });

    it('should strip bare keys with no value', () => {
      const input = 'name: test\nhooks:';
      const result = parse(input);
      expect(result['name']).toBe('test');
      expect(result['hooks']).toBeUndefined();
    });

    it('should strip explicit null and tilde values', () => {
      const input = 'a: null\nb: ~';
      const result = parse(input);
      expect(result['a']).toBeUndefined();
      expect(result['b']).toBeUndefined();
    });

    it('should treat yes/no as strings in YAML 1.2 core schema', () => {
      const input = 'answer: yes\nother: no';
      const result = parse(input);
      expect(result['answer']).toBe('yes');
      expect(result['other']).toBe('no');
    });

    it('should fall back to simple parser on invalid YAML', () => {
      const input = 'name: test\ndescription: value with unmatched "quote';
      const result = parse(input);
      expect(result['name']).toBe('test');
    });

    it('should handle empty input gracefully', () => {
      const result = parse('');
      expect(result).toEqual({});
    });

    it('should handle comment-only input gracefully', () => {
      const result = parse('# just a comment');
      expect(result).toEqual({});
    });
  });

  describe('stringify', () => {
    it('should stringify simple objects', () => {
      const obj = { name: 'test', description: 'A test config' };
      const result = stringify(obj);
      expect(result).toBe('name: test\ndescription: A test config');
    });

    it('should stringify arrays', () => {
      const obj = { tools: ['file', 'shell'] };
      const result = stringify(obj);
      expect(result).toBe('tools:\n  - file\n  - shell');
    });

    it('should stringify nested objects', () => {
      const obj = {
        modelConfig: {
          temperature: 0.7,
          maxTokens: 1000,
        },
      };
      const result = stringify(obj);
      expect(result).toBe(
        'modelConfig:\n  temperature: 0.7\n  maxTokens: 1000',
      );
    });

    describe('string escaping security', () => {
      it('should properly escape strings with quotes', () => {
        const obj = { key: 'value with "quotes"' };
        const result = stringify(obj);
        expect(result).toBe('key: "value with \\"quotes\\""');
      });

      it('should properly escape strings with backslashes', () => {
        const obj = { key: 'value with \\ backslash' };
        const result = stringify(obj);
        expect(result).toBe('key: "value with \\\\ backslash"');
      });

      it('should properly escape strings with backslash-quote sequences', () => {
        // This is the critical security test case
        const obj = { key: 'value with \\" sequence' };
        const result = stringify(obj);
        // Should escape backslashes first, then quotes
        expect(result).toBe('key: "value with \\\\\\" sequence"');
      });

      it('should handle complex escaping scenarios', () => {
        const testCases = [
          {
            input: { path: 'C:\\Program Files\\"App"\\file.txt' },
            expected: 'path: "C:\\\\Program Files\\\\\\"App\\"\\\\file.txt"',
          },
          {
            input: { message: 'He said: \\"Hello\\"' },
            expected: 'message: "He said: \\\\\\"Hello\\\\\\""',
          },
          {
            input: { complex: 'Multiple \\\\ backslashes \\" and " quotes' },
            expected:
              'complex: "Multiple \\\\\\\\ backslashes \\\\\\" and \\" quotes"',
          },
        ];

        testCases.forEach(({ input, expected }) => {
          const result = stringify(input);
          expect(result).toBe(expected);
        });
      });

      it('should maintain round-trip integrity for escaped strings', () => {
        const testStrings = [
          'simple string',
          'string with "quotes"',
          'string with \\ backslash',
          'string with \\" sequence',
          'path\\to\\"file".txt',
          'He said: \\"Hello\\"',
          'Multiple \\\\ backslashes \\" and " quotes',
        ];

        testStrings.forEach((testString) => {
          // Force quoting by adding a colon
          const originalObj = { key: testString + ':' };
          const yamlString = stringify(originalObj);
          const parsedObj = parse(yamlString);
          expect(parsedObj).toEqual(originalObj);
        });
      });

      it('should not quote strings that do not need quoting', () => {
        const obj = { key: 'simplevalue' };
        const result = stringify(obj);
        expect(result).toBe('key: simplevalue');
      });

      it('should quote strings with colons', () => {
        const obj = { key: 'value:with:colons' };
        const result = stringify(obj);
        expect(result).toBe('key: "value:with:colons"');
      });

      it('should quote strings with hash symbols', () => {
        const obj = { key: 'value#with#hash' };
        const result = stringify(obj);
        expect(result).toBe('key: "value#with#hash"');
      });

      it('should quote strings with leading/trailing whitespace', () => {
        const obj = { key: ' value with spaces ' };
        const result = stringify(obj);
        expect(result).toBe('key: " value with spaces "');
      });
    });

    describe('numeric string handling', () => {
      it('should parse unquoted numeric values as numbers', () => {
        const yaml = 'name: 11\ndescription: 333';
        const result = parse(yaml);
        expect(result).toEqual({
          name: 11,
          description: 333,
        });
        expect(typeof result['name']).toBe('number');
        expect(typeof result['description']).toBe('number');
      });

      it('should parse quoted numeric values as strings', () => {
        const yaml = 'name: "11"\ndescription: "333"';
        const result = parse(yaml);
        expect(result).toEqual({
          name: '11',
          description: '333',
        });
        expect(typeof result['name']).toBe('string');
        expect(typeof result['description']).toBe('string');
      });

      it('should handle mixed numeric and string values', () => {
        const yaml = 'name: "11"\nage: 25\ndescription: "333"';
        const result = parse(yaml);
        expect(result).toEqual({
          name: '11',
          age: 25,
          description: '333',
        });
        expect(typeof result['name']).toBe('string');
        expect(typeof result['age']).toBe('number');
        expect(typeof result['description']).toBe('string');
      });
    });
  });
});
