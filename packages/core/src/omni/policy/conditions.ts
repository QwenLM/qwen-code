/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Restricted `when` condition DSL for fixed policies (policy design §8.3).
 *
 * Conditions are Mapbox-style expression arrays: `[operator, ...operands]`.
 * A comparison takes exactly two operands, each either a
 * `["field", "<namespace.name>"]` reference or a bare literal —
 * `[">", ["field", "resource.width"], 3000]`. Combinators nest recursively:
 * `["all", <expr>, ...]`, `["any", <expr>, ...]`, `["!", <expr>]`. No
 * arbitrary code, no JSONPath, no value-producing sub-expressions inside
 * operands. Evaluation is three-valued: a comparison over a field that
 * cannot be resolved yields `unavailable`, which must NEVER be silently
 * treated as false — the caller applies the policy's
 * `onConditionUnavailable` behavior (default: skip) and the run record
 * names the missing fields.
 */

/** Readable fields, grouped in their three natural namespaces. */
export const RESOURCE_CONDITION_FIELDS = [
  'sizeBytes',
  'durationMs',
  'width',
  'height',
  'maxWidth',
  'maxHeight',
  'frameRate',
  'frameCount',
  'bitRate',
  'sampleRateHz',
  'channels',
  'estimatedTokenCount',
] as const;
export const REQUEST_CONDITION_FIELDS = ['totalEstimatedMediaTokens'] as const;
export const SESSION_CONDITION_FIELDS = [
  'contextWindowTokens',
  'promptTokenCount',
  'reservedOutputTokens',
  'availableContextTokens',
] as const;
/** Memory-state fields (policy design §4.1/4.4): 1 when the media
 * memory subgraph of the item being matched already carries an output
 * with the corresponding role, 0 when it does not. Numeric so the
 * comparison operators work unchanged — `["==", ["field",
 * "memory.hasTranscript"], 0]` reads as "no transcript yet". */
export const MEMORY_CONDITION_FIELDS = [
  'hasTranscript',
  'hasOcr',
  'hasCaption',
  'hasSummary',
  'hasKeyframes',
  'hasClip',
] as const;

export type ResourceConditionField = (typeof RESOURCE_CONDITION_FIELDS)[number];
export type RequestConditionField = (typeof REQUEST_CONDITION_FIELDS)[number];
export type SessionConditionField = (typeof SESSION_CONDITION_FIELDS)[number];
export type MemoryConditionField = (typeof MEMORY_CONDITION_FIELDS)[number];

/** Fully-qualified field name, e.g. `resource.sizeBytes`. */
export type FixedPolicyField =
  | `resource.${ResourceConditionField}`
  | `request.${RequestConditionField}`
  | `session.${SessionConditionField}`
  | `memory.${MemoryConditionField}`;

/** Operand of a comparison: a field reference or a bare literal. */
export type ConditionOperand =
  | ['field', FixedPolicyField]
  | number
  | string
  | boolean;

export type ComparisonOperator = '>' | '>=' | '<' | '<=' | '==' | '!=';

export type ComparisonCondition = [
  ComparisonOperator,
  ConditionOperand,
  ConditionOperand,
];

export type FixedPolicyCondition =
  | ComparisonCondition
  | ['all' | 'any', ...FixedPolicyCondition[]]
  | ['!', FixedPolicyCondition];

/** Values feeding field resolution. Resource/request/session entries are
 * numeric; an absent entry means the field could not be obtained for this
 * resource (e.g. `durationMs` for an image, or a probe that returned
 * nothing). The memory namespace is numeric too (0/1 presence flags); it
 * is ABSENT ENTIRELY when memory state could not be consulted (memory
 * disabled, no binding, store unreadable) — a memory condition then
 * evaluates `unavailable`, never silently false. */
export interface FixedPolicyConditionContext {
  resource?: Partial<Record<ResourceConditionField, number>>;
  request?: Partial<Record<RequestConditionField, number>>;
  session?: Partial<Record<SessionConditionField, number>>;
  memory?: Partial<Record<MemoryConditionField, number>>;
}

export type ConditionEvaluation =
  | { outcome: 'match' }
  | { outcome: 'no_match' }
  | {
      outcome: 'unavailable';
      /** Field names (or operand descriptions) that made the result
       * undecidable — surfaced in the policy run record. */
      missingFields: string[];
    };

const MATCH: ConditionEvaluation = { outcome: 'match' };
const NO_MATCH: ConditionEvaluation = { outcome: 'no_match' };

