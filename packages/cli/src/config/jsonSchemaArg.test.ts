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
    // The root-type check fires first for an integer `type`; drop type
    // entirely to exercise the Ajv compile-path rejection instead.
    expect(() =>
      resolveJsonSchemaArg('{"properties":{"foo":{"type":42}}}'),
    ).toThrow(/not a valid JSON Schema/);
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

  it('rejects a schema whose root type is not object', () => {
    expect(() => resolveJsonSchemaArg('{"type":"array"}')).toThrow(
      /must accept object-typed values/,
    );
    expect(() => resolveJsonSchemaArg('{"type":"string"}')).toThrow(
      /must accept object-typed values/,
    );
  });

  it('accepts a schema whose type array includes "object"', () => {
    // Rare but valid; don't over-restrict nullable object roots.
    const schema = resolveJsonSchemaArg('{"type":["object","null"]}');
    expect(schema).toEqual({ type: ['object', 'null'] });
  });

  it('accepts a schema without an explicit root type', () => {
    // Absent type is tolerated — Ajv treats it as "anything" which covers
    // the object case the model will actually submit.
    const schema = resolveJsonSchemaArg('{"properties":{"foo":{}}}');
    expect(schema).toBeDefined();
  });

  it('rejects root anyOf where no branch accepts object', () => {
    expect(() =>
      resolveJsonSchemaArg('{"anyOf":[{"type":"array"},{"type":"string"}]}'),
    ).toThrow(/must accept object-typed values/);
  });

  it('rejects root oneOf where no branch accepts object', () => {
    expect(() =>
      resolveJsonSchemaArg('{"oneOf":[{"type":"number"},{"type":"boolean"}]}'),
    ).toThrow(/must accept object-typed values/);
  });

  it('accepts root anyOf when at least one branch accepts object', () => {
    const schema = resolveJsonSchemaArg(
      '{"anyOf":[{"type":"object"},{"type":"string"}]}',
    );
    expect(schema).toBeDefined();
  });

  it('accepts nested anyOf/oneOf chains where a deep branch accepts object', () => {
    // The recursion should see through one level of nesting.
    const schema = resolveJsonSchemaArg(
      '{"anyOf":[{"oneOf":[{"type":"object"}]},{"type":"string"}]}',
    );
    expect(schema).toBeDefined();
  });

  it('rejects type:"object" combined with an anyOf that excludes object', () => {
    // type and anyOf are AND'd at the same level — type:"object" alone is
    // not enough if a sibling anyOf forbids every object branch. Without
    // this check the synthetic tool would register an unsatisfiable schema.
    expect(() =>
      resolveJsonSchemaArg(
        '{"type":"object","anyOf":[{"type":"string"},{"type":"number"}]}',
      ),
    ).toThrow(/must accept object-typed values/);
  });

  it('accepts type:"object" combined with anyOf where one branch admits object', () => {
    const schema = resolveJsonSchemaArg(
      '{"type":"object","anyOf":[{"type":"object","properties":{"a":{"type":"string"}}},{"type":"object","properties":{"b":{"type":"number"}}}]}',
    );
    expect(schema).toBeDefined();
  });

  it('rejects a bare root $ref without a sibling type:"object" anchor', () => {
    // We don't follow $refs ourselves; without a sibling `type:"object"` we
    // can't tell whether the resolved schema admits objects, so refuse to
    // register a synthetic tool whose parameter contract is "whatever this
    // $ref points to".
    expect(() =>
      resolveJsonSchemaArg(
        '{"$ref":"#/$defs/Foo","$defs":{"Foo":{"type":"array"}}}',
      ),
    ).toThrow(/must accept object-typed values/);
  });

  it('accepts a root $ref when the user anchors it with type:"object"', () => {
    // Sibling `type:"object"` is the explicit opt-out — the user is telling
    // us the resolved schema describes an object. Trust that and let Ajv
    // surface any deeper mismatch at runtime.
    const schema = resolveJsonSchemaArg(
      '{"type":"object","$ref":"#/$defs/Foo","$defs":{"Foo":{"type":"object","properties":{"a":{"type":"string"}}}}}',
    );
    expect(schema).toBeDefined();
  });

  it('rejects allOf where any branch forbids object at the root', () => {
    // allOf is conjunctive — every branch must accept object. A schema
    // like `allOf:[{type:"object"}, {type:"string"}]` is unsatisfiable.
    expect(() =>
      resolveJsonSchemaArg('{"allOf":[{"type":"object"},{"type":"string"}]}'),
    ).toThrow(/must accept object-typed values/);
  });

  it('accepts allOf where every branch admits object', () => {
    const schema = resolveJsonSchemaArg(
      '{"allOf":[{"type":"object","properties":{"a":{"type":"string"}}},{"type":"object","required":["a"]}]}',
    );
    expect(schema).toBeDefined();
  });
});
