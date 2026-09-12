/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** 外部定义的来源标记，不授予工作目录或工具权限。 */
export interface WorkflowSourceRef {
  id: string;
  revision: string;
  digest?: string;
  title?: string;
}

export const WORKFLOW_SOURCE_REF_LIMITS = {
  id: 256,
  revision: 256,
  digest: 256,
  title: 512,
} as const;

function isUnsafeWorkflowReferenceCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    code < 32 ||
    (code >= 127 && code <= 159) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

export function isWorkflowReferenceString(
  value: unknown,
  maxLength = 256,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !Array.from(value).some(isUnsafeWorkflowReferenceCharacter)
  );
}

export function normalizeWorkflowSourceRef(value: unknown): WorkflowSourceRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workflow sourceRef must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !Object.hasOwn(WORKFLOW_SOURCE_REF_LIMITS, key),
    )
  ) {
    throw new Error('Workflow sourceRef contains an unknown field.');
  }
  for (const [key, limit] of Object.entries(WORKFLOW_SOURCE_REF_LIMITS)) {
    if (record[key] === undefined && key !== 'id' && key !== 'revision') {
      continue;
    }
    if (!isWorkflowReferenceString(record[key], limit)) {
      throw new Error(
        `Workflow sourceRef.${key} must be a non-empty string of at most ${limit} characters without surrounding whitespace or control characters.`,
      );
    }
  }
  return {
    id: record['id'] as string,
    revision: record['revision'] as string,
    ...(record['digest'] !== undefined
      ? { digest: record['digest'] as string }
      : {}),
    ...(record['title'] !== undefined
      ? { title: record['title'] as string }
      : {}),
  };
}

export function isWorkflowSourceRef(
  value: unknown,
): value is WorkflowSourceRef {
  try {
    normalizeWorkflowSourceRef(value);
    return true;
  } catch {
    return false;
  }
}
