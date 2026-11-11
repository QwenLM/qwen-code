/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ErrorObject } from 'ajv';

export type ToolParameterErrorSubtype =
  | 'json_schema'
  | 'custom_semantic'
  | 'tool_state'
  | 'missing_reference'
  | 'file_precondition'
  | 'unknown_build_validation'
  | 'unknown_execution_validation';

export interface ToolParameterDiagnosticDetails {
  schema_version: 1;
  validation_source: 'json_schema' | 'custom' | 'build' | 'tool_execution';
  parameter_path?: string;
  validation_keyword?: string;
  expected_type?: string;
  actual_type?: string;
  expected_format?: string;
  actual_shape_bucket?: string;
  constraint_category?: string;
  quality: 'precise' | 'fallback';
  validation_phase: 'build' | 'execution';
}

export interface ToolParameterDiagnosticData extends Record<string, unknown> {
  tool_error_stage: 'parameter_validation';
  tool_error_subtype: ToolParameterErrorSubtype;
  tool_error_details_json: string;
}

interface ValueShape {
  type: string;
  bucket: string;
}

export class ToolParameterValidationError extends Error {
  constructor(
    message: string,
    readonly data: ToolParameterDiagnosticData,
  ) {
    super(message);
    this.name = 'ToolParameterValidationError';
  }
}

export function createToolParameterDiagnosticData(
  subtype: ToolParameterErrorSubtype,
  details: Omit<ToolParameterDiagnosticDetails, 'schema_version'>,
): ToolParameterDiagnosticData {
  const boundedDetails: ToolParameterDiagnosticDetails = {
    schema_version: 1,
    ...details,
  };
  return {
    tool_error_stage: 'parameter_validation',
    tool_error_subtype: subtype,
    tool_error_details_json: JSON.stringify(boundedDetails),
  };
}

export function getToolParameterDiagnosticData(
  error: unknown,
): ToolParameterDiagnosticData | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const subtype = record['tool_error_subtype'];
  const detailsJson = record['tool_error_details_json'];
  return record['tool_error_stage'] === 'parameter_validation' &&
    typeof subtype === 'string' &&
    typeof detailsJson === 'string'
    ? (record as ToolParameterDiagnosticData)
    : undefined;
}

export function createUnknownBuildDiagnosticData(): ToolParameterDiagnosticData {
  return createToolParameterDiagnosticData('unknown_build_validation', {
    validation_source: 'build',
    constraint_category: 'unknown',
    quality: 'fallback',
    validation_phase: 'build',
  });
}

export function createUnknownExecutionDiagnosticData(): ToolParameterDiagnosticData {
  return createToolParameterDiagnosticData('unknown_execution_validation', {
    validation_source: 'tool_execution',
    constraint_category: 'unknown',
    quality: 'fallback',
    validation_phase: 'execution',
  });
}

