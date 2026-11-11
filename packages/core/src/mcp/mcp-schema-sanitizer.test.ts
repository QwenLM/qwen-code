/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/runLogger.js', () => ({
  runLogger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  MCP_PROPERTY_KEY_PATTERN,
  restoreOriginalArgKeys,
  sanitizeMcpInputSchema,
} from './mcp-schema-sanitizer.js';
import { runLogger } from '../utils/runLogger.js';

describe('sanitizeMcpInputSchema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the input unchanged when every property key is valid', () => {
    const schema = {
      type: 'object',
      properties: { url: { type: 'string' }, depth: { type: 'integer' } },
      required: ['url'],
    };
    const { schema: out, keyMap } = sanitizeMcpInputSchema(schema);
    expect(out).toBe(schema);
    expect(keyMap).toBeNull();
  });

  it('drops ghost required entries not defined in properties (fast path)', () => {
    const schema = {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url', '//TODO: Add Field Name 0'],
    };
    const { schema: out, keyMap } = sanitizeMcpInputSchema(
      schema,
      'server/tool',
    );
    // A new object is produced because a ghost entry was pruned.
    expect(out).not.toBe(schema);
    expect((out as { required: string[] }).required).toEqual(['url']);
    // Properties remain untouched, no key rewriting happened.
    expect((out as { properties: unknown }).properties).toBe(schema.properties);
    expect(keyMap).toBeNull();
    expect(runLogger.warn).toHaveBeenCalledOnce();
  });

  it('keeps the original reference when every required entry is defined', () => {
    const schema = {
      type: 'object',
      properties: { url: { type: 'string' }, depth: { type: 'integer' } },
      required: ['url', 'depth'],
    };
    const { schema: out, keyMap } = sanitizeMcpInputSchema(schema);
    expect(out).toBe(schema);
    expect(keyMap).toBeNull();
    expect(runLogger.warn).not.toHaveBeenCalled();
  });

  it('drops ghost required entries while rewriting invalid keys', () => {
    const schema = {
      type: 'object',
      properties: {
        'a:b': { type: 'string' },
        url: { type: 'string' },
      },
      required: ['a:b', 'url', '//TODO: Add Field Name 0'],
    };
    const { schema: out, keyMap } = sanitizeMcpInputSchema(schema, 'server/tool');
    const required = (out as { required: string[] }).required;
    // Ghost entry is gone; renamed key is mapped, valid key stays.
    expect(required).toContain('url');
    expect(required).toContain('a_b');
    expect(required).not.toContain('//TODO: Add Field Name 0');
    expect(required).toHaveLength(2);
    expect(keyMap).not.toBeNull();
    expect(runLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('rewrites keys violating the API pattern and returns a keyMap', () => {
    const schema = {
      type: 'object',
      properties: {
        '8:BizyAir_NanoBanana2.prompt': { type: 'string' },
        '8:BizyAir_NanoBanana2.seed': { type: 'number' },
      },
      required: ['8:BizyAir_NanoBanana2.prompt'],
    };

    const { schema: out, keyMap } = sanitizeMcpInputSchema(
      schema,
      'nanobanana/generate',
    );

    expect(keyMap).not.toBeNull();
    const sanitizedProps = (out as { properties: Record<string, unknown> })
      .properties;
    const keys = Object.keys(sanitizedProps);

    // Every rewritten key conforms to the API pattern.
    for (const k of keys) {
      expect(k).toMatch(MCP_PROPERTY_KEY_PATTERN);
    }

    // Reverse-map entries exist for the two rewritten keys.
    expect(keyMap!.size).toBe(2);
    const sanitizedPrompt = [...keyMap!.entries()].find(
      ([, orig]) => orig === '8:BizyAir_NanoBanana2.prompt',
    )?.[0];
    expect(sanitizedPrompt).toBeDefined();

    // `required` is rewritten in lockstep.
    expect((out as { required: string[] }).required).toEqual([sanitizedPrompt]);

    expect(runLogger.warn).toHaveBeenCalledOnce();
  });

  it('resolves collisions by suffixing _1, _2', () => {
    const schema = {
      type: 'object',
      properties: {
        'a:b': { type: 'string' },
        'a/b': { type: 'string' },
        'a b': { type: 'string' },
      },
    };
    const { schema: out, keyMap } = sanitizeMcpInputSchema(schema);
    const keys = Object.keys(
      (out as { properties: Record<string, unknown> }).properties,
    );
    // All three collide to "a_b"; first wins, the others get numeric suffixes.
    expect(keys.sort()).toEqual(['a_b', 'a_b_1', 'a_b_2']);
    expect(keyMap!.size).toBe(3);
  });

  it('does not collide a sanitized key with an already-valid sibling', () => {
    const schema = {
      type: 'object',
      properties: {
        foo_bar: { type: 'string' },
        'foo:bar': { type: 'string' },
      },
    };
    const { schema: out } = sanitizeMcpInputSchema(schema);
    const keys = Object.keys(
      (out as { properties: Record<string, unknown> }).properties,
    );
    expect(keys).toContain('foo_bar');
    expect(keys).toContain('foo_bar_1');
  });

  it('returns input unchanged when schema has no properties object', () => {
    const schema = { type: 'string' };
    const { schema: out, keyMap } = sanitizeMcpInputSchema(schema);
    expect(out).toBe(schema);
    expect(keyMap).toBeNull();
  });

  it('drops ghost required entries from an object schema without properties', () => {
    const schema = {
      type: 'object',
      required: ['//TODO: Add Field Name 0'],
    };
    const { schema: out, keyMap } = sanitizeMcpInputSchema(
      schema,
      'server/tool',
    );
    expect(out).not.toBe(schema);
    expect((out as { required: string[] }).required).toEqual([]);
    expect(schema.required).toEqual(['//TODO: Add Field Name 0']);
    expect(keyMap).toBeNull();
    expect(runLogger.warn).toHaveBeenCalledOnce();
  });

  it('handles null / non-object inputs defensively', () => {
    expect(sanitizeMcpInputSchema(null)).toEqual({
      schema: null,
      keyMap: null,
    });
    expect(sanitizeMcpInputSchema(undefined)).toEqual({
      schema: undefined,
      keyMap: null,
    });
  });

  it('truncates keys longer than 64 characters', () => {
    const longKey = 'a:' + 'x'.repeat(200);
    const schema = {
      type: 'object',
      properties: { [longKey]: { type: 'string' } },
    };
    const { schema: out, keyMap } = sanitizeMcpInputSchema(schema);
    const keys = Object.keys(
      (out as { properties: Record<string, unknown> }).properties,
    );
    expect(keys[0].length).toBeLessThanOrEqual(64);
    expect(keyMap!.get(keys[0])).toBe(longKey);
  });

  it('preserves an already-valid key even when an earlier invalid sibling sanitizes to the same name', () => {
    // `foo:bar` is iterated first and would otherwise claim `foo_bar`,
    // overwriting the legitimate `foo_bar` that follows.
    const schema = {
      type: 'object',
      properties: {
        'foo:bar': { type: 'string', description: 'invalid' },
        foo_bar: { type: 'integer', description: 'valid' },
      },
    };
    const { schema: out, keyMap } = sanitizeMcpInputSchema(schema);
    const props = (
      out as { properties: Record<string, Record<string, unknown>> }
    ).properties;
    // The valid sibling keeps its slot intact.
    expect(props['foo_bar']).toEqual({
      type: 'integer',
      description: 'valid',
    });
    // The invalid one is suffixed.
    expect(props['foo_bar_1']).toEqual({
      type: 'string',
      description: 'invalid',
    });
    expect(keyMap!.get('foo_bar_1')).toBe('foo:bar');
    expect(keyMap!.has('foo_bar')).toBe(false);
  });

  it('keeps suffixed keys within the 64-char limit at extreme collision counts', () => {
    // 200 invalid keys all sanitize to the same long base, forcing
    // suffixes from `_1` up through `_199`.
    const longBase = 'a' + ':'.repeat(80);
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      properties[`${longBase}#${i}`] = { type: 'string' };
    }
    const { schema: out } = sanitizeMcpInputSchema({
      type: 'object',
      properties,
    });
    const keys = Object.keys(
      (out as { properties: Record<string, unknown> }).properties,
    );
    expect(keys).toHaveLength(200);
    for (const k of keys) {
      expect(k.length).toBeLessThanOrEqual(64);
      expect(k).toMatch(MCP_PROPERTY_KEY_PATTERN);
    }
    // All keys are unique.
    expect(new Set(keys).size).toBe(200);
  });
});

