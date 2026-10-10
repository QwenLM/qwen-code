/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { normalizeWorkspaceRelativePath } from '@qwen-code/qwen-code-core/managed-runtime/managed-workspace-relative-path.js';
export {
  InvalidWorkspaceRelativePathError,
  normalizeWorkspaceRelativePath,
  WORKSPACE_ROOT,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-workspace-relative-path.js';

// TypeScript half of the W0a Workspace binding contract; the Java half is the
// com.alibaba.qwen.code.runtimebroker.managedworkspace package in
// packages/sdk-java/runtime-broker. The shared fixtures in
// contracts/managed-workspace-binding-v1.fixtures.json keep both byte for
// byte identical. The Runtime worker uses it through the managed-context/1
// envelope.

export const CONTEXT_BINDING_DOMAIN_TAG = 'qwen-managed-context-binding-v1';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const STORAGE_ID_PATTERN = /^[\x21-\x7E]{1,256}$/;
const REFERENCE_PATTERN = /^[\x21-\x7E]{1,512}$/;
const DECIMAL_PATTERN = /^[1-9][0-9]{0,18}$/;
const INT64_MAX = 9223372036854775807n;

export interface ManagedContextBinding {
  readonly tenantId: string;
  readonly workspaceId: string;
  /** Decimal text, so a 64-bit value never passes through Number. */
  readonly workspaceGeneration: string;
  readonly storageId: string;
  /** Already in the normal form of normalizeWorkspaceRelativePath. */
  readonly cwdRelative: string;
  readonly contextConfigRef: string;
  /** Decimal text, at least 1. */
  readonly contextRevision: string;
}

/**
 * Encodes each item as a 4-byte big-endian length followed by its UTF-8
 * bytes: the domain tag, then the binding fields in contract order.
 */
export function encodeManagedContextBinding(
  binding: ManagedContextBinding,
): Buffer {
  if (typeof binding !== 'object' || binding === null) {
    throw new Error('Managed context binding is invalid.');
  }
  // Each field is read once, so the value checked is the value encoded.
  const {
    tenantId,
    workspaceId,
    workspaceGeneration,
    storageId,
    cwdRelative,
    contextConfigRef,
    contextRevision,
  } = binding;
  if (
    !matches(IDENTIFIER_PATTERN, tenantId) ||
    !matches(IDENTIFIER_PATTERN, workspaceId) ||
    !isCanonicalDecimal(workspaceGeneration) ||
    !matches(STORAGE_ID_PATTERN, storageId) ||
    !isNormalized(cwdRelative) ||
    !matches(REFERENCE_PATTERN, contextConfigRef) ||
    !isCanonicalDecimal(contextRevision)
  ) {
    throw new Error('Managed context binding is invalid.');
  }
  const items = [
    CONTEXT_BINDING_DOMAIN_TAG,
    tenantId,
    workspaceId,
    workspaceGeneration,
    storageId,
    cwdRelative,
    contextConfigRef,
    contextRevision,
  ];
  const parts: Buffer[] = [];
  for (const item of items) {
    const bytes = Buffer.from(item, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

/** `sha256:` and the lowercase hex SHA-256 of the encoded binding. */
export function computeManagedContextDigest(
  binding: ManagedContextBinding,
): string {
  return `sha256:${createHash('sha256')
    .update(encodeManagedContextBinding(binding))
    .digest('hex')}`;
}

/** Whether a value follows the W0a identifier rule, as tenant IDs do. */
export function isManagedIdentifier(value: unknown): value is string {
  return matches(IDENTIFIER_PATTERN, value);
}

/** Whether a value is a storage ID under the W0a rule. */
export function isWorkspaceStorageId(value: unknown): value is string {
  return matches(STORAGE_ID_PATTERN, value);
}

/** Whether a value is canonical decimal text from 1 to 2^63-1. */
export function isCanonicalDecimalText(value: unknown): value is string {
  return isCanonicalDecimal(value);
}

function matches(pattern: RegExp, value: unknown): boolean {
  return typeof value === 'string' && pattern.test(value);
}

function isCanonicalDecimal(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    DECIMAL_PATTERN.test(value) &&
    BigInt(value) <= INT64_MAX
  );
}

function isNormalized(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return normalizeWorkspaceRelativePath(value) === value;
  } catch {
    return false;
  }
}
