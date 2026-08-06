/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Restricted `when` condition DSL for fixed policies (policy design §8.3).
 *
 * Conditions are recursive compositions of `all` / `any` over comparisons;
 * comparisons support `gt|gte|lt|lte|eq` with fields or literals on either
 * side. No arbitrary code, no JSONPath. Evaluation is three-valued: a
 * comparison over a field that cannot be resolved yields `unavailable`,
 * which must NEVER be silently treated as false — the caller applies the
 * policy's `onConditionUnavailable` behavior (default: skip) and the run
 * record names the missing fields.
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

export type ResourceConditionField = (typeof RESOURCE_CONDITION_FIELDS)[number];
export type RequestConditionField = (typeof REQUEST_CONDITION_FIELDS)[number];
export type SessionConditionField = (typeof SESSION_CONDITION_FIELDS)[number];

/** Fully-qualified field name, e.g. `resource.sizeBytes`. */
export type FixedPolicyField =
  | `resource.${ResourceConditionField}`
  | `request.${RequestConditionField}`
  | `session.${SessionConditionField}`;

export type ConditionOperand =
  | { field: FixedPolicyField }
  | { value: number | string | boolean };

export type ComparisonOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

export interface ComparisonCondition {
  left: ConditionOperand;
  operator: ComparisonOperator;
  right: ConditionOperand;
}

export type FixedPolicyCondition =
  | ComparisonCondition
  | { all: FixedPolicyCondition[] }
  | { any: FixedPolicyCondition[] };

/** Values feeding field resolution. All defined fields are numeric; an
 * absent entry means the field could not be obtained for this resource
 * (e.g. `durationMs` for an image, or a probe that returned nothing). */
export interface FixedPolicyConditionContext {
  resource?: Partial<Record<ResourceConditionField, number>>;
  request?: Partial<Record<RequestConditionField, number>>;
  session?: Partial<Record<SessionConditionField, number>>;
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

const OPERATORS: readonly ComparisonOperator[] = [
  'gt',
  'gte',
  'lt',
  'lte',
  'eq',
];

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  ...RESOURCE_CONDITION_FIELDS.map((f) => `resource.${f}`),
  ...REQUEST_CONDITION_FIELDS.map((f) => `request.${f}`),
  ...SESSION_CONDITION_FIELDS.map((f) => `session.${f}`),
]);

type ResolvedOperand =
  | { ok: true; value: number | string | boolean; describe: string }
  | { ok: false; missing: string };

function resolveOperand(
  operand: ConditionOperand,
  context: FixedPolicyConditionContext,
): ResolvedOperand {
  if ('value' in operand) {
    return { ok: true, value: operand.value, describe: 'value' };
  }
  const field = operand.field;
  if (!KNOWN_FIELDS.has(field)) {
    return { ok: false, missing: field };
  }
  const [namespace, name] = field.split('.') as [
    'resource' | 'request' | 'session',
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

function evaluateComparison(
  condition: ComparisonCondition,
  context: FixedPolicyConditionContext,
): ConditionEvaluation {
  const left = resolveOperand(condition.left, context);
  const right = resolveOperand(condition.right, context);
  if (!left.ok || !right.ok) {
    const missing: string[] = [];
    if (!left.ok) missing.push(left.missing);
    if (!right.ok) missing.push(right.missing);
    return unavailable(missing);
  }
  if (condition.operator === 'eq') {
    // Strict equality: a type mismatch between two AVAILABLE values is a
    // determinate not-equal, not an unavailability.
    return left.value === right.value ? MATCH : NO_MATCH;
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
  switch (condition.operator) {
    case 'gt':
      return left.value > right.value ? MATCH : NO_MATCH;
    case 'gte':
      return left.value >= right.value ? MATCH : NO_MATCH;
    case 'lt':
      return left.value < right.value ? MATCH : NO_MATCH;
    case 'lte':
      return left.value <= right.value ? MATCH : NO_MATCH;
    default: {
      const exhaustive: never = condition.operator;
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
 * regardless of an unavailable sibling; `any` with a true branch is true.
 */
export function evaluateFixedPolicyCondition(
  condition: FixedPolicyCondition,
  context: FixedPolicyConditionContext,
): ConditionEvaluation {
  // Deliberately typed as a loose record: the type predicate would narrow
  // `condition` itself into a `never` after the combinator checks, and this
  // total function must handle malformed nodes anyway.
  const node: unknown = condition;
  if (!isPlainObject(node)) {
    return unavailable(['<malformed condition>']);
  }
  if ('all' in node || 'any' in node) {
    const isAll = 'all' in node;
    const children = isAll ? node['all'] : node['any'];
    if (!Array.isArray(children)) {
      return unavailable(['<malformed condition>']);
    }
    const missing: string[] = [];
    let sawUnavailable = false;
    for (const child of children) {
      const result = evaluateFixedPolicyCondition(
        child as FixedPolicyCondition,
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
  if (
    'left' in node &&
    'operator' in node &&
    'right' in node &&
    isPlainObject(node['left']) &&
    isPlainObject(node['right']) &&
    OPERATORS.includes(node['operator'] as ComparisonOperator)
  ) {
    return evaluateComparison(node as unknown as ComparisonCondition, context);
  }
  return unavailable(['<malformed condition>']);
}

function validateOperand(
  raw: unknown,
  operator: ComparisonOperator | undefined,
  where: string,
  errors: string[],
): void {
  if (!isPlainObject(raw)) {
    errors.push(`${where}: operand must be an object`);
    return;
  }
  const hasField = 'field' in raw;
  const hasValue = 'value' in raw;
  if (hasField === hasValue) {
    errors.push(`${where}: operand must have exactly one of "field"/"value"`);
    return;
  }
  if (hasField) {
    if (typeof raw['field'] !== 'string' || !KNOWN_FIELDS.has(raw['field'])) {
      errors.push(`${where}: unknown field ${JSON.stringify(raw['field'])}`);
    }
    return;
  }
  const value = raw['value'];
  if (
    typeof value !== 'number' &&
    typeof value !== 'string' &&
    typeof value !== 'boolean'
  ) {
    errors.push(`${where}: literal must be a number, string, or boolean`);
    return;
  }
  if (operator !== 'eq' && operator !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
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
  if (!isPlainObject(raw)) {
    errors.push(`${where}: condition must be an object`);
    return errors;
  }
  const keys = ['all', 'any', 'left'].filter((k) => k in raw);
  if (keys.length !== 1) {
    errors.push(
      `${where}: condition must be exactly one of a comparison, "all", or "any"`,
    );
    return errors;
  }
  if ('all' in raw || 'any' in raw) {
    const key = 'all' in raw ? 'all' : 'any';
    const children = raw[key];
    if (!Array.isArray(children) || children.length === 0) {
      errors.push(`${where}.${key}: must be a non-empty array of conditions`);
      return errors;
    }
    children.forEach((child, i) => {
      errors.push(
        ...validateFixedPolicyCondition(child, `${where}.${key}[${i}]`),
      );
    });
    return errors;
  }
  const operator = raw['operator'];
  const knownOperator = OPERATORS.includes(operator as ComparisonOperator);
  if (!knownOperator) {
    errors.push(
      `${where}.operator: must be one of ${OPERATORS.join(', ')} (got ${JSON.stringify(operator)})`,
    );
  }
  validateOperand(
    raw['left'],
    knownOperator ? (operator as ComparisonOperator) : undefined,
    `${where}.left`,
    errors,
  );
  validateOperand(
    raw['right'],
    knownOperator ? (operator as ComparisonOperator) : undefined,
    `${where}.right`,
    errors,
  );
  return errors;
}