export function captureParameterShapes(
  input: unknown,
): ReadonlyMap<string, ValueShape> {
  const shapes = new Map<string, ValueShape>();
  let visited = 0;

  const visit = (value: unknown, path: string, depth: number): void => {
    if (visited >= 256 || depth > 12) return;
    visited++;
    shapes.set(path, describeValueShape(value));
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}/${index}`, depth + 1));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, `${path}/${escapeJsonPointer(key)}`, depth + 1);
      }
    }
  };

  visit(input, '', 0);
  return shapes;
}

export function createSchemaDiagnosticData(
  error: ErrorObject,
  schema: unknown,
  originalShapes: ReadonlyMap<string, ValueShape>,
): ToolParameterDiagnosticData {
  const path = error.instancePath || '';
  const originalShape = originalShapes.get(path);
  const expectedType = getExpectedType(error, schema);
  const expectedFormat = getStringParam(error.params, 'format');

  return createToolParameterDiagnosticData('json_schema', {
    validation_source: 'json_schema',
    parameter_path: normalizeParameterPath(path, schema, error),
    validation_keyword: boundedCategory(error.keyword),
    ...(expectedType ? { expected_type: boundedCategory(expectedType) } : {}),
    ...(error.keyword === 'required'
      ? { actual_type: 'missing', actual_shape_bucket: 'missing' }
      : originalShape
      ? {
          actual_type: originalShape.type,
          actual_shape_bucket: originalShape.bucket,
        }
      : {}),
    ...(expectedFormat
      ? { expected_format: boundedCategory(expectedFormat) }
      : {}),
    constraint_category: constraintCategory(error.keyword),
    quality: 'precise',
    validation_phase: 'build',
  });
}

function getExpectedType(
  error: ErrorObject,
  schema: unknown,
): string | undefined {
  const directType = getStringParam(error.params, 'type');
  if (directType || error.keyword !== 'required') return directType;

  const missingProperty = getStringParam(error.params, 'missingProperty');
  if (!missingProperty) return undefined;
  const parentSchema = schemaAtInstancePath(schema, error.instancePath);
  const properties = asRecord(parentSchema?.['properties']);
  const propertySchema = asRecord(properties?.[missingProperty]);
  const expected = propertySchema?.['type'];
  return typeof expected === 'string' ? expected : undefined;
}

function schemaAtInstancePath(
  schema: unknown,
  instancePath: string,
): Record<string, unknown> | undefined {
  let current = asRecord(schema);
  for (const segment of instancePath.split('/').slice(1).map(unescapeJsonPointer)) {
    if (/^\d+$/u.test(segment)) {
      current = asRecord(current?.['items']);
      continue;
    }
    const properties = asRecord(current?.['properties']);
    current = asRecord(properties?.[segment]);
  }
  return current;
}

function describeValueShape(value: unknown): ValueShape {
  if (value === null) return { type: 'null', bucket: 'null' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      bucket: value.length === 0 ? 'array_empty' : 'array_nonempty',
    };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { type: 'string', bucket: 'string_empty' };
    if (trimmed.length <= 4096 && (trimmed[0] === '[' || trimmed[0] === '{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return { type: 'string', bucket: 'string_json_array' };
        }
        if (parsed && typeof parsed === 'object') {
          return { type: 'string', bucket: 'string_json_object' };
        }
      } catch {
        // Shape classification is best-effort and never records the value.
      }
    }
    return { type: 'string', bucket: 'string_nonempty' };
  }
  if (typeof value === 'object') {
    return {
      type: 'object',
      bucket:
        Object.keys(value as Record<string, unknown>).length === 0
          ? 'object_empty'
          : 'object_nonempty',
    };
  }
  if (typeof value === 'number') {
    return {
      type: 'number',
      bucket: Number.isFinite(value) ? 'number_finite' : 'number_nonfinite',
    };
  }
  if (typeof value === 'boolean') return { type: 'boolean', bucket: 'boolean' };
  if (typeof value === 'undefined') return { type: 'missing', bucket: 'missing' };
  return { type: 'other', bucket: 'other' };
}

function normalizeParameterPath(
  instancePath: string,
  schema: unknown,
  error: ErrorObject,
): string {
  const rawSegments = instancePath
    .split('/')
    .slice(1)
    .map(unescapeJsonPointer);
  const outputSegments: string[] = [];
  let currentSchema = asRecord(schema);

  for (const segment of rawSegments.slice(0, 12)) {
    if (/^\d+$/u.test(segment)) {
      outputSegments.push('[]');
      currentSchema = asRecord(currentSchema?.['items']);
      continue;
    }
    const properties = asRecord(currentSchema?.['properties']);
    if (properties && Object.hasOwn(properties, segment)) {
      outputSegments.push(boundedPathSegment(segment));
      currentSchema = asRecord(properties[segment]);
    } else {
      outputSegments.push('{}');
      currentSchema = asRecord(currentSchema?.['additionalProperties']);
    }
  }

  if (error.keyword === 'required') {
    const missingProperty = getStringParam(error.params, 'missingProperty');
    const properties = asRecord(currentSchema?.['properties']);
    if (missingProperty && properties && Object.hasOwn(properties, missingProperty)) {
      outputSegments.push(boundedPathSegment(missingProperty));
    }
  }

  return `params${outputSegments
    .map((segment) => (segment === '[]' ? segment : `.${segment}`))
    .join('')}`;
}

function constraintCategory(keyword: string): string {
  if (keyword === 'type') return 'type';
  if (keyword === 'required') return 'presence';
  if (keyword === 'format' || keyword === 'pattern') return 'format';
  if (
    keyword === 'minItems' ||
    keyword === 'maxItems' ||
    keyword === 'minLength' ||
    keyword === 'maxLength' ||
    keyword === 'minProperties' ||
    keyword === 'maxProperties'
  ) {
    return 'cardinality';
  }
  if (keyword === 'additionalProperties') return 'shape';
  if (keyword === 'enum' || keyword === 'const') return 'allowed_category';
  return 'schema_constraint';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getStringParam(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value ? value : undefined;
}

function boundedCategory(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 64);
}

function boundedPathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 64);
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function unescapeJsonPointer(value: string): string {
  return value.replace(/~1/gu, '/').replace(/~0/gu, '~');
}
