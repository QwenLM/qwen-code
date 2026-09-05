/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseWorkflowMetaLiteral,
  WorkflowMetaSyntaxError,
} from './workflow-meta-literal.js';

/** Strip null prototypes so `toEqual` compares against plain object literals. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return value;
}

describe('parseWorkflowMetaLiteral', () => {
  describe('the contract shape', () => {
    it('parses the minimal required fields', () => {
      expect(
        plain(parseWorkflowMetaLiteral(`{ name: 'w', description: 'd' }`)),
      ).toEqual({ name: 'w', description: 'd' });
    });

    it('parses the full contract including phases', () => {
      const src = `{
        name: 'deep-research',
        description: 'Research a question across sources',
        whenToUse: 'when the question spans sources',
        phases: [
          { title: 'Scout', detail: 'find the sources' },
          { title: 'Read', detail: 'read each one', model: 'fast' },
          { title: 'Synthesize' },
        ],
      }`;
      expect(plain(parseWorkflowMetaLiteral(src))).toEqual({
        name: 'deep-research',
        description: 'Research a question across sources',
        whenToUse: 'when the question spans sources',
        phases: [
          { title: 'Scout', detail: 'find the sources' },
          { title: 'Read', detail: 'read each one', model: 'fast' },
          { title: 'Synthesize' },
        ],
      });
    });
  });

  describe('the JS spellings a model actually writes', () => {
    it.each([
      ['double-quoted keys and values', `{ "name": "w", "description": "d" }`],
      ['single quotes', `{ name: 'w', description: 'd' }`],
      ['substitution-free template strings', '{ name: `w`, description: `d` }'],
      ['trailing comma in an object', `{ name: 'w', description: 'd', }`],
      ['line comments', `{ // lead\n name: 'w', description: 'd' }`],
      ['block comments', `{ /* a */ name: 'w', /* b */ description: 'd' }`],
    ])('accepts %s', (_label, src) => {
      expect(plain(parseWorkflowMetaLiteral(src))).toEqual({
        name: 'w',
        description: 'd',
      });
    });

    it('accepts a trailing comma in an array', () => {
      const src = `{ name: 'w', description: 'd', phases: [{ title: 'A' },] }`;
      expect(plain(parseWorkflowMetaLiteral(src))).toEqual({
        name: 'w',
        description: 'd',
        phases: [{ title: 'A' }],
      });
    });

    it('accepts a multi-line template string', () => {
      const src = '{ name: `a\nb`, description: `d` }';
      expect(plain(parseWorkflowMetaLiteral(src))).toEqual({
        name: 'a\nb',
        description: 'd',
      });
    });

    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
      ['CR', '\r'],
      ['line separator', '\u2028'],
      ['paragraph separator', '\u2029'],
    ])('ends a line comment at %s', (_label, terminator) => {
      const src =
        `{ name: 'w', description: 'd' // note` +
        terminator +
        `, whenToUse: 'u' }`;
      expect(plain(parseWorkflowMetaLiteral(src))).toEqual({
        name: 'w',
        description: 'd',
        whenToUse: 'u',
      });
    });

    it('accepts numbers, booleans and null in non-contract fields', () => {
      const src = `{ name: 'w', description: 'd', n: -1.5e3, b: true, f: false, z: null }`;
      expect(plain(parseWorkflowMetaLiteral(src))).toEqual({
        name: 'w',
        description: 'd',
        n: -1500,
        b: true,
        f: false,
        z: null,
      });
    });

    it('treats get/set/async as ordinary keys when no property name follows', () => {
      const src = `{ name: 'w', description: 'd', get: 'a', set: 'b', async: 'c' }`;
      expect(plain(parseWorkflowMetaLiteral(src))).toEqual({
        name: 'w',
        description: 'd',
        get: 'a',
        set: 'b',
        async: 'c',
      });
    });
  });

  // The hand-rolled escape handling is the fiddliest part of the parser, so
  // each form is pinned against the equivalent JS string literal rather than
  // against a hand-written expectation.
  describe('string escapes', () => {
    it.each([
      ['\\n', '\n'],
      ['\\t', '\t'],
      ['\\r', '\r'],
      ['\\b', '\b'],
      ['\\f', '\f'],
      ['\\v', '\v'],
      ['\\0', '\0'],
      ['\\\\', '\\'],
      ['\\/', '/'],
      ['\\x41', 'A'],
      ['\\u0041', 'A'],
      ['\\u{1F600}', '\u{1F600}'],
      ['\\u{41}', 'A'],
      ['\\q', 'q'],
    ])('decodes %s', (escape, expected) => {
      const { name } = parseWorkflowMetaLiteral(
        `{ name: "${escape}", description: "d" }`,
      ) as { name: string };
      expect(name).toBe(expected);
    });

    it('decodes a quote escaped with its own quote character', () => {
      expect(
        parseWorkflowMetaLiteral(
          `{ name: 'it\\'s', description: "a\\"b" }`,
        ) as {
          name: string;
          description: string;
        },
      ).toMatchObject({ name: "it's", description: 'a"b' });
    });

    it('treats a backslash-newline as a line continuation', () => {
      const { name } = parseWorkflowMetaLiteral(
        '{ name: "a\\\nb", description: "d" }',
      ) as { name: string };
      expect(name).toBe('ab');
    });

    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
      ['CR', '\r'],
      ['line separator', '\u2028'],
      ['paragraph separator', '\u2029'],
    ])('treats a backslash-%s as a line continuation', (_label, terminator) => {
      for (const quote of ['"', "'", '`']) {
        const src =
          `{ name: ${quote}a\\` + terminator + `b${quote}, description: 'd' }`;
        const { name } = parseWorkflowMetaLiteral(src) as { name: string };
        expect(name).toBe('ab');
      }
    });

    it.each([
      ['CR', '\r'],
      ['CRLF', '\r\n'],
    ])('cooks raw %s to LF in a template string', (_label, terminator) => {
      const { name } = parseWorkflowMetaLiteral(
        '{ name: `a' + terminator + "b`, description: 'd' }",
      ) as { name: string };
      expect(name).toBe('a\nb');
    });

    it('preserves non-ASCII text verbatim', () => {
      const { name } = parseWorkflowMetaLiteral(
        `{ name: '工作流 🪜', description: 'd' }`,
      ) as { name: string };
      expect(name).toBe('工作流 🪜');
    });

    it.each([
      ['an octal escape', String.raw`{ name: "\01", description: "d" }`],
      ['a short \\x escape', String.raw`{ name: "\xZZ", description: "d" }`],
      ['a short \\u escape', String.raw`{ name: "\u00", description: "d" }`],
      [
        'an out-of-range \\u{} escape',
        String.raw`{ name: "\u{FFFFFF}", description: "d" }`,
      ],
      ['an unterminated escape', `{ name: "a\\`],
    ])('rejects %s', (_label, src) => {
      expect(() => parseWorkflowMetaLiteral(src)).toThrow(
        WorkflowMetaSyntaxError,
      );
    });

    it('rejects a newline inside a non-template string', () => {
      expect(() =>
        parseWorkflowMetaLiteral('{ name: "a\nb", description: "d" }'),
      ).toThrow(/unterminated string/);
    });

    it.each(['"', "'"])('rejects a raw CR inside a %s string', (quote) => {
      expect(() =>
        parseWorkflowMetaLiteral(
          `{ name: ${quote}a\rb${quote}, description: 'd' }`,
        ),
      ).toThrow(/unterminated string/);
    });
  });

  // Each of these drove at least one review finding while meta was evaluated.
  // They are not "bounded" now — they are unrepresentable.
  describe('everything that would mean "evaluate something"', () => {
    it.each([
      [
        'an identifier',
        `{ name: someVar, description: 'd' }`,
        /unsupported value/,
      ],
      ['a call', `{ name: compute(), description: 'd' }`, /unsupported value/],
      [
        'an IIFE',
        `{ name: (function(){ while(true){} })(), description: 'd' }`,
        /unsupported value/,
      ],
      [
        'a getter',
        `{ name: 'x', description: 'd', get phases() { return []; } }`,
        /getters are not allowed/,
      ],
      [
        'a setter',
        `{ name: 'x', description: 'd', set phases(v) {} }`,
        /setters are not allowed/,
      ],
      [
        'a method',
        `{ name: 'x', description: 'd', toString() { return 'x'; } }`,
        /methods are not allowed/,
      ],
      [
        'an async member',
        `{ name: 'x', description: 'd', async load() {} }`,
        /async members are not allowed/,
      ],
      [
        'a spread',
        `{ ...other, name: 'x', description: 'd' }`,
        /spread is not allowed/,
      ],
      [
        'a computed key',
        `{ ['na' + 'me']: 'x', description: 'd' }`,
        /computed keys are not allowed/,
      ],
      [
        'a template substitution',
        '{ name: `v${version}`, description: `d` }',
        /template substitutions are not allowed/,
      ],
      [
        'a regex literal',
        `{ name: 'x', description: 'd', pattern: /a[b]c/g }`,
        /regular expressions are not allowed/,
      ],
      [
        'a dynamic import',
        `{ name: 'x', description: import('node:fs') }`,
        /unsupported value/,
      ],
      [
        'a new expression',
        `{ name: new String('x'), description: 'd' }`,
        /unsupported value/,
      ],
      [
        'an operator',
        `{ name: 'a' + 'b', description: 'd' }`,
        /expected "," or "}"/,
      ],
      [
        'a bigint',
        `{ name: 'x', description: 'd', n: 1n }`,
        /unsupported numeric literal/,
      ],
      [
        'a hex literal',
        `{ name: 'x', description: 'd', n: 0x10 }`,
        /unsupported numeric literal/,
      ],
      [
        'an array hole',
        `{ name: 'x', description: 'd', phases: [, {}] }`,
        /missing array element/,
      ],
    ])('rejects %s', (_label, src, pattern) => {
      expect(() => parseWorkflowMetaLiteral(src)).toThrow(pattern);
    });

    it('names the rule in every rejection so the author knows what to write', () => {
      try {
        parseWorkflowMetaLiteral(`{ name: someVar, description: 'd' }`);
        throw new Error('expected a rejection');
      } catch (e) {
        expect((e as Error).message).toMatch(
          /meta must be a plain object literal/,
        );
        expect((e as Error).message).toMatch(/no variables, function calls/);
      }
    });

    it('reports the offending position', () => {
      try {
        parseWorkflowMetaLiteral(`{ name: 'x', description: someVar }`);
        throw new Error('expected a rejection');
      } catch (e) {
        expect(e).toBeInstanceOf(WorkflowMetaSyntaxError);
        expect((e as WorkflowMetaSyntaxError).index).toBe(26);
      }
    });
  });

  describe('structural limits', () => {
    it('rejects nesting past the depth cap without overflowing the stack', () => {
      const src = `{ name: 'x', description: 'd', a: ${'['.repeat(200)}${']'.repeat(200)} }`;
      expect(() => parseWorkflowMetaLiteral(src)).toThrow(/nested too deeply/);
    });

    it('accepts nesting up to the depth cap', () => {
      const src = `{ a: ${'['.repeat(30)}${']'.repeat(30)} }`;
      expect(() => parseWorkflowMetaLiteral(src)).not.toThrow();
    });

    it.each([
      ['an unterminated object', `{ name: 'x'`],
      ['an unterminated array', `{ name: 'x', phases: [`],
      ['an unterminated comment', `{ /* name: 'x' }`],
      ['trailing content', `{ name: 'x', description: 'd' } trailing`],
      ['a missing colon', `{ name 'x' }`],
      ['an empty source', ``],
    ])('rejects %s', (_label, src) => {
      expect(() => parseWorkflowMetaLiteral(src)).toThrow(
        WorkflowMetaSyntaxError,
      );
    });
  });

  // A `__proto__` key in JSON.parse is an own property; in an object literal it
  // would set the prototype. The parser builds null-prototype objects so the
  // key is inert either way.
  describe('prototype safety', () => {
    it('treats __proto__ as an ordinary own key and does not pollute', () => {
      const value = parseWorkflowMetaLiteral(
        `{ name: 'x', description: 'd', "__proto__": { polluted: 1 } }`,
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(value)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(
        true,
      );
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('treats constructor as an ordinary key', () => {
      const value = parseWorkflowMetaLiteral(
        `{ name: 'x', description: 'd', constructor: 'safe' }`,
      ) as Record<string, unknown>;
      expect(value['constructor']).toBe('safe');
    });
  });
});
