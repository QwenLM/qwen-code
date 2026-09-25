/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

// TypeScript half of the W0a Workspace binding contract; the Java half is the
// com.alibaba.qwen.code.runtimebroker.managedworkspace package in
// packages/sdk-java/runtime-broker. The shared fixtures in
// contracts/managed-workspace-binding-v1.fixtures.json keep both byte for
// byte identical. Nothing wires this into the Runtime worker yet.

export const WORKSPACE_ROOT = '.';
export const CONTEXT_BINDING_DOMAIN_TAG = 'qwen-managed-context-binding-v1';

const MAXIMUM_CWD_CODE_POINTS = 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const STORAGE_ID_PATTERN = /^[\x21-\x7E]{1,256}$/;
const REFERENCE_PATTERN = /^[\x21-\x7E]{1,512}$/;
const DECIMAL_PATTERN = /^[1-9][0-9]{0,18}$/;
const INT64_MAX = 9223372036854775807n;

export class InvalidWorkspaceRelativePathError extends Error {
  readonly code = 'invalid_cwd';

  constructor() {
    super('cwdRelative is not a valid Workspace-relative directory.');
    this.name = 'InvalidWorkspaceRelativePathError';
  }
}

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
 * Returns the normal form of a Workspace-relative directory: empty and `.`
 * segments are dropped and nothing else changes. The check is lexical; the
 * Runtime still verifies the directory on disk.
 */
export function normalizeWorkspaceRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > MAXIMUM_CWD_CODE_POINTS * 2 ||
    !isWellFormed(value)
  ) {
    throw new InvalidWorkspaceRelativePathError();
  }
  const codePoints = [...value].length;
  if (
    codePoints < 1 ||
    codePoints > MAXIMUM_CWD_CODE_POINTS ||
    hasControlCharacter(value) ||
    value.includes('\\') ||
    value.startsWith('/')
  ) {
    throw new InvalidWorkspaceRelativePathError();
  }
  const kept: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '..') {
      throw new InvalidWorkspaceRelativePathError();
    }
    if (segment !== '' && segment !== '.') {
      kept.push(segment);
    }
  }
  const normalized = kept.length === 0 ? WORKSPACE_ROOT : kept.join('/');
  // Checked on the normal form: dropping a leading "." segment would
  // otherwise turn ./C:x into the drive path C:x.
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new InvalidWorkspaceRelativePathError();
  }
  return normalized;
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

function isWellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

// Unicode category Cc: C0 controls, DEL and C1 controls.
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}
