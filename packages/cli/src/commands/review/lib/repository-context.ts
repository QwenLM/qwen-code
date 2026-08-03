/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RepositoryContextRoleId } from './agent-briefs.js';
import { isRepositoryContextRoleId } from './agent-briefs.js';

export const REPOSITORY_CONTEXT_VERSION = 1 as const;

// Shared bounds for the context contract and every provider that produces one:
// a provider validator must emit exactly what validateRepositoryContext accepts,
// so both read the same constants instead of keeping lockstep copies that can
// drift.
export const MAX_ARRAY_ITEMS = 128;
const MAX_PROVIDER_LENGTH = 64;
export const MAX_LABEL_LENGTH = 120;
export const MAX_TOKEN_LENGTH = 160;
export const MAX_PATH_LENGTH = 512;
export const MAX_NOTE_LENGTH = 512;

export interface RepositoryContext {
  version: typeof REPOSITORY_CONTEXT_VERSION;
  provider: string;
  label: string;
  domains: string[];
  relatedPaths: string[];
  recommendedTests: string[];
  requiredConfigurations: string[];
  requiredAgents: RepositoryContextRoleId[];
  unverifiedDimensions: string[];
  verificationNotes: string[];
}

export interface RepositoryContextPlan {
  repositoryContext?: unknown;
}

export interface RepositoryContextProviderInput {
  worktree: string;
  changedPaths: string[];
  /**
   * Read an identity file the provider keys on. The content is identical in
   * every mode — CRLF normalised to LF, surrounding whitespace trimmed — so a
   * provider that exact-compares a marker file gets the same value in a pull
   * request review (read from the trusted merge base) and a local one (read
   * from the worktree). `null` means the file is absent; a read failure
   * THROWS, fail-closed, so a broken read cannot pose as "not this
   * repository".
   */
  readIdentityFile(relativePath: string): string | null;
}

export interface RepositoryContextProvider {
  provide(input: RepositoryContextProviderInput): RepositoryContext | null;
}

const CONTEXT_KEYS = [
  'version',
  'provider',
  'label',
  'domains',
  'relatedPaths',
  'recommendedTests',
  'requiredConfigurations',
  'requiredAgents',
  'unverifiedDimensions',
  'verificationNotes',
].sort();

const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]*$/;

export function isControlFree(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      return false;
    }
  }
  return true;
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || compareText(values[index - 1], value) < 0,
  );
}

export function isSafeRepositoryRelativePath(path: string): boolean {
  const segments = path.split('/');
  return (
    path.length > 0 &&
    path.length <= MAX_PATH_LENGTH &&
    isControlFree(path) &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes('\\') &&
    segments.every(
      (segment) => segment !== '' && segment !== '.' && segment !== '..',
    )
  );
}

/**
 * Bounded, non-empty, control-character-free string. `prefix` names the owner
 * of the field in the error (`repositoryContext.` for the wire format, the
 * manifest's own wording for manifest parsing), so one validator serves both
 * without their bounds drifting apart.
 */
export function validateBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  prefix: string,
  pattern?: RegExp,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !isControlFree(value) ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new Error(`${prefix}${field} is invalid`);
  }
}

/** Item-shape half of {@link validateBoundedString}; ordering is the caller's. */
export function validateBoundedStringArray(
  value: unknown,
  field: string,
  maxLength: number,
  prefix: string,
  pattern?: RegExp,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARRAY_ITEMS ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        item.length === 0 ||
        item.length > maxLength ||
        !isControlFree(item) ||
        (pattern !== undefined && !pattern.test(item)),
    )
  ) {
    throw new Error(`${prefix}${field} is invalid`);
  }
}

/** Validate repository context before any downstream consumer trusts it. */
export function validateRepositoryContext(value: unknown): RepositoryContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('repositoryContext must be an object');
  }
  const context = value as Record<string, unknown>;
  const keys = Object.keys(context).sort();
  if (
    keys.length !== CONTEXT_KEYS.length ||
    keys.some((key, index) => key !== CONTEXT_KEYS[index])
  ) {
    throw new Error('repositoryContext has unknown or missing fields');
  }
  if (context['version'] !== REPOSITORY_CONTEXT_VERSION) {
    throw new Error('unsupported repositoryContext version');
  }

  const prefix = 'repositoryContext.';
  // The wire format every downstream consumer trusts is deterministic by
  // construction: sorted and unique. Providers earn that shape on the way in
  // (the manifest provider sorts and dedupes); the validator enforces it.
  const requireSortedUnique = (values: readonly string[], field: string) => {
    if (!isSortedUnique(values)) {
      throw new Error(`${prefix}${field} must be sorted and unique`);
    }
  };

  validateBoundedString(
    context['provider'],
    'provider',
    MAX_PROVIDER_LENGTH,
    prefix,
    SAFE_PROVIDER,
  );
  validateBoundedString(context['label'], 'label', MAX_LABEL_LENGTH, prefix);
  for (const field of [
    'domains',
    'recommendedTests',
    'requiredConfigurations',
  ] as const) {
    validateBoundedStringArray(context[field], field, MAX_TOKEN_LENGTH, prefix);
    requireSortedUnique(context[field], field);
  }
  validateBoundedStringArray(
    context['relatedPaths'],
    'relatedPaths',
    MAX_PATH_LENGTH,
    prefix,
  );
  requireSortedUnique(context['relatedPaths'], 'relatedPaths');
  if (
    context['relatedPaths'].some((path) => !isSafeRepositoryRelativePath(path))
  ) {
    throw new Error('repositoryContext.relatedPaths contains an unsafe path');
  }
  // requiredAgents carries no token pattern: the role allow-list membership
  // check below is strictly tighter than any shape check.
  validateBoundedStringArray(
    context['requiredAgents'],
    'requiredAgents',
    MAX_TOKEN_LENGTH,
    prefix,
  );
  requireSortedUnique(context['requiredAgents'], 'requiredAgents');
  if (
    context['requiredAgents'].some((role) => !isRepositoryContextRoleId(role))
  ) {
    throw new Error(
      'repositoryContext.requiredAgents contains an unsupported role',
    );
  }
  for (const field of ['unverifiedDimensions', 'verificationNotes'] as const) {
    validateBoundedStringArray(context[field], field, MAX_NOTE_LENGTH, prefix);
    requireSortedUnique(context[field], field);
  }

  return context as unknown as RepositoryContext;
}

export function repositoryContextOf(
  plan: RepositoryContextPlan,
): RepositoryContext | null {
  if (plan.repositoryContext === undefined) return null;
  return validateRepositoryContext(plan.repositoryContext);
}