function unavailable(missingFields: string[]): ConditionEvaluation {
  return { outcome: 'unavailable', missingFields: [...new Set(missingFields)] };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const COMPARISON_OPERATORS: readonly ComparisonOperator[] = [
  '>',
  '>=',
  '<',
  '<=',
  '==',
  '!=',
];

function isComparisonOperator(v: unknown): v is ComparisonOperator {
  return (COMPARISON_OPERATORS as readonly unknown[]).includes(v);
}

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  ...RESOURCE_CONDITION_FIELDS.map((f) => `resource.${f}`),
  ...REQUEST_CONDITION_FIELDS.map((f) => `request.${f}`),
  ...SESSION_CONDITION_FIELDS.map((f) => `session.${f}`),
  ...MEMORY_CONDITION_FIELDS.map((f) => `memory.${f}`),
]);

/**
 * Whether a `when` expression references any field of the given
 * namespace (`resource.` / `request.` / `session.` / `memory.`) — the
 * orchestrator uses this to skip computing an expensive namespace (the
 * memory subgraph query) when no policy in play reads it.
 */
export function conditionUsesNamespace(
  condition: FixedPolicyCondition,
  namespace: string,
): boolean {
  const node: unknown = condition;
  if (!Array.isArray(node)) return false;
  const prefix = `${namespace}.`;
  for (const operand of node) {
    if (!Array.isArray(operand)) continue;
    if (
      operand.length === 2 &&
      operand[0] === 'field' &&
      typeof operand[1] === 'string'
    ) {
      if (operand[1].startsWith(prefix)) return true;
      continue;
    }
    // Nested combinator operands recurse; field refs were handled above.
    if (conditionUsesNamespace(operand as FixedPolicyCondition, namespace)) {
      return true;
    }
  }
  return false;
}

type ResolvedOperand =
  | { ok: true; value: number | string | boolean; describe: string }
  | { ok: false; missing: string };

function resolveOperand(
  operand: unknown,
  context: FixedPolicyConditionContext,
): ResolvedOperand {
  if (Array.isArray(operand)) {
    if (
      operand.length !== 2 ||
      operand[0] !== 'field' ||
      typeof operand[1] !== 'string'
    ) {
      return { ok: false, missing: '<malformed operand>' };
    }
    const field = operand[1];
    if (!KNOWN_FIELDS.has(field)) {
      return { ok: false, missing: field };
    }
    const [namespace, name] = field.split('.') as [
      'resource' | 'request' | 'session' | 'memory',
      string,
    ];
    const value = (
      context[namespace] as Record<string, number | undefined> | undefined
    )?.[name];
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return { ok: false, missing: field };
    }
    return { ok: true, value, describe: field };
  }
  if (
    typeof operand === 'number' ||
    typeof operand === 'string' ||
    typeof operand === 'boolean'
  ) {
    return { ok: true, value: operand, describe: 'value' };
  }
  return { ok: false, missing: '<malformed operand>' };
}

function evaluateComparison(
  operator: ComparisonOperator,
  leftRaw: unknown,
  rightRaw: unknown,
  context: FixedPolicyConditionContext,
): ConditionEvaluation {
  const left = resolveOperand(leftRaw, context);
  const right = resolveOperand(rightRaw, context);
  if (!left.ok || !right.ok) {
    const missing: string[] = [];
    if (!left.ok) missing.push(left.missing);
    if (!right.ok) missing.push(right.missing);
    return unavailable(missing);
  }
  if (operator === '==' || operator === '!=') {
    // Strict (in)equality: a type mismatch between two AVAILABLE values is
    // a determinate not-equal, not an unavailability.
    const equal = left.value === right.value;
    return equal === (operator === '==') ? MATCH : NO_MATCH;
  }
  // Ordering requires two finite numbers; anything else cannot be ordered
  // and must not silently collapse to false.
  if (
    typeof left.value !== 'number' ||
    typeof right.value !== 'number' ||
    !Number.isFinite(left.value) ||
    !Number.isFinite(right.value)
  ) {
    const missing: string[] = [];
    if (typeof left.value !== 'number' || !Number.isFinite(left.value)) {
      missing.push(`${left.describe} (not orderable)`);
    }
    if (typeof right.value !== 'number' || !Number.isFinite(right.value)) {
      missing.push(`${right.describe} (not orderable)`);
    }
    return unavailable(missing);
  }
  switch (operator) {
    case '>':
      return left.value > right.value ? MATCH : NO_MATCH;
    case '>=':
      return left.value >= right.value ? MATCH : NO_MATCH;
    case '<':
      return left.value < right.value ? MATCH : NO_MATCH;
    case '<=':
      return left.value <= right.value ? MATCH : NO_MATCH;
    default: {
      const exhaustive: never = operator;
      return unavailable([`unknown operator ${String(exhaustive)}`]);
    }
  }
}

/**
 * Evaluate a `when` condition against a context snapshot. Total function —
 * never throws, even on structurally malformed input (which startup
 * validation rejects; anything that slips through degrades to
 * `unavailable`, the fail-safe outcome).
 *
 * Combinators use strong Kleene logic so `unavailable` propagates only
 * when it is actually decisive: `all` with a false branch is false
 * regardless of an unavailable sibling; `any` with a true branch is true;
 * `!` flips determinate outcomes and passes `unavailable` through.
 */