describe('restoreOriginalArgKeys', () => {
  it('returns args unchanged when keyMap is null or empty', () => {
    const args = { foo: 1 };
    expect(restoreOriginalArgKeys(args, null)).toBe(args);
    expect(restoreOriginalArgKeys(args, new Map())).toBe(args);
  });

  it('reverses sanitized keys back to the original names', () => {
    const keyMap = new Map([
      ['_8_BizyAir_NanoBanana2.prompt', '8:BizyAir_NanoBanana2.prompt'],
      ['_8_BizyAir_NanoBanana2.seed', '8:BizyAir_NanoBanana2.seed'],
    ]);
    const args = {
      '_8_BizyAir_NanoBanana2.prompt': 'hello',
      '_8_BizyAir_NanoBanana2.seed': 42,
    };
    const out = restoreOriginalArgKeys(args, keyMap);
    expect(out).toEqual({
      '8:BizyAir_NanoBanana2.prompt': 'hello',
      '8:BizyAir_NanoBanana2.seed': 42,
    });
  });

  it('leaves unmapped keys untouched while mapping the known ones', () => {
    const keyMap = new Map([['a_b', 'a:b']]);
    const out = restoreOriginalArgKeys({ a_b: 1, other: 2 }, keyMap);
    expect(out).toEqual({ 'a:b': 1, other: 2 });
  });

  it('returns same reference when no sanitized key appears in args', () => {
    const keyMap = new Map([['a_b', 'a:b']]);
    const args = { other: 1 };
    expect(restoreOriginalArgKeys(args, keyMap)).toBe(args);
  });
});
