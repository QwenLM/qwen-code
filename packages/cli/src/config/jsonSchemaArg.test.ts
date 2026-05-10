/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveJsonSchemaArg } from './config.js';

describe('resolveJsonSchemaArg', () => {
  it('returns undefined when the arg is absent', () => {
    expect(resolveJsonSchemaArg(undefined)).toBeUndefined();
  });

  it('parses an inline JSON literal into a schema object', () => {
    const schema = resolveJsonSchemaArg(
      '{"type":"object","properties":{"summary":{"type":"string"}}}',
    );
    expect(schema).toEqual({
      type: 'object',
      properties: { summary: { type: 'string' } },
    });
  });

  it('reads schema from disk via @path syntax', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-schema-'));
    const file = path.join(tmp, 'schema.json');
    fs.writeFileSync(file, '{"type":"object"}');
    try {
      const schema = resolveJsonSchemaArg(`@${file}`);
      expect(schema).toEqual({ type: 'object' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws on empty string', () => {
    expect(() => resolveJsonSchemaArg('   ')).toThrow(/cannot be empty/);
  });

  it('throws on invalid JSON', () => {
    expect(() => resolveJsonSchemaArg('{not json}')).toThrow(/not valid JSON/);
  });

  it('throws when the parsed value is not an object', () => {
    expect(() => resolveJsonSchemaArg('[]')).toThrow(/must be a JSON object/);
    expect(() => resolveJsonSchemaArg('"just a string"')).toThrow(
      /must be a JSON object/,
    );
  });

  it('throws when the referenced file does not exist', () => {
    expect(() =>
      resolveJsonSchemaArg('@/this/path/does/not/exist.json'),
    ).toThrow(/could not read/);
  });

  it('throws when schema is syntactically JSON but invalid as a JSON Schema', () => {
    // `type` must be a string or array, not a number.
    expect(() => resolveJsonSchemaArg('{"type": 42}')).toThrow(
      /not a valid JSON Schema/,
    );
  });

  it('accepts a minimal empty-object schema', () => {
    // `{}` is a valid schema that accepts anything.
    expect(resolveJsonSchemaArg('{}')).toEqual({});
  });

  it('accepts a draft-2020-12 schema', () => {
    const schema = resolveJsonSchemaArg(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}',
    );
    expect(schema).toBeDefined();
  });

  it('rejects schemas whose top-level type is not "object"', () => {
    // The schema becomes structured_output's parameter schema; tool args
    // are object-shaped, so non-object roots can never be satisfied.
    expect(() => resolveJsonSchemaArg('{"type":"string"}')).toThrow(
      /top-level type must include "object"/,
    );
    expect(() => resolveJsonSchemaArg('{"type":"array"}')).toThrow(
      /top-level type must include "object"/,
    );
  });

  it('accepts type-arrays that include "object"', () => {
    // `{"type":["object","null"]}` is a common nullable-object pattern.
    // The earlier guard rejected anything that wasn't exactly the string
    // "object", which broke this idiom.
    expect(
      resolveJsonSchemaArg(
        '{"type":["object","null"],"properties":{"x":{"type":"string"}}}',
      ),
    ).toEqual({
      type: ['object', 'null'],
      properties: { x: { type: 'string' } },
    });
  });

  it('rejects type-arrays that do not include "object"', () => {
    expect(() => resolveJsonSchemaArg('{"type":["string","number"]}')).toThrow(
      /top-level type must include "object"/,
    );
  });
});
