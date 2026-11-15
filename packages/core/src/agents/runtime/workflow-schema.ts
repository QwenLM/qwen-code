/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Readies an `agent({schema})` schema before any agent runs.
 *
 * The shared tool-parameter validator skips a schema it cannot compile, and
 * its one Ajv registry lets a schema whose `$id` another schema claimed first
 * pass its first call unchecked. Both are right for MCP tools, whose schemas
 * the session does not own, and wrong for a workflow's structured output: the
 * script is told the result it gets back matches its schema. So a workflow
 * schema is compiled strictly, checked for a few contradictions no object can
 * satisfy, and given a validator of its own that the structured output tool
 * and the resume cache both use.
 */

import { SchemaValidator } from '../../utils/schemaValidator.js';
import { stripAnsiAndControl } from '../../utils/textUtils.js';

/** Validates one structured output candidate in place; null when it passes. */
export type WorkflowSchemaValidate = (params: unknown) => string | null;

export type WorkflowSchemaPreparation =
  | { ok: true; validate: WorkflowSchemaValidate }
  | { ok: false; error: string };

const MAX_ERROR_DETAIL_LENGTH = 500;
const MAX_KEY_LENGTH = 120;
/** The contradiction walk stops here; stopping proves nothing either way. */
const MAX_WALK_DEPTH = 32;
const MAX_WALK_NODES = 1000;

/**
 * Keywords that make a node's accepted objects depend on more than its own
 * `properties`, `patternProperties`, `additionalProperties` and `required`.
 * The contradiction rules do not reason about such a node; Ajv still
 * compiles it and validates every result against it.
 */
const COMPOUND_KEYWORDS = [
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependencies',
  'dependentSchemas',
  'dependentRequired',
  'unevaluatedProperties',
  'propertyNames',
];

/**
 * Prepares `schema` for one `agent({schema})` call. Only `undefined` means
 * "no schema"; every other value must be a JSON Schema object that compiles
 * strictly, is synchronous, and has no contradiction this module can prove.
 * The error names the problem and never echoes the schema.
 */
export function prepareWorkflowSchema(
  schema: unknown,
): WorkflowSchemaPreparation {
  const shape = describeNonObject(schema);
  if (shape !== undefined) {
    return fail(`must be a JSON Schema object, got ${shape}.`);
  }
  // The validator keeps this copy, so nothing the caller does to its own
  // object later can change what the validator enforces.
  let copy: Record<string, unknown>;
  try {
    copy = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  } catch (error) {
    return fail(`is not JSON: ${errorText(error)}`);
  }
  // A property may be both declared and matched by a pattern; the result
  // must then satisfy both schemas, which the runtime validator enforces.
  const strictError = SchemaValidator.compileStrict(copy, {
    allowMatchingProperties: true,
  });
  if (strictError !== null) {
    return fail(`is not a valid JSON Schema: ${strictError}`);
  }
  if (copy['$async'] === true) {
    return fail(
      'uses $async, which structured output does not support. Remove $async.',
    );
  }
  const contradiction = findContradiction(copy);
  if (contradiction !== undefined) {
    return fail(contradiction);
  }
  const compiled = SchemaValidator.compileIsolated(copy);
  if (compiled.error !== undefined) {
    return fail(`could not be compiled: ${compiled.error}`);
  }
  return { ok: true, validate: compiled.validate };
}

/**
 * Checks a structured result against a prepared schema without touching it.
 * Returns the validated copy (with any coercion applied), or why the value
 * is not an object that passes.
 */
export function validateStructuredResult(
  value: unknown,
  validate: WorkflowSchemaValidate,
): { value: Record<string, unknown> } | { error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'the result is not a JSON object' };
  }
  let copy: Record<string, unknown>;
  try {
    copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch (error) {
    return { error: `the result is not JSON: ${errorText(error)}` };
  }
  try {
    const error = validate(copy);
    return error === null ? { value: copy } : { error };
  } catch (error) {
    return { error: errorText(error) };
  }
}

function fail(detail: string): WorkflowSchemaPreparation {
  return { ok: false, error: `agent({schema}): ${boundedDetail(detail)}` };
}

function boundedDetail(detail: string): string {
  const clean = stripAnsiAndControl(detail);
  return clean.length > MAX_ERROR_DETAIL_LENGTH
    ? `${clean.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
    : clean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeNonObject(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value !== 'object') return `a ${typeof value}`;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointerToken(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function quoteKey(key: string): string {
  const quoted = JSON.stringify(key);
  return quoted.length > MAX_KEY_LENGTH
    ? `${quoted.slice(0, MAX_KEY_LENGTH)}…"`
    : quoted;
}

/** Whether `type` names object among its types; undefined when absent. */
function typeAllowsObject(type: unknown): boolean | undefined {
  if (typeof type === 'string') return type === 'object';
  if (Array.isArray(type)) return type.includes('object');
  return undefined;
}

