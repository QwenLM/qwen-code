/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, sanitizeValue, stringify } from './yaml-parser.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('./debugLogger.js', () => ({
  createDebugLogger: () => ({ warn }),
}));
vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>();
  return { ...actual, parseDocument: vi.fn(actual.parseDocument) };
});

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

  describe('positive raw cache', () => {
    let parseCached: typeof parse;
    let documentCalls: () => number;
    let conversionCalls: () => number;

    beforeEach(async () => {
      vi.resetModules();
      vi.clearAllMocks();
      vi.stubEnv('LOG_TOKENS', '');
      vi.stubEnv('LOG_STREAM', '');
      const yaml = await import('yaml');
      const documents = vi.spyOn(yaml, 'parseDocument');
      const conversions = vi.spyOn(yaml.Document.prototype, 'toJS');
      documentCalls = () => documents.mock.calls.length;
      conversionCalls = () => conversions.mock.calls.length;
      ({ parse: parseCached } = await import('./yaml-parser.js'));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it('reuses parsing while returning independent sanitized records and arrays', () => {
      const input =
        'source: &source {items: [one, null, two]}\ncopy: *source\n' +
        'hooks: {pre: [{command: original}]}\n__proto__: {marker: safe}';
      const first = parseCached(input);
      const source = first['source'] as Record<string, unknown>;
      (source['items'] as string[]).push('changed');
      const hooks = first['hooks'] as Record<string, unknown>;
      (hooks['pre'] as Array<Record<string, unknown>>)[0]!['command'] =
        'changed';
      (first['__proto__'] as Record<string, unknown>)['marker'] = 'changed';

      const second = parseCached(input);
      expect(second).toEqual({
        source: { items: ['one', 'two'] },
        copy: { items: ['one', 'two'] },
        hooks: { pre: [{ command: 'original' }] },
        ['__proto__']: { marker: 'safe' },
      });
      expect(first).not.toBe(second);
      for (const key of ['source', 'copy', 'hooks', '__proto__']) {
        expect(first[key]).not.toBe(second[key]);
        expect(Object.getPrototypeOf(second[key])).toBeNull();
      }
      expect(Object.getPrototypeOf(second)).toBeNull();
      expect((first['copy'] as Record<string, unknown>)['items']).toEqual([
        'one',
        'two',
      ]);
      expect(documentCalls()).toBe(1);
      expect(conversionCalls()).toBe(1);
    });

    it('keeps typed value coercion on cache hits', () => {
      const input =
        'date: !!timestamp 2024-01-01\nbytes: !!binary aGVsbG8=\n' +
        'set: !!set {one: null, two: null}\n' +
        'pairs: !!omap [{one: 1}, {two: 2}]';
      const first = parseCached(input);
      const second = parseCached(input);
      expect(second).toEqual({
        date: '2024-01-01T00:00:00.000Z',
        bytes: 'hello',
        set: {},
        pairs: {},
      });
      expect(second['set']).not.toBe(first['set']);
      expect(Object.getPrototypeOf(second['set'])).toBeNull();
      expect(documentCalls()).toBe(1);
      expect(conversionCalls()).toBe(1);
    });

    it('keys entries by the complete input text', () => {
      const inputs = [
        'name: exact\n',
        'name: exact\r\n',
        '# comment\nname: exact\n',
        'name: "exact"\n',
        '\uFEFFname: exact\n',
      ];
      for (const input of inputs) {
        expect(parseCached(input)).toEqual({ name: 'exact' });
        expect(parseCached(input)).toEqual({ name: 'exact' });
      }
      expect(documentCalls()).toBe(inputs.length);
      expect(conversionCalls()).toBe(inputs.length);
    });

    it('bounds input length in UTF-16 code units and bypasses oversized input', () => {
      const prefix = 'name: ';
      const input = prefix + '😀'.repeat((16_384 - prefix.length) / 2);
      expect(input.length).toBe(16_384);
      expect(parseCached(input)).toEqual(parseCached(input));
      expect(documentCalls()).toBe(1);
      expect(conversionCalls()).toBe(1);
      const oversized = input + 'x';
      expect(parseCached(oversized)).toEqual(parseCached(oversized));
      expect(documentCalls()).toBe(1);
      expect(conversionCalls()).toBe(3);
    });

    it('evicts the oldest of 256 entries without refreshing hits', () => {
      const inputs = Array.from({ length: 256 }, (_, i) => `name: fifo-${i}`);
      for (const input of inputs) parseCached(input);
      parseCached(inputs[0]!);
      parseCached('name: fifo-256');
      expect(documentCalls()).toBe(257);
      parseCached(inputs[0]!);
      expect(documentCalls()).toBe(258);
      parseCached(inputs[255]!);
      expect(documentCalls()).toBe(258);
    });

    it.each([
      ['collection', '? [one, two]\n: value'],
      ['alias', 'source: &key [one, two]\n? *key\n: value'],
      ['timestamp', '? !!timestamp 2024-01-01\n: value'],
      ['binary', '? !!binary aGVsbG8=\n: value'],
    ])(
      'preserves the conversion warning for %s keys on every call',
      (_, input) => {
        const warnings = vi
          .spyOn(process, 'emitWarning')
          .mockImplementation(() => {});
        expect(parseCached(input)).toEqual(parseCached(input));
        expect(warnings).toHaveBeenCalledTimes(2);
        for (const [warning] of warnings.mock.calls) {
          expect(String(warning)).toContain('Keys with collection values');
        }
        expect(warn).not.toHaveBeenCalled();
        expect(documentCalls()).toBe(2);
        expect(conversionCalls()).toBe(2);
      },
    );

    it('preserves document warnings on every call', () => {
      const warnings = vi
        .spyOn(process, 'emitWarning')
        .mockImplementation(() => {});
      const input = 'name: !unknown value';
      expect(parseCached(input)).toEqual(parseCached(input));
      expect(warnings).toHaveBeenCalledTimes(2);
      for (const [warning] of warnings.mock.calls) {
        expect(warning).toMatchObject({ code: 'TAG_RESOLVE_FAILED' });
      }
      expect(warn).not.toHaveBeenCalled();
      expect(documentCalls()).toBe(2);
    });

    it.each([
      ['syntax', 'name: fallback\nbroken: [unclosed'],
      ['duplicate key', 'name: first\nname: second'],
      ['multiple documents', 'name: first\n---\nname: second'],
      ['cycle', 'name: cycle\nloop: &loop {self: *loop}'],
      [
        'excessive aliases',
        'a: &a [x,x,x,x,x,x,x,x,x,x]\n' +
          'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\n' +
          'c: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      ],
      ['scalar', 'plain'],
      ['array', '[one, two]'],
      ['null', 'null'],
      ['empty', ''],
    ])('does not cache %s fallback results', (_, input) => {
      const first = parseCached(input);
      const second = parseCached(input);
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(Object.getPrototypeOf(second)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(documentCalls()).toBe(2);
    });

    it.each([
      ['LOG_TOKENS', '1', 'log'],
      ['LOG_TOKENS', '0', 'log'],
      ['LOG_STREAM', '1', 'dir'],
      ['LOG_STREAM', '0', 'dir'],
    ] as const)(
      'preserves one original parse for %s=%s',
      async (flag, value, method) => {
        const yaml = await import('yaml');
        const output = vi.spyOn(console, method).mockImplementation(() => {});
        const warnings = vi
          .spyOn(process, 'emitWarning')
          .mockImplementation(() => {});
        const input = 'name: debug\nmetadata: {items: [one, null]}';
        const expected = parseCached(input);
        parseCached(input);
        expect(documentCalls()).toBe(1);
        expect(conversionCalls()).toBe(1);
        vi.stubEnv(flag, value);
        for (const text of [input, '? [one, two]\n: value']) {
          output.mockClear();
          warnings.mockClear();
          const original = sanitizeValue(
            yaml.parse(text, {
              schema: 'core',
              customTags: (tags) =>
                tags.filter((tag) => {
                  const uri = typeof tag === 'string' ? tag : tag.tag;
                  return ![
                    'tag:yaml.org,2002:timestamp',
                    'tag:yaml.org,2002:binary',
                    'timestamp',
                    'binary',
                  ].includes(uri);
                }),
            }),
          );
          const originalOutput = output.mock.calls.slice();
          const originalWarnings = warnings.mock.calls.slice();
          expect(originalOutput.length).toBeGreaterThan(0);
          const convertedBefore = conversionCalls();
          for (let i = 0; i < 2; i++) {
            output.mockClear();
            warnings.mockClear();
            expect(parseCached(text)).toEqual(original);
            expect(output.mock.calls).toEqual(originalOutput);
            expect(warnings.mock.calls).toEqual(originalWarnings);
          }
          expect(documentCalls()).toBe(1);
          expect(conversionCalls()).toBe(convertedBefore + 2);
        }
        vi.stubEnv(flag, '');
        output.mockClear();
        const convertedBefore = conversionCalls();
        expect(parseCached(input)).toEqual(expected);
        expect(output).not.toHaveBeenCalled();
        expect(documentCalls()).toBe(1);
        expect(conversionCalls()).toBe(convertedBefore);
      },
    );
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
          { filesystem: { type: 'stdio', command: 'node' } },
        ]);
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
