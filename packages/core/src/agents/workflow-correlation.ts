/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface WorkflowSourceRef {
  id: string;
  revision: string;
}

function isCorrelationId(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

export function isWorkflowSourceRef(
  value: unknown,
): value is WorkflowSourceRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    Object.keys(ref).length === 2 &&
    Object.hasOwn(ref, 'id') &&
    Object.hasOwn(ref, 'revision') &&
    isCorrelationId(ref['id'], 256) &&
    isCorrelationId(ref['revision'], 256)
  );
}

export function readWorkflowSourceRef(
  value: unknown,
): WorkflowSourceRef | undefined {
  if (value === undefined) return undefined;
  if (!isWorkflowSourceRef(value)) {
    throw new Error(
      'Workflow sourceRef must contain only id and revision, each a non-empty string of at most 256 characters without surrounding whitespace or control characters.',
    );
  }
  return Object.freeze({ id: value.id, revision: value.revision });
}