export function evaluateFixedPolicyCondition(
  condition: FixedPolicyCondition,
  context: FixedPolicyConditionContext,
): ConditionEvaluation {
  // Deliberately treated as unknown: this total function must handle
  // malformed nodes anyway, and narrowing the tuple union member-by-member
  // buys nothing here.
  const node: unknown = condition;
  if (!Array.isArray(node) || node.length === 0) {
    return unavailable(['<malformed condition>']);
  }
  const head = node[0];
  if (head === 'all' || head === 'any') {
    const isAll = head === 'all';
    const missing: string[] = [];
    let sawUnavailable = false;
    for (let i = 1; i < node.length; i++) {
      const result = evaluateFixedPolicyCondition(
        node[i] as FixedPolicyCondition,
        context,
      );
      if (result.outcome === 'unavailable') {
        sawUnavailable = true;
        missing.push(...result.missingFields);
        continue;
      }
      // Dominant outcomes short-circuit: false for `all`, true for `any`.
      if (isAll && result.outcome === 'no_match') return NO_MATCH;
      if (!isAll && result.outcome === 'match') return MATCH;
    }
    if (sawUnavailable) return unavailable(missing);
    return isAll ? MATCH : NO_MATCH;
  }
  if (head === '!') {
    if (node.length !== 2) {
      return unavailable(['<malformed condition>']);
    }
    const result = evaluateFixedPolicyCondition(
      node[1] as FixedPolicyCondition,
      context,
    );
    if (result.outcome === 'unavailable') return result;
    return result.outcome === 'match' ? NO_MATCH : MATCH;
  }
  if (isComparisonOperator(head) && node.length === 3) {
    return evaluateComparison(head, node[1], node[2], context);
  }
  return unavailable(['<malformed condition>']);
}

function validateOperand(
  raw: unknown,
  operator: ComparisonOperator,
  where: string,
  errors: string[],
): void {
  if (Array.isArray(raw)) {
    if (raw.length !== 2 || raw[0] !== 'field') {
      errors.push(
        `${where}: field reference must be ["field", "<namespace.field>"]`,
      );
      return;
    }
    if (typeof raw[1] !== 'string' || !KNOWN_FIELDS.has(raw[1])) {
      errors.push(`${where}: unknown field ${JSON.stringify(raw[1])}`);
    }
    return;
  }
  if (
    typeof raw !== 'number' &&
    typeof raw !== 'string' &&
    typeof raw !== 'boolean'
  ) {
    errors.push(`${where}: literal must be a number, string, or boolean`);
    return;
  }
  if (operator !== '==' && operator !== '!=') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      errors.push(
        `${where}: operator "${operator}" requires a finite numeric literal`,
      );
    }
  }
}

/**
 * Structural validation for a raw `when` condition (policy design §13 #5),
 * run at config-normalization time. Returns a list of human-readable
 * errors; empty means valid.
 */
export function validateFixedPolicyCondition(
  raw: unknown,
  where = 'when',
): string[] {
  const errors: string[] = [];
  if (isPlainObject(raw)) {
    // Catch the pre-expression object form with a pointed migration hint
    // instead of a generic type error.
    errors.push(
      `${where}: condition must be an expression array like ` +
        `[">", ["field", "resource.width"], 3000] or ["all", <expr>, ...] ` +
        `(the {left, operator, right} object form is no longer supported)`,
    );
    return errors;
  }
  if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== 'string') {
    errors.push(
      `${where}: condition must be an expression array [operator, ...operands]`,
    );
    return errors;
  }
  const head = raw[0];
  if (head === 'all' || head === 'any') {
    if (raw.length < 2) {
      errors.push(
        `${where}: "${head}" requires at least one operand condition`,
      );
      return errors;
    }
    for (let i = 1; i < raw.length; i++) {
      errors.push(...validateFixedPolicyCondition(raw[i], `${where}[${i}]`));
    }
    return errors;
  }
  if (head === '!') {
    if (raw.length !== 2) {
      errors.push(`${where}: "!" takes exactly one operand condition`);
      return errors;
    }
    errors.push(...validateFixedPolicyCondition(raw[1], `${where}[1]`));
    return errors;
  }
  if (!isComparisonOperator(head)) {
    errors.push(
      `${where}[0]: unknown operator ${JSON.stringify(head)} (expected one ` +
        `of ${COMPARISON_OPERATORS.join(', ')}, all, any, !)`,
    );
    return errors;
  }
  if (raw.length !== 3) {
    errors.push(`${where}: comparison "${head}" takes exactly two operands`);
    return errors;
  }
  validateOperand(raw[1], head, `${where}[1]`, errors);
  validateOperand(raw[2], head, `${where}[2]`, errors);
  return errors;
}
