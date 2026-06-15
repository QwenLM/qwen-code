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
      // Unclosed flow sequence triggers a yaml.parse error
      const input = 'name: test\nallowedTools: [unclosed';
      const result = parse(input);
      expect(result['name']).toBe('test');
    });

    it('should strip null values in fallback path same as main path', () => {
      // Unclosed flow forces fallback to parseSimple; explicit null
      // must be stripped so callers can use `!== undefined` consistently.
      const input = 'name: test\noptional: null\nbroken: [unclosed';
      const result = parse(input);
      expect(result['name']).toBe('test');
      expect(result['optional']).toBeUndefined();
      expect('optional' in result).toBe(false);
    });

    it('should not allow prototype pollution via simple parser fallback', () => {
      // Crafted to fail yaml.parse (unclosed flow) and trigger parseSimple,
      // where __proto__ as a nested-object key could pollute the prototype.
      const input =
        '__proto__:\n  polluted: true\nname: test\nbroken: [unclosed';
      const result = parse(input);
      expect(result['name']).toBe('test');
      const clean: Record<string, unknown> = {};
      expect(clean['polluted']).toBeUndefined();
      expect(Object.getPrototypeOf(result)).toBeNull();
    });

    it('should handle empty input gracefully', () => {
      const result = parse('');
      expect(result).toEqual({});
    });

    it('should handle comment-only input gracefully', () => {
      const result = parse('# just a comment');
      expect(result).toEqual({});
    });

    it('should not allow prototype pollution via __proto__ key', () => {
      const input = 'name: legit\n__proto__:\n  polluted: true';
      const result = parse(input);
      expect(result['name']).toBe('legit');
      // result uses null prototype — __proto__ is a plain own property
      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(Object.hasOwn(result, '__proto__')).toBe(true);
    });

    it('should not resolve !!timestamp explicit tags', () => {
      const input = 'name: test\ncreated: !!timestamp 2024-01-01';
      const result = parse(input);
      expect(typeof result['created']).toBe('string');
    });

    it('should sanitize nested objects recursively', () => {
      const input =
        'name: test\nmetadata:\n  created: !!timestamp 2024-01-01\n  note: hello';
      const result = parse(input);
      const metadata = result['metadata'] as Record<string, unknown>;
      expect(typeof metadata['created']).toBe('string');
      expect(metadata['note']).toBe('hello');
      expect(Object.getPrototypeOf(metadata)).toBeNull();
    });
  });

  describe('stringify', () => {
    // Stringify now delegates to eemeli/yaml's serializer, which appends a
    // trailing newline and is free to choose among equivalent serializations
    // depending on content. Assertions therefore check round-trip rather
    // than byte-exact output.
    it('should stringify simple objects', () => {
      const obj = { name: 'test', description: 'A test config' };
      expect(parse(stringify(obj))).toEqual(obj);
    });

    it('should stringify arrays', () => {
      const obj = { tools: ['file', 'shell'] };
      expect(parse(stringify(obj))).toEqual(obj);
    });

    it('should stringify nested objects', () => {
      const obj = {
        modelConfig: {
          temperature: 0.7,
          maxTokens: 1000,
        },
      };
      expect(parse(stringify(obj))).toEqual(obj);
    });

    describe('round-trip integrity', () => {
      // Property-based: parse(stringify(x)) === x. We no longer pin the
      // exact YAML bytes — eemeli/yaml's stringify legitimately chooses
      // among equivalent plain / quoted / block-scalar representations
      // depending on content. The contract that matters at the API
      // boundary is round-trip.
      it.each([
        ['simple string', 'simplevalue'],
        ['with quotes', 'value with "quotes"'],
        ['with backslash', 'value with \\ backslash'],
        ['with backslash-quote', 'value with \\" sequence'],
        ['windows-style path', 'C:\\Program Files\\"App"\\file.txt'],
        ['containing colon', 'value:with:colons'],
        ['containing hash', 'value#with#hash'],
        ['leading/trailing spaces', ' value with spaces '],
        ['multiline newlines', 'line one\nline two\nline three'],
        ['unicode', '中文 — naïve café'],
      ])('round-trips: %s', (_label, str) => {
        const obj = { key: str };
        expect(parse(stringify(obj))).toEqual(obj);
      });
    });

    describe('nested round-trip for mcpServers / hooks', () => {
      // The previous hand-rolled stringifier emitted `[object Object]` for
      // any value below the first level of nesting. With yaml.stringify
      // the CC-shape `mcpServers` (record-of-records) and `hooks`
      // (record-of-array-of-records) now round-trip cleanly.
      it('round-trips a CC-shape mcpServers block', () => {
        const obj = {
          mcpServers: {
            filesystem: {
              type: 'stdio',
              command: 'node',
              args: ['/path/to/server.js'],
            },
          },
        };
        expect(parse(stringify(obj))).toEqual(obj);
      });

      it('round-trips a CC-shape hooks block', () => {
        const obj = {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'echo before' }],
              },
            ],
          },
        };
        expect(parse(stringify(obj))).toEqual(obj);
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

    describe('nested YAML', () => {
      it('parses array-of-records', () => {
        const yaml =
          'mcpServers:\n  - filesystem:\n      type: stdio\n      command: node';
        const result = parse(yaml);
        expect(result['mcpServers']).toEqual([
          {
            filesystem: {
              type: 'stdio',
              command: 'node',
            },
          },
        ]);
        expect(result['type']).toBeUndefined();
        expect(result['command']).toBeUndefined();
      });

      it('parses record-of-records with arrays', () => {
        const yaml = 'hooks:\n  PreToolUse:\n    - matcher: Read';
        const result = parse(yaml);
        expect(result['hooks']).toEqual({
          PreToolUse: [{ matcher: 'Read' }],
        });
      });
    });
  });
});
