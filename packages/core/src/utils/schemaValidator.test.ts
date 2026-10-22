/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { SchemaValidator } from './schemaValidator.js';
import { expectWithinLatencyBudget } from '../test-utils/latency-budget.js';

const debugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./debugLogger.js', () => ({
  createDebugLogger: () => debugLogger,
}));

// The compile cache lives as long as the module. A test that builds its
// schemas from names of its own on every attempt, a retry included, meets the
// cache as its first attempt did.
let probes = 0;
const probe = (name: string) => `${name}${probes++}`;

const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema';

// Schema builders. Each call returns fresh objects: the validator memoizes by
// schema object identity, so fixtures must not share sub-schemas.
// `{ type: 'object', properties }`, plus `required` only when names are given.
const obj = (properties: Record<string, unknown>, ...required: string[]) => ({
  type: 'object',
  properties,
  ...(required.length > 0 && { required }),
});
const arrayOf = (items: unknown) => ({ type: 'array', items });
const strings = () => arrayOf({ type: 'string' });
const anyOf = (...types: string[]) => ({
  anyOf: types.map((type) => ({ type })),
});
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });

// Validation must pass; returns the params, which it coerces in place.
const valid = <T>(schema: unknown, params: T): T => {
  expect(SchemaValidator.validate(schema, params)).toBeNull();
  return params;
};
// Validation must fail; returns the params.
const invalid = <T>(schema: unknown, params: T): T => {
  expect(SchemaValidator.validate(schema, params)).not.toBeNull();
  return params;
};
// Runs validation (and so the coercion passes) without asserting its result.
const coerced = <T>(schema: unknown, params: T): T => {
  SchemaValidator.validate(schema, params);
  return params;
};