/**
 * A node the walk descends into must hold nothing but an object: a node
 * that also admits null (or any other type) can satisfy its parent without
 * satisfying its own object rules.
 */
function isObjectOnly(node: Record<string, unknown>): boolean {
  const type = node['type'];
  const onlyObject =
    type === 'object' ||
    (Array.isArray(type) && type.length === 1 && type[0] === 'object');
  return onlyObject && node['nullable'] !== true;
}

/**
 * Why the root cannot accept any object: its own `type`, `const` or `enum`
 * excludes every object. These keywords apply whatever else the root says.
 */
function rootExcludesObject(root: Record<string, unknown>): string | undefined {
  if (typeAllowsObject(root['type']) === false) {
    return `# does not accept an object (type ${stripAnsiAndControl(
      JSON.stringify(root['type']),
    )}); structured output is always a JSON object.`;
  }
  if ('const' in root && !isRecord(root['const'])) {
    return '# does not accept an object (its const is not an object); structured output is always a JSON object.';
  }
  if (Array.isArray(root['enum']) && !root['enum'].some(isRecord)) {
    return '# does not accept an object (its enum has no object member); structured output is always a JSON object.';
  }
  return undefined;
}

/**
 * The conservative contradiction rules. Only a contradiction that leaves
 * NO object able to pass the whole schema is reported: the root, and
 * object-only properties that the path down to them requires. An optional
 * property, a nullable one, an array item or a branch of a combinator can be
 * impossible without making the result impossible, so those are left alone.
 * Returning undefined means "no contradiction proven", not "satisfiable".
 */
function findContradiction(root: Record<string, unknown>): string | undefined {
  const rootProblem = rootExcludesObject(root);
  if (rootProblem !== undefined) return rootProblem;

  let visited = 0;
  const visit = (
    node: Record<string, unknown>,
    pointer: string,
    depth: number,
  ): string | undefined => {
    visited += 1;
    if (depth > MAX_WALK_DEPTH || visited > MAX_WALK_NODES) return undefined;
    if (COMPOUND_KEYWORDS.some((keyword) => keyword in node)) return undefined;
    const required = node['required'];
    if (!Array.isArray(required) || required.length === 0) return undefined;
    if (!required.every((key): key is string => typeof key === 'string')) {
      return undefined;
    }
    const properties = isRecord(node['properties']) ? node['properties'] : {};
    const patterns = compilePatterns(node['patternProperties']);
    if (patterns === undefined) return undefined;

    const maxProperties = node['maxProperties'];
    const distinct = new Set(required);
    if (typeof maxProperties === 'number' && distinct.size > maxProperties) {
      return `${pointer}/required lists ${distinct.size} distinct properties, but ${pointer}/maxProperties allows at most ${maxProperties}.`;
    }

    for (let index = 0; index < required.length; index++) {
      const key = required[index];
      const requiredAt = `${pointer}/required/${index}`;
      const declared = Object.hasOwn(properties, key);
      const matching = patterns.filter((entry) => entry.regex.test(key));
      if (declared && properties[key] === false) {
        return `${requiredAt} requires ${quoteKey(key)}, but ${pointer}/properties/${pointerToken(key)} is false, which forbids it.`;
      }
      const forbiddingPattern = matching.find(
        (entry) => entry.schema === false,
      );
      if (forbiddingPattern !== undefined) {
        return `${requiredAt} requires ${quoteKey(key)}, but ${pointer}/patternProperties/${pointerToken(forbiddingPattern.source)} is false, which forbids it.`;
      }
      if (
        !declared &&
        matching.length === 0 &&
        node['additionalProperties'] === false
      ) {
        return `${requiredAt} requires ${quoteKey(key)}, but this object forbids it via additionalProperties:false (it is not in properties and matches no patternProperties).`;
      }
    }

    for (const key of distinct) {
      if (!Object.hasOwn(properties, key)) continue;
      const child = properties[key];
      if (!isRecord(child) || !isObjectOnly(child)) continue;
      const problem = visit(
        child,
        `${pointer}/properties/${pointerToken(key)}`,
        depth + 1,
      );
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  return visit(root, '#', 0);
}

interface PatternEntry {
  source: string;
  regex: RegExp;
  schema: unknown;
}

/**
 * Compiles `patternProperties` the way Ajv does by default (unicode regular
 * expressions). Undefined when a pattern cannot be compiled that way, in
 * which case the rules that depend on pattern matching are skipped.
 */
function compilePatterns(value: unknown): PatternEntry[] | undefined {
  if (value === undefined) return [];
  if (!isRecord(value)) return undefined;
  const entries: PatternEntry[] = [];
  for (const [source, schema] of Object.entries(value)) {
    try {
      entries.push({ source, regex: new RegExp(source, 'u'), schema });
    } catch {
      return undefined;
    }
  }
  return entries;
}
