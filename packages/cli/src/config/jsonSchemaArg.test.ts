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

  it('rejects @path that resolves to a directory', () => {
    // stat-based "must be a regular file" guard. Without this, a path
    // pointing at a directory would surface a less-specific Node EISDIR
    // error from the readFileSync call (or worse, on systems where
    // readFileSync on a directory does not error).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-schema-dir-'));
    try {
      expect(() => resolveJsonSchemaArg(`@${tmp}`)).toThrow(
        /must be a regular file/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects @path schema files that exceed the size cap', () => {
    // Defence against a wrapper that forwards a user-supplied path into
    // `qwen --json-schema "$X"` where X is e.g. `@/dev/zero` or any
    // pathologically large file. We pre-check size via fs.statSync so the
    // huge buffer never gets allocated.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-schema-big-'));
    const file = path.join(tmp, 'huge.json');
    // Cap is 4 MiB; write 4 MiB + 1 byte to trip it.
    fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    try {
      expect(() => resolveJsonSchemaArg(`@${file}`)).toThrow(
        /Refusing to read/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not echo the JSON parse error message for @path source', () => {
    // The Node ≥18 SyntaxError message for `JSON.parse('hello world…')`
    // embeds a ~10-char prefix of the input. For inline JSON that's
    // fine — the user typed it themselves — but for @path it would leak
    // a prefix of the referenced file through stderr to any wrapper
    // that surfaces qwen's error output. Sanitise by emitting a generic
    // "content of <path> is not valid JSON" instead.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-schema-bad-'));
    const file = path.join(tmp, 'leaky.txt');
    const secretContent = 'SECRET_TOKEN_PREFIX hello world';
    fs.writeFileSync(file, secretContent);
    try {
      let caught: Error | undefined;
      try {
        resolveJsonSchemaArg(`@${file}`);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/is not valid JSON/);
      // The file's contents must NOT appear in the error message.
      expect(caught!.message).not.toContain('SECRET_TOKEN_PREFIX');
      expect(caught!.message).not.toContain('hello worl');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('still echoes JSON parse error detail for inline (non-@path) source', () => {
    // Inline JSON is the user's own input — keeping the SyntaxError detail
    // is helpful for debugging typos, and there's no third-party file
    // content to leak.
    let caught: Error | undefined;
    try {
      resolveJsonSchemaArg('{"foo":}');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/--json-schema is not valid JSON/);
    // Should mention the JSON parser detail (echoes SyntaxError text).
    expect(caught!.message).not.toBe('--json-schema is not valid JSON: ');
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

  it('rejects any root $ref, even with a sibling type:"object" anchor', () => {
    // Ajv applies `$ref` conjunctively with sibling keywords, so a sibling
    // `type:"object"` is NOT enough to make the schema satisfiable — when
    // the referenced subschema is non-object, the resulting AND is
    // unsatisfiable at runtime. We reject root `$ref` outright rather than
    // following the reference ourselves (local-only resolution would still
    // have to handle remote / recursive refs).
    expect(() =>
      resolveJsonSchemaArg(
        '{"$ref":"#/$defs/Foo","$defs":{"Foo":{"type":"array"}}}',
      ),
    ).toThrow(/must accept object-typed values/);
    expect(() =>
      resolveJsonSchemaArg(
        '{"type":"object","$ref":"#/$defs/Foo","$defs":{"Foo":{"type":"array"}}}',
      ),
    ).toThrow(/must accept object-typed values/);
    // Even when the referenced schema IS object-shaped, we still reject —
    // the contract for `--json-schema` is "the root schema describes the
    // tool args directly", not "follow these refs". Users wanting
    // composition should inline at the root or use `allOf`.
    expect(() =>
      resolveJsonSchemaArg(
        '{"type":"object","$ref":"#/$defs/Foo","$defs":{"Foo":{"type":"object","properties":{"a":{"type":"string"}}}}}',
      ),
    ).toThrow(/must accept object-typed values/);
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

  it('rejects a root `not` that directly forbids object', () => {
    // `not:{type:"object"}` excludes every object value, so the schema is
    // unsatisfiable for tool-call args. Best-effort check — only inspects
    // `not.type`; deeper negated patterns fall through to Ajv at runtime.
    expect(() => resolveJsonSchemaArg('{"not":{"type":"object"}}')).toThrow(
      /must accept object-typed values/,
    );
    expect(() =>
      resolveJsonSchemaArg('{"not":{"type":["object","null"]}}'),
    ).toThrow(/must accept object-typed values/);
  });

  it('accepts a root `not` whose negated type does not exclude object', () => {
    // `not:{type:"string"}` only forbids strings — objects are still fine.
    const schema = resolveJsonSchemaArg('{"not":{"type":"string"}}');
    expect(schema).toBeDefined();
  });

  it('accepts root `not:{type:"object", ...narrowing}` because narrowing keywords leave some objects satisfiable', () => {
    // `not:{type:"object",required:["error"]}` only excludes objects
    // that have an `error` key. An object like `{}` is NOT excluded
    // (it doesn't match the `required` constraint), so the schema is
    // satisfiable for at least one object value.
    //
    // The previous parse-time check looked only at `not.type` and
    // rejected this as "must accept object-typed values" — a false
    // positive. The fix: only reject when `not` is exactly
    // `{type: ...}` with no narrowing siblings; otherwise defer to
    // Ajv at runtime.
    expect(
      resolveJsonSchemaArg('{"not":{"type":"object","required":["error"]}}'),
    ).toBeDefined();
    expect(
      resolveJsonSchemaArg(
        '{"not":{"type":"object","properties":{"k":{"type":"string"}},"required":["k"]}}',
      ),
    ).toBeDefined();
    expect(
      resolveJsonSchemaArg('{"not":{"type":"object","minProperties":1}}'),
    ).toBeDefined();
  });

  it('rejects a root `const` whose value is not an object', () => {
    expect(() => resolveJsonSchemaArg('{"const":1}')).toThrow(
      /must accept object-typed values/,
    );
    expect(() => resolveJsonSchemaArg('{"const":"hello"}')).toThrow(
      /must accept object-typed values/,
    );
    expect(() => resolveJsonSchemaArg('{"const":[1,2]}')).toThrow(
      /must accept object-typed values/,
    );
  });

  it('accepts a root `const` whose value is an object', () => {
    const schema = resolveJsonSchemaArg(
      '{"const":{"summary":"hello","risk":"low"}}',
    );
    expect(schema).toBeDefined();
  });

  it('rejects a root `enum` with no object members', () => {
    expect(() => resolveJsonSchemaArg('{"enum":[1,2,"three"]}')).toThrow(
      /must accept object-typed values/,
    );
    // Empty enum admits nothing — also reject.
    expect(() => resolveJsonSchemaArg('{"enum":[]}')).toThrow(
      /must accept object-typed values/,
    );
  });

  it('accepts a root `enum` when at least one member is an object', () => {
    const schema = resolveJsonSchemaArg(
      '{"enum":[{"summary":"a","risk":"low"},{"summary":"b","risk":"high"}]}',
    );
    expect(schema).toBeDefined();
  });

  it('rejects an empty root anyOf / oneOf as unsatisfiable', () => {
    expect(() => resolveJsonSchemaArg('{"anyOf":[]}')).toThrow(
      /must accept object-typed values/,
    );
    expect(() => resolveJsonSchemaArg('{"oneOf":[]}')).toThrow(
      /must accept object-typed values/,
    );
  });

  it('accepts boolean subschemas in anyOf where any branch is true', () => {
    // `true` matches every value (per JSON Schema 2019-09+), so it admits
    // objects. `{anyOf:[true]}` should pass.
    const a = resolveJsonSchemaArg('{"anyOf":[true]}');
    expect(a).toBeDefined();
    const b = resolveJsonSchemaArg('{"anyOf":[false,true]}');
    expect(b).toBeDefined();
    const c = resolveJsonSchemaArg('{"anyOf":[true,{"type":"string"}]}');
    expect(c).toBeDefined();
  });

  it('rejects anyOf where every branch is `false`', () => {
    // `false` matches nothing, so an anyOf of all-false is unsatisfiable.
    expect(() => resolveJsonSchemaArg('{"anyOf":[false]}')).toThrow(
      /must accept object-typed values/,
    );
    expect(() => resolveJsonSchemaArg('{"anyOf":[false,false]}')).toThrow(
      /must accept object-typed values/,
    );
  });

  it('accepts $ref nested inside anyOf / oneOf / allOf branches', () => {
    // Root $ref is rejected unconditionally (Ajv applies it conjunctively
    // with siblings), but $ref *inside* a composition branch is opaque
    // at parse time — Ajv will resolve it at runtime. Refusing nested
    // refs would block common $defs/$ref composition shapes.
    const a = resolveJsonSchemaArg(
      '{"anyOf":[{"$ref":"#/$defs/Foo"},{"type":"string"}],"$defs":{"Foo":{"type":"object"}}}',
    );
    expect(a).toBeDefined();
    const b = resolveJsonSchemaArg(
      '{"oneOf":[{"$ref":"#/$defs/A"},{"$ref":"#/$defs/B"}],"$defs":{"A":{"type":"object"},"B":{"type":"object"}}}',
    );
    expect(b).toBeDefined();
    const c = resolveJsonSchemaArg(
      '{"allOf":[{"$ref":"#/$defs/Bar"},{"type":"object"}],"$defs":{"Bar":{"type":"object"}}}',
    );
    expect(c).toBeDefined();
  });

  it('handles boolean subschemas in allOf', () => {
    // `true` is neutral in allOf, `false` makes the whole schema unsatisfiable.
    const ok = resolveJsonSchemaArg('{"allOf":[true,{"type":"object"}]}');
    expect(ok).toBeDefined();
    expect(() =>
      resolveJsonSchemaArg('{"allOf":[false,{"type":"object"}]}'),
    ).toThrow(/must accept object-typed values/);
    expect(() => resolveJsonSchemaArg('{"allOf":[false]}')).toThrow(
      /must accept object-typed values/,
    );
  });

  it('rejects if/then/else when the decidable branch admits no objects', () => {
    // `if: true` reduces root acceptance to `then`'s acceptance.
    // `if: false` reduces it to `else`'s acceptance. Object schemas in
    // `if` are runtime-decidable only and fall through to Ajv.
    expect(() =>
      resolveJsonSchemaArg('{"if":true,"then":{"type":"string"}}'),
    ).toThrow(/must accept object-typed values/);
    expect(() => resolveJsonSchemaArg('{"if":true,"then":false}')).toThrow(
      /must accept object-typed values/,
    );
    expect(() =>
      resolveJsonSchemaArg('{"if":false,"else":{"type":"array"}}'),
    ).toThrow(/must accept object-typed values/);
    expect(() => resolveJsonSchemaArg('{"if":false,"else":false}')).toThrow(
      /must accept object-typed values/,
    );
  });

  it('accepts if/then/else when the decidable branch admits objects', () => {
    // `if: true` + object-compatible `then` passes (parse-time
    // schemaRootAcceptsObject reduces to checking `then`).
    expect(
      resolveJsonSchemaArg('{"if":true,"then":{"type":"object"}}'),
    ).toBeDefined();
    // `if: false` + object-compatible `else`.
    expect(
      resolveJsonSchemaArg('{"if":false,"else":{"type":"object"}}'),
    ).toBeDefined();
    // Object schema for `if` — runtime-decidable; defer to Ajv. We
    // accept at parse time even when `then` excludes object, because
    // an object value may not match `if` and so isn't bound by `then`.
    expect(
      resolveJsonSchemaArg(
        '{"if":{"type":"object","properties":{"k":{"const":"x"}}},"then":{"type":"object","properties":{"v":{"type":"string"}}}}',
      ),
    ).toBeDefined();
    // (The degenerate `{if:true}` / `{if:false}` shapes — no `then` and
    // no `else` — are rejected by Ajv strict mode as meaningless rather
    // than by schemaRootAcceptsObject; that's fine.)
  });
});