describe('SchemaValidator', () => {
  it('strictly validates without coercing application data', () => {
    const schema = {
      ...obj({ count: { type: 'integer' } }, 'count'),
      additionalProperties: false,
    };
    const value = { count: '3' };

    expect(SchemaValidator.validateStrict(schema, value)).not.toBeNull();
    expect(value).toEqual({ count: '3' });
    expect(SchemaValidator.validateStrict(schema, { count: 3 })).toBeNull();
  });

  it('should allow any params if schema is undefined', () => {
    expect(SchemaValidator.validate(undefined, { foo: 'bar' })).toBeNull();
  });

  it.each([
    ['rejects null params', null],
    ['rejects params that are not objects', 'not an object'],
  ])('%s', (_title, params) => {
    expect(
      SchemaValidator.validate(obj({ foo: { type: 'string' } }), params),
    ).toBe('Value of params must be an object');
  });

  it('allows schema with extra properties', () => {
    const schema = obj({
      example_enum: {
        type: 'string',
        enum: ['FOO', 'BAR'],
        // enum-descriptions is not part of the JSON schema spec. This test
        // verifies that the validator allows extra keywords like this one.
        'enum-descriptions': ['a foo', 'a bar'],
      },
    });
    valid(schema, { example_enum: 'BAR' });
  });

  it('allows custom format values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      description: probe('customFormats'),
      ...obj({
        // See: https://cloud.google.com/docs/discovery/type-format
        duration: { type: 'string', format: 'google-duration' },
        mask: { type: 'string', format: 'google-fieldmask' },
        foo: { type: 'string', format: 'something-totally-custom' },
      }),
    };
    const params = {
      duration: '10s',
      mask: 'foo.bar,biz.baz',
      foo: 'some value',
    };
    try {
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('allows valid values for known formats', () => {
    valid(obj({ today: { type: 'string', format: 'date' } }), {
      today: '2025-04-08',
    });
  });

  it('rejects invalid values for known formats', () => {
    invalid(obj({ today: { type: 'string', format: 'date' } }), {
      today: 'this is not a date',
    });
  });

  describe('boolean string coercion', () => {
    const booleanSchema = obj(
      { is_background: { type: 'boolean' } },
      'is_background',
    );

    it.each([
      ['should coerce string "true" to boolean true', 'true', true],
      ['should coerce string "True" to boolean true', 'True', true],
      ['should coerce string "TRUE" to boolean true', 'TRUE', true],
      ['should coerce string "false" to boolean false', 'false', false],
      ['should coerce string "False" to boolean false', 'False', false],
      ['should coerce string "FALSE" to boolean false', 'FALSE', false],
      ['should pass through actual boolean values unchanged', true, true],
    ])('%s', (_title, input, expected) => {
      expect(valid(booleanSchema, { is_background: input }).is_background).toBe(
        expected,
      );
    });

    it('coerces nested booleans while preserving accepted string fields', () => {
      const schema = obj({
        options: obj({ enabled: { type: 'boolean' } }),
        name: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        value: anyOf('boolean', 'string'),
        is_active: { type: 'boolean' },
      });
      expect(
        valid(schema, {
          options: { enabled: 'true' },
          name: 'trueman',
          old_string: 'true',
          new_string: 'false',
          value: 'false',
          is_active: 'false',
        }),
      ).toEqual({
        options: { enabled: true },
        name: 'trueman',
        old_string: 'true',
        new_string: 'false',
        value: 'false',
        is_active: false,
      });
    });

    it('should coerce string booleans inside arrays of booleans', () => {
      const schema = obj({ flags: arrayOf({ type: 'boolean' }) }, 'flags');
      const params = valid(schema, { flags: ['true', 'false', 'true'] });
      expect(params.flags).toEqual([true, false, true]);
    });
  });

  describe('stringified JSON value coercion', () => {
    it('parses accepted array/object forms and preserves accepted strings', () => {
      const schema = obj({
        urls: { ...orNull(strings()), default: null },
        config: orNull(obj({ key: { type: 'string' } })),
        items: { oneOf: [arrayOf({ type: 'integer' }), { type: 'null' }] },
        data: { anyOf: [{ type: 'string' }, strings()] },
        plain: strings(),
      });
      expect(
        valid(schema, {
          urls: '["https://example.com"]',
          config: '{"key":"value"}',
          items: '[1, 2, 3]',
          data: '["hello"]',
          plain: '["https://example.com"]',
        }),
      ).toEqual({
        urls: ['https://example.com'],
        config: { key: 'value' },
        items: [1, 2, 3],
        data: '["hello"]',
        plain: ['https://example.com'],
      });
    });

    it.each(['[not valid json', 'hello world'])(
      'rejects invalid JSON input unchanged: %s',
      (urls) => {
        expect(
          invalid(obj({ urls: orNull(strings()) }, 'urls'), { urls }),
        ).toEqual({ urls });
      },
    );
  });

  describe('numeric string coercion', () => {
    it('coerces numeric fields, nested objects and arrays without changing strings', () => {
      const schema = obj({
        depth: { type: 'integer' },
        timeout: { type: 'number' },
        offset: { type: 'integer' },
        value: anyOf('string', 'integer'),
        options: obj({ retries: { type: 'integer' } }),
        actual: { type: 'integer' },
        name: { type: 'string' },
        count: { type: 'integer' },
        decimal: anyOf('integer', 'number'),
        whole: { type: 'integer' },
        ports: arrayOf({ type: 'integer' }),
      });
      expect(
        valid(schema, {
          depth: '3',
          timeout: '5.5',
          offset: '-10',
          value: '42',
          options: { retries: '3' },
          actual: 3,
          name: '42',
          count: '7',
          decimal: '5.5',
          whole: '3.0',
          ports: ['8080', '3000'],
        }),
      ).toEqual({
        depth: 3,
        timeout: 5.5,
        offset: -10,
        value: '42',
        options: { retries: 3 },
        actual: 3,
        name: '42',
        count: 7,
        decimal: 5.5,
        whole: 3,
        ports: [8080, 3000],
      });
    });

    it('should work with draft-2020-12 schema (MCP servers)', () => {
      expect(
        valid(
          { $schema: DRAFT_2020, ...obj({ time: { type: 'number' } }) },
          { time: '5' },
        ),
      ).toEqual({ time: 5 });
    });

    it.each(['abc', '5.5'])(
      'rejects non-integer input unchanged: %s',
      (count) => {
        expect(
          invalid(obj({ count: { type: 'integer' } }, 'count'), { count }),
        ).toEqual({ count });
      },
    );
  });

  describe('JSON Schema version support', () => {
    it('validates draft-2020-12 properties, nested objects and nullable unions', () => {
      const schema = {
        $schema: DRAFT_2020,
        ...obj(
          {
            url: { type: 'string' },
            count: { type: 'integer' },
            config: obj({ enabled: { type: 'boolean' } }),
            urls: { ...orNull(strings()), default: null },
          },
          'url',
          'count',
        ),
      };
      valid(schema, {
        url: 'https://example.com',
        count: 42,
        config: { enabled: true },
        urls: ['https://example.com'],
      });
      valid(schema, { url: 'https://example.com', count: 42, urls: null });
      valid(schema, { url: 'https://example.com', count: 42 });
      invalid(schema, { url: 'https://example.com', count: 'not a number' });
    });

    it('should support JSON Schema draft-07 (default)', () => {
      const schema = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        ...obj({ name: { type: 'string' } }, 'name'),
      };
      valid(schema, { name: 'test' });
    });

    it('should support 2020-12 specific keywords like prefixItems', () => {
      const schema = {
        $schema: DRAFT_2020,
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'integer' }],
      };
      valid(schema, ['hello', 42]);
    });

    it('should gracefully handle unsupported schema versions', () => {
      // draft-2019-09 is not supported by Ajv by default: validation is skipped
      // and returns null (graceful degradation).
      const schema = {
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        ...obj({ value: { type: 'string' } }),
      };
      valid(schema, { value: 'test' });
    });
  });

  describe('compileStrict', () => {
    const expectCompiles = (schema: unknown) =>
      expect(SchemaValidator.compileStrict(schema)).toBeNull();

    it('returns null for a simple valid schema', () => {
      expectCompiles(obj({ foo: { type: 'string' } }));
    });

    it('returns null for draft-2020-12 schemas', () => {
      expectCompiles({ $schema: DRAFT_2020, type: 'object' });
    });

    it('returns null for empty object schema', () => {
      expectCompiles({});
    });

    it('returns an error string when type keyword has an illegal value', () => {
      const err = SchemaValidator.compileStrict({ type: 42 });
      expect(err).not.toBeNull();
      expect(typeof err).toBe('string');
    });

    it('returns a descriptive error when schema is not an object', () => {
      expect(SchemaValidator.compileStrict(null)).toMatch(/JSON object/);
      expect(SchemaValidator.compileStrict(undefined)).toMatch(/JSON object/);
      expect(SchemaValidator.compileStrict('a string')).toMatch(/JSON object/);
    });

    it('rejects arrays even though typeof === "object"', () => {
      // Arrays satisfy `typeof === 'object'` but are not valid JSON Schema
      // root values; the prior guard accepted them and let the misleading
      // error surface from Ajv much later.
      expect(SchemaValidator.compileStrict([])).toMatch(/JSON object/);
      expect(SchemaValidator.compileStrict([{ type: 'string' }])).toMatch(
        /JSON object/,
      );
    });

    it('flags unknown keywords (typos) under strict mode', () => {
      // The shared SchemaValidator.validate is intentionally lenient
      // (`strictSchema: false`) so MCP-style custom keywords don't break
      // runtime validation. compileStrict is the explicit user-supplied
      // surface and should NOT swallow typos like `propertees`.
      const err = SchemaValidator.compileStrict({
        type: 'object',
        propertees: { foo: { type: 'string' } },
      });
      expect(err).not.toBeNull();
      expect(err).toMatch(/propert/i);
    });

    it('accepts type-union arrays under allowUnionTypes', () => {
      // Strict mode rejects `type: ["a","b"]` by default; we opt in via
      // allowUnionTypes because spec-valid type unions are common in
      // real-world schemas (e.g. nullable fields). Without this, a
      // schema like `{type:["object","null"]}` would have failed at
      // CLI parse time even though it's valid JSON Schema.
      expectCompiles(obj({ x: { type: ['string', 'number'] } }));
      expectCompiles({ type: ['object', 'null'] });
    });

    it('accepts spec-valid schemas that Ajv `strict: true` would reject', () => {
      // The previous `strict: true` setting enabled lint rules beyond
      // JSON-Schema validity (strictRequired / strictTypes /
      // validateFormats), which rejected real-world spec-valid schemas
      // and broke `--json-schema` for legitimate users.

      // strictRequired: required without listing in properties.
      expectCompiles({ type: 'object', required: ['answer'] });
      // strictTypes: nested const/enum without explicit type.
      expectCompiles(obj({ mode: { enum: ['a', 'b'] } }));
      // validateFormats: unknown custom format string.
      expectCompiles(obj({ id: { type: 'string', format: 'snowflake-id' } }));
    });

    it('accepts the draft-2020-12 URI with a trailing `#` fragment', () => {
      // Both `…/schema` and `…/schema#` reference the same meta-schema;
      // exact-equality on the canonical URI rejected the trailing-`#`
      // form, falling back to the draft-07 Ajv and surfacing as
      // `no schema with key or ref ...`. Real schemas in the wild
      // include the `#` because spec examples often do.
      expectCompiles({
        $schema: `${DRAFT_2020}#`,
        ...obj({ foo: { type: 'string' } }),
      });
    });
  });

  describe('compileStrict allowMatchingProperties', () => {
    const overlapping = {
      type: 'object',
      properties: { foo: { type: 'string' } },
      patternProperties: { '^f': { minLength: 1 } },
    };

    it('keeps refusing the overlap by default', () => {
      expect(SchemaValidator.compileStrict(overlapping)).toContain(
        'allowMatchingProperties',
      );
    });

    it('accepts the overlap when asked, keeping the other strict checks', () => {
      expect(
        SchemaValidator.compileStrict(overlapping, {
          allowMatchingProperties: true,
        }),
      ).toBeNull();
      expect(
        SchemaValidator.compileStrict(
          { ...overlapping, propertees: {} },
          { allowMatchingProperties: true },
        ),
      ).toContain('propertees');
    });
  });

  describe('compileIsolated', () => {
    it('reports a schema that does not compile instead of skipping it', () => {
      expect(SchemaValidator.validate({ type: 42 }, {})).toBeNull();
      expect(SchemaValidator.compileIsolated({ type: 42 })).toEqual({
        error: expect.stringContaining('type'),
      });
    });

    it.each([null, [], 'object'])(
      'refuses the non-object schema %j',
      (schema) => {
        expect(SchemaValidator.compileIsolated(schema)).toEqual({
          error: 'schema must be a JSON object',
        });
      },
    );

    it('refuses an asynchronous schema', () => {
      expect(
        SchemaValidator.compileIsolated({ $async: true, type: 'object' }),
      ).toEqual({ error: 'asynchronous schemas ($async) are not supported' });
    });

    it('validates with the same coercion and messages as validate()', () => {
      const schema = {
        type: 'object',
        properties: {
          flag: { type: 'boolean' },
          count: { type: 'integer' },
        },
        required: ['count'],
      };
      const compiled = SchemaValidator.compileIsolated(schema);
      if (compiled.error !== undefined) throw new Error(compiled.error);
      const isolatedData: Record<string, unknown> = {
        flag: 'true',
        count: '2',
      };
      const sharedData: Record<string, unknown> = { flag: 'true', count: '2' };
      expect(compiled.validate(isolatedData)).toBeNull();
      expect(SchemaValidator.validate(schema, sharedData)).toBeNull();
      expect(isolatedData).toEqual(sharedData);
      expect(compiled.validate({})).toBe(SchemaValidator.validate(schema, {}));
      expect(compiled.validate(null)).toBe('Value of params must be an object');
    });

    it('enforces a schema whose $id the shared validator already holds', () => {
      const id = 'https://example.com/schemas/isolated-taken-id.json';
      expect(
        SchemaValidator.validate(
          { $id: id, type: 'object', required: ['a'] },
          {},
        ),
      ).toContain("'a'");
      const compiled = SchemaValidator.compileIsolated({
        $id: id,
        type: 'object',
        required: ['b'],
      });
      if (compiled.error !== undefined) throw new Error(compiled.error);
      expect(compiled.validate({})).toContain("'b'");
    });

    it('selects the draft-2020-12 compiler from $schema', () => {
      const compiled = SchemaValidator.compileIsolated({
        $schema: 'https://json-schema.org/draft/2020-12/schema#',
        type: 'object',
        properties: {
          pair: { type: 'array', prefixItems: [{ type: 'string' }] },
        },
      });
      if (compiled.error !== undefined) throw new Error(compiled.error);
      expect(compiled.validate({ pair: ['a'] })).toBeNull();
      expect(compiled.validate({ pair: [{}] })).toContain('pair');
    });
  });

  describe('non-string to string coercion', () => {
    it('converts scalar string fields and preserves strings and numeric siblings', () => {
      const schema = obj({
        integer: { type: 'string' },
        float: { type: 'string' },
        yes: { type: 'string' },
        no: { type: 'string' },
        text: { type: 'string' },
        big: { type: 'string' },
        count: { type: 'integer' },
        options: obj({
          label: { type: 'string' },
          enabled: { type: 'boolean' },
        }),
      });
      expect(
        valid(schema, {
          integer: 123,
          float: 3.14,
          yes: true,
          no: false,
          text: 'original',
          big: BigInt(9007199254740991),
          count: 42,
          options: { label: 42, enabled: true },
        }),
      ).toEqual({
        integer: '123',
        float: '3.14',
        yes: 'true',
        no: 'false',
        text: 'original',
        big: '9007199254740991',
        count: 42,
        options: { label: '42', enabled: true },
      });
    });

    it.each([
      ['object', { x: 1 }],
      ['array', [1, 2, 3]],
      ['null', null],
      ['NaN', NaN],
      ['Infinity', Infinity],
    ])('rejects %s string-field input unchanged', (_label, value) => {
      expect(
        invalid(obj({ value: { type: 'string' } }), {
          value: structuredClone(value),
        }),
      ).toEqual({ value });
    });

    it('should coerce primitives in string arrays', () => {
      const arraySchema = obj(
        { tags: strings(), bad_field: { type: 'number' } },
        'tags',
        'bad_field',
      );
      expect(
        invalid(arraySchema, {
          tags: [1, 2.5, true],
          bad_field: 'not_a_number',
        }),
      ).toEqual({ tags: ['1', '2.5', 'true'], bad_field: 'not_a_number' });
    });
  });

  describe('schema-aware boolean coercion', () => {
    it('preserves enum, const, string arrays and unconstrained object values', () => {
      const schema = obj(
        {
          status: { enum: ['active', 'true', 'false'] },
          answer: { const: 'true' },
          tags: strings(),
          config: { type: 'object' },
          count: { type: 'number' },
        },
        'count',
      );
      const params = {
        status: 'true',
        answer: 'true',
        tags: ['active', 'True', 'false'],
        config: { name: 'True', mode: 'false' },
      };
      expect(invalid(schema, params)).toEqual({
        status: 'true',
        answer: 'true',
        tags: ['active', 'True', 'false'],
        config: { name: 'True', mode: 'false' },
      });
    });
  });

  describe('nested stringified JSON coercion', () => {
    it('should coerce stringified array in nested objects', () => {
      const schema = obj({ outer: obj({ inner: orNull(strings()) }) });
      expect(
        valid(schema, { outer: { inner: '["url"]' } }).outer.inner,
      ).toEqual(['url']);
    });
  });

  describe('composition keyword recursion', () => {
    it('resolves composed scalar types, nested objects and object arrays', () => {
      const schema = obj({
        name: { allOf: [{ type: 'string' }] },
        flag: { allOf: [{ type: 'boolean' }] },
        accepted: { allOf: [anyOf('string', 'integer')] },
        nested: { allOf: [anyOf('string')] },
        config: { allOf: [obj({ enabled: { type: 'boolean' } })] },
        nullable: orNull(obj({ label: { type: 'string' } })),
        items: arrayOf({ allOf: [obj({ enabled: { type: 'boolean' } })] }),
        data: { allOf: [obj({ tags: orNull(strings()) })] },
        json: { allOf: [strings()] },
      });
      expect(
        valid(schema, {
          name: 42,
          flag: 'true',
          accepted: 42,
          nested: 42,
          config: { enabled: 'true' },
          nullable: { label: 42 },
          items: [{ enabled: 'true' }, { enabled: 'false' }],
          data: { tags: '["a","b"]' },
          json: '["x","y"]',
        }),
      ).toEqual({
        name: '42',
        flag: true,
        accepted: 42,
        nested: '42',
        config: { enabled: true },
        nullable: { label: '42' },
        items: [{ enabled: true }, { enabled: false }],
        data: { tags: ['a', 'b'] },
        json: ['x', 'y'],
      });
    });
  });

  describe('accepted numeric union values', () => {
    it('preserves integer and number subtypes through all coercion passes', () => {
      const schema = obj(
        {
          integer: anyOf('integer', 'string'),
          number: anyOf('number', 'string'),
          one: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          vals: arrayOf(anyOf('number', 'string')),
          bad_field: { type: 'number' },
        },
        'bad_field',
      );
      expect(
        invalid(schema, {
          integer: 42,
          number: 42,
          one: 42,
          vals: [1, 2, 3],
          bad_field: 'not_a_number',
        }),
      ).toEqual({
        integer: 42,
        number: 42,
        one: 42,
        vals: [1, 2, 3],
        bad_field: 'not_a_number',
      });
    });
  });

  describe('fixBooleanValues with arrays', () => {
    it('should coerce primitives in boolean arrays', () => {
      const schema = obj(
        { flags: arrayOf({ type: 'boolean' }), bad_field: { type: 'number' } },
        'bad_field',
      );
      const params = coerced(schema, {
        flags: ['true', 'false', 'True'],
        bad_field: 'not_a_number',
      });
      expect(params.flags).toEqual([true, false, true]);
    });

    it('should coerce booleans in arrays of objects', () => {
      const schema = obj(
        {
          items: arrayOf(obj({ enabled: { type: 'boolean' } })),
          bad_field: { type: 'number' },
        },
        'bad_field',
      );
      const params = coerced(schema, {
        items: [{ enabled: 'true' }, { enabled: 'false' }],
        bad_field: 'not_a_number',
      });
      expect(params.items).toEqual([{ enabled: true }, { enabled: false }]);
    });

    it('should preserve string "true"/"false" in arrays whose items also accept string', () => {
      // items schema accepts boolean AND string → a string element of
      // "true"/"false" is legitimate and must not be coerced to a boolean.
      // Mirrors the scalar-field guard; covers the uniform-items path.
      const schema = obj(
        {
          values: arrayOf(anyOf('boolean', 'string')),
          flags: arrayOf({ type: 'boolean' }),
        },
        'values',
        'flags',
      );
      const params = valid(schema, {
        values: ['true', 'false'],
        flags: ['true', 'false'],
      });
      // values accept string → strings preserved.
      expect(params.values).toEqual(['true', 'false']);
      // flags are boolean-only → still coerced.
      expect(params.flags).toEqual([true, false]);
    });

    it('should preserve string "true"/"false" in tuple elements that also accept string', () => {
      // prefixItems tuple where position 0 accepts boolean AND string → a
      // string element of "true"/"false" there must not be coerced, while
      // position 1 (boolean-only) is still coerced. Covers the per-element
      // (prefixItems) path. bad_field forces initial validation to fail so the
      // coercion pass runs and walks prefixItems.
      const schema = obj(
        {
          pair: {
            type: 'array',
            prefixItems: [anyOf('boolean', 'string'), { type: 'boolean' }],
          },
          bad_field: { type: 'integer' },
        },
        'pair',
        'bad_field',
      );
      const params = coerced(schema, {
        pair: ['false', 'false'],
        bad_field: 'not_a_number',
      });
      // Position 0 accepts string → preserved; position 1 is boolean-only → coerced.
      expect(params.pair).toEqual(['false', false]);
    });
  });

  describe('fixStringifiedJsonValues with arrays', () => {
    it('should coerce stringified JSON in arrays of objects', () => {
      const schema = obj({ items: arrayOf(obj({ tags: orNull(strings()) })) });
      const params = valid(schema, {
        items: [{ tags: '["a","b"]' }, { tags: '["c"]' }],
      });
      expect(params.items).toEqual([{ tags: ['a', 'b'] }, { tags: ['c'] }]);
    });
  });

  describe('$ref resolution', () => {
    it('coerces scalar and nested values through definitions, $defs and ref chains', () => {
      const schema = {
        ...obj({
          name: { $ref: '#/definitions/NameProp' },
          flag: { $ref: '#/$defs/FlagProp' },
          urls: { $ref: '#/definitions/UrlsProp' },
          config: { $ref: '#/$defs/Config' },
          settings: { $ref: '#/definitions/Settings' },
          data: { $ref: '#/$defs/Data' },
          twoHops: { $ref: '#/$defs/A' },
          threeHops: { $ref: '#/$defs/B' },
        }),
        definitions: {
          NameProp: { type: 'string' },
          UrlsProp: orNull(strings()),
          Settings: obj({ label: { type: 'string' } }),
        },
        $defs: {
          FlagProp: { type: 'boolean' },
          Config: obj({ enabled: { type: 'boolean' } }),
          Data: obj({ tags: orNull(strings()) }),
          A: { $ref: '#/definitions/NameProp' },
          B: { $ref: '#/$defs/C' },
          C: { $ref: '#/$defs/FlagProp' },
        },
      };
      expect(
        valid(schema, {
          name: 42,
          flag: 'true',
          urls: '["https://example.com"]',
          config: { enabled: 'true' },
          settings: { label: 42 },
          data: { tags: '["a","b"]' },
          twoHops: 42,
          threeHops: 'true',
        }),
      ).toEqual({
        name: '42',
        flag: true,
        urls: ['https://example.com'],
        config: { enabled: true },
        settings: { label: '42' },
        data: { tags: ['a', 'b'] },
        twoHops: '42',
        threeHops: true,
      });
    });

    it('should handle unresolvable $ref gracefully', () => {
      const schema = obj({ val: { $ref: '#/definitions/MissingDef' } });
      // Unresolvable $ref — coercion should be skipped, not crash
      expect(() =>
        SchemaValidator.validate(schema, { val: 'true' }),
      ).not.toThrow();
    });
  });

  describe('fixStringValues array-of-objects recursion', () => {
    it('should coerce string fields in arrays of objects', () => {
      const schema = obj({
        items: arrayOf(
          obj({ name: { type: 'string' }, count: { type: 'integer' } }),
        ),
      });
      const params = valid(schema, {
        items: [
          { name: 42, count: 5 },
          { name: true, count: 0 },
        ],
      });
      expect(params.items).toEqual([
        { name: '42', count: 5 },
        { name: 'true', count: 0 },
      ]);
    });
  });

  describe('additionalProperties fallback', () => {
    it('should coerce values in additionalProperties schemas', () => {
      const schema = {
        type: 'object',
        additionalProperties: { type: 'string' },
      };
      const params = valid(schema, {
        key1: 42,
        key2: true,
        key3: 'already_string',
      });
      expect(params.key1).toBe('42');
      expect(params.key2).toBe('true');
      expect(params.key3).toBe('already_string');
    });

    it('should coerce boolean strings in additionalProperties', () => {
      const schema = {
        type: 'object',
        additionalProperties: { type: 'boolean' },
      };
      const params = valid(schema, { flag1: 'true', flag2: 'false' });
      expect(params.flag1).toBe(true);
      expect(params.flag2).toBe(false);
    });
  });

  describe('circular $ref protection', () => {
    it('should not crash on circular $ref', () => {
      // Finding #2: circular $ref should not cause stack overflow
      const schema = {
        ...obj({ node: { $ref: '#/$defs/Node' } }),
        $defs: {
          Node: obj({
            value: { type: 'string' },
            child: { $ref: '#/$defs/Node' },
          }),
        },
      };
      const params = { node: { value: 42, child: null } };
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
    });

    it('should handle deeply nested anyOf without stack overflow', () => {
      // Finding #6: deeply nested composition keywords should not crash.
      // Build a schema with deep nesting of anyOf (exceeds depth-64 limit).
      let inner: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 100; i++) {
        inner = { anyOf: [inner, { type: 'null' }] };
      }
      const params = { val: 42 };
      expect(() =>
        SchemaValidator.validate(obj({ val: inner }), params),
      ).not.toThrow();
      // Depth limit (64) is exceeded, so getAcceptedTypes returns null and
      // coercion is skipped — value stays unchanged. This is the safe behavior.
      expect(params.val).toBe(42);
    });
  });

  describe('additionalProperties recursion', () => {
    // `{ type: 'object', additionalProperties: <object of additional `type`s> }`
    const nested = (type: string) => ({
      type: 'object',
      additionalProperties: { type: 'object', additionalProperties: { type } },
    });

    it('should coerce booleans in nested additionalProperties', () => {
      // Finding #3: additionalProperties-only schemas should recurse
      const params = valid(nested('boolean'), { a: { b: 'true', c: 'false' } });
      expect(params.a.b).toBe(true);
      expect(params.a.c).toBe(false);
    });

    it('should coerce strings in nested additionalProperties', () => {
      expect(
        valid(nested('string'), { outer: { inner: 42 } }).outer.inner,
      ).toBe('42');
    });
  });

  describe('arrays of arrays coercion', () => {
    it('should coerce stringified JSON in arrays of arrays', () => {
      // Finding #4: fixStringifiedJsonValues should recurse into nested arrays
      const schema = obj({ matrix: arrayOf(arrayOf(orNull(strings()))) });
      const params = valid(schema, { matrix: [['["a"]'], ['["b","c"]']] });
      expect(params.matrix).toEqual([[['a']], [['b', 'c']]]);
    });
  });

  describe('boolean/string round-trip safety', () => {
    it('should not coerce "true" when schema accepts both boolean and string', () => {
      // Finding #5: anyOf: [boolean, string] with input "true" — the string
      // "true" is already valid (string is accepted), so validation passes
      // and no coercion runs at all. No round-trip occurs.
      const schema = obj({ val: anyOf('boolean', 'string') });
      expect(valid(schema, { val: 'true' }).val).toBe('true');
    });

    it('should preserve string when coercion runs due to other failure', () => {
      // When coercion runs (triggered by required_num failing), the string
      // "true" must stay a string: fixBooleanValues skips it (string is also
      // accepted) and fixStringValues skips it (it is already a string). No
      // round-trip or corruption occurs. Previously fixBooleanValues coerced
      // "true" → true here, regressing vs main.
      const schema = obj(
        { val: anyOf('boolean', 'string'), required_num: { type: 'integer' } },
        'val',
        'required_num',
      );
      expect(
        coerced(schema, { val: 'true', required_num: 'not_a_number' }).val,
      ).toBe('true');
    });

    it('should preserve string in tuple position when schema accepts both', () => {
      // Same invariant as above, but for prefixItems tuples: position 0
      // (anyOf [boolean, string], "true") and position 1 (string, "hello")
      // both stay strings.
      const schema = obj(
        {
          tuple: {
            type: 'array',
            prefixItems: [anyOf('boolean', 'string'), { type: 'string' }],
          },
          required_num: { type: 'integer' },
        },
        'tuple',
        'required_num',
      );
      const params = coerced(schema, {
        tuple: ['true', 'hello'],
        required_num: 'not_a_number',
      });
      expect(params.tuple).toEqual(['true', 'hello']);
    });
  });

  describe('resolveRef prototype pollution guard', () => {
    it('should not resolve $ref to __proto__', () => {
      // Finding #7: $ref of "#/__proto__" should not resolve to Object.prototype
      const schema = obj({ val: { $ref: '#/__proto__' } });
      expect(() =>
        SchemaValidator.validate(schema, { val: 'anything' }),
      ).not.toThrow();
    });

    it('should not resolve $ref to constructor', () => {
      const schema = obj({ val: { $ref: '#/constructor' } });
      expect(() =>
        SchemaValidator.validate(schema, { val: 'anything' }),
      ).not.toThrow();
    });
  });

  describe('$ref inside composition variants', () => {
    it.each(['anyOf', 'oneOf', 'allOf'])(
      'coerces nested boolean, string and JSON fields through %s references',
      (keyword) => {
        const schema = {
          ...obj({
            config: {
              [keyword]:
                keyword === 'allOf'
                  ? [{ $ref: '#/$defs/Config' }]
                  : [{ $ref: '#/$defs/Config' }, { type: 'null' }],
            },
          }),
          $defs: {
            Config: obj({
              enabled: { type: 'boolean' },
              label: { type: 'string' },
              tags: orNull(strings()),
            }),
          },
        };
        expect(
          valid(schema, {
            config: { enabled: 'true', label: 42, tags: '["a","b"]' },
          }),
        ).toEqual({ config: { enabled: true, label: '42', tags: ['a', 'b'] } });
      },
    );
  });

  describe('Object.hasOwn regression', () => {
    it('should coerce property named toString (Object.prototype shadow)', () => {
      // Regression test: getEffectiveProperties uses Object.hasOwn instead of
      // `in` to avoid prototype chain traversal. Without this guard, a schema
      // property named 'toString' would be silently skipped because
      // 'toString' in {} is true (found on Object.prototype).
      const schema = obj({
        obj: orNull(obj({ toString: { type: 'string' } })),
      });
      const params = valid(schema, { obj: { toString: 42 } });
      expect((params.obj as Record<string, unknown>)['toString']).toBe('42');
    });
  });

  describe('prefixItems (tuple) coercion', () => {
    // `{ type: 'array', prefixItems, ...rest }`
    const tuple = (prefixItems: unknown[], rest: object = {}) => ({
      type: 'array',
      prefixItems,
      ...rest,
    });

    it('should coerce stringified JSON in tuple with prefixItems-only schema', () => {
      const schema = {
        $schema: DRAFT_2020,
        ...obj({ tuple: tuple([orNull(strings()), { type: 'string' }]) }),
      };
      const params = valid(schema, { tuple: ['["a","b"]', 'hello'] });
      expect(params.tuple).toEqual([['a', 'b'], 'hello']);
    });

    it('should coerce boolean strings in tuple with prefixItems', () => {
      const schema = obj(
        {
          tuple: tuple([{ type: 'boolean' }, { type: 'string' }]),
          bad_field: { type: 'number' },
        },
        'bad_field',
      );
      const params = coerced(schema, {
        tuple: ['true', 'hello'],
        bad_field: 'not_a_number',
      });
      expect(params.tuple).toEqual([true, 'hello']);
    });

    it('should coerce non-string values to strings in tuple with prefixItems', () => {
      const schema = {
        $schema: DRAFT_2020,
        ...obj({ tuple: tuple([{ type: 'string' }, { type: 'integer' }]) }),
      };
      expect(valid(schema, { tuple: [42, 7] }).tuple).toEqual(['42', 7]);
    });

    it('should handle mixed prefixItems + items', () => {
      const schema = obj(
        {
          data: tuple([{ type: 'boolean' }], { items: { type: 'string' } }),
          bad_field: { type: 'number' },
        },
        'bad_field',
      );
      const params = coerced(schema, {
        data: ['true', 42, 99],
        bad_field: 'not_a_number',
      });
      // Position 0: prefixItems boolean coercion; positions 1+: items string coercion
      expect(params.data).toEqual([true, '42', '99']);
    });

    it('should skip elements beyond prefixItems range when no items', () => {
      const schema = {
        $schema: DRAFT_2020,
        // items: true accepts any additional items without constraint
        ...obj({ tuple: tuple([{ type: 'boolean' }], { items: true }) }),
      };
      const params = valid(schema, {
        tuple: ['true', 'should_stay', 'also_stay'],
      });
      expect(params.tuple).toEqual([true, 'should_stay', 'also_stay']);
    });

    it('should recurse into object elements in prefixItems tuple', () => {
      const schema = obj(
        {
          tuple: tuple([
            obj({ enabled: { type: 'boolean' }, name: { type: 'string' } }),
            { type: 'integer' },
          ]),
          bad_field: { type: 'number' },
        },
        'bad_field',
      );
      const params = coerced(schema, {
        tuple: [{ enabled: 'true', name: 42 }, 99],
        bad_field: 'not_a_number',
      });
      expect(params.tuple).toEqual([{ enabled: true, name: '42' }, 99]);
    });

    it('should resolve $ref inside prefixItems entries', () => {
      const schema = {
        ...obj(
          {
            tuple: tuple([
              { $ref: '#/$defs/FlagProp' },
              { $ref: '#/$defs/NameProp' },
            ]),
            bad_field: { type: 'number' },
          },
          'bad_field',
        ),
        $defs: { FlagProp: { type: 'boolean' }, NameProp: { type: 'string' } },
      };
      const params = coerced(schema, {
        tuple: ['true', 42],
        bad_field: 'not_a_number',
      });
      expect(params.tuple).toEqual([true, '42']);
    });

    it('should coerce stringified JSON inside nested tuple elements', () => {
      // Exercises the fixStringifiedJsonValuesInArray path when a tuple
      // element is itself an array with prefixItems (nested tuple).
      // Note: boolean/string passes do NOT recurse into nested array
      // elements (consistent with existing uniform-array behavior).
      // The JSON-stringify pass (pass 3) does recurse.
      const schema = {
        $schema: DRAFT_2020,
        ...obj({
          tuple: tuple([
            tuple([orNull(strings()), { type: 'string' }]),
            { type: 'string' },
          ]),
        }),
      };
      // tuple[0] = ['["a"]', 'hello'] — an array where position 0 is a
      // JSON string. Pass 3 recurses into the nested array via
      // fixStringifiedJsonValuesInArray, which handles the prefixItems
      // on the inner array and coerces '["a"]' → ['a'].
      const params = valid(schema, { tuple: [['["a"]', 'hello'], 'world'] });
      expect(params.tuple).toEqual([[['a'], 'hello'], 'world']);
    });

    it('should handle stringified JSON array inside nested tuple element', () => {
      // Value at tuple[0] is a JSON string that parses to an array.
      // The outer prefixItems[0] accepts array (not string), so pass 3
      // coerces '["hello"]' → ["hello"]. The inner array is then
      // validated by Ajv against the nested prefixItems schema.
      const schema = {
        $schema: DRAFT_2020,
        ...obj({
          tuple: tuple([tuple([{ type: 'string' }]), { type: 'string' }]),
        }),
      };
      expect(valid(schema, { tuple: ['["hello"]', 'x'] }).tuple).toEqual([
        ['hello'],
        'x',
      ]);
    });
  });

  describe('getEffectiveProperties prototype pollution guard', () => {
    it('should not coerce data via __proto__-polluted property prototype', () => {
      // Critical: a malicious MCP schema can register
      // `properties: {__proto__: {trigger_field: {type: 'boolean'}}, safe: ...}`.
      // With the unfixed code, `merged['__proto__'] = v` on a plain `{}`
      // triggers the prototype setter, polluting `merged` with `trigger_field`.
      // A subsequent lookup of `merged['trigger_field']` (for a data key not
      // actually defined in the schema) returns the polluted schema and
      // coerces a legitimate 'true' string to boolean.
      //
      // The fix uses Object.create(null) (no prototype chain to pollute)
      // AND skips dangerous keys (__proto__/constructor/prototype) during
      // the copy.
      //
      // A safe sibling property is included so that getEffectiveProperties
      // returns a non-undefined value (the early-return check is
      // `Object.keys(merged).length > 0`; without a sibling, the polluted
      // merged has zero own keys and is treated as empty).
      //
      // A required 'bad' field forces Ajv to fail initially so the coercion
      // passes actually run.
      //
      // JSON.parse is used to make __proto__ an OWN enumerable property.
      // Object-literal `{__proto__: ...}` would set the prototype chain
      // instead and defeat the test.
      const schema = JSON.parse(`{
        "type": "object",
        "properties": {
          "__proto__": { "trigger_field": { "type": "boolean" } },
          "safe": { "type": "string" },
          "bad": { "type": "string" }
        },
        "required": ["bad"]
      }`);
      // Sanity: __proto__ is an own property of schema.properties
      expect(Object.hasOwn(schema.properties, '__proto__')).toBe(true);

      // trigger_field is not a real property of the schema. It happens to
      // match a field inside the __proto__'s value. bad is a number, schema
      // expects a string — Ajv fails, triggering coercion.
      const params = { trigger_field: 'true', bad: 5 };
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
      // Without the fix: 'true' would be coerced to true via the polluted
      // prototype. With the fix: trigger_field is not in the schema's own
      // properties and the value stays as a string.
      expect(params.trigger_field).toBe('true');
      // bad should still coerce normally to its expected string type.
      expect(params.bad).toBe('5');
    });

    it('should still coerce legitimate sibling keys when __proto__ is in properties', () => {
      // Defence-in-depth: even if __proto__ is present, legitimate sibling
      // keys must still coerce normally.
      const schema = JSON.parse(`{
        "type": "object",
        "properties": {
          "__proto__": { "type": "boolean" },
          "legitimate": { "type": "string" }
        }
      }`);
      const params = { legitimate: 42 };
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
      expect(params.legitimate).toBe('42');
      // Object.prototype must not be modified either.
      expect(
        (Object.prototype as Record<string, unknown>)['polluted'],
      ).toBeUndefined();
    });

    it('should skip constructor and prototype keys as own properties', () => {
      // Use JSON.parse to make constructor/prototype OWN enumerable properties.
      // Include a sibling so getEffectiveProperties returns non-undefined.
      const schema = JSON.parse(`{
        "type": "object",
        "properties": {
          "constructor": { "type": "boolean" },
          "prototype": { "type": "string" },
          "name": { "type": "string" }
        }
      }`);
      // Sanity: all three are own properties of schema.properties
      expect(Object.hasOwn(schema.properties, 'constructor')).toBe(true);
      expect(Object.hasOwn(schema.properties, 'prototype')).toBe(true);
      expect(Object.hasOwn(schema.properties, 'name')).toBe(true);

      const params = { name: 99 };
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
      // The safe 'name' key still gets coerced; the dangerous keys are
      // skipped so they cannot fabricate behavior via prototype traversal.
      expect(params.name).toBe('99');
    });
  });

  describe('fixStringifiedJsonValuesInArray element-level schema', () => {
    it('should coerce stringified JSON in nested uniform arrays of objects', () => {
      // Regression: previously getAcceptedTypes was called on the OUTER array
      // schema (yielding {array}), not the element-level schema. Parsed
      // objects would never match {array}, so coercion was silently skipped.
      // The fix resolves the inner items schema before checking accepted types.
      //
      // The data shape is matrix: [ ['{"a":1}'] ] — an array containing an
      // array containing a stringified JSON object. The outer uniform-items
      // pass in fixStringifiedJsonValues dispatches into
      // fixStringifiedJsonValuesInArray for each sub-array.
      const schema = obj({ matrix: arrayOf(arrayOf({ type: 'object' })) });
      // With the fix, '{"a":1}' is parsed and coerced to {a:1} because the
      // element schema accepts 'object'. Without the fix, the helper would
      // check {array} (the outer schema's type), find no match for 'object',
      // and silently skip — leaving validation to fail with "must be object".
      expect(valid(schema, { matrix: [['{"a":1}']] }).matrix).toEqual([
        [{ a: 1 }],
      ]);
    });
  });

  describe('getAcceptedTypes memoization (branching $ref DoS guard)', () => {
    it('collapses an exponentially branching $ref type tree to linear time', () => {
      // Regression guard for the [Critical] review finding (PR #4793): a
      // compact schema can encode an exponentially branching type tree via
      // $ref, e.g.
      //   $defs/D0 = {type: number}
      //   $defs/Dn = {anyOf: [{$ref: Dn-1}, {$ref: Dn-1}]}
      // Before memoization, getAcceptedTypes re-traversed every shared
      // $defs/Dk target once per path reaching it — O(2^depth) calls
      // (~9s at depth 24 on a laptop, projected to days by depth 40). The
      // memoization cache keys on the *resolved* $defs object (shared across
      // all refs to it), collapsing the descent to O(depth).
      //
      // `val` holds a value that is VALID against the branching schema (a
      // number, since D0 accepts number). That keeps Ajv's work linear — it
      // short-circuits anyOf on the first passing branch and emits no
      // exponential error array — so the test bounds memory regardless of
      // depth. A sibling `bad` field fails, triggering the coercion path that
      // calls getAcceptedTypes on the full branching tree for `val`.
      const DEPTH = 24;
      const $defs: Record<string, unknown> = { D0: { type: 'number' } };
      for (let i = 1; i <= DEPTH; i++) {
        $defs[`D${i}`] = {
          anyOf: [{ $ref: `#/$defs/D${i - 1}` }, { $ref: `#/$defs/D${i - 1}` }],
        };
      }
      const schema = {
        ...obj(
          { val: { $ref: `#/$defs/D${DEPTH}` }, bad: { type: 'string' } },
          'val',
          'bad',
        ),
        $defs,
      };
      const params = { val: 42, bad: 123 };

      const start = Date.now();
      const result = SchemaValidator.validate(schema, params);
      const elapsed = Date.now() - start;

      expect(result).toBeNull();
      // val is a valid number — its schema accepts number, so it is unchanged.
      expect(params.val).toBe(42);
      // bad is coerced number → string.
      expect(params.bad).toBe('123');
      // Fixed: <50ms. Unfixed (2^24 ≈ 16M getAcceptedTypes calls): ~9s. The
      // 1s budget catches a regression on any realistic hardware without
      // flaking on slow CI (the fixed path does linear work in both Ajv and
      // the coercion passes).
      expectWithinLatencyBudget(elapsed, 1000, { poolMultiplier: 20 });
    });
  });
});

describe('SchemaValidator compile cache', () => {
  it('compiles equal schemas once, whatever their object identity', async () => {
    const { default: AjvPkg } = await import('ajv');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AjvClass = ((AjvPkg as any).default || AjvPkg) as any;
    const compile = vi.spyOn(AjvClass.prototype, 'compile');
    const name = probe('compileOnceProbe');
    try {
      for (let i = 0; i < 50; i++) {
        const schema = {
          type: 'object',
          properties: { [name]: { type: 'string' } },
        };
        expect(SchemaValidator.validate(schema, { [name]: 'x' })).toBeNull();
      }
      expect(compile).toHaveBeenCalledTimes(1);
    } finally {
      compile.mockRestore();
    }
  });

  it('never hands a mutated schema object its old validator for fresh text', () => {
    const name = probe('mutationProbe');
    const property = { type: 'string' };
    const mutated = { type: 'object', properties: { [name]: property } };
    expect(SchemaValidator.validate(mutated, { [name]: 'x' })).toBeNull();
    property.type = 'boolean';
    SchemaValidator.validate(mutated, { [name]: true });

    const fresh = {
      type: 'object',
      properties: { [name]: { type: 'boolean' } },
    };
    expect(SchemaValidator.validate(fresh, { [name]: true })).toBeNull();
    expect(SchemaValidator.validate(fresh, { [name]: 'x' })).not.toBeNull();
  });

  it('keeps apart schemas that JSON text cannot tell apart', () => {
    const name = probe('exactProbe');
    const constant = (value: unknown) => ({
      type: 'object',
      properties: { [name]: { const: value } },
    });

    expect(SchemaValidator.validate(constant(null), { [name]: null })).toBe(
      null,
    );
    expect(
      SchemaValidator.validate(constant(Number.NaN), { [name]: null }),
    ).not.toBeNull();
    expect(
      SchemaValidator.validate(constant(Number.POSITIVE_INFINITY), {
        [name]: null,
      }),
    ).not.toBeNull();
  });

  it('does not let a toJSON method stand in for a schema', () => {
    const name = probe('disguiseProbe');
    const plain = { type: 'object', description: name };
    const disguised = {
      type: 'object',
      required: [name],
      toJSON: () => plain,
    };

    expect(SchemaValidator.validate(plain, {})).toBeNull();
    expect(SchemaValidator.validate(disguised, {})).toContain(name);
  });

  it('validates a rebuilt schema that carries an $id', () => {
    const id = probe('id-probe');
    const schema = () => ({
      $id: `https://example.com/schemas/${id}.json`,
      type: 'object',
      properties: { idProbe: { type: 'integer' } },
      required: ['idProbe'],
    });

    for (let i = 0; i < 3; i++) {
      expect(SchemaValidator.validate(schema(), {})).toContain('idProbe');
    }
  });

  it('compiles a schema that fails to compile as Ajv always has', () => {
    // Ajv cannot load the draft-04 meta-schema, so the first compile fails
    // and validation is skipped; Ajv compiles the same object on later calls.
    const name = probe('draftProbe');
    const schema = {
      $schema: 'http://json-schema.org/draft-04/schema#',
      type: 'object',
      properties: { [name]: { type: 'integer' } },
      required: [name],
    };
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const results = [0, 1, 2].map(() => SchemaValidator.validate(schema, {}));

      expect(results[0]).toBeNull();
      expect(results[1]).toContain(name);
      expect(results[2]).toContain(name);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('does not compile a copy for each rebuilt schema that fails to compile', () => {
    // A per-call tool build or a rediscovery hands over a new object each
    // time. Only the first one is compiled from a copy parsed from its text.
    const name = probe('rebuiltDraftProbe');
    const schema = () => ({
      $schema: 'http://json-schema.org/draft-04/schema#',
      type: 'object',
      properties: { [name]: { type: 'integer' } },
      required: [name],
    });
    const parse = vi.spyOn(JSON, 'parse');
    try {
      for (let i = 0; i < 3; i++) {
        expect(SchemaValidator.validate(schema(), {})).toBeNull();
      }
      // As before, Ajv compiles such an object on its second use, and the
      // object is not serialized again.
      const reused = schema();
      expect(SchemaValidator.validate(reused, {})).toBeNull();
      const stringify = vi.spyOn(JSON, 'stringify');
      try {
        for (let i = 0; i < 2; i++) {
          expect(SchemaValidator.validate(reused, {})).toContain(name);
        }
        expect(stringify.mock.calls.map(([value]) => value)).not.toContain(
          reused,
        );
      } finally {
        stringify.mockRestore();
      }
      // An object rebuilt after that still fails its own first compile.
      expect(SchemaValidator.validate(schema(), {})).toBeNull();
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('validates each rebuilt schema with an $id that fails to compile on its second use', () => {
    // The copy parsed from the text claims the $id first, so each object's
    // first compile fails as a duplicate of it. Ajv still keeps the object
    // and compiles it on its second use, as it did before.
    const id = probe('id-fail-probe');
    const schema = () => ({
      $id: `https://example.com/schemas/${id}.json`,
      $schema: 'http://json-schema.org/draft-04/schema#',
      type: 'object',
      properties: { idFailProbe: { type: 'integer' } },
      required: ['idFailProbe'],
    });
    for (let i = 0; i < 2; i++) {
      const object = schema();
      expect(SchemaValidator.validate(object, {})).toBeNull();
      expect(SchemaValidator.validate(object, {})).toContain('idFailProbe');
    }
  });

  it('shares no validator with a caller that mutates its schema object', () => {
    const name = probe('sharedProbe');
    const schema = (constant: { value: number }) => ({
      type: 'object',
      properties: { [name]: { const: constant } },
    });
    const shared = { value: 1 };
    const mutated = schema(shared);
    expect(
      SchemaValidator.validate(mutated, { [name]: { value: 1 } }),
    ).toBeNull();
    shared.value = 2;

    expect(
      SchemaValidator.validate(schema({ value: 1 }), { [name]: { value: 1 } }),
    ).toBeNull();
  });

  it('validates a schema that JSON text does not describe by its own content', () => {
    const inheritedProbe = probe('inheritedProbe');
    class Inherited {
      get required() {
        return [inheritedProbe];
      }
    }
    const hiddenProbe = probe('hiddenProbe');
    const hidden = { type: 'object' };
    Object.defineProperty(hidden, 'required', {
      value: [hiddenProbe],
      enumerable: false,
    });
    class Listed extends Array<string> {}
    const listedProbe = probe('listedProbe');
    const listed = Listed.from([listedProbe]);
    const disguisedProbe = probe('disguisedProbe');
    const enumProbe = probe('enumProbe');

    expect(
      SchemaValidator.validate(
        Object.assign(new Inherited(), { type: 'object' }),
        {},
      ),
    ).toContain(inheritedProbe);
    expect(SchemaValidator.validate(hidden, {})).toContain(hiddenProbe);
    expect(
      SchemaValidator.validate(
        {
          type: 'object',
          required: Object.assign([disguisedProbe], { toJSON: () => [] }),
        },
        {},
      ),
    ).toContain(disguisedProbe);
    // Its text is that of a plain array with the same items, so only the
    // absence of a parsed copy shows that it was compiled from the object.
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(
        SchemaValidator.validate({ type: 'object', required: listed }, {}),
      ).toContain(listedProbe);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    expect(
      SchemaValidator.validate(
        {
          type: 'object',
          properties: { [enumProbe]: { enum: [undefined] } },
        },
        { [enumProbe]: 'x' },
      ),
    ).toBeNull();
  });

  it.each([
    [
      'that JSON text describes',
      (name: string) => ({
        type: 'object',
        properties: { [name]: { type: 'string' } },
      }),
    ],
    [
      'that JSON text does not describe',
      (name: string) => ({
        type: 'object',
        properties: {
          [name]: { type: 'string' },
          nanProbe: { const: Number.NaN },
        },
      }),
    ],
  ])('does not serialize a second time a schema object %s', (_label, build) => {
    const name = probe('reuseProbe');
    const schema = build(name);
    expect(SchemaValidator.validate(schema, { [name]: 'x' })).toBeNull();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      for (const value of ['y', 'z']) {
        expect(SchemaValidator.validate(schema, { [name]: value })).toBeNull();
      }
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it.each([
    [
      'whose first compile failed',
      (name: string) => ({
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: { [name]: { type: 'string' } },
      }),
      // Ajv compiles such an object on its second use.
      (name: string) => expect.stringContaining(name),
    ],
    [
      'that never compiles',
      (name: string) => ({
        type: 'object',
        properties: { [name]: { $ref: '#/definitions/missing' } },
      }),
      () => null,
    ],
  ])(
    'does not serialize a second time a schema object %s',
    (_label, build, later) => {
      const name = probe('failedReuseProbe');
      const schema = build(name);
      expect(SchemaValidator.validate(schema, { [name]: 'x' })).toBeNull();
      const stringify = vi.spyOn(JSON, 'stringify');
      try {
        for (let i = 0; i < 2; i++) {
          expect(SchemaValidator.validate(schema, { [name]: {} })).toEqual(
            later(name),
          );
        }
        // Compiling serializes parts of a schema, but never the object
        // itself.
        expect(stringify.mock.calls.map(([value]) => value)).not.toContain(
          schema,
        );
      } finally {
        stringify.mockRestore();
      }
    },
  );

  it('shares one validator between rebuilt schemas holding -0, which the text writes as 0', async () => {
    // JSON.parse gives -0 for -0.0, and Ajv validates it as 0, so each rebuilt
    // object, $id and all, is validated on its first use.
    const { default: AjvPkg } = await import('ajv');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AjvClass = ((AjvPkg as any).default || AjvPkg) as any;
    const compile = vi.spyOn(AjvClass.prototype, 'compile');
    const name = probe('zeroProbe');
    try {
      for (let i = 0; i < 3; i++) {
        const schema = {
          $id: `https://example.com/schemas/${name}.json`,
          type: 'object',
          properties: { [name]: { type: 'number', minimum: -0 } },
        };
        expect(SchemaValidator.validate(schema, { [name]: -1 })).toContain(
          name,
        );
      }
      expect(compile).toHaveBeenCalledTimes(1);
    } finally {
      compile.mockRestore();
    }
  });

  it('compiles a schema holding an array with a named property from the object', () => {
    // The text drops the property, but a JSON pointer in a $ref reaches it.
    const name = probe('pointedProbe');
    const schema = {
      $id: `https://example.com/schemas/${name}.json`,
      type: 'object',
      allOf: Object.assign([{}], { note: { required: [name] } }),
      properties: { wrapped: { $ref: '#/allOf/note' } },
    };

    expect(SchemaValidator.validate(schema, { wrapped: {} })).toContain(name);
  });

  it('compiles a schema holding an object without a prototype from the object', () => {
    // Ajv tells such an object from a plain one with the same keys, which is
    // all that a copy parsed from the text would hold.
    const name = probe('bareProbe');
    const bare = Object.create(null) as Record<string, unknown>;
    bare['x'] = 1;
    const schema = { type: 'object', properties: { [name]: { const: bare } } };

    expect(SchemaValidator.validate(schema, { [name]: { x: 1 } })).toContain(
      name,
    );
  });

  it('gives a schema whose $id another schema holds the results it gave before', () => {
    // The text changes but the $id stays, as when a server updates a tool.
    const id = probe('taken-id-probe');
    const schema = (name: string) => ({
      $id: `https://example.com/schemas/${id}.json`,
      type: 'object',
      properties: { [name]: { type: 'integer' } },
      required: [name],
    });
    const first = probe('takenFirstProbe');
    const second = probe('takenSecondProbe');

    expect(SchemaValidator.validate(schema(first), {})).toContain(first);
    for (let i = 0; i < 2; i++) {
      const object = schema(second);
      expect(SchemaValidator.validate(object, {})).toBeNull();
      expect(SchemaValidator.validate(object, {})).toContain(second);
    }
  });

  it("logs a failing schema's own error, not a duplicate of the $id its copy claimed", () => {
    const schema = {
      $id: `https://example.com/schemas/${probe('logged-id-probe')}.json`,
      $schema: 'http://json-schema.org/draft-04/schema#',
      type: 'object',
    };
    debugLogger.warn.mockClear();

    expect(SchemaValidator.validate(schema, {})).toBeNull();
    expect(debugLogger.warn).toHaveBeenCalledOnce();
    expect(debugLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'no schema with key or ref "http://json-schema.org/draft-04/schema#"',
      ),
    );
  });
});
